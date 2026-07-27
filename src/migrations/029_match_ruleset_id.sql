-- Persist the operator-selected gameplay ruleset independently from the coarse legacy
-- matches.variant ('race'/'pvp'). Existing rows are classic races; new built-ins such as
-- score-attack and coop-escape remain fully auditable without widening money/economy keys.

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS ruleset_id VARCHAR(64) NOT NULL DEFAULT 'race';

CREATE INDEX IF NOT EXISTS idx_matches_ruleset_finished
    ON matches (ruleset_id, ended_at DESC)
    WHERE status = 'finished';
