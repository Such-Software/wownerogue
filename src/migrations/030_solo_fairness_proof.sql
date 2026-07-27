-- Durable two-party proof material for solo games. The server seed is stored privately for
-- crash/audit recovery but is exposed by verification routes only after the game completes.

ALTER TABLE games
    ADD COLUMN IF NOT EXISTS proof_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS fairness_offer_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS fairness_offer_issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS proof_commitment CHAR(64),
    ADD COLUMN IF NOT EXISTS server_seed CHAR(64),
    ADD COLUMN IF NOT EXISTS client_seed VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS effective_seed CHAR(64),
    ADD COLUMN IF NOT EXISTS layout_fingerprint CHAR(64),
    ADD COLUMN IF NOT EXISTS proof_context JSONB,
    ADD COLUMN IF NOT EXISTS proof_revealed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_fairness_offer_once
    ON games (fairness_offer_id)
    WHERE fairness_offer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_games_proof_commitment
    ON games (proof_commitment)
    WHERE proof_commitment IS NOT NULL;
