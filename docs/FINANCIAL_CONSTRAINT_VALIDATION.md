# Historical financial constraint release gate

Several migrations add `CHECK ... NOT VALID`. PostgreSQL enforces those constraints for every new and
changed row, but it does not scan rows that already existed when the constraint was added. A complete
`schema_migrations` ledger therefore does not, by itself, prove that historical financial rows obey
the current constraints.

Two repository-owned gates close that evidence gap without changing a live database. Both cover the
same 18 constraints across `payments`, `payouts`, `games`, `matches`, `match_queue_entries`,
`race_entry_lots`, and `payment_refunds`.

## 1. Read-only historical audit

`scripts/deploy/financial-constraint-audit.sql` checks the exact connected database name, verifies
the complete 18-constraint catalog inventory, and reports a named row count for every historical
predicate. It runs in one repeatable-read, read-only transaction, takes no explicit table lock, and
rolls back. Connection and credential handling stay operator-specific; keep database passwords out of
command history.

```bash
psql -X -v ON_ERROR_STOP=1 \
  --set=expected_database=EXACT_DATABASE_NAME \
  --file=scripts/deploy/financial-constraint-audit.sql
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every required constraint exists and every historical row satisfies it. |
| `2` | `expected_database` was not supplied, or the connected database does not match it exactly. |
| `3` | A required constraint is missing, or at least one predicate has a nonzero violation count. |

The violation predicates mirror PostgreSQL `CHECK` semantics: only `FALSE` counts as a violation,
since `CHECK` accepts `NULL`. Reconcile any violation with a separately reviewed, backup-backed
repair. The audit has no repair mode by design.

This check is safe against production and should also run against every restored release candidate
database. It reports how many of the constraints are still catalog-marked unvalidated; that count is
informational, because the second gate exercises PostgreSQL's own validator.

## 2. Explicit validation on a disposable restore

`scripts/deploy/financial-constraint-validate-restore.sql` includes the read-only audit, then issues
an explicit `ALTER TABLE ... VALIDATE CONSTRAINT` for all 18 constraints inside a transaction. It
confirms `pg_constraint.convalidated` for each one and rolls the whole transaction back, so no
catalog flag changes durably.

`VALIDATE CONSTRAINT` still scans tables, takes locks, and transiently updates PostgreSQL catalogs.
The script therefore refuses to reach `BEGIN` unless all three conditions hold:

- the connected database name exactly equals `expected_database`;
- that name contains `restore` or `scratch`;
- the exact disposable-restore confirmation string is supplied.

Run it only against a freshly restored, isolated database with no application traffic:

```bash
psql -X -v ON_ERROR_STOP=1 \
  --set=expected_database=monerogue_release_restore \
  --set=confirm_disposable=I_CONFIRM_THIS_DATABASE_IS_A_DISPOSABLE_RESTORE \
  --file=scripts/deploy/financial-constraint-validate-restore.sql
```

Both scripts set `statement_timeout` to 10 minutes and `lock_timeout` to 5 seconds for the duration
of their transaction.

A pass proves both the explicit historical predicates and PostgreSQL's native validation path on that
restored data. It does not mark live constraints validated. Making a live `VALIDATE CONSTRAINT`
durable is a separate operation that needs its own reviewed maintenance plan, backup and restore
proof, lock budget, and rollback decision. Do not fold that mutation into application startup.

## Static coverage

A focused test inventories every migration occurrence of `NOT VALID` and fails if either gate omits a
constraint or if the inventory size drifts from 18:

```bash
npm --prefix src test -- --runTestsByPath ../test/financialConstraintValidation.test.js
```

The test also asserts that the audit script contains no `ALTER TABLE` and no write statement, so the
read-only gate cannot silently gain a mutation.

Adding another `NOT VALID` constraint requires three matching updates: its exact historical predicate
and inventory entry in the audit script, its `VALIDATE CONSTRAINT` statement and inventory entry in
the restore script, and its table and name in the test's constraint list.
