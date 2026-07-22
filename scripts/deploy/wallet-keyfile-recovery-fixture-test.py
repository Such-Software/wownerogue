#!/usr/bin/env python3
"""Synthetic-only tests for the fixed wallet keyfile recovery proof primitives."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("wallet-keyfile-recovery-proof.py")
SPEC = importlib.util.spec_from_file_location("wallet_keyfile_recovery_proof", SCRIPT)
if SPEC is None or SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("fixture import unavailable")
proof = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = proof
SPEC.loader.exec_module(proof)


def synthetic_profile(stagenet: bool = True):
    return proof.WalletProfile(
        name="synthetic",
        unit="synthetic.service",
        user="synthetic",
        group="synthetic",
        binary=pathlib.Path("/fixed/bin/wallet-rpc"),
        live_wallet=pathlib.Path("/fixed/live/wallet"),
        live_rpc_port=38083,
        live_bind_address="127.0.0.1",
        snapshot_wallet=pathlib.Path("/fixed/snapshot.wallet"),
        snapshot_keys=pathlib.Path("/fixed/snapshot.keys"),
        proof_port=39084,
        stagenet=stagenet,
        address_kind="xmr-stagenet" if stagenet else "wow-mainnet",
        proof_directory=pathlib.Path("/fixed/proof"),
    )


def cmdline(profile, *, wallet=None, passwords=(b"synthetic-wallet-password",), extra=()):
    arguments = [os.fsencode(profile.binary)]
    if profile.stagenet:
        arguments.append(b"--stagenet")
    arguments.extend((b"--wallet-file", os.fsencode(wallet or profile.live_wallet)))
    for password in passwords:
        arguments.extend((b"--password", password))
    arguments.extend((b"--rpc-bind-port", str(profile.live_rpc_port).encode("ascii")))
    arguments.extend(extra)
    raw = bytearray(b"\0".join(arguments) + b"\0")
    return raw, len(raw)


class CmdlineContractFixture(unittest.TestCase):
    def test_exact_fixed_argv_extracts_only_the_inline_password_and_wipes_input(self):
        profile = synthetic_profile()
        raw, length = cmdline(profile)
        secret = proof.extract_inline_wallet_password(raw, length, profile)
        try:
            self.assertEqual(secret, b"synthetic-wallet-password")
            self.assertFalse(any(raw))
        finally:
            proof.wipe_buffer(secret)

    def test_wrong_wallet_path_is_refused_and_input_is_wiped(self):
        profile = synthetic_profile()
        raw, length = cmdline(profile, wallet=pathlib.Path("/wrong/wallet"))
        with self.assertRaises(proof.Refusal):
            proof.extract_inline_wallet_password(raw, length, profile)
        self.assertFalse(any(raw))

    def test_duplicate_password_is_refused(self):
        profile = synthetic_profile()
        raw, length = cmdline(profile, passwords=(b"one", b"two"))
        with self.assertRaises(proof.Refusal):
            proof.extract_inline_wallet_password(raw, length, profile)
        self.assertFalse(any(raw))

    def test_password_file_or_wrong_network_is_refused(self):
        profile = synthetic_profile()
        for indirect in (
            (b"--password-file", b"/not-accepted"),
            (b"--password-file=/not-accepted",),
            (b"--wallet-dir=/not-accepted",),
        ):
            raw, length = cmdline(profile, extra=indirect)
            with self.assertRaises(proof.Refusal):
                proof.extract_inline_wallet_password(raw, length, profile)
            self.assertFalse(any(raw))

        mainnet = synthetic_profile(stagenet=False)
        for wrong_network in ((b"--stagenet",), (b"--stagenet=1",), (b"--testnet=1",)):
            raw, length = cmdline(mainnet, extra=wrong_network)
            with self.assertRaises(proof.Refusal):
                proof.extract_inline_wallet_password(raw, length, mainnet)
            self.assertFalse(any(raw))


class SnapshotCopyFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wallet-recovery-fixture-")
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / "source"
        self.destination = self.root / "destination"
        self.source.mkdir(mode=0o700)
        self.destination.mkdir(mode=0o700)
        self.wallet = self.source / "snapshot.wallet"
        self.keys = self.source / "snapshot.keys"
        self.wallet.write_bytes(b"synthetic encrypted wallet cache\0bytes")
        self.keys.write_bytes(b"synthetic encrypted keyfile\0bytes")
        self.wallet.chmod(0o600)
        self.keys.chmod(0o600)

    def tearDown(self):
        self.temporary.cleanup()

    def copy(self, after_first_copy=None):
        proof.copy_snapshot_pair(
            self.source,
            self.wallet.name,
            self.keys.name,
            self.destination,
            os.getuid(),
            os.getgid(),
            after_first_copy,
        )

    def test_copy_is_byte_equal_private_and_source_is_unchanged(self):
        wallet_before = self.wallet.read_bytes()
        keys_before = self.keys.read_bytes()
        self.copy()
        self.assertEqual((self.destination / "wallet").read_bytes(), wallet_before)
        self.assertEqual((self.destination / "wallet.keys").read_bytes(), keys_before)
        self.assertEqual(self.wallet.read_bytes(), wallet_before)
        self.assertEqual(self.keys.read_bytes(), keys_before)
        self.assertEqual((self.destination / "wallet").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.destination / "wallet.keys").stat().st_mode & 0o777, 0o600)

    def test_hard_linked_source_is_refused(self):
        os.link(self.keys, self.root / "second-key-link")
        with self.assertRaises(proof.Refusal):
            self.copy()
        self.assertFalse((self.destination / "wallet").exists())

    def test_symlink_source_component_is_refused(self):
        linked = self.root / "linked-source"
        linked.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises((OSError, proof.Refusal)):
            proof.copy_snapshot_pair(
                linked,
                self.wallet.name,
                self.keys.name,
                self.destination,
                os.getuid(),
                os.getgid(),
            )

    def test_source_change_during_copy_is_refused_and_partial_copy_removed(self):
        def mutate():
            with self.wallet.open("ab") as output:
                output.write(b"changed")

        with self.assertRaises(proof.Refusal):
            self.copy(mutate)
        self.assertFalse((self.destination / "wallet").exists())
        self.assertFalse((self.destination / "wallet.keys").exists())


class CleanupAndProtocolFixture(unittest.TestCase):
    def test_protection_failure_wipes_the_synthetic_secret(self):
        value = bytearray(b"synthetic-secret")
        with mock.patch.object(proof.LIBC, "mlock", return_value=-1):
            with self.assertRaises(proof.Refusal):
                proof.protect_buffer(value)
        self.assertFalse(any(value))

    def test_cleanup_never_follows_a_link_outside_its_exact_directory(self):
        with tempfile.TemporaryDirectory(prefix="wallet-cleanup-fixture-") as temporary:
            root = pathlib.Path(temporary)
            proof_dir = root / "proof"
            proof_dir.mkdir(mode=0o700)
            secret = proof_dir / "wallet-password"
            secret.write_bytes(b"synthetic secret")
            secret.chmod(0o600)
            external = root / "external"
            external.write_bytes(b"must survive")
            (proof_dir / "linked").symlink_to(external)
            details = proof_dir.stat()

            self.assertFalse(
                proof.secure_remove_proof_directory(
                    proof_dir, (details.st_dev, details.st_ino)
                )
            )
            self.assertFalse(proof_dir.exists())
            self.assertEqual(external.read_bytes(), b"must survive")

    def test_cleanup_never_overwrites_an_external_hard_link(self):
        with tempfile.TemporaryDirectory(prefix="wallet-hardlink-fixture-") as temporary:
            root = pathlib.Path(temporary)
            proof_dir = root / "proof"
            proof_dir.mkdir(mode=0o700)
            external = root / "external"
            external.write_bytes(b"must survive")
            os.link(external, proof_dir / "linked")
            details = proof_dir.stat()

            self.assertFalse(
                proof.secure_remove_proof_directory(
                    proof_dir, (details.st_dev, details.st_ino)
                )
            )
            self.assertFalse(proof_dir.exists())
            self.assertEqual(external.read_bytes(), b"must survive")

    def test_fixed_address_shapes_reject_cross_network_values(self):
        xmr = synthetic_profile()
        wow = synthetic_profile(stagenet=False)
        xmr_address = "5" + "1" * 94
        wow_address = "Wo" + "1" * 95
        self.assertTrue(proof.network_shaped_address(xmr_address, xmr))
        self.assertTrue(proof.network_shaped_address(wow_address, wow))
        self.assertFalse(proof.network_shaped_address(wow_address, xmr))
        self.assertFalse(proof.network_shaped_address(xmr_address, wow))

    def test_digest_header_does_not_embed_the_ephemeral_rpc_password(self):
        challenge = 'Digest realm="wallet-rpc", nonce="abcdef", qop="auth", algorithm=MD5'
        rpc_secret = bytearray(b"a" * 64)
        authorization = proof.digest_authorization(challenge, rpc_secret)
        self.assertTrue(authorization.startswith("Digest "))
        self.assertNotIn(rpc_secret.decode("ascii"), authorization)

    def test_digest_requires_auth_qop_but_accepts_a_spaced_offer(self):
        parsed = proof.parse_digest_challenge(
            'Digest realm="wallet-rpc", nonce="abcdef", qop="auth-int, auth"'
        )
        self.assertEqual(parsed["nonce"], "abcdef")
        with self.assertRaises(proof.Refusal):
            proof.parse_digest_challenge(
                'Digest realm="wallet-rpc", nonce="abcdef", qop="auth-int"'
            )

    def test_candidate_files_use_password_file_loopback_offline_contract(self):
        with tempfile.TemporaryDirectory(prefix="wallet-config-fixture-") as temporary:
            profile = dataclasses.replace(
                synthetic_profile(), proof_directory=pathlib.Path(temporary)
            )
            profile.candidate_directory.mkdir(mode=0o700)
            written = {}

            def capture(_directory_fd, name, value):
                written[name] = bytes(value)

            with mock.patch.object(proof, "write_new_file", side_effect=capture):
                rpc_secret = proof.prepare_candidate_files(
                    profile, bytearray(b"synthetic-wallet-password")
                )
            try:
                config = written["wallet-rpc.conf"]
                self.assertEqual(
                    written["wallet-password"], b"synthetic-wallet-password\n"
                )
                self.assertIn(
                    b"wallet-file="
                    + os.fsencode(profile.candidate_directory / "wallet")
                    + b"\n",
                    config,
                )
                self.assertIn(
                    b"password-file="
                    + os.fsencode(profile.candidate_directory / "wallet-password")
                    + b"\n",
                    config,
                )
                self.assertIn(b"rpc-bind-ip=127.0.0.1\n", config)
                self.assertIn(b"rpc-bind-port=39084\n", config)
                self.assertIn(b"non-interactive=1\n", config)
                self.assertIn(b"rpc-login=recovery-proof:" + bytes(rpc_secret), config)
                self.assertIn(b"stagenet=1\n", config)
                self.assertNotIn(b"daemon-address", config)
            finally:
                proof.wipe_buffer(rpc_secret, True)

    def test_fixed_message_signature_must_verify_as_spend_capability(self):
        profile = synthetic_profile()
        requests = []
        signature = "SigV1" + "1" * 80

        def answer(_profile, _challenge, _rpc_secret, request_body, nonce_count):
            request = json.loads(bytes(request_body).decode("ascii"))
            requests.append((request, nonce_count))
            if request["method"] == "sign":
                return json.dumps({"result": {"signature": signature}}).encode()
            return json.dumps(
                {"result": {"good": True, "signature_type": "spend"}}
            ).encode()

        with mock.patch.object(proof, "authenticated_candidate_rpc", side_effect=answer):
            proof.prove_spend_capability(
                profile,
                'Digest realm="wallet-rpc", nonce="abcdef", qop="auth"',
                bytearray(b"synthetic-rpc-secret"),
                "5" + "1" * 94,
            )

        self.assertEqual([request["method"] for request, _ in requests], ["sign", "verify"])
        self.assertEqual([nonce_count for _, nonce_count in requests], [2, 3])
        self.assertEqual(requests[0][0]["params"], {"data": proof.SIGN_MESSAGE})
        self.assertEqual(requests[1][0]["params"]["signature"], signature)

    def test_missing_spend_signature_is_refused(self):
        with mock.patch.object(
            proof,
            "authenticated_candidate_rpc",
            return_value=b'{"error":{"message":"watch-only"}}',
        ):
            with self.assertRaises(proof.Refusal):
                proof.prove_spend_capability(
                    synthetic_profile(),
                    'Digest realm="wallet-rpc", nonce="abcdef", qop="auth"',
                    bytearray(b"synthetic-rpc-secret"),
                    "5" + "1" * 94,
                )

    def test_verified_view_signature_is_not_spend_capability(self):
        signature = "SigV1" + "1" * 80
        responses = [
            json.dumps({"result": {"signature": signature}}).encode(),
            b'{"result":{"good":true,"signature_type":"view"}}',
        ]
        with mock.patch.object(
            proof, "authenticated_candidate_rpc", side_effect=responses
        ):
            with self.assertRaises(proof.Refusal):
                proof.prove_spend_capability(
                    synthetic_profile(),
                    'Digest realm="wallet-rpc", nonce="abcdef", qop="auth"',
                    bytearray(b"synthetic-rpc-secret"),
                    "5" + "1" * 94,
                )

    def test_child_drops_to_exact_ids_with_no_supplementary_groups(self):
        with (
            mock.patch.object(proof.os, "setgroups") as setgroups,
            mock.patch.object(proof.os, "setgid") as setgid,
            mock.patch.object(proof.os, "setuid") as setuid,
            mock.patch.object(proof.os, "getresuid", return_value=(123, 123, 123)),
            mock.patch.object(proof.os, "getresgid", return_value=(456, 456, 456)),
            mock.patch.object(proof.os, "getgroups", return_value=[]),
            mock.patch.object(proof.os, "umask"),
            mock.patch.object(proof.resource, "setrlimit"),
            mock.patch.object(proof.LIBC, "prctl", return_value=0) as prctl,
        ):
            proof.child_hardening(123, 456)
        setgroups.assert_called_once_with([])
        setgid.assert_called_once_with(456)
        setuid.assert_called_once_with(123)
        self.assertEqual(prctl.call_count, 3)

    def test_listener_collision_is_refused(self):
        with mock.patch.object(proof, "listeners", return_value=[("127.0.0.1", 42)]):
            with self.assertRaises(proof.Refusal):
                proof.require_unused_port(39084)


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main(verbosity=2)
