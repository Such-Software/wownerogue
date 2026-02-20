-- Migration 014: Score persistence and leaderboard support
-- Adds score column to games, high_score and display_name to users

-- Add score to games table (persists calculated score at game end)
ALTER TABLE games ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;

-- Add high_score to users for quick leaderboard lookups
ALTER TABLE users ADD COLUMN IF NOT EXISTS high_score INTEGER DEFAULT 0;

-- Add display_name for leaderboard identity (set via /nick command)
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);

-- Indexes for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_games_score ON games(score DESC) WHERE status = 'won';
CREATE INDEX IF NOT EXISTS idx_users_high_score ON users(high_score DESC) WHERE high_score > 0;
