# Parallel Monero stagenet wallet candidate

> **STATUS: DESIGN / NO-GO FOR HOST MUTATION OR PRODUCTION DEPLOYMENT.**
>
> The read-only preflight and disposable fixture test in this change are executable. The candidate
> unit is an inert, manual-only template. There is intentionally no password-capture, wallet-copy,
> credential-bundle, installer, activation, or cutover program yet. Do not improvise those steps
> from shell commands. No in-place destructive migration is shipped with this design; deleting an
> abandoned draft does not make the parallel candidate production-deployable.

This is the smaller alternative to replacing the current wallet in place. It is fixed to the
Monero **stagenet** wallet used by `monerogue.app`. It has no mainnet or Wownero mode.

The safety property is simple: the current wallet, unit, and application stay exactly as they are.
A stopped, consistent copy is opened under a new dedicated identity on a different loopback port.
Nothing can use that copy until one complete directory containing the wallet, protected
credentials, configuration, and readiness marker has been validated and atomically published.

## What is safe to run now

The local fixture uses only synthetic bytes below a temporary directory:

```bash
python3 scripts/deploy/monero-stagenet-parallel-fixture-test.py
```

The fixed-path preflight is read-only. It deliberately does not read unit text, process argv,
wallet bytes, keys, passwords, or mnemonics. After independent review, it can check the current
legacy RPC:

```bash
sudo python3 scripts/deploy/monero-stagenet-parallel-preflight.py legacy
```

Its `candidate-prereqs` scope additionally requires the new system identity, free candidate ports,
an unused candidate path, the root-owned candidate binary, and enough local space. Provisioning
that identity is a future approved change; the preflight does not create it.

Neither command proves that secret capture, bundle creation, activation, backup recovery, or an
application cutover is safe. The service template must not be installed yet.

## Fixed boundary

| Purpose | Fixed value |
| --- | --- |
| Legacy unit | `monero-wallet-rpc.service` |
| Legacy wallet | `/home/jw/Programs/monero-x86_64-linux-gnu-v0.18.4.4/test` + `.keys` |
| Legacy RPC | `127.0.0.1:38083` |
| Network/daemon | Monero stagenet / `127.0.0.1:38081` |
| Candidate identity | `monerogue-wallet-candidate:monerogue-wallet-candidate` |
| Staging generation | `/var/lib/.monerogue-stagenet-wallet-candidate.staging` |
| Published generation | `/var/lib/monerogue-stagenet-wallet-candidate` |
| Candidate RPC | `127.0.0.1:38084`, Digest authentication required |
| Offline verification RPC | `127.0.0.1:39084`, temporary only |
| Candidate unit | `monerogue-stagenet-wallet-candidate.service`, manual only |

The final bundle must be one directory on the same filesystem as its staging generation:

```text
/var/lib/monerogue-stagenet-wallet-candidate/  root:root 0711
├── READY                         root:root 0600, written last
├── STATE.json                    root:root 0600, non-secret phase/address metadata
├── expected-address              root:root 0600, public address only
├── wallet/                       candidate:candidate 0700
│   ├── stagenet                  candidate:candidate 0600
│   └── stagenet.keys             candidate:candidate 0600
├── config/                       root:candidate 0710
│   └── wallet-rpc.conf           root:candidate 0640
├── secrets/                      root:root 0711
│   ├── wallet-password           root:candidate 0640
│   └── rpc-auth.netrc            root:root 0600
└── integration/                  root:root 0711
    └── candidate-app.env         root:monerogue 0640
```

Execute-only directory traversal permits each identity to open its one reviewed fixed path without
listing the directory. No file may be a symlink or have a link count other than one. The `READY`
marker contains only version, stagenet, `127.0.0.1:38084`, the public address, and a
`manual-only` flag—never a password, hash of a seed, private key, or wallet bytes.

## Required staged procedure

These are acceptance requirements for small future helpers, not commands to run today.

### 1. Read-only inventory

The preflight must pass immediately before a maintenance window. Separately record the public
wallet address without recording credentials. Confirm the current application and wallet remain
healthy and that `38084` and `39084` have no listener.

The preflight intentionally does not inspect `/proc/<pid>/cmdline`, because the current process
contains a password. That work belongs only in the bounded capture helper described next.

### 2. Capture the already-exposed wallet password

A future fixed-path helper may read the password only from the validated live process. It must:

- run as root with `RLIMIT_CORE=0`, `PR_SET_DUMPABLE=0`, `umask 077`, and no tracing/logging;
- obtain only `MainPID` from systemd, then validate PID start time, `/proc/<pid>/exe`, UID, cgroup,
  and the sole PID-owned `127.0.0.1:38083` listener before and after capture;
- read NUL-delimited `/proc/<pid>/cmdline` directly, never systemd unit text or `ExecStart` output;
- accept exactly one bounded `--password VALUE` or `--password=VALUE`, reject duplicates,
  `--password-file`, NUL/newline data, or a process change;
- write only a new `root:root 0600` file below the unpublished staging generation using
  `openat(O_NOFOLLOW|O_CREAT|O_EXCL)`, `fsync`, and retained directory descriptors;
- print only success/refusal, never arguments, password length, content, hash, or exception data;
- zero mutable buffers before exit; and
- leave an incomplete stage inert and refuse automatic overwrite or cleanup after any failure.

The helper needs executable fixture coverage for both argv forms, duplicates, process replacement,
short writes, fsync failures, interruption, and restart with every possible partial file/state. A
static source test is not sufficient.

### 3. One bounded stopped-wallet copy window

Only a narrow wrapper may stop the legacy unit. It must acquire a fixed root-only lock and install
an `EXIT`, signal, and error trap that always attempts to restart the exact legacy unit. It must not
read or alter the unit.

After stop, require `MainPID=0`, no listener on `38083`, and no other process descriptor open on
either source inode. Open every source/path component with retained directory descriptors and
`O_NOFOLLOW`; require `jw:jw 0600`, a single link, and stable inode/size/timestamps. Copy wallet and
keys with `O_EXCL` temporary files, `fsync`, byte-compare through retained descriptors, publish each
inside the unpublished stage with `renameat2(RENAME_NOREPLACE)`, and fsync its directory.

The wrapper must restart the legacy unit whether the copy succeeds, fails, or is interrupted. A
successful window is not complete until the restarted RPC has the same PID ownership/listener
properties and returns the exact public address captured before stop. At no point may a helper
move, rename, chmod, chown, truncate, erase, or unlink the legacy wallet, keys, directory, or unit.

### 4. Build and verify one unused bundle

Generate a new RPC credential in a non-dumpable process. The wallet password and RPC credential
must be distinct. Keep all copies in the one unpublished generation; no `/etc` credential file or
application drop-in is needed.

The protected wallet config must contain exactly these non-secret semantics plus one Digest login:

```text
stagenet=1
wallet-file=/var/lib/monerogue-stagenet-wallet-candidate/wallet/stagenet
password-file=/var/lib/monerogue-stagenet-wallet-candidate/secrets/wallet-password
rpc-bind-port=38084
rpc-bind-ip=127.0.0.1
daemon-address=127.0.0.1:38081
rpc-login=monerogue-candidate:<generated-secret>
non-interactive=1
```

Before publication, open the copied wallet offline on temporary port `39084` as the candidate UID,
with supplementary groups and all capabilities cleared, `no_new_privs`, core dumps disabled, and
logs directed to `/dev/null`. Prove all of the following without printing response data:

- the verifier PID owns the sole exact loopback listener;
- unauthenticated JSON-RPC returns HTTP 401;
- Digest-authenticated `get_address` returns HTTP 200 and the captured stagenet address; and
- termination removes the verifier and listener cleanly.

Then verify every directory/file owner, mode, type, and link count. Write and fsync `STATE.json`,
write `READY` **last**, fsync every file and directory, atomically rename the whole staging
directory to the unused final name with `RENAME_NOREPLACE`, and fsync `/var/lib`. A crash before the
single directory rename leaves no final candidate. An existing final candidate is never replaced.

### 5. Manual candidate validation

Only after an independent reviewer accepts the helper and crash evidence may the inert service
template be installed as `/etc/systemd/system/monerogue-stagenet-wallet-candidate.service`. It has
no `[Install]` section, no boot target, no restart loop, no relationship to `monerogue.service`, and
requires the exact readiness marker.

Start it manually, then prove systemd MainPID/executable/UID/cgroup agreement, the sole
`127.0.0.1:38084` listener owned by that PID, HTTP 401 without auth, HTTP 200 with the protected
netrc, and the sealed public address. The legacy RPC and live app must remain healthy throughout.

### 6. Candidate application canary

The bundle may contain one `root:monerogue 0640` environment override with candidate endpoint and
Digest credentials. It must also force:

```text
HOST=127.0.0.1
PORT=3103
PAYMENTS_ENABLED=false
PAYOUTS_ENABLED=false
DIRECT_PAYMENT_ENABLED=false
DIRECT_PAYOUTS_ENABLED=false
CREDITS_PAYOUTS_ENABLED=false
MATCH_ENABLED=false
MATCH_CRYPTO_RACE_ENABLED=false
MATCH_PAYOUTS_ENABLED=false
```

Run the exact release only against a fresh, isolated canary database. Do not attach port 3103 to
the NPM/router, public ingress, production database, payment intake, payout dispatchers, or the
live service. Readiness and a non-money wallet query are the only allowed checks. Stop both canary
app and candidate wallet afterward.

Promotion of the production app from `38083` to `38084` is explicitly out of scope. It requires a
separate reviewed maintenance change and rollback plan.

## Rollback and partial failures

There is no destructive wallet rollback because this path never alters the legacy artifacts.

- During the copy window, always restart and validate the legacy unit from the trap.
- Before candidate activation, leave any partial staging generation root-only and inert. Do not
  delete, merge, resume, or overwrite it automatically.
- After candidate activation, stop the candidate unit and prove port `38084` is closed. Restart and
  validate the legacy unit if needed. The live application still points to `38083`.
- Preserve the unused candidate bundle for incident review; cleanup is a later exact-target,
  separately approved operation.

If the legacy unit cannot restart or its address differs, keep the application stopped/ingress
held under the existing incident runbook. Do not attempt an app cutover to rescue the ceremony.

## GO criteria

All are mandatory before any host mutation beyond provisioning the unused candidate identity:

1. Small fixed-path capture, copy-window, bundle, and validation helpers exist; no general source,
   destination, network, unit, port, user, or overwrite arguments exist.
2. Disposable tests inject failure before/after every create, write, chmod/chown, file fsync,
   directory fsync, state write, readiness write, stop, start, address check, and final rename.
3. Kill/restart tests prove every partial stage remains inert and every stopped-wallet failure
   makes a bounded restart attempt without touching legacy bytes or metadata.
4. Symlink, hardlink, inode replacement, open-writer, wrong UID/cgroup/PID, wildcard/IPv6 listener,
   port collision, duplicate password option, and existing-final fixtures all fail closed.
5. A reviewer verifies secrets never enter argv, environment, stdout/stderr, journald, unit text,
   tracebacks, Git, ordinary docs, or the non-secret readiness marker.
6. The restored wallet backup plus its password has been opened offline and address-matched, and
   mnemonic/off-host recovery custody is resolved separately. A `.keys` file alone is not mnemonic
   custody evidence.
7. The complete process succeeds, rolls back, and succeeds again on an isolated stagenet host with
   synthetic/unfunded material before touching the funded stagenet wallet.
8. An independent reviewer records GO against an immutable release hash.

Until every item passes, the production-deployable answer is **no**. Only the read-only preflight
and disposable fixture test are approved by this document; even the candidate service template is
not approved for installation.
