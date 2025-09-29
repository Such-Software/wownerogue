-- Migration 005: Unified payment system foundation

-- Extend payments table to track unified payment metadata
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20);
ALTER TABLE payments
    ALTER COLUMN payment_mode SET DEFAULT 'direct';
UPDATE payments
    SET payment_mode = 'direct'
    WHERE payment_mode IS NULL;

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS credit_package_id VARCHAR(20);

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS credits_purchased INTEGER DEFAULT 0;
UPDATE payments
    SET credits_purchased = 0
    WHERE credits_purchased IS NULL;

-- Extend user profile with payment preferences and stats
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS preferred_payment_mode VARCHAR(20) DEFAULT 'direct';
UPDATE users
    SET preferred_payment_mode = 'direct'
    WHERE preferred_payment_mode IS NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_credits_purchased INTEGER DEFAULT 0;
UPDATE users
    SET total_credits_purchased = 0
    WHERE total_credits_purchased IS NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_payouts_received BIGINT DEFAULT 0;
UPDATE users
    SET total_payouts_received = 0
    WHERE total_payouts_received IS NULL;

-- Ensure total_games_played always has a sensible default
ALTER TABLE users
    ALTER COLUMN total_games_played SET DEFAULT 0;
UPDATE users
    SET total_games_played = 0
    WHERE total_games_played IS NULL;

-- Ensure credit_transactions table exists for installs that missed migration 004
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'credit_transactions'
    ) THEN
        CREATE TABLE credit_transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            amount INTEGER NOT NULL,
            reason VARCHAR(100) NOT NULL,
            balance_after INTEGER NOT NULL,
            transaction_type VARCHAR(20) DEFAULT 'legacy',
            created_at TIMESTAMP DEFAULT NOW(),
            metadata JSONB
        );
    END IF;
END $$;

-- Tag credit transactions with a transaction type
ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(20);
UPDATE credit_transactions
    SET transaction_type = COALESCE(transaction_type, 'legacy');
ALTER TABLE credit_transactions
    ALTER COLUMN transaction_type SET DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON credit_transactions(created_at);

-- Create payouts table if it was dropped in the past (fresh installs)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'payouts'
    ) THEN
        CREATE TABLE payouts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
            payout_address VARCHAR(110) NOT NULL,
            amount BIGINT NOT NULL,
            multiplier DECIMAL(3,1) DEFAULT 0,
            reason VARCHAR(50) DEFAULT 'legacy' NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            batch_id VARCHAR(50),
            tx_hash VARCHAR(64),
            fee BIGINT,
            created_at TIMESTAMP DEFAULT NOW(),
            processed_at TIMESTAMP,
            error_message TEXT
        );
    END IF;
END $$;

-- Add new payout tracking columns for existing installs
ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS multiplier DECIMAL(3,1) DEFAULT 0;
UPDATE payouts
    SET multiplier = 0
    WHERE multiplier IS NULL;
ALTER TABLE payouts
    ALTER COLUMN multiplier SET NOT NULL;

ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS reason VARCHAR(50) DEFAULT 'legacy';
UPDATE payouts
    SET reason = 'legacy'
    WHERE reason IS NULL;
ALTER TABLE payouts
    ALTER COLUMN reason SET NOT NULL;

ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Align payout address length with Wownero expectations
DROP VIEW IF EXISTS pending_payouts;

ALTER TABLE payouts
    ALTER COLUMN payout_address TYPE VARCHAR(110);

CREATE OR REPLACE VIEW pending_payouts AS
SELECT 
    p.id,
    p.user_id,
    u.username,
    p.payout_address,
    p.amount,
    p.status,
    p.created_at,
    g.outcome AS game_outcome
FROM payouts p
JOIN users u ON p.user_id = u.id
LEFT JOIN games g ON p.game_id = g.id
WHERE p.status = 'pending'
ORDER BY p.created_at ASC;

-- Add helpful indexes for new queries
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_user_id ON payouts(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_mode ON payments(payment_mode);
