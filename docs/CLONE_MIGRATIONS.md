# Disposable clone migration gate

`npm run db:migrate:clone` applies a release's ordered migrations to an existing, disposable
PostgreSQL clone. It is the migration step for a restored production dump, run before an immutable
release becomes eligible for activation. It never creates, restores, drops, audits, or activates a
database.

The runner is `src/scripts/migrate-disposable-clone.js`. Its only input is the inherited process
environment: it accepts no command-line options, so a target or credential cannot land in argv or
shell history.

## Hard target contract

The runner refuses to open a connection unless all of these conditions hold:

- `DB_HOST` is explicit loopback (`127.0.0.1`, `::1`, or `localhost`) or one of the standard local
  Unix socket directories `/run/postgresql` and `/var/run/postgresql`;
- `DB_NAME` matches `^[a-z][a-z0-9_]{2,62}$`, its first underscore-delimited token is `monerogue`,
  `wownerogue`, or `wowngeon`, and some later token is exactly `clone`, `restore`, or `canary`;
- no token of `DB_NAME` begins with a live marker: `active`, `current`, `live`, `mainnet`, `master`,
  `primary`, `prd`, `prod`, or `production`;
- `CLONE_MIGRATION_EXPECT_DATABASE` exactly equals `DB_NAME`;
- `CLONE_MIGRATION_CONFIRM` exactly equals `MIGRATE_DISPOSABLE_CLONE:<DB_NAME>`;
- `DB_PORT` is an explicit integer port from 1 through 65535 and `DB_USER` is an explicit simple
  role name matching `^[a-z_][a-z0-9_]{0,62}$`;
- `DATABASE_URL` is unset or empty, and the process receives no command-line arguments.

The migration manifest is then discovered from the running release's `src/migrations` directory.
Every `.sql` entry must be a regular file named `NNN_name.sql`, the ordinals must be contiguous
from `001`, and the highest ordinal must be at least `043`.

Only after those static gates pass does the runner connect. It opens a single-connection pool
(`max: 1`, five-second connection and idle timeouts, `application_name`
`wowngeon-disposable-clone-migrations`) and reads PostgreSQL's own `current_database()` before any
DDL, requiring an exact match with `CLONE_MIGRATION_EXPECT_DATABASE`.

Migrations then run through the same `DatabaseManager.runMigrations()` that application startup
uses: lexical filename order, a `schema_migrations` ledger, and one transaction per newly applied
file that both executes the SQL and records the ledger row. Afterwards the runner requires the
ledger to equal the repository manifest exactly: same count, same filenames, same order, ending at
the same latest migration.

A successful run reports:

```text
clone_migration_status=ok
database=monerogue_restore_20260721t220048z_28d513b29b36
migration_count=43
latest_migration=043_durable_solo_restart_snapshots.sql
```

Any refusal or verification failure exits non-zero after printing a single line prefixed `REFUSED:`
(target or manifest contract violation) or `FAILED:` (any other error). The `FAILED:` path prints no
server diagnostics, connection object, or environment value.

## Invocation

Create and restore the clone with the reviewed backup procedure first. Keep the target variables in
a protected operator-owned environment file and database credentials in a mode-0600 `PGPASSFILE`.
Do not pass a password, connection URL, or target as a command argument. A non-secret target
environment looks like this:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=monerogue_restore_20260721t220048z_28d513b29b36
DB_USER=monerogue
PGPASSFILE=/run/wowngeon/clone-migration.pgpass
CLONE_MIGRATION_EXPECT_DATABASE=monerogue_restore_20260721t220048z_28d513b29b36
CLONE_MIGRATION_CONFIRM=MIGRATE_DISPOSABLE_CLONE:monerogue_restore_20260721t220048z_28d513b29b36
```

Database names use lowercase letters, digits, and underscores only. Normalize a release ID into a
separate safe tag rather than copying a hyphenated artifact ID into `DB_NAME`.

Load that protected environment through the reviewed service or wrapper, change into the extracted
candidate's `src` directory, and run only:

```bash
npm run db:migrate:clone
```

Do not append `--` arguments. The runner logs no host, role, password, connection URL, or
`PGPASSFILE` contents. `DB_PASSWORD` is honoured when an already-protected service environment
supplies it and is held in memory only; `PGPASSFILE` or `PGPASSWORD` is preferred, and neither
requires the application-specific variable.

## Required follow-on gates

Run these against the same clone after migration:

- `scripts/deploy/financial-audit.sql`, compared against the pre-migration audit of the same data;
- `scripts/deploy/financial-constraint-validate-restore.sql`, the restored-data constraint
  validation gate described in
  [FINANCIAL_CONSTRAINT_VALIDATION.md](./FINANCIAL_CONSTRAINT_VALIDATION.md).

Then test both the candidate and its predecessor against the migrated clone, as described in
[RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md). The deploy SQL lives outside the runtime artifact and
is run from the repository against the clone.

## Limits

This runner does not prove that a database with a disposable-looking name is operationally
disposable, does not prevent another process from connecting to it, and does not acquire an
activation-wide drain lock. The operator must create the clone from the intended fresh dump, keep it
outside public service configuration, and destroy it separately after the release decision.

A successful result authorizes only the next audit and test gate. It does not authorize a symlink
switch, wallet action, payout, or traffic restoration.
