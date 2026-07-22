-- Migration 032: immutable solo payout commitments and unconditional payout identity
--
-- A paid game's payout eligibility and exact terms are committed in the same transaction
-- that consumes its entry.  Runtime kill switches may pause dispatch, but cannot erase or
-- retroactively create an already-committed liability.
ALTER TABLE games
    ADD COLUMN IF NOT EXISTS payout_eligible BOOLEAN,
    ADD COLUMN IF NOT EXISTS payout_terms JSONB,
    ADD COLUMN IF NOT EXISTS payout_committed_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'games_payout_commitment_complete'
    ) THEN
        ALTER TABLE games
            ADD CONSTRAINT games_payout_commitment_complete
            CHECK (
                payout_committed_at IS NULL
                OR (payout_eligible IS NOT NULL AND payout_terms IS NOT NULL)
            ) NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_game_payout_commitment_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.payout_committed_at IS NOT NULL AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.payout_eligible IS DISTINCT FROM OLD.payout_eligible
        OR NEW.payout_terms IS DISTINCT FROM OLD.payout_terms
        OR NEW.payout_committed_at IS DISTINCT FROM OLD.payout_committed_at
        OR NEW.payout_escape_amount IS DISTINCT FROM OLD.payout_escape_amount
        OR NEW.payout_treasure_amount IS DISTINCT FROM OLD.payout_treasure_amount
        OR NEW.payout_escape_mult IS DISTINCT FROM OLD.payout_escape_mult
        OR NEW.payout_treasure_mult IS DISTINCT FROM OLD.payout_treasure_mult
        OR NEW.payout_address IS DISTINCT FROM OLD.payout_address
        OR NEW.game_mode IS DISTINCT FROM OLD.game_mode
        OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
    ) THEN
        RAISE EXCEPTION 'committed solo payout terms are immutable for game %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    IF OLD.payout_committed_at IS NULL
        AND NEW.payout_committed_at IS NOT NULL
        AND NEW.user_id IS DISTINCT FROM OLD.user_id
    THEN
        RAISE EXCEPTION 'solo payout owner cannot change while committing game %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_games_immutable_payout_commitment ON games;
CREATE TRIGGER trg_games_immutable_payout_commitment
    BEFORE UPDATE ON games
    FOR EACH ROW
    EXECUTE FUNCTION reject_game_payout_commitment_mutation();

-- Refuse to weaken identity silently if historical duplicate obligations exist. Operators
-- must reconcile them explicitly before this migration can complete.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM payouts
        WHERE game_id IS NOT NULL
        GROUP BY game_id HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot enforce one payout per game: duplicate game_id obligations exist';
    END IF;
    IF EXISTS (
        SELECT 1 FROM payouts
        WHERE match_id IS NOT NULL
        GROUP BY match_id HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot enforce one payout per match: duplicate match_id obligations exist';
    END IF;
END $$;

-- Status changes (including failed/needs_review) never release the identity. A possibly
-- broadcast payout must not permit a replacement row for the same game or match.
DROP INDEX IF EXISTS idx_payouts_one_per_game;
CREATE UNIQUE INDEX idx_payouts_one_per_game
    ON payouts(game_id)
    WHERE game_id IS NOT NULL;

DROP INDEX IF EXISTS idx_payouts_one_per_match;
CREATE UNIQUE INDEX idx_payouts_one_per_match
    ON payouts(match_id)
    WHERE match_id IS NOT NULL;
