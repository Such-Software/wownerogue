# Immutable release artifacts

`scripts/deploy/build-release-artifact.sh` is the local, non-activating boundary between a reviewed
Git commit and the two production application instances. It produces a **runtime artifact**, not a
source or operations bundle. It does not read an environment file, install a package, connect to
`deb`, or move either `current` symlink.

## Build gate

Commit every intended source and documentation change first. Review that commit and confirm that a
secret scanner has not found credentials embedded in otherwise legitimate source files; filename
policy alone cannot detect a hard-coded secret. Then run:

```bash
git status --short                         # must print nothing
./scripts/deploy/build-release-artifact.sh # defaults to git-<12-character HEAD prefix>
cd dist/releases
sha256sum --check <release-id>.tar.gz.sha256
```

The builder fails on any tracked or non-ignored untracked worktree change, tracked symlink/gitlink,
runtime `.env` or credential-capable dotfile, unsafe release ID, or existing output. Ignored local
files are never read because the archive comes only from the selected commit. The archive contains
only `LICENSE`, `html/**`, the runtime subset of `src/**`, and deterministic release metadata.
It intentionally contains no `docs/`, `test/`, root `scripts/`, deployment service units, wallet
migration tools, environment examples, ad-capture bot, stagenet transfer canary, or development
database/smoke helpers. Simulation/Jest sources are also excluded, and the staged package manifest
retains only the runnable `start`, `preflight`, and `db:migrate:clone` commands. The guarded
`src/scripts/preflight.js` and
`src/scripts/migrate-disposable-clone.js` remain available for staging checks.
`.release-source-sha256` identifies the prefix-free,
runtime-allowlisted `git archive`; the external sidecar identifies the final compressed artifact;
`.release-files.sha256` verifies every extracted runtime/metadata file without covering the later
`src/node_modules` install.

Run the complete test suite from the clean source commit **before** building. Tests and operator
tools are source/control-plane inputs; they are not production runtime files:

```bash
cd src
npm ci --ignore-scripts --no-audit --no-fund
npm test
cd ..
git status --short # must still print nothing
./scripts/deploy/build-release-artifact.sh
```

Then test the runtime bytes that will be shipped. In a disposable directory, verify the artifact
sidecar and manifest and install only the locked production dependency graph:

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

Advisory lookup is a separate, explicitly authorized network operation. Do not use `npm audit fix`
to mutate a candidate or live release.

## Production staging gate

Use the same runtime artifact SHA-256 for `monerogue` and `wownerogue`. Transfer it into a
root-controlled staging path and verify the operator-pinned 64-hex digest before extraction. The
activation boundary must then:

1. reject an existing release ID, links/special files, an unexpected top-level directory, or unsafe
   ownership/path components;
2. install only locked production dependencies with
   `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` while staging is writable;
3. run `npm ls --omit=dev`, recheck `.release-files.sha256`, then make the complete release
   `root:root` and non-writable before it can become `current`;
4. restore each fresh pre-deploy dump into a separately named clone database, run
   `npm run db:migrate:clone` under the exact disposable-target contract in
   [CLONE_MIGRATIONS.md](./CLONE_MIGRATIONS.md), require its exact manifest proof (currently through
   migration 043), and run the separately reviewed and hash-pinned fleet copy of
   `financial-audit.sql` there—the SQL is intentionally not inside the runtime artifact;
5. run `npm run preflight` from the candidate with each final protected environment. Preflight is
   intentionally non-mutating and does not replace database, daemon, or wallet health checks.

The clone runner is deliberately non-activating. Such Software production activation must use the
separately reviewed, default-closed `wowngeon_release_activate` role in `~/src/such-fleet`; do not
substitute manual extraction, dependency installation, service commands, or a hand-written
`current` switch. The role still refuses activation until the matching clone-validation receipt,
wallet-promotion receipt, drain/audit gates, literal hashes, and rollback target satisfy the
complete contract in `~/src/such-fleet/RUNBOOK-wowngeon.md`.

## Source and operations boundary

The Git checkout remains the review/test source. `~/src/such-fleet` is the deployment control plane
for hash-pinned SQL, service units, backup/firewall jobs, clone validation, activation, and rollback.
Neither source-tree deployment scripts nor fleet tools are copied beneath the application release
directory. A runtime artifact hash does not attest a separately delivered operations file; record
and verify an independent hash for every such file in the fleet change plan.

## Activation and rollback gate

Drain public ingress and require zero active and queued games. Take and validate fresh dumps; run the
financial audit before and after stopping only the affected app. Preserve and validate the exact
predecessor target, switch `current` atomically, then start stagenet first. Require bounded local
`/health/live` and `/health/ready`, exact network/money-mode disclosures, public TLS, WebSocket, and
leaderboard/intake smoke tests before traffic is restored. The stagenet payout canary is a later,
one-shot gate and is never a mainnet command.

Application rollback is safe only if the predecessor was tested against the *post-migration* clone
schema. Migrations are forward-only and run one transaction per file at application startup; a
mid-sequence failure can leave earlier files committed. On activation failure, stop the candidate,
atomically restore the validated predecessor symlink, start it, and require both the exact target and
readiness. Do not automatically restore the database after new writes; keep the dump for an
operator-reviewed recovery decision.
