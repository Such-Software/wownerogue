-- Migration 009: Smirk wallet integration
-- Adds support for "Login with Smirk" wallet authentication

-- Add Smirk public key to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS smirk_public_key VARCHAR(128);

-- Unique constraint on Smirk public key (one wallet per user account)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_smirk_public_key
ON users(smirk_public_key)
WHERE smirk_public_key IS NOT NULL;

-- Challenge storage for authentication flow
-- Challenges expire after 5 minutes and are single-use
CREATE TABLE IF NOT EXISTS smirk_challenges (
    id SERIAL PRIMARY KEY,
    challenge VARCHAR(64) NOT NULL UNIQUE,
    socket_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '5 minutes'),
    used BOOLEAN DEFAULT FALSE
);

-- Index for looking up challenges by socket
CREATE INDEX IF NOT EXISTS idx_smirk_challenges_socket
ON smirk_challenges(socket_id);

-- Index for cleanup of expired challenges
CREATE INDEX IF NOT EXISTS idx_smirk_challenges_expires
ON smirk_challenges(expires_at);

-- Cleanup function for expired challenges (run periodically)
-- DELETE FROM smirk_challenges WHERE expires_at < NOW() OR used = TRUE;
