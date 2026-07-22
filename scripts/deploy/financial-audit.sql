\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT current_database() AS database,
       COUNT(*) AS applied_migrations,
       MAX(filename) AS latest_migration
FROM schema_migrations;

WITH audit(category, row_count, atomic_amount) AS (
    SELECT 'payout_nonterminal', COUNT(*), COALESCE(SUM(amount), 0)::numeric
      FROM payouts
     WHERE status IS NULL OR status NOT IN ('recorded', 'completed')
    UNION ALL
    SELECT 'payout_completed_missing_tx', COUNT(*), COALESCE(SUM(amount), 0)::numeric
      FROM payouts
     WHERE status = 'completed' AND NULLIF(BTRIM(COALESCE(tx_hash, '')), '') IS NULL
    UNION ALL
    SELECT 'refund_unsettled', COUNT(*), COALESCE(SUM(amount), 0)::numeric
      FROM payment_refunds
     WHERE status IS NULL OR status NOT IN ('recorded', 'completed')
    UNION ALL
    SELECT 'solo_orphan', COUNT(*), 0::numeric
      FROM games
     WHERE status IS NULL OR status NOT IN ('won', 'lost', 'expired')
    UNION ALL
    SELECT 'match_orphan', COUNT(*), COALESCE(SUM(payout_liability_amount_atomic), 0)::numeric
      FROM matches
     WHERE status IS NULL OR status NOT IN ('finished', 'cancelled')
    UNION ALL
    SELECT 'match_queue_outstanding', COUNT(*), COALESCE(SUM(escrow_value_atomic), 0)::numeric
      FROM match_queue_entries
     WHERE status IS NULL OR status NOT IN ('consumed', 'cancelled')
    UNION ALL
    SELECT 'solo_liability_without_payout', COUNT(*),
           COALESCE(SUM(CASE
               WHEN treasure_found THEN payout_treasure_amount
               ELSE payout_escape_amount
           END), 0)::numeric
      FROM games g
     WHERE g.status = 'won'
       AND g.payout_eligible = TRUE
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.game_id = g.id)
    UNION ALL
    SELECT 'match_liability_without_payout', COUNT(*),
           COALESCE(SUM(m.payout_liability_amount_atomic), 0)::numeric
      FROM matches m
     WHERE m.economy = 'crypto_race'
       AND m.status = 'finished'
       AND m.winner_user_id IS NOT NULL
       AND m.payout_liability_accepted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.match_id = m.id)
    UNION ALL
    SELECT 'late_payment_manual_review', COUNT(*), COALESCE(SUM(observed_amount), 0)::numeric
      FROM payment_late_reviews
     WHERE status IS NULL OR status NOT IN ('resolved', 'ignored')
)
SELECT category, row_count, atomic_amount
FROM audit
ORDER BY category;

WITH ledger AS (
    SELECT COUNT(*) = 42
       AND MAX(filename) = '042_immutable_financial_event_snapshots.sql' AS valid
      FROM schema_migrations
), audit(row_count) AS (
    SELECT COUNT(*) FROM payouts WHERE status IS DISTINCT FROM 'completed'
    UNION ALL
    SELECT COUNT(*) FROM payouts
     WHERE status = 'completed' AND NULLIF(BTRIM(COALESCE(tx_hash, '')), '') IS NULL
    UNION ALL
    SELECT COUNT(*) FROM payment_refunds
     WHERE status IS DISTINCT FROM 'completed'
    UNION ALL
    SELECT COUNT(*) FROM games WHERE status IS NULL OR status NOT IN ('won', 'lost', 'expired')
    UNION ALL
    SELECT COUNT(*) FROM matches WHERE status IS NULL OR status NOT IN ('finished', 'cancelled')
    UNION ALL
    SELECT COUNT(*) FROM match_queue_entries WHERE status IS NULL OR status NOT IN ('consumed', 'cancelled')
    UNION ALL
    SELECT COUNT(*) FROM games g
     WHERE g.status = 'won' AND g.payout_eligible = TRUE
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.game_id = g.id)
    UNION ALL
    SELECT COUNT(*) FROM matches m
     WHERE m.economy = 'crypto_race' AND m.status = 'finished'
       AND m.winner_user_id IS NOT NULL
       AND m.payout_liability_accepted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.match_id = m.id)
    UNION ALL
    SELECT COUNT(*) FROM payment_late_reviews WHERE status IS NULL OR status NOT IN ('resolved', 'ignored')
)
SELECT ((SELECT valid FROM ledger) AND COALESCE(SUM(row_count), 0) = 0) AS financial_audit_clean FROM audit \gset

\if :financial_audit_clean
\echo 'PASS: no dispatchable/ambiguous financial state or orphaned gameplay state'
\else
\echo 'FAIL: reconcile every nonzero category before any payout-capable boot'
\quit 3
\endif

ROLLBACK;
