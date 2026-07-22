-- Migration 040: durable proof that a paid entrant freeze committed before its entropy block.
--
-- A pending match first commits its exact entrants and future target. Only after that transaction
-- is durably visible may the server read a fresh daemon tip and record that the target still did
-- not exist. These two columns are that post-commit witness. Legacy/unverified freezes are refunded
-- at startup and may never activate.

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS entropy_precommit_tip_height BIGINT,
    ADD COLUMN IF NOT EXISTS entropy_precommit_verified_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'matches_entropy_precommit_shape'
          AND conrelid = 'matches'::regclass
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_entropy_precommit_shape CHECK (
                (entropy_precommit_tip_height IS NULL
                    AND entropy_precommit_verified_at IS NULL)
                OR
                (entropy_precommit_tip_height IS NOT NULL
                    AND entropy_precommit_verified_at IS NOT NULL
                    AND entropy_precommit_tip_height >= 0
                    AND start_block_height IS NOT NULL
                    AND entropy_precommit_tip_height < start_block_height
                    AND economy IN ('credits_prestige', 'crypto_race'))
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_match_entropy_precommit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.entropy_precommit_verified_at IS NOT NULL AND (
        NEW.entropy_precommit_tip_height IS DISTINCT FROM OLD.entropy_precommit_tip_height
        OR NEW.entropy_precommit_verified_at IS DISTINCT FROM OLD.entropy_precommit_verified_at
    ) THEN
        RAISE EXCEPTION 'paid entropy precommit proof is immutable for match %', OLD.id
            USING ERRCODE = '23514';
    END IF;

    -- Recording the proof locks the paid freeze identity. The one permitted identity-changing
    -- transition is the application's pending -> starting activation, whose conditional UPDATE
    -- proves the commitment, target, economy, and marker. Once starting, normal lifecycle writes
    -- change only status/times, seed reveal, winner, and liability fields.
    IF OLD.entropy_precommit_verified_at IS NOT NULL
        AND NOT (OLD.status = 'pending' AND NEW.status = 'starting')
        AND (
            NEW.id IS DISTINCT FROM OLD.id
            OR NEW.economy IS DISTINCT FROM OLD.economy
            OR NEW.variant IS DISTINCT FROM OLD.variant
            OR NEW.ruleset_id IS DISTINCT FROM OLD.ruleset_id
            OR NEW.difficulty_preset IS DISTINCT FROM OLD.difficulty_preset
            OR NEW.max_players IS DISTINCT FROM OLD.max_players
            OR NEW.seed_hash IS DISTINCT FROM OLD.seed_hash
            OR NEW.dungeon IS DISTINCT FROM OLD.dungeon
            OR NEW.start_block_height IS DISTINCT FROM OLD.start_block_height
        )
    THEN
        RAISE EXCEPTION 'paid match fairness identity is immutable after precommit for match %', OLD.id
            USING ERRCODE = '23514';
    END IF;

    IF OLD.entropy_precommit_verified_at IS NULL
        AND NEW.entropy_precommit_verified_at IS NOT NULL
        AND (
            OLD.status <> 'pending'
            OR OLD.economy NOT IN ('credits_prestige', 'crypto_race')
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.economy IS DISTINCT FROM OLD.economy
            OR NEW.seed_hash IS DISTINCT FROM OLD.seed_hash
            OR NEW.dungeon IS DISTINCT FROM OLD.dungeon
            OR NEW.start_block_height IS DISTINCT FROM OLD.start_block_height
        )
    THEN
        RAISE EXCEPTION 'paid freeze identity cannot change while recording precommit proof for match %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_matches_immutable_entropy_precommit ON matches;
CREATE TRIGGER trg_matches_immutable_entropy_precommit
    BEFORE UPDATE ON matches
    FOR EACH ROW
    EXECUTE FUNCTION reject_match_entropy_precommit_mutation();
