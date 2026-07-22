-- Read-only release gate for every CHECK constraint introduced with NOT VALID in migrations.
--
-- Usage (connection arguments deliberately omitted):
--   psql -X -v ON_ERROR_STOP=1 \
--     --set=expected_database=EXACT_DATABASE_NAME \
--     --file=scripts/deploy/financial-constraint-audit.sql
--
-- This script is safe to run against a live database: it opens one repeatable-read, read-only
-- transaction, takes no explicit table lock, and makes no catalog or data change.

\set ON_ERROR_STOP on
\pset pager off

\if :{?expected_database}
\else
\echo 'FAIL: pass --set=expected_database=EXACT_DATABASE_NAME'
\quit 2
\endif

SELECT current_database() = :'expected_database' AS expected_database_matches \gset
\if :expected_database_matches
\else
\echo 'FAIL: connected database does not exactly match expected_database'
\quit 2
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '5s';

-- Names are intentionally explicit. A missing/renamed constraint is a release-gate failure even
-- if the equivalent predicate happens to be implemented elsewhere.
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
), actual AS (
    SELECT classes.relname AS table_name,
           constraints.conname AS constraint_name,
           constraints.convalidated
      FROM pg_catalog.pg_constraint AS constraints
      JOIN pg_catalog.pg_class AS classes ON classes.oid = constraints.conrelid
      JOIN pg_catalog.pg_namespace AS namespaces ON namespaces.oid = classes.relnamespace
     WHERE namespaces.nspname = 'public'
       AND constraints.contype = 'c'
)
SELECT COUNT(*) = 18
       AND COUNT(actual.constraint_name) = 18 AS constraint_inventory_ok,
       COUNT(*) FILTER (WHERE actual.convalidated IS FALSE) AS unvalidated_constraints,
       COALESCE(string_agg(expected.table_name || '.' || expected.constraint_name, ', '
            ORDER BY expected.table_name, expected.constraint_name)
            FILTER (WHERE actual.constraint_name IS NULL), '') AS missing_constraints
  FROM expected
  LEFT JOIN actual USING (table_name, constraint_name)
\gset

\if :constraint_inventory_ok
\echo 'Constraint inventory present; currently unvalidated:' :unvalidated_constraints
\else
ROLLBACK;
\echo 'FAIL: required financial CHECK constraint inventory is incomplete:' :missing_constraints
\quit 3
\endif

-- These predicates mirror PostgreSQL CHECK semantics exactly: only FALSE is a violation; NULL is
-- accepted by CHECK. Counts diagnose historical rows that predate NOT VALID constraint creation.
WITH violations(constraint_name, row_count) AS (
    SELECT 'payments_status_check', COUNT(*)::bigint
      FROM payments
     WHERE (status IN ('pending', 'confirmed', 'expired', 'refunded')) IS FALSE
    UNION ALL
    SELECT 'payments_payment_type_check', COUNT(*)::bigint
      FROM payments
     WHERE (payment_type IN ('single_game', 'credits_package', 'cosmetic_pack')) IS FALSE
    UNION ALL
    SELECT 'payouts_status_check', COUNT(*)::bigint
      FROM payouts
     WHERE (status IN ('pending', 'processing', 'completed', 'failed', 'needs_review',
                       'permanently_failed', 'batched')) IS FALSE
    UNION ALL
    SELECT 'games_payout_commitment_complete', COUNT(*)::bigint
      FROM games
     WHERE (payout_committed_at IS NULL
            OR (payout_eligible IS NOT NULL AND payout_terms IS NOT NULL)) IS FALSE
    UNION ALL
    SELECT 'games_layout_fingerprints_array_check', COUNT(*)::bigint
      FROM games
     WHERE (layout_fingerprints IS NULL OR jsonb_typeof(layout_fingerprints) = 'array') IS FALSE
    UNION ALL
    SELECT 'race_entry_lots_remaining_within_original', COUNT(*)::bigint
      FROM race_entry_lots
     WHERE (remaining_entries >= 0 AND remaining_entries <= original_entries) IS FALSE
    UNION ALL
    SELECT 'match_queue_entries_status_check', COUNT(*)::bigint
      FROM match_queue_entries
     WHERE (status IN ('queued', 'matched', 'consumed', 'cancelled')) IS FALSE
    UNION ALL
    SELECT 'match_queue_entries_escrow_nonnegative', COUNT(*)::bigint
      FROM match_queue_entries
     WHERE (escrow_amount >= 0 AND escrow_value_atomic >= 0) IS FALSE
    UNION ALL
    SELECT 'match_queue_committed_escrow_complete', COUNT(*)::bigint
      FROM match_queue_entries
     WHERE (
        status NOT IN ('matched', 'consumed')
        OR economy = 'free'
        OR (economy = 'credits_prestige' AND escrow_amount > 0)
        OR (economy = 'crypto_race' AND escrow_amount = 1
            AND escrow_value_atomic > 0 AND race_entry_lot_id IS NOT NULL)
     ) IS FALSE
    UNION ALL
    SELECT 'matches_payout_liability_amount_nonnegative', COUNT(*)::bigint
      FROM matches
     WHERE (payout_liability_amount_atomic IS NULL
            OR payout_liability_amount_atomic >= 0) IS FALSE
    UNION ALL
    SELECT 'matches_payout_liability_cap_positive', COUNT(*)::bigint
      FROM matches
     WHERE (payout_liability_cap_atomic IS NULL OR payout_liability_cap_atomic > 0) IS FALSE
    UNION ALL
    SELECT 'matches_payout_liability_complete', COUNT(*)::bigint
      FROM matches
     WHERE (
        payout_liability_accepted_at IS NULL
        OR (economy = 'crypto_race'
            AND payout_liability_amount_atomic IS NOT NULL
            AND payout_liability_amount_atomic > 0
            AND payout_liability_cap_atomic IS NOT NULL
            AND payout_liability_amount_atomic <= payout_liability_cap_atomic
            AND payout_liability_terms IS NOT NULL)
     ) IS FALSE
    UNION ALL
    SELECT 'matches_payout_liability_economics_consistent', COUNT(*)::bigint
      FROM matches
     WHERE (
        payout_liability_accepted_at IS NULL
        OR (entry_fee_atomic > 0
            AND pot_atomic > 0
            AND house_fee_atomic >= 0
            AND house_fee_atomic < pot_atomic
            AND payout_liability_amount_atomic = pot_atomic - house_fee_atomic)
     ) IS FALSE
    UNION ALL
    SELECT 'race_entry_lots_refund_shape', COUNT(*)::bigint
      FROM race_entry_lots
     WHERE (refunded_at IS NULL OR remaining_entries = 0) IS FALSE
    UNION ALL
    SELECT 'payment_refunds_progress_nonnegative', COUNT(*)::bigint
      FROM payment_refunds
     WHERE (purchase_progress_deducted >= 0) IS FALSE
    UNION ALL
    SELECT 'games_entry_consumption_shape', COUNT(*)::bigint
      FROM games
     WHERE (entry_credits_spent IS NULL OR entry_credits_spent > 0) IS FALSE
    UNION ALL
    SELECT 'payments_fairness_binding_complete', COUNT(*)::bigint
      FROM payments
     WHERE (
        fairness_bound_at IS NULL
        OR (payment_type = 'single_game'
            AND fairness_proof_version = 2
            AND fairness_offer_id IS NOT NULL
            AND fairness_offer_issued_at IS NOT NULL
            AND fairness_commitment ~ '^[0-9a-f]{64}$'
            AND fairness_server_seed ~ '^[0-9a-f]{64}$'
            AND fairness_client_seed IS NOT NULL)
     ) IS FALSE
    UNION ALL
    SELECT 'payouts_no_address_review_shape', COUNT(*)::bigint
      FROM payouts
     WHERE (
        payout_address <> 'PENDING_NO_ADDRESS'
        OR (status = 'needs_review'
            AND reason IN (
                'match_winner_no_address',
                'solo_winner_no_address',
                'solo_winner_identity_review'
            )
            AND tx_hash IS NULL)
     ) IS FALSE
)
SELECT COALESCE(SUM(row_count), 0) = 0 AS historical_constraints_clean,
       jsonb_object_agg(constraint_name, row_count ORDER BY constraint_name)::text
           AS violation_counts
  FROM violations
\gset

\echo 'Historical NOT VALID constraint violation counts:' :violation_counts
\if :historical_constraints_clean
ROLLBACK;
\echo 'PASS: every historical row satisfies all 18 NOT VALID financial/fairness constraints'
\else
ROLLBACK;
\echo 'FAIL: reconcile every nonzero historical constraint category before release'
\quit 3
\endif
