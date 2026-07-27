-- Migration 008: Add UNIQUE constraints on tx_hash for idempotency
-- Prevents duplicate transaction processing which could lead to double-crediting or double-payouts

-- Unique constraint on payments.tx_hash (partial index - only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_tx_hash_unique
ON payments(tx_hash)
WHERE tx_hash IS NOT NULL;

-- Unique constraint on payouts.tx_hash (partial index - only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_tx_hash_unique
ON payouts(tx_hash)
WHERE tx_hash IS NOT NULL;
