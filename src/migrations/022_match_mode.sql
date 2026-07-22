-- Migration 022: Match (race) mode foundation
--
-- Adds normalized tables for multiplayer races. Keeps existing games/payments/payouts
-- tables untouched except for one nullable foreign-key column on payouts.
--
-- Design notes:
-- - One fact, one table: matches, entrants, events, queue, and ticket ledger are separate.
-- - All money movement uses DatabaseManager.withTransaction() at the application layer.
-- - Verifiable commitment: seed_hash stored at creation and seed revealed on finish. Production
--   paid matches additionally persist chain-block derivation metadata inside dungeon JSON.
-- - Tickets (race_entries) are non-refundable crypto-race entry tokens; they avoid the
--   need for on-chain refunds when a player leaves the queue before a match starts.

-- -----------------------------------------------------------------------------
-- 1. Matches: one row per race
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'starting', 'active', 'finished', 'cancelled')),
    economy VARCHAR(20) NOT NULL
        CHECK (economy IN ('free', 'credits_prestige', 'crypto_race')),
    variant VARCHAR(20) NOT NULL DEFAULT 'race'
        CHECK (variant IN ('race', 'pvp')),
    difficulty_preset VARCHAR(20) NOT NULL,
    max_players INT NOT NULL DEFAULT 4
        CHECK (max_players >= 2 AND max_players <= 32),
    seed_hash VARCHAR(64) NOT NULL,
    seed VARCHAR(255),                              -- revealed on finish for verification
    dungeon JSONB NOT NULL,                         -- deterministic dungeon snapshot
    start_block_height BIGINT,                      -- block that triggered the race start
    end_block_height BIGINT,                        -- block that ended the race (if applicable)
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    -- Economy fields (all atomic currency units, BIGINT)
    entry_fee_atomic BIGINT DEFAULT 0
        CHECK (entry_fee_atomic >= 0),
    pot_atomic BIGINT DEFAULT 0
        CHECK (pot_atomic >= 0),
    house_fee_atomic BIGINT DEFAULT 0
        CHECK (house_fee_atomic >= 0),
    house_fee_percent DECIMAL(5, 2) DEFAULT 0
        CHECK (house_fee_percent >= 0 AND house_fee_percent <= 100),
    winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_economy_finished ON matches(economy, ended_at)
    WHERE status = 'finished';
CREATE INDEX IF NOT EXISTS idx_matches_start_block ON matches(start_block_height)
    WHERE start_block_height IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Match entrants: one row per player per match
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_entrants (
    id BIGSERIAL PRIMARY KEY,
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    socket_id VARCHAR(255) NOT NULL,
    placement INT,
    escaped BOOLEAN DEFAULT FALSE,
    has_treasure BOOLEAN DEFAULT FALSE,
    killed_by VARCHAR(50),                          -- 'monster', 'player:<id>', 'timeout', 'afk'
    score INT DEFAULT 0
        CHECK (score >= 0),
    payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
    entry_consumed BOOLEAN DEFAULT FALSE,           -- true once match actually starts
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_entrants_user_match
    ON match_entrants(match_id, user_id);
CREATE INDEX IF NOT EXISTS idx_match_entrants_match
    ON match_entrants(match_id);
CREATE INDEX IF NOT EXISTS idx_match_entrants_placement
    ON match_entrants(match_id, placement, score DESC);

-- -----------------------------------------------------------------------------
-- 3. Match events: replay / spectator / audit feed
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_events (
    id BIGSERIAL PRIMARY KEY,
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    tick INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_events_match_tick
    ON match_events(match_id, tick);

-- -----------------------------------------------------------------------------
-- 4. Match queue entries: persisted queue state for restart safety
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_queue_entries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    economy VARCHAR(20) NOT NULL
        CHECK (economy IN ('free', 'credits_prestige', 'crypto_race')),
    socket_id VARCHAR(255) NOT NULL,
    session_token VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'matched', 'cancelled')),
    match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    matched_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_queue_user_economy_queued
    ON match_queue_entries(user_id, economy)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_match_queue_economy_created
    ON match_queue_entries(economy, created_at)
    WHERE status = 'queued';

-- -----------------------------------------------------------------------------
-- 5. Race entry ticket balance and ledger
-- -----------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS race_entries INT NOT NULL DEFAULT 0
    CHECK (race_entries >= 0);

CREATE TABLE IF NOT EXISTS race_entry_transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INT NOT NULL,
    balance_after INT NOT NULL,
    reason VARCHAR(50) NOT NULL
        CHECK (reason IN ('purchase', 'refund', 'queue_join', 'queue_leave', 'match_start', 'match_cancel', 'admin_grant')),
    match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
    payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_race_entry_tx_user
    ON race_entry_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_race_entry_tx_match
    ON race_entry_transactions(match_id)
    WHERE match_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 6. Link payouts to matches (nullable, additive only)
-- -----------------------------------------------------------------------------
ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS match_id UUID REFERENCES matches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payouts_match
    ON payouts(match_id)
    WHERE match_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 7. Prestige leaderboard view (credit-prestige races)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW prestige_leaderboard AS
SELECT
    u.id AS user_id,
    u.display_name,
    MAX(me.score) AS best_score,
    COUNT(*) FILTER (WHERE me.escaped) AS wins,
    COUNT(*) AS races,
    MAX(m.ended_at) AS last_race_at
FROM match_entrants me
JOIN matches m ON me.match_id = m.id
JOIN users u ON me.user_id = u.id
WHERE m.economy = 'credits_prestige'
  AND m.status = 'finished'
  AND me.score > 0
GROUP BY u.id, u.display_name;

-- -----------------------------------------------------------------------------
-- 8. Safety constraints
-- -----------------------------------------------------------------------------

-- Only one active (pending/completed) payout per match, preventing double payouts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_one_per_match
    ON payouts(match_id)
    WHERE match_id IS NOT NULL AND status IN ('pending', 'completed');

-- Only one finished winner record per match (business rule, not a constraint, because
-- ties are resolved deterministically by the engine; this index supports the lookup).
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_finished_winner
    ON matches(id, winner_user_id)
    WHERE status = 'finished' AND winner_user_id IS NOT NULL;
