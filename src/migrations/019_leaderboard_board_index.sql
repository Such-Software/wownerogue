-- Migration 019: Index for the per-game leaderboard split (Pleb vs Hall of Champions)
--
-- The leaderboard is split by game_mode: free games -> Pleb board, paid (credits/entry)
-- games -> Hall of Champions. This composite index supports both filtered queries
-- (score-ranked, restricted to ranked games).
CREATE INDEX IF NOT EXISTS idx_games_leaderboard
ON games (game_mode, score DESC)
WHERE status IN ('won', 'lost') AND score > 0;
