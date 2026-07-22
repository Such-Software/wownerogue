# Wallet keyfile recovery proof

**Status: source and synthetic tests only. This helper has not been installed on or run against
`deb`, and this document does not authorize a host mutation or a production ceremony.**

This runbook covers one deliberately narrow question: can an audited encrypted wallet snapshot and
the password already exposed in the matching legacy wallet-RPC process open offline and reproduce
the exact public address currently returned by that process? The fixed helper is
`scripts/deploy/wallet-keyfile-recovery-proof.py`.

The answer is emitted as exactly one status line:

```text
result=passed
```

or:

```text
result=refused
```

There is intentionally no diagnostic mode. Never add shell tracing, a debugger, `strace`, command
line capture, wallet-RPC response logging, or exception rendering to investigate a refusal. Those
would defeat the secret-handling boundary this proof is meant to preserve.

## What a pass means

A pass establishes all of the following for the selected profile at that moment:

- the expected legacy systemd unit has a stable MainPID, executable, UID/GID, cgroup, listener,
  network flag, RPC port, and exact `--wallet-file` argument;
- its already-exposed inline wallet password could be copied from the NUL-delimited process command
  line without rendering it;
- both fixed, root-only pre-production snapshot files were real, single-link regular files with the
  audited metadata and were copied byte-for-byte into a newly created private `/run` directory;
- the matching wallet-RPC executable opened that copied pair offline on the fixed loopback proof
  port as the exact legacy UID/GID, with an empty supplementary-group list, using a password file and
  an ephemeral Digest credential;
- the proof endpoint rejected an unauthenticated request with HTTP 401, accepted an authenticated
  `get_address` request with HTTP 200, returned an address shaped for the expected network, and that
  address exactly equalled the current live address;
- that restored wallet signed one fixed, non-secret proof message and its own wallet-RPC verified the
  signature as a spend-key signature (or, for the legacy response shape, verified the default
  spend-key signature), so a watch-only keyfile cannot pass; and
- the candidate stopped, its listener disappeared, and only the exact ephemeral files and directory
  were securely cleaned up.

The helper does not stop, start, restart, reload, reconfigure, or write to a live unit or live wallet.
The proof candidate is offline; it cannot refresh, submit transactions, or contact a daemon.

## What a pass does not mean

This is **not seed custody** and it is **not an off-host disaster-recovery test**. In particular, a
pass does not establish:

- that a mnemonic or seed has ever been recorded, is readable, is complete, or is held by the right
  custodians;
- that the encrypted keyfile, its password, or a seed exists independently off this host—the password
  used here comes only from the already-running process, not from an independent custody source;
- that Restic media, repository credentials, retention, or an actual off-host restore path works;
- that a restore can rescan chain history, discover the expected balance, or spend funds;
- that daemon, database, application, DNS, proxy, Nebula, or fleet recovery works; or
- that payouts, wagering, mainnet money movement, or a production release is authorized.

Do not query, display, export, hash, or automate retrieval of a mnemonic to fill this gap. Seed
custody requires a separate human-controlled inventory and an off-host restore drill with an agreed
handling ceremony. Until that evidence exists, record seed custody and off-host recovery as
**unproven**, even if this helper passes.

## Fixed audited profiles

No path, unit, binary, port, user, or RPC method is accepted from the caller. The only accepted
profile names are `monero-stagenet` and `wownero-mainnet`.

| Profile | Fixed legacy identity | Fixed snapshots | Private proof target |
| --- | --- | --- | --- |
| `monero-stagenet` | `monero-wallet-rpc.service`, `jw:jw`, `/usr/bin/monero-wallet-rpc`, wallet `/home/jw/Programs/monero-x86_64-linux-gnu-v0.18.4.4/test`, `127.0.0.1:38083`, `--stagenet` | `/var/backups/wowngeon/wallets/monero-stagenet-preprod-20260721T1140Z.wallet` and `/var/backups/wowngeon/wallets/monero-stagenet-preprod-20260721T1140Z.keys` | outer `/run/wowngeon-wallet-keyfile-proof-monero-stagenet`, inner `candidate`, `127.0.0.1:39084` |
| `wownero-mainnet` | `wownero-wallet-rpc.service`, `jw:jw`, `/usr/bin/wownero-wallet-rpc`, wallet `/home/jw/Programs/wow-11.3.0/game`, audited legacy listener `0.0.0.0:34570` | `/var/backups/wowngeon/wallets/wownero-mainnet-preprod-20260721T1140Z.wallet` and `/var/backups/wowngeon/wallets/wownero-mainnet-preprod-20260721T1140Z.keys` | outer `/run/wowngeon-wallet-keyfile-proof-wownero-mainnet`, inner `candidate`, `127.0.0.1:39570` |

The live equality observations are unauthenticated because the legacy sources are. Monero is
loopback-only; Wownero's wildcard listener is an insecure legacy source contained by the host
firewall, not a state this proof endorses. `current_live_address` makes one read-only public-address
observation solely for equality; a match is **not** an RPC-hardening or network-security pass. The
helper neither changes nor resolves the wildcard/unauthenticated service. Its proof candidate always
binds loopback and requires an ephemeral Digest credential.

Each fixed proof path is a root-owned outer directory, `root:jw` mode `0710`, which prevents the
candidate identity from listing or writing its parent. Root builds the inner `candidate` subtree and
files before publishing only that subtree as `jw:jw` mode `0700` with `0600` files. Immediately before
exec, the child clears supplementary groups, sets all real/effective/saved GIDs and UIDs to `jw:jw`,
clears retained capabilities, then reapplies no-dump, no-new-privileges, and zero-core limits. The
parent verifies empty inheritable/permitted/effective/ambient capability sets. Wallet-RPC never runs
as root.

The audited snapshot directory is `/var/backups/wowngeon/wallets`, `root:root` mode `0700`; each
snapshot is `root:root` mode `0600` with one link. Its parent is `/var/backups/wowngeon`,
`root:postgres` mode `0710`. Any deviation refuses the proof.

## Review and synthetic verification

Before any future host ceremony, review the helper and run the disposable fixture locally:

```bash
python3 -m py_compile scripts/deploy/wallet-keyfile-recovery-proof.py \
  scripts/deploy/wallet-keyfile-recovery-fixture-test.py
python3 scripts/deploy/wallet-keyfile-recovery-fixture-test.py
```

The fixture uses only generated temporary files and synthetic credentials. It covers exact argument
selection and wiping, indirect or duplicate password refusal, network mismatch, link and metadata
failures, source mutation during copy, byte equality, cleanup containment, Digest authentication
shape, candidate config shape, privilege dropping, fixed-message spend signing/verification,
watch-only refusal, and proof-port collision. It never opens a real wallet.

Review must also confirm that the executable still contains only read-only `systemctl is-active` and
`systemctl show` calls; only the `get_address`, `sign`, and `verify` wallet RPC methods; no
caller-controlled paths, ports, or messages; and only the two status strings as runtime output. The
address and signature are never output or retained as ceremony evidence.

## Future authorized ceremony

Run Monero stagenet first. Wownero mainnet remains an offline keyfile-open proof only and must not be
treated as approval to enable payouts or submit a transaction.

Only after a reviewed revision is explicitly approved for installation should an operator install
that exact file to a root-owned, non-writable path such as
`/usr/local/sbin/wowngeon-wallet-keyfile-recovery-proof` with owner `root:root` and mode `0700`.
Do not run it from a mutable checkout. Record the reviewed source revision, but do not record wallet
bytes, addresses, passwords, command lines, Digest material, wallet-derived hashes, or RPC bodies.

Before each profile:

1. Confirm no debugger, tracing wrapper, shell xtrace, terminal recorder, or broad process collector
   will observe the root helper.
2. Confirm the expected proof port is not reserved for another operation and the exact fixed `/run`
   proof directory does not exist.
3. Confirm the legacy unit is expected to remain online and unchanged for the short proof window.
4. Invoke the installed helper as root with exactly one fixed profile argument and capture only its
   one-line status.

The future invocations are:

```bash
sudo /usr/local/sbin/wowngeon-wallet-keyfile-recovery-proof monero-stagenet
sudo /usr/local/sbin/wowngeon-wallet-keyfile-recovery-proof wownero-mainnet
```

These commands are examples for a later authorized ceremony, not evidence they have been run.

After each invocation, verify only that its fixed proof port is closed and its fixed proof directory
is absent. A pass is invalid if cleanup did not complete; the helper reports refusal in that case.

## Refusal or interrupted execution

`result=refused` is intentionally non-diagnostic. Do not weaken the helper or print an exception to
learn why. Review the fixed-path metadata, expected unit state, listener ownership, port availability,
and synthetic suite through non-secret checks, then arrange a new reviewed ceremony.

If a fixed proof directory remains after interruption, **do not blindly remove it**. Treat it as
potentially containing wallet material. First establish through metadata-only checks that no proof
wallet-RPC process or proof-port listener remains, keep the incident off shared logs, and have an
authorized operator review cleanup of that exact path. Never use a recursive command against `/run`
or a variable/glob target.

The next independent backup milestone is a human-approved seed-custody inventory followed by a
restore from genuinely off-host media into an isolated environment. That is the evidence needed to
answer “do we have recoverable wallet seeds?”; this helper deliberately cannot answer it.
