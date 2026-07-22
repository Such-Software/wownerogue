#!/usr/bin/env python3
"""Read-only preflight for a parallel Monero stagenet wallet-RPC candidate.

This script does not read systemd unit text, process arguments, wallet bytes, keys, passwords, or
mnemonics.  It does not create, modify, move, or delete anything.  It validates only public RPC
identity, process/listener identity, path metadata, capacity, and inert candidate prerequisites.
"""

from __future__ import annotations

import argparse
import ctypes
import grp
import http.client
import json
import os
import pathlib
import pwd
import resource
import socket
import stat
import subprocess
import sys
import urllib.error
import urllib.request


LEGACY_UNIT = "monero-wallet-rpc.service"
LEGACY_USER = "jw"
LEGACY_GROUP = "jw"
LEGACY_BINARY = pathlib.Path("/usr/bin/monero-wallet-rpc")
LEGACY_DIR = pathlib.Path("/home/jw/Programs/monero-x86_64-linux-gnu-v0.18.4.4")
LEGACY_WALLET = LEGACY_DIR / "test"
LEGACY_KEYS = LEGACY_DIR / "test.keys"
LEGACY_RPC_PORT = 38083
LEGACY_RPC_URL = "http://127.0.0.1:38083/json_rpc"

CANDIDATE_UNIT = "monerogue-stagenet-wallet-candidate.service"
CANDIDATE_USER = "monerogue-wallet-candidate"
CANDIDATE_GROUP = "monerogue-wallet-candidate"
CANDIDATE_HOME = pathlib.Path("/var/lib/monerogue-stagenet-wallet-candidate")
CANDIDATE_STAGE = pathlib.Path("/var/lib/.monerogue-stagenet-wallet-candidate.staging")
CANDIDATE_BINARY = pathlib.Path("/usr/bin/monero-wallet-rpc")
CANDIDATE_RPC_PORT = 38084
VERIFY_RPC_PORT = 39084

ADDRESS_REQUEST = {
    "jsonrpc": "2.0",
    "id": "parallel-preflight",
    "method": "get_address",
    "params": {"account_index": 0},
}
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
LIBC = ctypes.CDLL(None, use_errno=True)


class Refusal(RuntimeError):
    pass


def refuse(message: str) -> None:
    raise Refusal(message)


def harden_process() -> None:
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        if LIBC.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
            refuse("could not disable process dumps")
    except AttributeError:
        refuse("could not disable process dumps")


def identity(user: str, group: str) -> tuple[int, int]:
    try:
        return pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid
    except KeyError:
        refuse(f"required identity is missing: {user}:{group}")


def open_directory_nofollow(path: pathlib.Path) -> int:
    if not path.is_absolute() or pathlib.Path(os.path.normpath(path)) != path:
        refuse("path is not absolute and normalized")
    descriptor = os.open("/", os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try:
        for component in path.parts[1:]:
            following = os.open(
                component,
                os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = following
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            refuse("opened path is not a directory")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def require_directory(path: pathlib.Path, user: str, group: str, mode: int) -> os.stat_result:
    try:
        descriptor = open_directory_nofollow(path)
    except (FileNotFoundError, NotADirectoryError, OSError):
        refuse(f"required real directory is unavailable: {path}")
    try:
        details = os.fstat(descriptor)
        expected = (*identity(user, group), mode)
        actual = (details.st_uid, details.st_gid, stat.S_IMODE(details.st_mode))
        if actual != expected:
            refuse(f"directory metadata mismatch: {path}")
        return details
    finally:
        os.close(descriptor)


def require_regular(path: pathlib.Path, user: str, group: str, mode: int) -> os.stat_result:
    parent = open_directory_nofollow(path.parent)
    try:
        try:
            descriptor = os.open(path.name, os.O_RDONLY | O_NOFOLLOW, dir_fd=parent)
        except OSError:
            refuse(f"required real file is unavailable: {path}")
        try:
            details = os.fstat(descriptor)
            expected = (*identity(user, group), mode)
            actual = (details.st_uid, details.st_gid, stat.S_IMODE(details.st_mode))
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or actual != expected:
                refuse(f"file metadata mismatch or hard link refused: {path}")
            if details.st_size <= 0:
                refuse(f"required file is empty: {path}")
            return details
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def systemctl(*arguments: str) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["/usr/bin/systemctl", *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        refuse("systemd state check failed")


def main_pid(unit: str) -> int:
    result = systemctl("show", unit, "--property=MainPID", "--value")
    if result.returncode != 0:
        refuse("systemd MainPID check failed")
    try:
        return int(result.stdout.strip())
    except ValueError:
        refuse("systemd returned an invalid MainPID")


def process_uid(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:
            for line in source:
                if line.startswith("Uid:"):
                    values = line.split()[1:]
                    if len(values) == 4 and len(set(values)) == 1:
                        return int(values[0])
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    refuse("legacy process UID is unavailable")


def process_start_time(pid: int) -> str:
    try:
        raw = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        fields = raw[raw.rfind(")") + 2 :].split()
        return fields[19]
    except (OSError, UnicodeDecodeError, IndexError):
        refuse("legacy process start time is unavailable")


def process_has_unit_cgroup(pid: int, unit: str) -> bool:
    try:
        lines = pathlib.Path(f"/proc/{pid}/cgroup").read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeDecodeError):
        refuse("legacy process cgroup is unavailable")
    return any(line.rsplit(":", 1)[-1].endswith(f"/{unit}") for line in lines)


def parse_listener_table(path: str, port: int, ipv6: bool) -> list[tuple[str, int]]:
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
                    address = socket.inet_ntop(socket.AF_INET6, bytes.fromhex(address_hex))
                else:
                    address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
                found.append((address, int(fields[9])))
    except (OSError, UnicodeDecodeError, ValueError, IndexError):
        refuse("kernel listener state is unavailable")
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
        refuse("legacy process descriptors are unavailable")
    return False


def require_exact_listener(pid: int, port: int) -> None:
    active = listeners(port)
    if len(active) != 1 or active[0][0] != "127.0.0.1":
        refuse(f"port {port} is not one exact IPv4 loopback listener")
    if not process_owns_socket(pid, active[0][1]):
        refuse(f"port {port} is not owned by the expected process")


def require_unused_port(port: int) -> None:
    if listeners(port):
        refuse(f"candidate port {port} is already in use")


def validate_public_address() -> None:
    body = json.dumps(ADDRESS_REQUEST, separators=(",", ":")).encode("ascii")
    request = urllib.request.Request(
        LEGACY_RPC_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        # Never honor ambient proxy settings for a loopback identity check.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=5) as response:
            if response.status != 200:
                refuse("legacy wallet RPC returned an unexpected status")
            raw = response.read(1024 * 1024 + 1)
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        refuse("legacy wallet RPC public address check failed")
    if len(raw) > 1024 * 1024:
        refuse("legacy wallet RPC response is oversized")
    try:
        payload = json.loads(raw.decode("utf-8"))
        address = payload["result"]["address"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
        refuse("legacy wallet RPC returned an invalid public address response")
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    if (
        not isinstance(address, str)
        or len(address) != 95
        or not address.startswith("5")
        or any(character not in alphabet for character in address)
    ):
        refuse("legacy wallet RPC address is not a primary stagenet address")


def validate_legacy() -> tuple[os.stat_result, os.stat_result]:
    if os.geteuid() != 0:
        refuse("run as root so process ownership checks cannot be hidden")
    if systemctl("is-active", "--quiet", LEGACY_UNIT).returncode != 0:
        refuse("legacy wallet service must be active")
    pid = main_pid(LEGACY_UNIT)
    if pid <= 1:
        refuse("legacy wallet service has no stable MainPID")
    started = process_start_time(pid)
    expected_uid, _ = identity(LEGACY_USER, LEGACY_GROUP)
    if process_uid(pid) != expected_uid:
        refuse("legacy wallet process UID is unexpected")
    try:
        executable = pathlib.Path(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        refuse("legacy wallet process executable is unavailable")
    if executable != LEGACY_BINARY:
        refuse("legacy wallet process executable is unexpected")
    if not process_has_unit_cgroup(pid, LEGACY_UNIT):
        refuse("legacy wallet process cgroup is unexpected")
    require_exact_listener(pid, LEGACY_RPC_PORT)
    require_directory(LEGACY_DIR, LEGACY_USER, LEGACY_GROUP, 0o775)
    wallet = require_regular(LEGACY_WALLET, LEGACY_USER, LEGACY_GROUP, 0o600)
    keys = require_regular(LEGACY_KEYS, LEGACY_USER, LEGACY_GROUP, 0o600)
    validate_public_address()
    if main_pid(LEGACY_UNIT) != pid or process_start_time(pid) != started:
        refuse("legacy wallet process changed during preflight")
    require_exact_listener(pid, LEGACY_RPC_PORT)
    return wallet, keys


def validate_candidate_prerequisites(wallet: os.stat_result, keys: os.stat_result) -> None:
    try:
        record = pwd.getpwnam(CANDIDATE_USER)
        group = grp.getgrnam(CANDIDATE_GROUP)
    except KeyError:
        refuse("parallel candidate service identity is not provisioned")
    if (
        record.pw_uid >= 1000
        or record.pw_gid != group.gr_gid
        or os.getgrouplist(CANDIDATE_USER, record.pw_gid) != [record.pw_gid]
        or record.pw_dir != os.fspath(CANDIDATE_HOME)
        or record.pw_shell not in ("/usr/sbin/nologin", "/bin/false")
    ):
        refuse("parallel candidate identity is not a dedicated system account")
    require_regular(CANDIDATE_BINARY, "root", "root", 0o755)
    require_directory(CANDIDATE_HOME.parent, "root", "root", 0o755)
    if os.path.lexists(CANDIDATE_STAGE) or os.path.lexists(CANDIDATE_HOME):
        refuse("candidate staging/final path already exists; do not overwrite it")
    if systemctl("is-active", "--quiet", CANDIDATE_UNIT).returncode == 0:
        refuse("candidate unit must be inactive")
    require_unused_port(CANDIDATE_RPC_PORT)
    require_unused_port(VERIFY_RPC_PORT)
    capacity = os.statvfs(CANDIDATE_HOME.parent)
    available = capacity.f_bavail * capacity.f_frsize
    required = wallet.st_size + keys.st_size + 64 * 1024 * 1024
    if available < required:
        refuse("insufficient space for a non-replacing candidate wallet copy")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only Monero stagenet parallel preflight")
    parser.add_argument(
        "scope",
        choices=("legacy", "candidate-prereqs"),
        help="legacy checks the current RPC; candidate-prereqs also checks inert new-path gates",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    options = parse_args(sys.argv[1:] if argv is None else argv)
    harden_process()
    wallet, keys = validate_legacy()
    if options.scope == "candidate-prereqs":
        validate_candidate_prerequisites(wallet, keys)
    print(f"PASSED: read-only {options.scope} preflight")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refusal as problem:
        print(f"REFUSED: {problem}", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # Do not render process or RPC data in an unexpected exception.
        print("REFUSED: unexpected read-only preflight failure", file=sys.stderr)
        raise SystemExit(1)
