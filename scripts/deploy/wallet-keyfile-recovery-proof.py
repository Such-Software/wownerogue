#!/usr/bin/env python3
"""Fixed, root-only encrypted-wallet keyfile/password recovery proof for ``deb``.

The two accepted profile names select compile-time paths.  No caller-controlled path, port, unit,
binary, user, or RPC method is accepted.  The proof reads no mnemonic and has no mnemonic RPC.
Its only output is ``result=passed`` or ``result=refused``.
"""

from __future__ import annotations

import ctypes
import grp
import hashlib
import hmac
import http.client
import json
import os
import pathlib
import pwd
import resource
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable


PR_SET_DUMPABLE = 4
PR_SET_KEEPCAPS = 8
PR_SET_NO_NEW_PRIVS = 38
MADV_DONTDUMP = 16
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
MAX_CMDLINE = 64 * 1024
MAX_RPC_RESPONSE = 1024 * 1024
RPC_PATH = "/json_rpc"
RPC_USER = "recovery-proof"
ZERO_BLOCK = b"\0" * (1024 * 1024)
LIBC = ctypes.CDLL(None, use_errno=True)
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

ADDRESS_REQUEST = json.dumps(
    {
        "jsonrpc": "2.0",
        "id": "keyfile-recovery-proof",
        "method": "get_address",
        "params": {"account_index": 0},
    },
    separators=(",", ":"),
).encode("ascii")
SIGN_MESSAGE = "wowngeon-wallet-keyfile-recovery-proof-v1"


@dataclass(frozen=True)
class WalletProfile:
    name: str
    unit: str
    user: str
    group: str
    binary: pathlib.Path
    live_wallet: pathlib.Path
    live_rpc_port: int
    live_bind_address: str
    snapshot_wallet: pathlib.Path
    snapshot_keys: pathlib.Path
    proof_port: int
    stagenet: bool
    address_kind: str
    proof_directory: pathlib.Path

    @property
    def candidate_directory(self) -> pathlib.Path:
        return self.proof_directory / "candidate"


SNAPSHOT_DIRECTORY = pathlib.Path("/var/backups/wowngeon/wallets")
PROFILES = {
    "monero-stagenet": WalletProfile(
        name="monero-stagenet",
        unit="monero-wallet-rpc.service",
        user="jw",
        group="jw",
        binary=pathlib.Path("/usr/bin/monero-wallet-rpc"),
        live_wallet=pathlib.Path(
            "/home/jw/Programs/monero-x86_64-linux-gnu-v0.18.4.4/test"
        ),
        live_rpc_port=38083,
        live_bind_address="127.0.0.1",
        snapshot_wallet=SNAPSHOT_DIRECTORY
        / "monero-stagenet-preprod-20260721T1140Z.wallet",
        snapshot_keys=SNAPSHOT_DIRECTORY
        / "monero-stagenet-preprod-20260721T1140Z.keys",
        proof_port=39084,
        stagenet=True,
        address_kind="xmr-stagenet",
        proof_directory=pathlib.Path(
            "/run/wowngeon-wallet-keyfile-proof-monero-stagenet"
        ),
    ),
    "wownero-mainnet": WalletProfile(
        name="wownero-mainnet",
        unit="wownero-wallet-rpc.service",
        user="jw",
        group="jw",
        binary=pathlib.Path("/usr/bin/wownero-wallet-rpc"),
        live_wallet=pathlib.Path("/home/jw/Programs/wow-11.3.0/game"),
        live_rpc_port=34570,
        # This is the audited legacy listener.  The proof does not broaden or change it.
        live_bind_address="0.0.0.0",
        snapshot_wallet=SNAPSHOT_DIRECTORY
        / "wownero-mainnet-preprod-20260721T1140Z.wallet",
        snapshot_keys=SNAPSHOT_DIRECTORY
        / "wownero-mainnet-preprod-20260721T1140Z.keys",
        proof_port=39570,
        stagenet=False,
        address_kind="wow-mainnet",
        proof_directory=pathlib.Path(
            "/run/wowngeon-wallet-keyfile-proof-wownero-mainnet"
        ),
    ),
}


class Refusal(RuntimeError):
    """A fixed fail-closed condition.  Its detail is deliberately never rendered."""


def refuse(code: str) -> None:
    raise Refusal(code)


def harden_process() -> None:
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if LIBC.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        refuse("dump-hardening")
    if LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        refuse("privilege-hardening")


def protect_buffer(value: bytearray) -> None:
    if not value:
        refuse("empty-protected-buffer")
    address = ctypes.addressof(ctypes.c_char.from_buffer(value))
    page_size = os.sysconf("SC_PAGESIZE")
    page_start = address - (address % page_size)
    page_end = (address + len(value) + page_size - 1) // page_size * page_size
    if LIBC.mlock(ctypes.c_void_p(address), ctypes.c_size_t(len(value))) != 0:
        ctypes.memset(ctypes.c_void_p(address), 0, len(value))
        refuse("secret-lock")
    if LIBC.madvise(
        ctypes.c_void_p(page_start),
        ctypes.c_size_t(page_end - page_start),
        ctypes.c_int(MADV_DONTDUMP),
    ) != 0:
        ctypes.memset(ctypes.c_void_p(address), 0, len(value))
        LIBC.munlock(ctypes.c_void_p(address), ctypes.c_size_t(len(value)))
        refuse("secret-dontdump")


def wipe_buffer(value: bytearray | None, protected: bool = False) -> None:
    if value is None or len(value) == 0:
        return
    address = ctypes.addressof(ctypes.c_char.from_buffer(value))
    ctypes.memset(ctypes.c_void_p(address), 0, len(value))
    if protected:
        # mlock is page-granular and Python allocations can share a page.  Unlocking one wiped
        # allocation could unlock another live protected buffer, so retain the small lock set until
        # this short-lived helper exits.
        pass


def identity(user: str, group: str) -> tuple[int, int]:
    try:
        return pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid
    except KeyError:
        refuse("identity")


def open_directory_nofollow(path: pathlib.Path) -> int:
    if not path.is_absolute() or pathlib.Path(os.path.normpath(path)) != path:
        refuse("path")
    descriptor = os.open("/", os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    try:
        for component in path.parts[1:]:
            following = os.open(
                component,
                os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = following
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            refuse("directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_directory(
    path: pathlib.Path, expected_uid: int, expected_gid: int, expected_mode: int
) -> os.stat_result:
    descriptor = open_directory_nofollow(path)
    try:
        details = os.fstat(descriptor)
        if (
            details.st_uid,
            details.st_gid,
            stat.S_IMODE(details.st_mode),
        ) != (expected_uid, expected_gid, expected_mode):
            refuse("directory-metadata")
        return details
    finally:
        os.close(descriptor)


def file_identity(details: os.stat_result) -> tuple[int, ...]:
    return (
        details.st_dev,
        details.st_ino,
        details.st_uid,
        details.st_gid,
        stat.S_IMODE(details.st_mode),
        details.st_nlink,
        details.st_size,
        details.st_mtime_ns,
        details.st_ctime_ns,
    )


def open_secure_file_at(
    directory_fd: int,
    name: str,
    expected_uid: int,
    expected_gid: int,
    expected_mode: int,
) -> tuple[int, tuple[int, ...]]:
    try:
        descriptor = os.open(
            name, os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC, dir_fd=directory_fd
        )
    except OSError:
        refuse("source-file")
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_nlink != 1
            or details.st_size <= 0
            or (
                details.st_uid,
                details.st_gid,
                stat.S_IMODE(details.st_mode),
            )
            != (expected_uid, expected_gid, expected_mode)
        ):
            refuse("source-metadata")
        return descriptor, file_identity(details)
    except BaseException:
        os.close(descriptor)
        raise


def secure_wipe_fd(descriptor: int) -> None:
    details = os.fstat(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        refuse("wipe-target")
    os.lseek(descriptor, 0, os.SEEK_SET)
    remaining = details.st_size
    while remaining:
        block = ZERO_BLOCK if remaining >= len(ZERO_BLOCK) else ZERO_BLOCK[:remaining]
        view = memoryview(block)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                refuse("wipe-write")
            view = view[written:]
        remaining -= len(block)
    os.ftruncate(descriptor, 0)
    os.fsync(descriptor)


def copy_one_exact(
    source_fd: int,
    expected_source: tuple[int, ...],
    destination_fd: int,
    destination_name: str,
    expected_destination_uid: int,
    expected_destination_gid: int,
    after_copy: Callable[[], None] | None = None,
) -> None:
    output = os.open(
        destination_name,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0o600,
        dir_fd=destination_fd,
    )
    published = False
    try:
        os.lseek(source_fd, 0, os.SEEK_SET)
        while True:
            block = os.read(source_fd, 1024 * 1024)
            if not block:
                break
            view = memoryview(block)
            while view:
                written = os.write(output, view)
                if written <= 0:
                    refuse("copy-write")
                view = view[written:]
        os.fsync(output)
        if after_copy is not None:
            after_copy()
        if file_identity(os.fstat(source_fd)) != expected_source:
            refuse("source-race")
        os.lseek(source_fd, 0, os.SEEK_SET)
        os.lseek(output, 0, os.SEEK_SET)
        while True:
            source_block = os.read(source_fd, 1024 * 1024)
            copy_block = os.read(output, 1024 * 1024)
            if source_block != copy_block:
                refuse("copy-mismatch")
            if not source_block:
                break
        output_details = os.fstat(output)
        if (
            not stat.S_ISREG(output_details.st_mode)
            or output_details.st_uid != expected_destination_uid
            or output_details.st_gid != expected_destination_gid
            or output_details.st_nlink != 1
            or stat.S_IMODE(output_details.st_mode) != 0o600
        ):
            refuse("copy-mode")
        published = True
        os.fsync(destination_fd)
    finally:
        if not published:
            try:
                secure_wipe_fd(output)
            except BaseException:
                pass
        os.close(output)
        if not published:
            try:
                os.unlink(destination_name, dir_fd=destination_fd)
            except OSError:
                pass


def copy_snapshot_pair(
    source_directory: pathlib.Path,
    source_wallet_name: str,
    source_keys_name: str,
    destination_directory: pathlib.Path,
    expected_uid: int,
    expected_gid: int,
    after_first_copy: Callable[[], None] | None = None,
) -> None:
    source_fd = open_directory_nofollow(source_directory)
    destination_fd = open_directory_nofollow(destination_directory)
    opened: list[tuple[int, tuple[int, ...]]] = []
    try:
        opened.append(
            open_secure_file_at(
                source_fd, source_wallet_name, expected_uid, expected_gid, 0o600
            )
        )
        opened.append(
            open_secure_file_at(
                source_fd, source_keys_name, expected_uid, expected_gid, 0o600
            )
        )
        copy_one_exact(
            opened[0][0],
            opened[0][1],
            destination_fd,
            "wallet",
            expected_uid,
            expected_gid,
            after_first_copy,
        )
        copy_one_exact(
            opened[1][0],
            opened[1][1],
            destination_fd,
            "wallet.keys",
            expected_uid,
            expected_gid,
        )
        for descriptor, expected in opened:
            if file_identity(os.fstat(descriptor)) != expected:
                refuse("pair-source-race")
    finally:
        for descriptor, _ in opened:
            os.close(descriptor)
        os.close(source_fd)
        os.close(destination_fd)


def span_equals(buffer: bytearray, span: tuple[int, int], expected: bytes) -> bool:
    start, end = span
    return end - start == len(expected) and all(
        buffer[start + index] == value for index, value in enumerate(expected)
    )


def span_starts(buffer: bytearray, span: tuple[int, int], expected: bytes) -> bool:
    start, end = span
    return end - start >= len(expected) and all(
        buffer[start + index] == value for index, value in enumerate(expected)
    )


def argv_spans(buffer: bytearray, length: int) -> list[tuple[int, int]]:
    if length < 2 or buffer[length - 1] != 0:
        refuse("cmdline-shape")
    spans: list[tuple[int, int]] = []
    start = 0
    for index in range(length):
        if buffer[index] == 0:
            spans.append((start, index))
            start = index + 1
    if not spans or spans[0][0] == spans[0][1]:
        refuse("cmdline-empty")
    return spans


def option_value_span(
    buffer: bytearray, spans: list[tuple[int, int]], option: bytes
) -> tuple[int, int]:
    matches: list[tuple[int, int]] = []
    inline_prefix = option + b"="
    for index, span in enumerate(spans):
        if span_equals(buffer, span, option):
            if index + 1 >= len(spans):
                refuse("option-value")
            matches.append(spans[index + 1])
        elif span_starts(buffer, span, inline_prefix):
            matches.append((span[0] + len(inline_prefix), span[1]))
    if len(matches) != 1 or matches[0][0] == matches[0][1]:
        refuse("option-count")
    return matches[0]


def count_arg(buffer: bytearray, spans: list[tuple[int, int]], value: bytes) -> int:
    return sum(1 for span in spans if span_equals(buffer, span, value))


def count_inline_option(
    buffer: bytearray, spans: list[tuple[int, int]], option: bytes
) -> int:
    prefix = option + b"="
    return sum(1 for span in spans if span_starts(buffer, span, prefix))


def extract_inline_wallet_password(
    buffer: bytearray,
    length: int,
    profile: WalletProfile,
    protect_secret: bool = False,
    buffer_is_protected: bool = False,
) -> bytearray:
    secret: bytearray | None = None
    try:
        spans = argv_spans(buffer, length)
        if not span_equals(buffer, spans[0], os.fsencode(profile.binary)):
            refuse("argv-binary")
        if any(
            span_equals(buffer, span, forbidden)
            or span_starts(buffer, span, forbidden + b"=")
            for span in spans
            for forbidden in (b"--password-file", b"--wallet-dir")
        ):
            refuse("argv-indirect-wallet")
        wallet_span = option_value_span(buffer, spans, b"--wallet-file")
        if not span_equals(buffer, wallet_span, os.fsencode(profile.live_wallet)):
            refuse("argv-wallet")
        port_span = option_value_span(buffer, spans, b"--rpc-bind-port")
        if not span_equals(buffer, port_span, str(profile.live_rpc_port).encode("ascii")):
            refuse("argv-port")
        if profile.stagenet:
            if (
                count_arg(buffer, spans, b"--stagenet") != 1
                or count_inline_option(buffer, spans, b"--stagenet") != 0
            ):
                refuse("argv-network")
        elif (
            count_arg(buffer, spans, b"--stagenet") != 0
            or count_inline_option(buffer, spans, b"--stagenet") != 0
        ):
            refuse("argv-network")
        if (
            count_arg(buffer, spans, b"--testnet") != 0
            or count_inline_option(buffer, spans, b"--testnet") != 0
        ):
            refuse("argv-network")
        password_span = option_value_span(buffer, spans, b"--password")
        password_length = password_span[1] - password_span[0]
        if password_length < 1 or password_length > 4096:
            refuse("password-shape")
        if any(buffer[index] in (10, 13) for index in range(*password_span)):
            refuse("password-shape")
        secret = bytearray(memoryview(buffer)[password_span[0] : password_span[1]])
        if protect_secret:
            protect_buffer(secret)
        return secret
    finally:
        wipe_buffer(buffer, buffer_is_protected)


def read_live_cmdline_password(pid: int, profile: WalletProfile) -> bytearray:
    buffer = bytearray(MAX_CMDLINE)
    protect_buffer(buffer)
    try:
        descriptor = os.open(
            f"/proc/{pid}/cmdline", os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                refuse("cmdline-file")
            length = os.readv(descriptor, [buffer])
            overflow = bytearray(1)
            try:
                if os.readv(descriptor, [overflow]) != 0:
                    refuse("cmdline-size")
            finally:
                wipe_buffer(overflow)
        finally:
            os.close(descriptor)
        return extract_inline_wallet_password(
            buffer,
            length,
            profile,
            protect_secret=True,
            buffer_is_protected=True,
        )
    except BaseException:
        # extract_inline_wallet_password already wipes on the normal parsing path.
        wipe_buffer(buffer, True)
        raise


def systemctl(*arguments: str) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["/usr/bin/systemctl", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=20,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired):
        refuse("systemd")


def main_pid(unit: str) -> int:
    result = systemctl("show", unit, "--property=MainPID", "--value")
    if result.returncode != 0:
        refuse("mainpid")
    try:
        return int(result.stdout.strip())
    except ValueError:
        refuse("mainpid")


def process_status_ids(pid: int, field: str) -> tuple[int, int, int, int]:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:
            for line in source:
                if line.startswith(f"{field}:"):
                    values = line.split()[1:]
                    if len(values) == 4:
                        return (
                            int(values[0]),
                            int(values[1]),
                            int(values[2]),
                            int(values[3]),
                        )
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    refuse("process-identity")


def process_uid(pid: int) -> int:
    values = process_status_ids(pid, "Uid")
    if len(set(values)) != 1:
        refuse("process-uid")
    return values[0]


def process_gid(pid: int) -> int:
    values = process_status_ids(pid, "Gid")
    if len(set(values)) != 1:
        refuse("process-gid")
    return values[0]


def process_groups(pid: int) -> list[int]:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:
            for line in source:
                if line.startswith("Groups:"):
                    return [int(value) for value in line.split()[1:]]
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    refuse("process-groups")


def process_status_integer(pid: int, field: str) -> int:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:
            for line in source:
                if line.startswith(f"{field}:"):
                    values = line.split()[1:]
                    if len(values) == 1:
                        return int(values[0])
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    refuse("process-security-state")


def process_status_hex(pid: int, field: str) -> int:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:
            for line in source:
                if line.startswith(f"{field}:"):
                    values = line.split()[1:]
                    if len(values) == 1:
                        return int(values[0], 16)
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    refuse("process-capabilities")


def process_start_time(pid: int) -> str:
    try:
        raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        fields = raw[raw.rfind(")") + 2 :].split()
        return fields[19]
    except (OSError, UnicodeDecodeError, IndexError):
        refuse("process-start")


def process_has_unit_cgroup(pid: int, unit: str) -> bool:
    try:
        lines = pathlib.Path(f"/proc/{pid}/cgroup").read_text(
            encoding="ascii"
        ).splitlines()
    except (OSError, UnicodeDecodeError):
        refuse("process-cgroup")
    return any(line.rsplit(":", 1)[-1].endswith(f"/{unit}") for line in lines)


def process_executable(pid: int) -> pathlib.Path:
    try:
        return pathlib.Path(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        refuse("process-executable")


def process_executable_identity(pid: int) -> tuple[int, ...]:
    try:
        descriptor = os.open(f"/proc/{pid}/exe", os.O_RDONLY | O_CLOEXEC)
    except OSError:
        refuse("process-executable-file")
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            refuse("process-executable-file")
        return file_identity(details)
    finally:
        os.close(descriptor)


def parse_listener_table(
    path: str, port: int, ipv6: bool
) -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    try:
        with open(path, "r", encoding="ascii") as source:
            next(source, None)
            for line in source:
                fields = line.split()
                if len(fields) < 10 or fields[3] != "0A":
                    continue
                address_hex, port_hex = fields[1].split(":")
                if int(port_hex, 16) != port:
                    continue
                if ipv6:
                    address = socket.inet_ntop(
                        socket.AF_INET6, bytes.fromhex(address_hex)
                    )
                else:
                    address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
                found.append((address, int(fields[9])))
    except (OSError, UnicodeDecodeError, ValueError, IndexError):
        refuse("listener-table")
    return found


def listeners(port: int) -> list[tuple[str, int]]:
    return parse_listener_table("/proc/net/tcp", port, False) + parse_listener_table(
        "/proc/net/tcp6", port, True
    )


def process_owns_socket(pid: int, inode: int) -> bool:
    expected = f"socket:[{inode}]"
    try:
        for entry in os.scandir(f"/proc/{pid}/fd"):
            try:
                if os.readlink(entry.path) == expected:
                    return True
            except OSError:
                continue
    except OSError:
        refuse("process-fds")
    return False


def require_exact_listener(pid: int, port: int, bind_address: str) -> None:
    active = listeners(port)
    if len(active) != 1 or active[0][0] != bind_address:
        refuse("listener-identity")
    if not process_owns_socket(pid, active[0][1]):
        refuse("listener-owner")


def require_unused_port(port: int) -> None:
    if listeners(port):
        refuse("proof-port-collision")


@dataclass(frozen=True)
class LiveIdentity:
    pid: int
    start_time: str
    binary_identity: tuple[int, ...]


def require_live_process(
    profile: WalletProfile, expected_binary: tuple[int, ...]
) -> LiveIdentity:
    if systemctl("is-active", "--quiet", profile.unit).returncode != 0:
        refuse("unit-inactive")
    pid = main_pid(profile.unit)
    if pid <= 1:
        refuse("unit-pid")
    expected_uid, expected_gid = identity(profile.user, profile.group)
    started = process_start_time(pid)
    if process_uid(pid) != expected_uid:
        refuse("live-uid")
    if process_gid(pid) != expected_gid:
        refuse("live-gid")
    if process_executable(pid) != profile.binary:
        refuse("live-executable")
    if process_executable_identity(pid) != expected_binary:
        refuse("live-executable-identity")
    if not process_has_unit_cgroup(pid, profile.unit):
        refuse("live-cgroup")
    require_exact_listener(
        pid, profile.live_rpc_port, profile.live_bind_address
    )
    return LiveIdentity(
        pid=pid, start_time=started, binary_identity=expected_binary
    )


def require_live_unchanged(profile: WalletProfile, live: LiveIdentity) -> None:
    if main_pid(profile.unit) != live.pid:
        refuse("live-race")
    if process_start_time(live.pid) != live.start_time:
        refuse("live-race")
    expected_uid, expected_gid = identity(profile.user, profile.group)
    if process_uid(live.pid) != expected_uid:
        refuse("live-race")
    if process_gid(live.pid) != expected_gid:
        refuse("live-race")
    if process_executable(live.pid) != profile.binary:
        refuse("live-race")
    if (
        process_executable_identity(live.pid) != live.binary_identity
        or require_binary(profile) != live.binary_identity
    ):
        refuse("live-race")
    if not process_has_unit_cgroup(live.pid, profile.unit):
        refuse("live-race")
    require_exact_listener(
        live.pid, profile.live_rpc_port, profile.live_bind_address
    )


def network_shaped_address(value: object, profile: WalletProfile) -> bool:
    if not isinstance(value, str) or not value.isascii():
        return False
    if profile.address_kind == "xmr-stagenet":
        return (
            len(value) == 95
            and value.startswith("5")
            and all(character in BASE58_ALPHABET for character in value)
        )
    if profile.address_kind == "wow-mainnet":
        return (
            len(value) == 97
            and value.startswith("Wo")
            and all(character in BASE58_ALPHABET for character in value)
        )
    return False


def rpc_post(
    port: int,
    request_body: bytes | bytearray = ADDRESS_REQUEST,
    authorization: str | None = None,
) -> tuple[int, str | None, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if authorization is not None:
        headers["Authorization"] = authorization
    try:
        connection.request("POST", RPC_PATH, body=request_body, headers=headers)
        response = connection.getresponse()
        challenge = response.getheader("WWW-Authenticate")
        raw = response.read(MAX_RPC_RESPONSE + 1)
        if len(raw) > MAX_RPC_RESPONSE:
            refuse("rpc-size")
        return response.status, challenge, raw
    except (OSError, TimeoutError, http.client.HTTPException):
        refuse("rpc-transport")
    finally:
        connection.close()


def address_from_response(raw: bytes, profile: WalletProfile) -> str:
    try:
        payload = json.loads(raw.decode("utf-8"))
        address = payload["result"]["address"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        refuse("rpc-payload")
    if not network_shaped_address(address, profile):
        refuse("address-network")
    return address


def current_live_address(profile: WalletProfile) -> str:
    status, _, raw = rpc_post(profile.live_rpc_port)
    if status != 200:
        refuse("live-rpc-status")
    return address_from_response(raw, profile)


def parse_digest_challenge(header: str | None) -> dict[str, str]:
    if header is None or len(header) > 4096 or "\r" in header or "\n" in header:
        refuse("digest-challenge")
    scheme, separator, fields = header.partition(" ")
    if scheme.lower() != "digest" or not separator:
        refuse("digest-scheme")
    try:
        parsed = urllib.request.parse_keqv_list(urllib.request.parse_http_list(fields))
    except (TypeError, ValueError):
        refuse("digest-parse")
    if not isinstance(parsed, dict):
        refuse("digest-parse")
    realm = parsed.get("realm")
    nonce = parsed.get("nonce")
    qop = parsed.get("qop")
    algorithm = parsed.get("algorithm", "MD5")
    qop_values = {value.strip().lower() for value in qop.split(",")} if qop else set()
    if not realm or not nonce or "auth" not in qop_values:
        refuse("digest-fields")
    if algorithm.upper() != "MD5":
        refuse("digest-algorithm")
    for value in (realm, nonce, parsed.get("opaque", "")):
        if not value.isascii() or any(character in value for character in ('"', "\\")):
            refuse("digest-value")
    return parsed


def md5_hex(*parts: bytes | bytearray | memoryview) -> str:
    try:
        digest = hashlib.md5(usedforsecurity=False)
    except TypeError:  # pragma: no cover - compatibility with older Python/OpenSSL builds
        digest = hashlib.md5()
    for part in parts:
        digest.update(part)
    return digest.hexdigest()


def random_hex(byte_count: int) -> bytearray:
    entropy = bytearray(byte_count)
    protect_buffer(entropy)
    output = bytearray(byte_count * 2)
    try:
        protect_buffer(output)
        descriptor = os.open("/dev/urandom", os.O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        try:
            if os.readv(descriptor, [entropy]) != byte_count:
                refuse("random-read")
        finally:
            os.close(descriptor)
        alphabet = b"0123456789abcdef"
        for index, value in enumerate(entropy):
            output[index * 2] = alphabet[value >> 4]
            output[index * 2 + 1] = alphabet[value & 15]
        return output
    except BaseException:
        wipe_buffer(output, True)
        raise
    finally:
        wipe_buffer(entropy, True)


def digest_authorization(
    challenge: str, rpc_secret: bytearray, nonce_count: int = 1
) -> str:
    if nonce_count < 1 or nonce_count > 0xFFFFFFFF:
        refuse("digest-count")
    parsed = parse_digest_challenge(challenge)
    realm = parsed["realm"]
    nonce = parsed["nonce"]
    cnonce = random_hex(16)
    try:
        cnonce_text = bytes(cnonce).decode("ascii")
        ha1 = md5_hex(
            RPC_USER.encode("ascii"),
            b":",
            realm.encode("ascii"),
            b":",
            memoryview(rpc_secret),
        )
        ha2 = md5_hex(b"POST", b":", RPC_PATH.encode("ascii"))
        nonce_count_text = f"{nonce_count:08x}"
        response = md5_hex(
            ha1.encode("ascii"),
            b":",
            nonce.encode("ascii"),
            b":",
            nonce_count_text.encode("ascii"),
            b":",
            cnonce_text.encode("ascii"),
            b":auth:",
            ha2.encode("ascii"),
        )
        fields = [
            f'username="{RPC_USER}"',
            f'realm="{realm}"',
            f'nonce="{nonce}"',
            f'uri="{RPC_PATH}"',
            "algorithm=MD5",
            f'response="{response}"',
            "qop=auth",
            f"nc={nonce_count_text}",
            f'cnonce="{cnonce_text}"',
        ]
        if parsed.get("opaque"):
            fields.append(f'opaque="{parsed["opaque"]}"')
        return "Digest " + ", ".join(fields)
    finally:
        wipe_buffer(cnonce, True)


def authenticated_candidate_rpc(
    profile: WalletProfile,
    challenge: str,
    rpc_secret: bytearray,
    request_body: bytes | bytearray,
    nonce_count: int,
) -> bytes:
    authorization = digest_authorization(challenge, rpc_secret, nonce_count)
    status, _, raw = rpc_post(profile.proof_port, request_body, authorization)
    if status != 200:
        refuse("authenticated-rpc-status")
    return raw


def candidate_address(profile: WalletProfile, challenge: str, rpc_secret: bytearray) -> str:
    raw = authenticated_candidate_rpc(
        profile, challenge, rpc_secret, ADDRESS_REQUEST, 1
    )
    return address_from_response(raw, profile)


def rpc_request(method: str, params: dict[str, object]) -> bytearray:
    if method not in {"sign", "verify"}:
        refuse("rpc-method")
    request = bytearray(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "keyfile-recovery-proof",
                "method": method,
                "params": params,
            },
            separators=(",", ":"),
        ).encode("ascii")
    )
    protect_buffer(request)
    return request


def prove_spend_capability(
    profile: WalletProfile,
    challenge: str,
    rpc_secret: bytearray,
    restored_address: str,
) -> None:
    sign_request = rpc_request("sign", {"data": SIGN_MESSAGE})
    try:
        sign_raw = authenticated_candidate_rpc(
            profile, challenge, rpc_secret, sign_request, 2
        )
    finally:
        wipe_buffer(sign_request, True)
    try:
        sign_payload = json.loads(sign_raw.decode("utf-8"))
        signature = sign_payload["result"]["signature"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        refuse("sign-payload")
    if (
        not isinstance(signature, str)
        or not signature.isascii()
        or len(signature) < 16
        or len(signature) > 4096
        or not signature.startswith("Sig")
        or any(character in ('"', "\\", "\r", "\n") for character in signature)
    ):
        refuse("signature-shape")
    verify_request = rpc_request(
        "verify",
        {
            "data": SIGN_MESSAGE,
            "address": restored_address,
            "signature": signature,
        },
    )
    try:
        verify_raw = authenticated_candidate_rpc(
            profile, challenge, rpc_secret, verify_request, 3
        )
    finally:
        wipe_buffer(verify_request, True)
    try:
        verify_result = json.loads(verify_raw.decode("utf-8"))["result"]
        good = verify_result["good"]
        signature_type = verify_result.get("signature_type")
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        refuse("verify-payload")
    if good is not True or signature_type not in (None, "spend"):
        refuse("spend-capability")


def wait_for_digest_challenge(
    profile: WalletProfile, process: subprocess.Popen[bytes]
) -> str:
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if process.poll() is not None:
            refuse("candidate-exited")
        try:
            status, challenge, _ = rpc_post(profile.proof_port, ADDRESS_REQUEST)
            if status != 401:
                refuse("unauthenticated-not-refused")
            parse_digest_challenge(challenge)
            require_exact_listener(
                process.pid, profile.proof_port, "127.0.0.1"
            )
            return challenge or ""
        except Refusal as problem:
            if str(problem) not in {"rpc-transport", "listener-identity"}:
                raise
        time.sleep(0.1)
    refuse("candidate-timeout")


def write_new_file(directory_fd: int, name: str, value: bytearray) -> None:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        view = memoryview(value)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                refuse("secret-write")
            view = view[written:]
        os.fsync(descriptor)
        details = os.fstat(descriptor)
        if (
            details.st_uid != 0
            or details.st_gid != 0
            or details.st_nlink != 1
            or stat.S_IMODE(details.st_mode) != 0o600
        ):
            refuse("secret-file-metadata")
    finally:
        os.close(descriptor)


def prepare_candidate_files(
    profile: WalletProfile, wallet_password: bytearray
) -> bytearray:
    rpc_secret = random_hex(32)
    directory_fd = open_directory_nofollow(profile.candidate_directory)
    password_file = bytearray(wallet_password)
    password_file.extend(b"\n")
    config = bytearray()
    try:
        protect_buffer(password_file)
        write_new_file(directory_fd, "wallet-password", password_file)
        config.extend(
            f"wallet-file={profile.candidate_directory}/wallet\n"
            f"password-file={profile.candidate_directory}/wallet-password\n"
            f"rpc-bind-port={profile.proof_port}\n"
            "rpc-bind-ip=127.0.0.1\n"
            "non-interactive=1\n"
            f"rpc-login={RPC_USER}:".encode("ascii")
        )
        config.extend(rpc_secret)
        config.extend(b"\n")
        if profile.stagenet:
            config.extend(b"stagenet=1\n")
        protect_buffer(config)
        try:
            write_new_file(directory_fd, "wallet-rpc.conf", config)
        finally:
            wipe_buffer(config, True)
        os.fsync(directory_fd)
        return rpc_secret
    except BaseException:
        wipe_buffer(rpc_secret, True)
        raise
    finally:
        wipe_buffer(password_file, True)
        os.close(directory_fd)


def require_binary(profile: WalletProfile) -> tuple[int, ...]:
    parent_fd = open_directory_nofollow(profile.binary.parent)
    try:
        descriptor, expected = open_secure_file_at(
            parent_fd, profile.binary.name, 0, 0, 0o755
        )
        os.close(descriptor)
        return expected
    finally:
        os.close(parent_fd)


def require_candidate_process(
    profile: WalletProfile,
    process: subprocess.Popen[bytes],
    expected_binary: tuple[int, ...],
    expected_uid: int,
    expected_gid: int,
) -> None:
    if process.poll() is not None:
        refuse("candidate-exited")
    if process_uid(process.pid) != expected_uid:
        refuse("candidate-uid")
    if process_gid(process.pid) != expected_gid:
        refuse("candidate-gid")
    if process_groups(process.pid):
        refuse("candidate-groups")
    if process_status_integer(process.pid, "NoNewPrivs") != 1:
        refuse("candidate-no-new-privileges")
    if any(
        process_status_hex(process.pid, field) != 0
        for field in ("CapInh", "CapPrm", "CapEff", "CapAmb")
    ):
        refuse("candidate-capabilities")
    if process_executable(process.pid) != profile.binary:
        refuse("candidate-executable")
    if process_executable_identity(process.pid) != expected_binary:
        refuse("candidate-executable-identity")
    if require_binary(profile) != expected_binary:
        refuse("candidate-binary-race")


def child_hardening(expected_uid: int, expected_gid: int) -> None:
    try:
        if LIBC.prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) != 0:
            os._exit(126)
        os.setgroups([])
        os.setgid(expected_gid)
        os.setuid(expected_uid)
        if (
            os.getresuid() != (expected_uid, expected_uid, expected_uid)
            or os.getresgid() != (expected_gid, expected_gid, expected_gid)
            or os.getgroups()
        ):
            os._exit(126)
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Linux resets dumpability across a credential transition, so set this after setuid.
        if LIBC.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            os._exit(126)
        if LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            os._exit(126)
    except BaseException:
        os._exit(126)


def launch_candidate(
    profile: WalletProfile, expected_uid: int, expected_gid: int
) -> subprocess.Popen[bytes]:
    command = [
        os.fspath(profile.binary),
        "--config-file",
        os.fspath(profile.candidate_directory / "wallet-rpc.conf"),
        "--offline",
        "--log-file",
        "/dev/null",
    ]
    try:
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=profile.candidate_directory,
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": os.fspath(profile.candidate_directory),
                "LANG": "C",
                "LC_ALL": "C",
            },
            close_fds=True,
            start_new_session=True,
            preexec_fn=lambda: child_hardening(expected_uid, expected_gid),
        )
    except OSError:
        refuse("candidate-launch")


def stop_candidate(
    profile: WalletProfile, process: subprocess.Popen[bytes] | None
) -> bool:
    if process is None:
        return not listeners(profile.proof_port)
    clean = True
    if process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            clean = False
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                clean = False
        except OSError:
            clean = False
    if process.returncode not in (0, -signal.SIGTERM):
        clean = False
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and listeners(profile.proof_port):
        time.sleep(0.05)
    return clean and not listeners(profile.proof_port)


def secure_delete_file_at(directory_fd: int, name: str) -> bool:
    try:
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            os.unlink(name, dir_fd=directory_fd)
            return False
        descriptor = os.open(
            name, os.O_RDWR | O_NOFOLLOW | O_CLOEXEC, dir_fd=directory_fd
        )
        try:
            after = os.fstat(descriptor)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                return False
            secure_wipe_fd(descriptor)
        finally:
            os.close(descriptor)
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def secure_clean_directory_fd(directory_fd: int, depth: int = 0) -> bool:
    if depth > 8:
        return False
    clean = True
    try:
        names = os.listdir(directory_fd)
    except OSError:
        return False
    for name in names:
        try:
            details = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISREG(details.st_mode):
                clean = secure_delete_file_at(directory_fd, name) and clean
            elif stat.S_ISDIR(details.st_mode):
                child_fd = os.open(
                    name,
                    os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
                    dir_fd=directory_fd,
                )
                try:
                    clean = secure_clean_directory_fd(child_fd, depth + 1) and clean
                finally:
                    os.close(child_fd)
                os.rmdir(name, dir_fd=directory_fd)
            else:
                os.unlink(name, dir_fd=directory_fd)
                clean = False
        except OSError:
            clean = False
    try:
        os.fsync(directory_fd)
    except OSError:
        clean = False
    return clean


def secure_remove_proof_directory(
    path: pathlib.Path, expected_identity: tuple[int, int]
) -> bool:
    try:
        directory_fd = open_directory_nofollow(path)
    except BaseException:
        return False
    clean = True
    try:
        details = os.fstat(directory_fd)
        if (details.st_dev, details.st_ino) != expected_identity:
            return False
        clean = secure_clean_directory_fd(directory_fd) and clean
    finally:
        os.close(directory_fd)
    try:
        parent_fd = open_directory_nofollow(path.parent)
        try:
            current = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != expected_identity:
                return False
            os.rmdir(path.name, dir_fd=parent_fd)
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except BaseException:
        return False
    return clean


def create_proof_directory(
    profile: WalletProfile, expected_gid: int
) -> tuple[int, int]:
    require_directory(pathlib.Path("/run"), 0, 0, 0o755)
    parent_fd = open_directory_nofollow(profile.proof_directory.parent)
    created_identity: tuple[int, int] | None = None
    proof_fd: int | None = None
    try:
        try:
            os.mkdir(profile.proof_directory.name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            refuse("stale-proof-directory")
        proof_fd = os.open(
            profile.proof_directory.name,
            os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            dir_fd=parent_fd,
        )
        details = os.fstat(proof_fd)
        created_identity = details.st_dev, details.st_ino
        os.fchown(proof_fd, 0, expected_gid)
        os.fchmod(proof_fd, 0o710)
        details = os.fstat(proof_fd)
        if (
            not stat.S_ISDIR(details.st_mode)
            or details.st_uid != 0
            or details.st_gid != expected_gid
            or stat.S_IMODE(details.st_mode) != 0o710
        ):
            refuse("proof-directory-metadata")
        os.mkdir("candidate", 0o700, dir_fd=proof_fd)
        candidate_fd = os.open(
            "candidate",
            os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            dir_fd=proof_fd,
        )
        try:
            os.fchown(candidate_fd, 0, 0)
            os.fchmod(candidate_fd, 0o700)
            candidate_details = os.fstat(candidate_fd)
            if (
                not stat.S_ISDIR(candidate_details.st_mode)
                or candidate_details.st_uid != 0
                or candidate_details.st_gid != 0
                or stat.S_IMODE(candidate_details.st_mode) != 0o700
            ):
                refuse("candidate-directory-metadata")
            os.fsync(candidate_fd)
        finally:
            os.close(candidate_fd)
        os.fsync(proof_fd)
        os.fsync(parent_fd)
        return created_identity
    except BaseException:
        if created_identity is not None:
            try:
                current = os.stat(
                    profile.proof_directory.name,
                    dir_fd=parent_fd,
                    follow_symlinks=False,
                )
                if (current.st_dev, current.st_ino) == created_identity:
                    if proof_fd is not None:
                        try:
                            os.rmdir("candidate", dir_fd=proof_fd)
                        except OSError:
                            pass
                    os.rmdir(profile.proof_directory.name, dir_fd=parent_fd)
                    os.fsync(parent_fd)
            except OSError:
                pass
        raise
    finally:
        if proof_fd is not None:
            os.close(proof_fd)
        os.close(parent_fd)


CANDIDATE_FILES = ("wallet", "wallet.keys", "wallet-password", "wallet-rpc.conf")


def publish_candidate_tree(
    profile: WalletProfile, expected_uid: int, expected_gid: int
) -> None:
    require_directory(profile.proof_directory, 0, expected_gid, 0o710)
    directory_fd = open_directory_nofollow(profile.candidate_directory)
    try:
        directory_details = os.fstat(directory_fd)
        if (
            directory_details.st_uid != 0
            or directory_details.st_gid != 0
            or stat.S_IMODE(directory_details.st_mode) != 0o700
        ):
            refuse("candidate-directory-prepublish")
        if sorted(os.listdir(directory_fd)) != sorted(CANDIDATE_FILES):
            refuse("candidate-files")
        for name in CANDIDATE_FILES:
            descriptor, _ = open_secure_file_at(directory_fd, name, 0, 0, 0o600)
            try:
                os.fchown(descriptor, expected_uid, expected_gid)
                details = os.fstat(descriptor)
                if (
                    details.st_uid != expected_uid
                    or details.st_gid != expected_gid
                    or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) != 0o600
                ):
                    refuse("candidate-file-publish")
            finally:
                os.close(descriptor)
        os.fchown(directory_fd, expected_uid, expected_gid)
        os.fchmod(directory_fd, 0o700)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def require_published_candidate_tree(
    profile: WalletProfile, expected_uid: int, expected_gid: int
) -> None:
    require_directory(profile.proof_directory, 0, expected_gid, 0o710)
    require_directory(
        profile.candidate_directory, expected_uid, expected_gid, 0o700
    )
    directory_fd = open_directory_nofollow(profile.candidate_directory)
    try:
        if sorted(os.listdir(directory_fd)) != sorted(CANDIDATE_FILES):
            refuse("candidate-files-race")
        for name in CANDIDATE_FILES:
            descriptor, _ = open_secure_file_at(
                directory_fd, name, expected_uid, expected_gid, 0o600
            )
            os.close(descriptor)
    finally:
        os.close(directory_fd)


def remove_loaded_secret_files(profile: WalletProfile) -> bool:
    directory_fd = open_directory_nofollow(profile.candidate_directory)
    try:
        password_removed = secure_delete_file_at(directory_fd, "wallet-password")
        config_removed = secure_delete_file_at(directory_fd, "wallet-rpc.conf")
        return password_removed and config_removed
    finally:
        os.close(directory_fd)


def run_proof(profile: WalletProfile) -> None:
    if os.getuid() != 0 or os.geteuid() != 0:
        refuse("root-only")
    expected_uid, expected_gid = identity(profile.user, profile.group)
    if expected_uid <= 0 or expected_gid <= 0:
        refuse("non-root-candidate-identity")
    require_unused_port(profile.proof_port)
    expected_binary = require_binary(profile)
    live = require_live_process(profile, expected_binary)

    candidate: subprocess.Popen[bytes] | None = None
    wallet_password: bytearray | None = None
    rpc_secret: bytearray | None = None
    proof_identity: tuple[int, int] | None = None
    failed = False
    cleanup_ok = True
    try:
        wallet_password = read_live_cmdline_password(live.pid, profile)
        require_live_unchanged(profile, live)
        live_address = current_live_address(profile)
        require_live_unchanged(profile, live)
        blocked_signals = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT}
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked_signals)
        try:
            proof_identity = create_proof_directory(profile, expected_gid)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        require_directory(
            pathlib.Path("/var/backups/wowngeon"),
            0,
            grp.getgrnam("postgres").gr_gid,
            0o710,
        )
        require_directory(SNAPSHOT_DIRECTORY, 0, 0, 0o700)
        copy_snapshot_pair(
            SNAPSHOT_DIRECTORY,
            profile.snapshot_wallet.name,
            profile.snapshot_keys.name,
            profile.candidate_directory,
            0,
            0,
        )
        rpc_secret = prepare_candidate_files(profile, wallet_password)
        wipe_buffer(wallet_password, True)
        wallet_password = None
        publish_candidate_tree(profile, expected_uid, expected_gid)
        require_published_candidate_tree(profile, expected_uid, expected_gid)
        candidate = launch_candidate(profile, expected_uid, expected_gid)
        require_candidate_process(
            profile, candidate, expected_binary, expected_uid, expected_gid
        )
        challenge = wait_for_digest_challenge(profile, candidate)
        require_candidate_process(
            profile, candidate, expected_binary, expected_uid, expected_gid
        )
        if not remove_loaded_secret_files(profile):
            refuse("loaded-secret-cleanup")
        restored_address = candidate_address(profile, challenge, rpc_secret)
        if not hmac.compare_digest(live_address, restored_address):
            refuse("address-mismatch")
        prove_spend_capability(
            profile, challenge, rpc_secret, restored_address
        )
        wipe_buffer(rpc_secret, True)
        rpc_secret = None
        require_live_unchanged(profile, live)
        require_candidate_process(
            profile, candidate, expected_binary, expected_uid, expected_gid
        )
        require_exact_listener(candidate.pid, profile.proof_port, "127.0.0.1")
    except BaseException:
        failed = True
    finally:
        cleanup_signals = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT}
        cleanup_mask: set[signal.Signals] | None = None
        try:
            try:
                cleanup_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cleanup_signals)
            except BaseException:
                cleanup_ok = False
            try:
                wipe_buffer(wallet_password, wallet_password is not None)
                wipe_buffer(rpc_secret, rpc_secret is not None)
            except BaseException:
                cleanup_ok = False
            try:
                cleanup_ok = stop_candidate(profile, candidate) and cleanup_ok
            except BaseException:
                cleanup_ok = False
            if proof_identity is not None:
                try:
                    cleanup_ok = (
                        secure_remove_proof_directory(
                            profile.proof_directory, proof_identity
                        )
                        and cleanup_ok
                    )
                except BaseException:
                    cleanup_ok = False
        finally:
            if cleanup_mask is not None:
                signal.pthread_sigmask(signal.SIG_SETMASK, cleanup_mask)
    if failed or not cleanup_ok:
        refuse("proof-failed")


def interrupted(_signum: int, _frame: object) -> None:
    refuse("interrupted")


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    harden_process()
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
        signal.signal(signum, interrupted)
    if len(arguments) != 1 or arguments[0] not in PROFILES:
        refuse("arguments")
    run_proof(PROFILES[arguments[0]])
    return 0


def emit_status(passed: bool) -> None:
    try:
        os.write(1, b"result=passed\n" if passed else b"result=refused\n")
    except OSError:
        pass


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except BaseException:
        # Never render exception text, a traceback, argv, an address, or secret material.
        exit_code = 1
    emit_status(exit_code == 0)
    raise SystemExit(exit_code)
