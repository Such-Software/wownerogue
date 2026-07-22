# Disposable clone migration gate

`npm run db:migrate:clone` applies the release's normal ordered migrations to an existing,
disposable PostgreSQL clone. It is the migration step for a restored production dump before an
immutable release is eligible for activation. It never creates, restores, drops, audits, or
activates a database.

## Hard target contract

The runner refuses to open a connection unless all of these conditions hold:

- `DB_HOST` is explicit loopback (`127.0.0.1`, `::1`, or `localhost`) or the standard local Unix
  socket directory `/run/postgresql` or `/var/run/postgresql`;
- `DB_NAME` starts with `monerogue_`, `wownerogue_`, or `wowngeon_` and contains a complete
  underscore-delimited `clone`, `restore`, or `canary` token;
- the name contains no live marker beginning with `prd`, `prod`, `production`, `live`, `mainnet`,
  `master`, `primary`, `current`, or `active`;
- `CLONE_MIGRATION_EXPECT_DATABASE` exactly equals `DB_NAME`;
- `CLONE_MIGRATION_CONFIRM` exactly equals `MIGRATE_DISPOSABLE_CLONE:<DB_NAME>`;
- `DB_PORT` and `DB_USER` are explicit, `DATABASE_URL` is absent, and the process receives no
  command-line arguments.

After connecting, the runner checks PostgreSQL's `current_database()` before any DDL. It then calls
the same `DatabaseManager.runMigrations()` used by application startup: lexical filename order,
the `schema_migrations` ledger, and one transaction per newly applied file. Finally, it requires the
ledger to equal the complete repository migration manifest, in order, with no missing or extra
entry. The manifest is discovered from the candidate release and must be contiguous from 001; the
current floor is migration 042. A successful current release reports:

```text
clone_migration_status=ok
database=monerogue_restore_20260721t220048z_28d513b29b36
migration_count=42
latest_migration=042_immutable_financial_event_snapshots.sql
```

## Invocation

Create and restore the clone with the reviewed backup procedure first. Keep the target variables in
a protected operator-owned environment file and database credentials in a mode-0600 `PGPASSFILE`;
do not type a password, connection URL, or target as a command argument. For example, the inherited
non-secret target environment is:

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

Load that protected environment through the reviewed service/wrapper, change into the extracted
candidate's `src` directory, and run only:

```bash
npm run db:migrate:clone
```

Do not append `--` arguments. The runner never logs host, role, password, connection URL, or
`PGPASSFILE` contents. `DB_PASSWORD` is supported only for an already-protected inherited service
environment and is kept in memory; `PGPASSFILE` is preferred.

## Required follow-on gates and limits

Run `scripts/deploy/financial-audit.sql` and the restored-data constraint validation gate against
the same clone after migration. Compare the result with the pre-migration audit, then test the
candidate and predecessor against the migrated clone as required by the fleet runbook.

This runner does not prove that a database with a disposable-looking name is operationally
disposable, does not prevent another application process from connecting, and does not acquire an
activation-wide drain lock. The operator must create the clone from the intended fresh dump, keep
it outside public service configuration, and destroy it separately after the release decision. A
successful result authorizes only the next audit/test gate; it does not authorize a symlink switch,
wallet action, payout, or traffic restoration.
