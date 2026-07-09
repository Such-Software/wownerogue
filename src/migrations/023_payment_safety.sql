-- Migration 023: Payment safety — one game per confirmed single_game payment
--
-- M3: claiming a confirmed single_game payment must be atomic. The application locks the
-- payment row FOR UPDATE while linking the game, but this partial unique index is the
-- final backstop: at most one games row may reference a given payment_id. A concurrent
-- start that races past the lock hits a 23505 unique_violation (handled gracefully in
-- gameModeManager._processGameStartWithPayment as "already consumed"), so a single paid
-- entry can never spawn two games.

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_payment_id
ON games(payment_id)
WHERE payment_id IS NOT NULL;
