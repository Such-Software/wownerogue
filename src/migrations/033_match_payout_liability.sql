-- Durable match payout terms.
--
-- A crypto match consumes escrow only after these fields are written in the same transaction.
-- They are an immutable acceptance snapshot: later configuration changes may stop new matches
-- or pause dispatch, but cannot erase or manufacture a liability for an already accepted match.

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS payout_liability_amount_atomic BIGINT,
    ADD COLUMN IF NOT EXISTS payout_liability_cap_atomic BIGINT,
    ADD COLUMN IF NOT EXISTS payout_liability_terms JSONB,
    ADD COLUMN IF NOT EXISTS payout_liability_accepted_at TIMESTAMPTZ;

-- Paid ticket lots preserve the accepted atomic backing for every future crypto entry. Fungible
-- user.race_entries remains the UI balance, but only a ticket with a funded lot can enter a crypto
-- payout match; legacy/admin-granted tickets remain usable only outside that liability path.
CREATE TABLE IF NOT EXISTS race_entry_lots (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    unit_value_atomic BIGINT NOT NULL CHECK (unit_value_atomic > 0),
    original_entries INT NOT NULL CHECK (original_entries > 0),
    remaining_entries INT NOT NULL CONSTRAINT race_entry_lots_remaining_within_original CHECK (
        remaining_entries >= 0 AND remaining_entries <= original_entries
    ),
    product_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_race_entry_lots_user_available
    ON race_entry_lots (user_id, created_at, id)
    WHERE remaining_entries > 0;

-- The backing identity and accepted economics of a lot are append-only. Redemption/refund
-- workflows may only reduce remaining_entries (and later migrations may add terminal markers).
CREATE OR REPLACE FUNCTION reject_race_entry_lot_backing_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
        OR NEW.unit_value_atomic IS DISTINCT FROM OLD.unit_value_atomic
        OR NEW.original_entries IS DISTINCT FROM OLD.original_entries
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'race entry lot backing is immutable for lot %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_race_entry_lot_immutable_backing ON race_entry_lots;
CREATE TRIGGER trg_race_entry_lot_immutable_backing
    BEFORE UPDATE ON race_entry_lots
    FOR EACH ROW
    EXECUTE FUNCTION reject_race_entry_lot_backing_mutation();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'race_entry_lots_remaining_within_original'
    ) THEN
        ALTER TABLE race_entry_lots
            ADD CONSTRAINT race_entry_lots_remaining_within_original
            CHECK (remaining_entries >= 0 AND remaining_entries <= original_entries) NOT VALID;
    END IF;
END $$;

-- One durable queue row is the idempotency anchor for one escrow hold/refund. `consumed` is a
-- terminal successful-start state; stale queue cleanup must never treat it as refundable merely
-- because time passed. The exact held amount survives config changes and concurrent re-queues.
ALTER TABLE match_queue_entries
    ADD COLUMN IF NOT EXISTS escrow_amount BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS escrow_value_atomic BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS race_entry_lot_id BIGINT
        REFERENCES race_entry_lots(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

ALTER TABLE match_queue_entries
    DROP CONSTRAINT IF EXISTS match_queue_entries_status_check;
ALTER TABLE match_queue_entries
    ADD CONSTRAINT match_queue_entries_status_check
    CHECK (status IN ('queued', 'matched', 'consumed', 'cancelled')) NOT VALID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'match_queue_entries_escrow_nonnegative'
    ) THEN
        ALTER TABLE match_queue_entries
            ADD CONSTRAINT match_queue_entries_escrow_nonnegative
            CHECK (escrow_amount >= 0 AND escrow_value_atomic >= 0) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'match_queue_committed_escrow_complete'
    ) THEN
        ALTER TABLE match_queue_entries
            ADD CONSTRAINT match_queue_committed_escrow_complete CHECK (
                status NOT IN ('matched', 'consumed')
                OR economy = 'free'
                OR (economy = 'credits_prestige' AND escrow_amount > 0)
                OR (
                    economy = 'crypto_race'
                    AND escrow_amount = 1
                    AND escrow_value_atomic > 0
                    AND race_entry_lot_id IS NOT NULL
                )
            ) NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_committed_match_queue_escrow_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('matched', 'consumed', 'cancelled') AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.economy IS DISTINCT FROM OLD.economy
        OR NEW.escrow_amount IS DISTINCT FROM OLD.escrow_amount
        OR NEW.escrow_value_atomic IS DISTINCT FROM OLD.escrow_value_atomic
        OR NEW.race_entry_lot_id IS DISTINCT FROM OLD.race_entry_lot_id
    ) THEN
        RAISE EXCEPTION 'committed queue escrow is immutable for queue entry %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_match_queue_immutable_committed_escrow ON match_queue_entries;
CREATE TRIGGER trg_match_queue_immutable_committed_escrow
    BEFORE UPDATE ON match_queue_entries
    FOR EACH ROW
    EXECUTE FUNCTION reject_committed_match_queue_escrow_mutation();

ALTER TABLE match_entrants
    ADD COLUMN IF NOT EXISTS queue_entry_id BIGINT
        REFERENCES match_queue_entries(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS entry_refunded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_entrants_queue_entry
    ON match_entrants (queue_entry_id)
    WHERE queue_entry_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'matches_payout_liability_amount_nonnegative'
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_payout_liability_amount_nonnegative
            CHECK (payout_liability_amount_atomic IS NULL OR payout_liability_amount_atomic >= 0)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'matches_payout_liability_cap_positive'
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_payout_liability_cap_positive
            CHECK (payout_liability_cap_atomic IS NULL OR payout_liability_cap_atomic > 0)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'matches_payout_liability_complete'
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_payout_liability_complete
            CHECK (
                payout_liability_accepted_at IS NULL
                OR (
                    economy = 'crypto_race'
                    AND payout_liability_amount_atomic IS NOT NULL
                    AND payout_liability_amount_atomic > 0
                    AND payout_liability_cap_atomic IS NOT NULL
                    AND payout_liability_amount_atomic <= payout_liability_cap_atomic
                    AND payout_liability_terms IS NOT NULL
                )
            ) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'matches_payout_liability_economics_consistent'
    ) THEN
        ALTER TABLE matches
            ADD CONSTRAINT matches_payout_liability_economics_consistent
            CHECK (
                payout_liability_accepted_at IS NULL
                OR (
                    entry_fee_atomic > 0
                    AND pot_atomic > 0
                    AND house_fee_atomic >= 0
                    AND house_fee_atomic < pot_atomic
                    AND payout_liability_amount_atomic = pot_atomic - house_fee_atomic
                )
            ) NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_match_payout_liability_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.payout_liability_accepted_at IS NOT NULL AND (
        NEW.payout_liability_amount_atomic IS DISTINCT FROM OLD.payout_liability_amount_atomic
        OR NEW.payout_liability_cap_atomic IS DISTINCT FROM OLD.payout_liability_cap_atomic
        OR NEW.payout_liability_terms IS DISTINCT FROM OLD.payout_liability_terms
        OR NEW.payout_liability_accepted_at IS DISTINCT FROM OLD.payout_liability_accepted_at
        OR NEW.entry_fee_atomic IS DISTINCT FROM OLD.entry_fee_atomic
        OR NEW.pot_atomic IS DISTINCT FROM OLD.pot_atomic
        OR NEW.house_fee_atomic IS DISTINCT FROM OLD.house_fee_atomic
        OR NEW.house_fee_percent IS DISTINCT FROM OLD.house_fee_percent
    ) THEN
        RAISE EXCEPTION 'accepted match payout liability is immutable for match %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_matches_immutable_payout_liability ON matches;
CREATE TRIGGER trg_matches_immutable_payout_liability
    BEFORE UPDATE ON matches
    FOR EACH ROW
    EXECUTE FUNCTION reject_match_payout_liability_mutation();

CREATE INDEX IF NOT EXISTS idx_matches_unsettled_payout_liability
    ON matches (ended_at, id)
    WHERE economy = 'crypto_race'
      AND status = 'finished'
      AND winner_user_id IS NOT NULL
      AND payout_liability_accepted_at IS NOT NULL;
