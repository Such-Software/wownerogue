# Historical financial constraint release gate

Several migrations add `CHECK ... NOT VALID`. PostgreSQL enforces those constraints for new and
changed rows, but it does not scan rows that existed before the constraint was added. A migration
even a current migration ledger therefore does not, by itself, prove that all historical financial rows obey
the current constraints.

Two repository-owned gates close that evidence gap without changing a live database.

## 1. Read-only historical audit

`scripts/deploy/financial-constraint-audit.sql` checks the exact connected database name, verifies
the complete 18-constraint catalog inventory, and reports a named count for every historical
predicate. It uses one repeatable-read, read-only transaction and rolls it back. Connection and
credential handling remain operator-specific; do not put a database password in command history.

```bash
psql -X -v ON_ERROR_STOP=1 \
  --set=expected_database=EXACT_DATABASE_NAME \
  --file=scripts/deploy/financial-constraint-audit.sql
```

Exit status `0` means all required constraints exist and every old row satisfies them. Any missing
constraint or nonzero category exits `3`. Reconcile violations with a separately reviewed,
backup-backed repair; this audit intentionally has no repair mode.

This check may be run read-only against production and should also run against every restored
release candidate database. It reports how many constraints remain catalog-marked unvalidated;
that count is informational because the second gate proves PostgreSQL's validator itself.

## 2. Explicit validation on a disposable restore

`scripts/deploy/financial-constraint-validate-restore.sql` includes the read-only audit, then issues
an explicit `ALTER TABLE ... VALIDATE CONSTRAINT` for all 18 constraints inside a transaction. It
checks `pg_constraint.convalidated` and rolls the entire transaction back, so no catalog flag is
durably changed.

`VALIDATE CONSTRAINT` still scans tables, takes locks, and transiently updates PostgreSQL catalogs.
For that reason this script fails before `BEGIN` unless all three conditions hold:

- the connected name exactly equals `expected_database`;
- the database name contains `restore` or `scratch`;
- the exact disposable-restore confirmation is supplied.

Run it only against a freshly restored, isolated database with no application traffic:

```bash
psql -X -v ON_ERROR_STOP=1 \
  --set=expected_database=monerogue_release_restore \
  --set=confirm_disposable=I_CONFIRM_THIS_DATABASE_IS_A_DISPOSABLE_RESTORE \
  --file=scripts/deploy/financial-constraint-validate-restore.sql
```

A pass proves both the explicit historical predicates and PostgreSQL's native validation path on
that restored data. It does not mark live constraints validated. A later durable live
`VALIDATE CONSTRAINT` operation requires its own reviewed maintenance plan, backup/restore proof,
lock budget, and rollback decision; do not fold that mutation into application startup.

## Static coverage

The focused test inventories every migration occurrence of `NOT VALID` and fails if either gate
omits a constraint:

```bash
npm --prefix src test -- --runTestsByPath ../test/financialConstraintValidation.test.js
```

Adding another `NOT VALID` constraint requires adding its exact historical predicate, its explicit
restore validation statement, and its table/name entry to both gates.
