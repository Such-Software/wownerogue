-- Migration 003: Add anonymous session token + last_seen
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS anon_token VARCHAR(64) UNIQUE,
    ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_anon_token ON users(anon_token);
