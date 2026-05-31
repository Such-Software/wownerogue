-- Migration 010: Security constraints to prevent invalid data states
-- These constraints enforce business rules at the database level as a safety net.
--
-- Each ADD CONSTRAINT is guarded by a conname check so the migration is idempotent and
-- safe to re-run / recover from a partial apply. (Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS, and a bare ADD CONSTRAINT on an existing constraint hard-fails, which previously
-- could wedge startup.)

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_credits_non_negative') THEN
        ALTER TABLE users ADD CONSTRAINT users_credits_non_negative CHECK (credits >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_total_won_non_negative') THEN
        ALTER TABLE users ADD CONSTRAINT users_total_won_non_negative CHECK (total_amount_won >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_games_played_non_negative') THEN
        ALTER TABLE users ADD CONSTRAINT users_games_played_non_negative CHECK (total_games_played >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_games_won_non_negative') THEN
        ALTER TABLE users ADD CONSTRAINT users_games_won_non_negative CHECK (total_games_won >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_amount_positive') THEN
        ALTER TABLE payouts ADD CONSTRAINT payouts_amount_positive CHECK (amount > 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_positive') THEN
        ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (expected_amount > 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_multiplier_non_negative') THEN
        ALTER TABLE payouts ADD CONSTRAINT payouts_multiplier_non_negative CHECK (multiplier >= 0);
    END IF;
END $$;

-- Add index for faster payout retry queries
CREATE INDEX IF NOT EXISTS idx_payouts_retry_candidates ON payouts (status, retry_count, last_retry_at)
WHERE status IN ('pending', 'failed') AND (retry_count IS NULL OR retry_count < 3);

-- Add index for finding unprocessed payments during recovery
CREATE INDEX IF NOT EXISTS idx_payments_recovery_candidates ON payments (user_id, status, payment_type, credits_purchased)
WHERE status = 'confirmed' AND payment_type = 'credits_package' AND (credits_purchased IS NULL OR credits_purchased = 0);
