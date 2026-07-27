-- Durable payment entitlements, entry-consumption evidence, and payment-bound fairness.
--
-- A confirmed invoice must never become claimable again after it has been converted into
-- another entitlement. Product refunds need an exact, payment-scoped grant record so every
-- reversible benefit can be locked and revoked before any wallet transfer is attempted.

CREATE TABLE IF NOT EXISTS payment_entitlement_grants (
    payment_id INTEGER PRIMARY KEY REFERENCES payments(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source VARCHAR(40) NOT NULL,
    credits_granted BIGINT NOT NULL DEFAULT 0 CHECK (credits_granted >= 0),
    purchase_progress_granted BIGINT NOT NULL DEFAULT 0 CHECK (purchase_progress_granted >= 0),
    race_entries_granted INTEGER NOT NULL DEFAULT 0 CHECK (race_entries_granted >= 0),
    packs_granted JSONB NOT NULL DEFAULT '[]'::jsonb,
    premium_level_granted VARCHAR(32),
    premium_level_previous VARCHAR(32),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reversed', 'needs_review')),
    credits_reversed BIGINT NOT NULL DEFAULT 0 CHECK (credits_reversed >= 0),
    purchase_progress_reversed BIGINT NOT NULL DEFAULT 0
        CHECK (purchase_progress_reversed >= 0),
    race_entries_reversed INTEGER NOT NULL DEFAULT 0 CHECK (race_entries_reversed >= 0),
    packs_reversed JSONB NOT NULL DEFAULT '[]'::jsonb,
    reversal_reason TEXT,
    reversed_at TIMESTAMPTZ,
    needs_review_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payment_entitlement_packs_array
        CHECK (jsonb_typeof(packs_granted) = 'array' AND jsonb_typeof(packs_reversed) = 'array'),
    CONSTRAINT payment_entitlement_reversal_bounds
        CHECK (credits_reversed <= credits_granted
            AND purchase_progress_reversed <= purchase_progress_granted
            AND race_entries_reversed <= race_entries_granted),
    CONSTRAINT payment_entitlement_state_shape CHECK (
        (status = 'active' AND reversed_at IS NULL)
        OR (status = 'reversed' AND reversed_at IS NOT NULL)
        OR (status = 'needs_review' AND needs_review_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_entitlement_user
    ON payment_entitlement_grants(user_id, created_at DESC);

-- Tie fungible ledgers to their invoice. Partial indexes are final idempotency backstops in
-- addition to the payment/refund row locks used by the application.
ALTER TABLE credit_transactions
    ADD COLUMN IF NOT EXISTS payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_payment_grant_once
    ON credit_transactions(payment_id)
    WHERE payment_id IS NOT NULL AND transaction_type IN ('purchase', 'recovery');

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_payment_refund_once
    ON credit_transactions(payment_id)
    WHERE payment_id IS NOT NULL AND transaction_type = 'refund';

CREATE UNIQUE INDEX IF NOT EXISTS idx_race_entry_tx_payment_refund_once
    ON race_entry_transactions(payment_id)
    WHERE payment_id IS NOT NULL AND reason = 'refund';

ALTER TABLE race_entry_lots
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'race_entry_lots_refund_shape'
    ) THEN
        ALTER TABLE race_entry_lots
            ADD CONSTRAINT race_entry_lots_refund_shape
            CHECK (refunded_at IS NULL OR remaining_entries = 0) NOT VALID;
    END IF;
END $$;

ALTER TABLE payment_refunds
    ADD COLUMN IF NOT EXISTS purchase_progress_deducted BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS race_entries_deducted INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS packs_revoked JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS premium_level_restored VARCHAR(32),
    ADD COLUMN IF NOT EXISTS entitlement_grant_payment_id INTEGER
        REFERENCES payment_entitlement_grants(payment_id) ON DELETE RESTRICT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payment_refunds_progress_nonnegative'
    ) THEN
        ALTER TABLE payment_refunds
            ADD CONSTRAINT payment_refunds_progress_nonnegative
            CHECK (purchase_progress_deducted >= 0) NOT VALID;
    END IF;
END $$;

-- A game mode label is not evidence that value was taken. Startup recovery may refund only the
-- exact entry snapshot committed in the same transaction that debited/linked the entry.
ALTER TABLE games
    ADD COLUMN IF NOT EXISTS entry_consumed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS entry_credits_spent INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'games_entry_consumption_shape'
    ) THEN
        ALTER TABLE games
            ADD CONSTRAINT games_entry_consumption_shape CHECK (
                entry_credits_spent IS NULL OR entry_credits_spent > 0
            ) NOT VALID;
    END IF;
END $$;

-- Bind the secret half of a v2 fairness offer to the invoice before an address is shown. The
-- server seed remains private until the linked game ends; only its hash is sent to the client.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS fairness_proof_version SMALLINT,
    ADD COLUMN IF NOT EXISTS fairness_offer_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS fairness_offer_issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fairness_commitment CHAR(64),
    ADD COLUMN IF NOT EXISTS fairness_server_seed CHAR(64),
    ADD COLUMN IF NOT EXISTS fairness_client_seed VARCHAR(64),
    ADD COLUMN IF NOT EXISTS fairness_bound_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fairness_consumed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_fairness_offer_once
    ON payments(fairness_offer_id)
    WHERE fairness_offer_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payments_fairness_binding_complete'
    ) THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_fairness_binding_complete CHECK (
                fairness_bound_at IS NULL OR (
                    payment_type = 'single_game'
                    AND fairness_proof_version = 2
                    AND fairness_offer_id IS NOT NULL
                    AND fairness_offer_issued_at IS NOT NULL
                    AND fairness_commitment ~ '^[0-9a-f]{64}$'
                    AND fairness_server_seed ~ '^[0-9a-f]{64}$'
                    AND fairness_client_seed IS NOT NULL
                )
            ) NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_payment_fairness_binding_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.fairness_bound_at IS NOT NULL AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
        OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
        OR NEW.subaddress IS DISTINCT FROM OLD.subaddress
        OR NEW.address_index IS DISTINCT FROM OLD.address_index
        OR NEW.fairness_proof_version IS DISTINCT FROM OLD.fairness_proof_version
        OR NEW.fairness_offer_id IS DISTINCT FROM OLD.fairness_offer_id
        OR NEW.fairness_offer_issued_at IS DISTINCT FROM OLD.fairness_offer_issued_at
        OR NEW.fairness_commitment IS DISTINCT FROM OLD.fairness_commitment
        OR NEW.fairness_server_seed IS DISTINCT FROM OLD.fairness_server_seed
        OR NEW.fairness_client_seed IS DISTINCT FROM OLD.fairness_client_seed
        OR NEW.fairness_bound_at IS DISTINCT FROM OLD.fairness_bound_at
        OR (OLD.fairness_consumed_at IS NOT NULL
            AND NEW.fairness_consumed_at IS DISTINCT FROM OLD.fairness_consumed_at)
    ) THEN
        RAISE EXCEPTION 'payment fairness binding is immutable for payment %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    IF OLD.fairness_bound_at IS NULL AND NEW.fairness_bound_at IS NOT NULL AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
        OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
        OR NEW.subaddress IS DISTINCT FROM OLD.subaddress
        OR NEW.address_index IS DISTINCT FROM OLD.address_index
    ) THEN
        RAISE EXCEPTION 'payment identity cannot change while binding fairness proof for payment %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_immutable_fairness_binding ON payments;
CREATE TRIGGER trg_payments_immutable_fairness_binding
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION reject_payment_fairness_binding_mutation();

-- Runtime fallback queries still recognize the legacy reason key, but backfill it into the
-- canonical marker and ledger FK so upgraded installations immediately get the same invariant.
WITH recovered AS (
    SELECT DISTINCT ON ((substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer)
        (substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer AS payment_id,
        ct.user_id,
        GREATEST(ct.amount, 0)::bigint AS credits_granted,
        ct.id AS credit_transaction_id
    FROM credit_transactions ct
    WHERE ct.reason ~ '^single_game_recovered:[0-9]+$'
    ORDER BY (substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer, ct.id
)
INSERT INTO payment_entitlement_grants (
    payment_id, user_id, source, credits_granted, metadata
)
SELECT r.payment_id, r.user_id, 'single_game_recovery', r.credits_granted,
       jsonb_build_object('legacyBackfill', true, 'creditTransactionId', r.credit_transaction_id)
FROM recovered r
JOIN payments p ON p.id = r.payment_id AND p.user_id = r.user_id
ON CONFLICT (payment_id) DO NOTHING;

-- Some legacy deployments may already contain duplicate recovery ledger rows from a race
-- between instances. Attach only the earliest row to the invoice; the unique payment ledger
-- index then remains a backstop instead of making this upgrade itself fail.
WITH canonical_recovery_ledger AS (
    SELECT DISTINCT ON ((substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer)
        ct.id,
        (substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer AS payment_id
    FROM credit_transactions ct
    JOIN payments p
      ON p.id = (substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer
     AND p.user_id = ct.user_id
    WHERE ct.payment_id IS NULL
      AND ct.reason ~ '^single_game_recovered:[0-9]+$'
    ORDER BY (substring(ct.reason FROM 'single_game_recovered:([0-9]+)'))::integer, ct.id
)
UPDATE credit_transactions ct
SET payment_id = canonical.payment_id
FROM canonical_recovery_ledger canonical
WHERE ct.id = canonical.id;

-- Historical confirmed products did not have an entitlement marker. Snapshot the durable grant
-- JSON conservatively; pack revocation still requires payment-specific entitlement provenance,
-- otherwise the refund service sends the row to manual review.
INSERT INTO payment_entitlement_grants (
    payment_id, user_id, source, credits_granted, purchase_progress_granted,
    race_entries_granted, packs_granted, premium_level_granted, metadata
)
SELECT
    p.id,
    p.user_id,
    'legacy_product_backfill',
    CASE
        WHEN COALESCE(p.product_grants->>'credits', '') ~ '^[0-9]+$'
            THEN (p.product_grants->>'credits')::bigint
        ELSE GREATEST(COALESCE(p.credits_purchased, 0), 0)::bigint
    END,
    GREATEST(COALESCE(p.credits_purchased, 0), 0)::bigint,
    CASE
        WHEN COALESCE(p.product_grants->>'raceEntries', '') ~ '^[0-9]+$'
            THEN (p.product_grants->>'raceEntries')::integer
        ELSE 0
    END,
    CASE WHEN jsonb_typeof(p.product_grants->'packs') = 'array'
        THEN p.product_grants->'packs' ELSE '[]'::jsonb END,
    NULLIF(p.product_grants->>'premiumLevel', ''),
    jsonb_build_object('legacyBackfill', true)
FROM payments p
WHERE p.status = 'confirmed'
  AND p.payment_type IN ('credits_package', 'cosmetic_pack')
  AND p.user_id IS NOT NULL
ON CONFLICT (payment_id) DO NOTHING;
