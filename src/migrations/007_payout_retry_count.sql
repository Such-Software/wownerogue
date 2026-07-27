-- Migration 007: Add retry tracking for failed payouts
-- Allows payouts to be retried up to PAYOUT_MAX_RETRIES times before permanent failure

-- Add retry_count column to track attempts
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Add last_error column to store the most recent failure reason
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Add last_retry_at to track when the last retry happened
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMP;

-- Create index for finding payouts that need retry
CREATE INDEX IF NOT EXISTS idx_payouts_retry ON payouts(status, retry_count) WHERE status = 'pending';

-- Update any existing failed payouts to have retry_count = max (so they stay failed)
-- This prevents old failures from being retried unexpectedly
UPDATE payouts SET retry_count = 999 WHERE status = 'failed' AND retry_count = 0;
