# Immutable release artifacts

`scripts/deploy/build-release-artifact.sh` is the local, non-activating boundary between a reviewed
Git commit and a production application instance. It produces a runtime artifact, not a source or
operations bundle. It does not read an environment file, install a package, contact a deployment
host, or move a `current` symlink.

## Artifact contents

The archive holds a single top-level directory named after the release ID. That directory contains
`LICENSE`, `html/**`, the runtime subset of `src/**`, and release metadata.

Everything else in the commit is excluded on purpose: `docs/`, `test/`, the root `scripts/` tree
(service units, firewall and backup jobs, the hash-pinned financial audit SQL, the wallet output
splitter), environment examples, `src/sim`, `src/jest.config.js`, and the operator-only commands
`src/scripts/pvp-capture.js`, `src/scripts/stagenet-financial-canary.js`, `src/scripts/setup_db.js`,
and `src/scripts/smoke.js`. Tests and operator tooling are source and control-plane inputs; they are
not production runtime files, and sharing a Git commit with the runtime does not make them part of
it.

`src/scripts/preflight.js` and `src/scripts/migrate-disposable-clone.js` do ship, because the staging
gates run them from the candidate. The staged `src/package.json` is rewritten to expose only the
runnable `start`, `preflight`, and `db:migrate:clone` scripts. That rewrite is metadata-only and
changes neither dependencies nor lockfile resolution.

Release metadata:

| File | Covers |
| --- | --- |
| `.release-id` | Release directory name |
| `.release-commit` | Full 40-character source commit |
| `.release-source-sha256` | The prefix-free, runtime-allowlisted `git archive` tar |
| `.release-package-lock-sha256` | The shipped `src/package-lock.json` |
| `.release-files.sha256` | Every extracted runtime and metadata file |
| `<release-id>.tar.gz.sha256` (external sidecar) | The final compressed blob |

`.release-files.sha256` is generated before any dependency install, so it covers the shipped bytes
and never covers `src/node_modules`.

Builds are reproducible: for the same commit, release ID, and toolchain the `.tar.gz` is
byte-identical, because tar entries are sorted by name, ownership is numeric `0:0`, modes are
normalized, mtimes are pinned to the commit timestamp, and gzip runs with `-n`. The artifact and its
sidecar are published by hard link, so a concurrent build using the same release ID fails rather than
overwriting a published file. Both land mode 0600 in a mode-0700 output directory.

## Build gate

Commit every intended source and documentation change first. Review that commit and confirm that a
secret scanner has not found credentials embedded in otherwise legitimate source files; filename
policy alone cannot detect a hard-coded secret.

Run the complete test suite from the clean source commit before building:

```bash
cd src
npm ci --ignore-scripts --no-audit --no-fund
npm test
cd ..
git status --short                         # must print nothing
./scripts/deploy/build-release-artifact.sh # defaults to git-<12-character HEAD prefix>
cd dist/releases
sha256sum --check <release-id>.tar.gz.sha256
```

The builder refuses to run on any tracked or non-ignored untracked worktree change, a tracked
symlink, gitlink, or unsafe file mode, a filename containing a newline or carriage return, an unsafe
tracked path, tracked `.git` or `node_modules` state, a tracked non-example `.env` file, a tracked
`.npmrc`, `.yarnrc`, or `.netrc`, an unsafe release ID, or an existing artifact or checksum. Ignored
local files are never read, because the archive is produced from the selected commit rather than the
worktree.

Then test the runtime bytes that will ship. In a disposable directory, verify the sidecar and
manifest and install only the locked production dependency graph:

```bash
cd <directory-containing-artifact>
sha256sum --check <release-id>.tar.gz.sha256
tar -xzf <release-id>.tar.gz -C <private-test-directory>
cd <private-test-directory>/<release-id>
sha256sum --check .release-files.sha256
cd src
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm ls --omit=dev
```

Advisory lookup is a separate, explicitly authorized network operation. Do not use `npm audit fix` to
mutate a candidate or a live release.

## Release identity at runtime

`src/config/releaseIdentity.js` reads `.release-id` and `.release-commit` from the release root at
startup. Each must be a non-symlink regular file with a link count of 1, no write bits, and a size
between 1 and 128 bytes, and it is re-stat-ed after reading to reject a file that changed mid-read.
The two values must agree: the ID must be `git-<first 12 characters of the commit>`. Under
`NODE_ENV=production` the process refuses to start when that check fails, so an artifact built with a
custom `--release-id` will not run in production even though the builder accepts the name.

`/health`, `/health/ready`, and the status disclosure report the verified `release.id` and
`release.commit`. That is how activation confirms which bytes are actually serving traffic.

## Production staging gate

Use the same runtime artifact SHA-256 for `monerogue` and `wownerogue`. Transfer it into a
root-controlled staging path and verify the operator-pinned 64-hex digest before extraction. The
activation boundary must then:

1. reject an existing release ID, links or special files, an unexpected top-level directory, or
   unsafe ownership or path components;
2. install only locked production dependencies with
   `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` while staging is still writable;
3. run `npm ls --omit=dev`, recheck `.release-files.sha256`, then make the complete release
   `root:root` and non-writable before it can become `current`;
4. restore each fresh pre-deploy dump into a separately named clone database, run
   `npm run db:migrate:clone` under the disposable-target contract in
   [CLONE_MIGRATIONS.md](./CLONE_MIGRATIONS.md), and require its exact manifest proof: the
   `schema_migrations` ledger must equal the candidate's complete migration manifest, in order, with
   no missing or extra entry, contiguous from 001 and at or above the runner's floor of migration
   043. Run the separately reviewed and hash-pinned fleet copy of `financial-audit.sql` against that
   clone; the SQL is intentionally not inside the runtime artifact;
5. run `npm run preflight` from the candidate against each final protected environment. Preflight
   validates payment and environment configuration only. It connects to neither PostgreSQL nor either
   RPC, so it does not replace database, daemon, or wallet health checks.

The clone runner is deliberately non-activating. Production activation uses the separately reviewed,
default-closed `wowngeon_release_activate` role in the fleet control-plane repository. Do not
substitute manual extraction, dependency installation, service commands, or a hand-written `current`
switch. That role refuses activation until the matching clone-validation receipt, wallet-promotion
receipt, drain and audit gates, literal hashes, and rollback target all satisfy the contract in the
fleet runbook `RUNBOOK-wowngeon.md`.

## Source and operations boundary

The Git checkout is the review and test source. The fleet control-plane repository owns hash-pinned
SQL, service units, backup and firewall jobs, clone validation, activation, and rollback. Neither
source-tree deployment scripts nor fleet tools are copied beneath the application release directory.
A runtime artifact hash attests nothing about a separately delivered operations file; record and
verify an independent hash for every such file in the fleet change plan.

## Activation and rollback gate

Drain public ingress and require zero active and queued games. Take and validate fresh dumps, and run
the financial audit before and after stopping only the affected app. Preserve and validate the exact
predecessor target, switch `current` atomically, then start the stagenet instance first.

Before traffic is restored, require bounded local `/health/live` and `/health/ready`, the expected
network and money-mode disclosures, public TLS, WebSocket, and leaderboard and intake smoke tests.
`/health/ready` answers 503 while any check is degraded and reports `chain.network`,
`money.paymentsEnabled`, `money.payoutsEnabled`, and the verified release identity, so the disclosure
comparison is exact rather than approximate. The stagenet payout canary is a later, one-shot gate and
is never a mainnet command.

Application rollback is safe only if the predecessor was tested against the post-migration clone
schema. Migrations are forward-only and run one transaction per file at application startup, so a
mid-sequence failure can leave earlier files committed. On activation failure, stop the candidate,
atomically restore the validated predecessor symlink, start it, and require both the exact target and
readiness. Do not automatically restore the database after new writes; keep the dump for an
operator-reviewed recovery decision.
