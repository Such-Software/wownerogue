-- Migration 010: Security constraints to prevent invalid data states
-- These constraints enforce business rules at the database level as a safety net

-- Ensure credits can never go negative
-- This catches any code bugs that might bypass application-level checks
ALTER TABLE users ADD CONSTRAINT users_credits_non_negative
    CHECK (credits >= 0);

-- Ensure total_amount_won can never go negative
ALTER TABLE users ADD CONSTRAINT users_total_won_non_negative
    CHECK (total_amount_won >= 0);

-- Ensure total_games_played can never go negative
ALTER TABLE users ADD CONSTRAINT users_games_played_non_negative
    CHECK (total_games_played >= 0);

-- Ensure total_games_won can never go negative
ALTER TABLE users ADD CONSTRAINT users_games_won_non_negative
    CHECK (total_games_won >= 0);

-- Ensure payout amounts are always positive
ALTER TABLE payouts ADD CONSTRAINT payouts_amount_positive
    CHECK (amount > 0);

-- Ensure payment amounts are always positive
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive
    CHECK (expected_amount > 0);

-- Ensure multiplier is non-negative (0 means no payout)
ALTER TABLE payouts ADD CONSTRAINT payouts_multiplier_non_negative
    CHECK (multiplier >= 0);

-- Add index for faster payout retry queries
CREATE INDEX IF NOT EXISTS idx_payouts_retry_candidates ON payouts (status, retry_count, last_retry_at)
WHERE status IN ('pending', 'failed') AND (retry_count IS NULL OR retry_count < 3);

-- Add index for finding unprocessed payments during recovery
CREATE INDEX IF NOT EXISTS idx_payments_recovery_candidates ON payments (user_id, status, payment_type, credits_purchased)
WHERE status = 'confirmed' AND payment_type = 'credits_package' AND (credits_purchased IS NULL OR credits_purchased = 0);
