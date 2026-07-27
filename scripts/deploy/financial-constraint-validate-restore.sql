-- Prove PostgreSQL can VALIDATE every historical NOT VALID constraint on a disposable restore.
-- Every catalog update is rolled back, but ALTER TABLE VALIDATE CONSTRAINT still scans and locks;
-- this script therefore refuses databases whose names do not contain "restore" or "scratch".
-- Never run it against a live application database.
--
-- Usage (connection arguments deliberately omitted):
--   psql -X -v ON_ERROR_STOP=1 \
--     --set=expected_database=EXACT_RESTORE_DATABASE \
--     --set=confirm_disposable=I_CONFIRM_THIS_DATABASE_IS_A_DISPOSABLE_RESTORE \
--     --file=scripts/deploy/financial-constraint-validate-restore.sql

\set ON_ERROR_STOP on
\pset pager off

\if :{?expected_database}
\else
\echo 'FAIL: pass --set=expected_database=EXACT_RESTORE_DATABASE'
\quit 2
\endif
\if :{?confirm_disposable}
\else
\echo 'FAIL: pass the documented confirm_disposable value'
\quit 2
\endif

SELECT current_database() = :'expected_database'
       AND current_database() ~* '(restore|scratch)'
       AND :'confirm_disposable' = 'I_CONFIRM_THIS_DATABASE_IS_A_DISPOSABLE_RESTORE'
       AS disposable_restore_confirmed
\gset
\if :disposable_restore_confirmed
\else
\echo 'FAIL: VALIDATE is restricted to the exact, explicitly confirmed restore/scratch database'
\quit 2
\endif

-- First provide named historical violation counts under a read-only snapshot. The included audit
-- exits nonzero before any ALTER if the inventory is incomplete or any old row violates a CHECK.
\ir financial-constraint-audit.sql

BEGIN;
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payments VALIDATE CONSTRAINT payments_status_check;
ALTER TABLE public.payments VALIDATE CONSTRAINT payments_payment_type_check;
ALTER TABLE public.payouts VALIDATE CONSTRAINT payouts_status_check;
ALTER TABLE public.games VALIDATE CONSTRAINT games_payout_commitment_complete;
ALTER TABLE public.games VALIDATE CONSTRAINT games_layout_fingerprints_array_check;
ALTER TABLE public.race_entry_lots VALIDATE CONSTRAINT race_entry_lots_remaining_within_original;
ALTER TABLE public.match_queue_entries VALIDATE CONSTRAINT match_queue_entries_status_check;
ALTER TABLE public.match_queue_entries VALIDATE CONSTRAINT match_queue_entries_escrow_nonnegative;
ALTER TABLE public.match_queue_entries VALIDATE CONSTRAINT match_queue_committed_escrow_complete;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_payout_liability_amount_nonnegative;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_payout_liability_cap_positive;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_payout_liability_complete;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_payout_liability_economics_consistent;
ALTER TABLE public.race_entry_lots VALIDATE CONSTRAINT race_entry_lots_refund_shape;
ALTER TABLE public.payment_refunds VALIDATE CONSTRAINT payment_refunds_progress_nonnegative;
ALTER TABLE public.games VALIDATE CONSTRAINT games_entry_consumption_shape;
ALTER TABLE public.payments VALIDATE CONSTRAINT payments_fairness_binding_complete;
ALTER TABLE public.payouts VALIDATE CONSTRAINT payouts_no_address_review_shape;

WITH expected(table_name, constraint_name) AS (
    VALUES
      ('payments', 'payments_status_check'),
      ('payments', 'payments_payment_type_check'),
      ('payouts', 'payouts_status_check'),
      ('games', 'games_payout_commitment_complete'),
      ('games', 'games_layout_fingerprints_array_check'),
      ('race_entry_lots', 'race_entry_lots_remaining_within_original'),
      ('match_queue_entries', 'match_queue_entries_status_check'),
      ('match_queue_entries', 'match_queue_entries_escrow_nonnegative'),
      ('match_queue_entries', 'match_queue_committed_escrow_complete'),
      ('matches', 'matches_payout_liability_amount_nonnegative'),
      ('matches', 'matches_payout_liability_cap_positive'),
      ('matches', 'matches_payout_liability_complete'),
      ('matches', 'matches_payout_liability_economics_consistent'),
      ('race_entry_lots', 'race_entry_lots_refund_shape'),
      ('payment_refunds', 'payment_refunds_progress_nonnegative'),
      ('games', 'games_entry_consumption_shape'),
      ('payments', 'payments_fairness_binding_complete'),
      ('payouts', 'payouts_no_address_review_shape')
)
SELECT COUNT(*) = 18 AND BOOL_AND(constraints.convalidated) AS all_constraints_validated
  FROM expected
  JOIN pg_catalog.pg_namespace AS namespaces ON namespaces.nspname = 'public'
  JOIN pg_catalog.pg_class AS classes
    ON classes.relnamespace = namespaces.oid AND classes.relname = expected.table_name
  JOIN pg_catalog.pg_constraint AS constraints
    ON constraints.conrelid = classes.oid
   AND constraints.conname = expected.constraint_name
   AND constraints.contype = 'c'
\gset

\if :all_constraints_validated
ROLLBACK;
\echo 'PASS: PostgreSQL validated all 18 constraints on the disposable restore; catalog changes rolled back'
\else
ROLLBACK;
\echo 'FAIL: explicit VALIDATE CONSTRAINT coverage was incomplete'
\quit 3
\endif
