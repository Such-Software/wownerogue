-- Migration 012: Payout safety constraints
-- Prevents double payouts and locks payout address at game start

-- Only one active (pending/completed) payout per game
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_one_per_game
ON payouts(game_id)
WHERE game_id IS NOT NULL AND status IN ('pending', 'completed');

-- Store the payout address at game start so it can't be changed mid-game
ALTER TABLE games
    ADD COLUMN IF NOT EXISTS payout_address VARCHAR(200);
