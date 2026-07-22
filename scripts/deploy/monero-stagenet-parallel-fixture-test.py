#!/usr/bin/env python3
"""Disposable fixture proof for the parallel-wallet filesystem contract.

This test uses only synthetic bytes below a fresh TemporaryDirectory.  It never imports or invokes
the host preflight, systemd, a wallet binary, a wallet file, or a credential.  Run directly with:

    python3 scripts/deploy/monero-stagenet-parallel-fixture-test.py
"""

from __future__ import annotations

import ctypes
import errno
import os
import pathlib
import secrets
import stat
import tempfile
import unittest
from collections.abc import Callable


O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
RENAME_NOREPLACE = 1
LIBC = ctypes.CDLL(None, use_errno=True)


class Refusal(RuntimeError):
    pass


def rename_noreplace(source_fd: int, source: str, destination_fd: int, destination: str) -> None:
    result = LIBC.renameat2(
        ctypes.c_int(source_fd),
        ctypes.c_char_p(os.fsencode(source)),
        ctypes.c_int(destination_fd),
        ctypes.c_char_p(os.fsencode(destination)),
        ctypes.c_uint(RENAME_NOREPLACE),
    )
    if result != 0:
        problem = ctypes.get_errno()
        raise OSError(problem, os.strerror(problem), destination)


def open_directory_nofollow(path: pathlib.Path) -> int:
    if not path.is_absolute() or pathlib.Path(os.path.normpath(path)) != path:
        raise Refusal("path is not absolute and normalized")
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
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


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


def open_source(directory_fd: int, name: str) -> tuple[int, tuple[int, ...]]:
    descriptor = os.open(name, os.O_RDONLY | O_NOFOLLOW, dir_fd=directory_fd)
    details = os.fstat(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        os.close(descriptor)
        raise Refusal("source is not a single-linked regular file")
    if stat.S_IMODE(details.st_mode) != 0o600:
        os.close(descriptor)
        raise Refusal("source mode differs from the contract")
    return descriptor, file_identity(details)


def copy_one(
    source_fd: int,
    expected: tuple[int, ...],
    destination_fd: int,
    name: str,
    after_copy: Callable[[], None] | None = None,
) -> None:
    temporary = f".{name}.pending.{secrets.token_hex(8)}"
    output = os.open(
        temporary,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | O_NOFOLLOW,
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
                    raise OSError("short synthetic copy write")
                view = view[written:]
        os.fsync(output)
        if after_copy is not None:
            after_copy()
        if file_identity(os.fstat(source_fd)) != expected:
            raise Refusal("source metadata changed during copy")
        os.lseek(source_fd, 0, os.SEEK_SET)
        os.lseek(output, 0, os.SEEK_SET)
        while True:
            source_block = os.read(source_fd, 1024 * 1024)
            output_block = os.read(output, 1024 * 1024)
            if source_block != output_block:
                raise Refusal("copy differs from retained source")
            if not source_block:
                break
        os.close(output)
        output = -1
        rename_noreplace(destination_fd, temporary, destination_fd, name)
        published = True
        os.fsync(destination_fd)
    finally:
        if output >= 0:
            os.close(output)
        if not published:
            try:
                os.unlink(temporary, dir_fd=destination_fd)
            except FileNotFoundError:
                pass


def copy_pair(source: pathlib.Path, wallet_destination: pathlib.Path) -> None:
    source_fd = open_directory_nofollow(source)
    destination_fd = open_directory_nofollow(wallet_destination)
    try:
        opened: list[tuple[int, tuple[int, ...], str]] = []
        try:
            for source_name, destination_name in (
                ("test", "stagenet"),
                ("test.keys", "stagenet.keys"),
            ):
                descriptor, expected = open_source(source_fd, source_name)
                opened.append((descriptor, expected, destination_name))
            for descriptor, expected, destination_name in opened:
                copy_one(descriptor, expected, destination_fd, destination_name)
        finally:
            for descriptor, _, _ in opened:
                os.close(descriptor)
    finally:
        os.close(source_fd)
        os.close(destination_fd)


def require_ready(stage: pathlib.Path) -> None:
    descriptor = open_directory_nofollow(stage)
    try:
        marker = os.open("READY", os.O_RDONLY | O_NOFOLLOW, dir_fd=descriptor)
        try:
            details = os.fstat(marker)
            if (
                not stat.S_ISREG(details.st_mode)
                or details.st_nlink != 1
                or stat.S_IMODE(details.st_mode) != 0o600
            ):
                raise Refusal("readiness marker metadata is invalid")
        finally:
            os.close(marker)
    except FileNotFoundError:
        raise Refusal("readiness marker is absent")
    finally:
        os.close(descriptor)


def publish(stage: pathlib.Path, final: pathlib.Path) -> None:
    require_ready(stage)
    if stage.parent != final.parent:
        raise Refusal("publication must be one same-filesystem directory rename")
    parent = open_directory_nofollow(stage.parent)
    try:
        rename_noreplace(parent, stage.name, parent, final.name)
        os.fsync(parent)
    finally:
        os.close(parent)


class BundleFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="monero-parallel-fixture-")
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / "legacy"
        self.stage = self.root / ".candidate.staging"
        self.final = self.root / "candidate"
        self.source.mkdir(mode=0o700)
        self.stage.mkdir(mode=0o700)
        (self.stage / "wallet").mkdir(mode=0o700)
        for name, content in (("test", b"synthetic-wallet\0bytes"), ("test.keys", b"synthetic-key\0bytes")):
            path = self.source / name
            path.write_bytes(content)
            path.chmod(0o600)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def ready(self) -> None:
        marker = self.stage / "READY"
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | O_NOFOLLOW, 0o600)
        try:
            os.write(descriptor, b"network=stagenet\nrpc_bind=127.0.0.1:38084\n")
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        stage_fd = open_directory_nofollow(self.stage)
        try:
            os.fsync(stage_fd)
        finally:
            os.close(stage_fd)

    def test_partial_stage_is_not_a_candidate(self) -> None:
        copy_pair(self.source, self.stage / "wallet")
        with self.assertRaises(Refusal):
            publish(self.stage, self.final)
        self.assertFalse(self.final.exists())
        self.assertTrue(self.stage.exists())

    def test_ready_bundle_is_one_atomic_nonreplacing_publish(self) -> None:
        copy_pair(self.source, self.stage / "wallet")
        self.ready()
        publish(self.stage, self.final)
        self.assertFalse(self.stage.exists())
        self.assertEqual((self.final / "wallet" / "stagenet").read_bytes(), b"synthetic-wallet\0bytes")
        self.assertEqual((self.final / "wallet" / "stagenet.keys").read_bytes(), b"synthetic-key\0bytes")

    def test_existing_final_is_never_replaced(self) -> None:
        self.ready()
        self.final.mkdir(mode=0o700)
        sentinel = self.final / "sentinel"
        sentinel.write_text("older generation", encoding="ascii")
        with self.assertRaises(OSError) as problem:
            publish(self.stage, self.final)
        self.assertEqual(problem.exception.errno, errno.EEXIST)
        self.assertEqual(sentinel.read_text(encoding="ascii"), "older generation")
        self.assertTrue(self.stage.exists())

    def test_symlink_component_is_refused(self) -> None:
        linked = self.root / "linked-source"
        linked.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(OSError):
            copy_pair(linked, self.stage / "wallet")

    def test_hard_linked_key_is_refused(self) -> None:
        os.link(self.source / "test.keys", self.root / "second-link")
        with self.assertRaises(Refusal):
            copy_pair(self.source, self.stage / "wallet")
        self.assertFalse((self.stage / "wallet" / "stagenet.keys").exists())

    def test_source_change_is_detected_before_publication(self) -> None:
        source_fd = open_directory_nofollow(self.source)
        destination_fd = open_directory_nofollow(self.stage / "wallet")
        descriptor, expected = open_source(source_fd, "test")
        try:
            def mutate() -> None:
                with open(self.source / "test", "ab") as output:
                    output.write(b"changed")

            with self.assertRaises(Refusal):
                copy_one(descriptor, expected, destination_fd, "stagenet", mutate)
            self.assertFalse((self.stage / "wallet" / "stagenet").exists())
        finally:
            os.close(descriptor)
            os.close(source_fd)
            os.close(destination_fd)

    def test_marker_contains_no_synthetic_secret(self) -> None:
        self.ready()
        self.assertNotIn(b"synthetic-key", (self.stage / "READY").read_bytes())
        self.assertNotIn(b"synthetic-wallet", (self.stage / "READY").read_bytes())

    def test_linked_readiness_marker_is_refused(self) -> None:
        external = self.root / "external-marker"
        external.write_text("network=stagenet\n", encoding="ascii")
        external.chmod(0o600)
        os.link(external, self.stage / "READY")
        with self.assertRaises(Refusal):
            publish(self.stage, self.final)
        self.assertFalse(self.final.exists())


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main(verbosity=2)
