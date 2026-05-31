-- Migration 015: Allow batched payouts to share a tx_hash; tighten one-per-game guard
--
-- `transfer_split` sends ONE on-chain transaction to many destinations, so multiple
-- payout rows in a batch legitimately share the same tx_hash. The old UNIQUE index on
-- payouts.tx_hash (migration 008) made the 2nd+ row in a batch fail to record its
-- tx_hash, leaving funds already sent but rows stranded in 'processing' — and at risk
-- of being re-sent by the retry service (a double-payout vector).
--
-- Payout idempotency does NOT depend on tx_hash uniqueness; it is enforced by
-- idx_payouts_one_per_game (one active payout per game). So we drop the payouts
-- tx_hash unique index. (The payments.tx_hash unique index stays — incoming payments
-- are 1:1 with a transaction.)
DROP INDEX IF EXISTS idx_payouts_tx_hash_unique;

-- Extend the one-active-payout-per-game guard to also cover 'processing', so a second
-- payable row cannot be inserted for a game while its payout is mid-flight.
DROP INDEX IF EXISTS idx_payouts_one_per_game;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_one_per_game
ON payouts(game_id)
WHERE game_id IS NOT NULL AND status IN ('pending', 'processing', 'completed');
