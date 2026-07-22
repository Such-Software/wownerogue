-- Close economic-identity mutation gaps for databases that already applied migrations 032/035.
-- Operational status, transaction evidence, retry counters, fees, and timestamps remain mutable;
-- owners, promise amounts, linkage, and destinations do not.

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

CREATE OR REPLACE FUNCTION reject_payment_fairness_binding_mutation()
RETURNS TRIGGER AS $$
DECLARE
    identity_locked BOOLEAN;
BEGIN
    -- A receipt is authorization evidence even before the final status update. Once evidence
    -- exists (or the invoice has reached a terminal money state), its economic promise and
    -- provider/destination identity may no longer be rewritten. Operational settlement fields
    -- such as status, received_amount, confirmations, and refund timestamps remain mutable.
    identity_locked := OLD.fairness_bound_at IS NOT NULL
        OR OLD.status IN ('confirmed', 'refunded', 'expired')
        OR EXISTS (SELECT 1 FROM payment_receipts r WHERE r.payment_id = OLD.id);

    IF identity_locked AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
        OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
        OR NEW.subaddress IS DISTINCT FROM OLD.subaddress
        OR NEW.address_index IS DISTINCT FROM OLD.address_index
        OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
        OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id
        OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode
        OR NEW.credit_package_id IS DISTINCT FROM OLD.credit_package_id
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
        OR NEW.product_grants IS DISTINCT FROM OLD.product_grants
        OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    ) THEN
        RAISE EXCEPTION 'payment economic identity is immutable for payment %', OLD.id
            USING ERRCODE = '23514';
    END IF;

    IF OLD.fairness_bound_at IS NOT NULL AND (
        NEW.fairness_proof_version IS DISTINCT FROM OLD.fairness_proof_version
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
        OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
        OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id
        OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode
        OR NEW.credit_package_id IS DISTINCT FROM OLD.credit_package_id
        OR NEW.product_id IS DISTINCT FROM OLD.product_id
        OR NEW.product_grants IS DISTINCT FROM OLD.product_grants
        OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    ) THEN
        RAISE EXCEPTION 'payment identity cannot change while binding fairness proof for payment %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Receipt evidence is an append-only authorization ledger. If an observation is later found to
-- be wrong, add adjudication metadata elsewhere; never rewrite or erase the evidence that allowed
-- an invoice to confirm.
CREATE OR REPLACE FUNCTION reject_payment_receipt_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'payment receipt evidence is append-only for receipt %', OLD.id
        USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_receipts_append_only ON payment_receipts;
CREATE TRIGGER trg_payment_receipts_append_only
    BEFORE UPDATE OR DELETE ON payment_receipts
    FOR EACH ROW
    EXECUTE FUNCTION reject_payment_receipt_mutation();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payouts_no_address_review_shape'
    ) THEN
        ALTER TABLE payouts
            ADD CONSTRAINT payouts_no_address_review_shape CHECK (
                payout_address <> 'PENDING_NO_ADDRESS'
                OR (
                    status = 'needs_review'
                    AND reason IN ('match_winner_no_address', 'solo_winner_no_address')
                    AND tx_hash IS NULL
                )
            ) NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_payout_obligation_mutation()
RETURNS TRIGGER AS $$
DECLARE
    allowed_address_claim BOOLEAN := FALSE;
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.game_id IS DISTINCT FROM OLD.game_id
        OR NEW.match_id IS DISTINCT FROM OLD.match_id
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.multiplier IS DISTINCT FROM OLD.multiplier
        OR NEW.reason IS DISTINCT FROM OLD.reason
    THEN
        RAISE EXCEPTION 'payout economic identity is immutable for payout %', OLD.id
            USING ERRCODE = '23514';
    END IF;

    IF NEW.payout_address IS DISTINCT FROM OLD.payout_address THEN
        allowed_address_claim :=
            OLD.payout_address = 'PENDING_NO_ADDRESS'
            AND OLD.status = 'needs_review'
            AND OLD.reason IN ('match_winner_no_address', 'solo_winner_no_address')
            AND OLD.tx_hash IS NULL
            AND NEW.status = 'pending'
            AND NEW.tx_hash IS NULL
            AND BTRIM(COALESCE(NEW.payout_address, '')) <> ''
            AND NEW.payout_address <> 'PENDING_NO_ADDRESS'
            AND EXISTS (
                SELECT 1 FROM users u
                WHERE u.id = OLD.user_id
                  AND u.payout_address = NEW.payout_address
            );
        IF NOT allowed_address_claim THEN
            RAISE EXCEPTION 'payout destination is immutable for payout %', OLD.id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payouts_immutable_obligation ON payouts;
CREATE TRIGGER trg_payouts_immutable_obligation
    BEFORE UPDATE ON payouts
    FOR EACH ROW
    EXECUTE FUNCTION reject_payout_obligation_mutation();
