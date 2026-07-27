-- Incoming-payment evidence must be unique per chain output, not per transaction or address.
-- One Monero transaction may contain several incoming outputs (including several for the same
-- subaddress), and one invoice may be completed by several top-up transactions.

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS provider_id VARCHAR(40) NOT NULL DEFAULT 'native-monero',
    ADD COLUMN IF NOT EXISTS provider_invoice_id VARCHAR(160),
    ADD COLUMN IF NOT EXISTS confirmation_evidence_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS late_receipt_checked_at TIMESTAMPTZ;

-- Migration 008 assumed one incoming transaction == one invoice. Keep tx_hash as display/search
-- evidence only. Legacy data also contains expired/retried rows that intentionally reused an
-- address, so neither transaction hashes nor invoice destinations are unique payment identities.
DROP INDEX IF EXISTS idx_payments_tx_hash_unique;
DROP INDEX IF EXISTS idx_payments_tx_hash_output_unique;

CREATE TABLE IF NOT EXISTS payment_receipts (
    id BIGSERIAL PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    provider_id VARCHAR(40) NOT NULL,
    evidence_type VARCHAR(24) NOT NULL
        CHECK (evidence_type IN ('chain_output', 'provider_invoice')),
    evidence_id VARCHAR(160) NOT NULL,
    tx_hash VARCHAR(64),
    output_id VARCHAR(80),
    address_index INTEGER,
    amount BIGINT NOT NULL CHECK (amount > 0),
    confirmed BOOLEAN NOT NULL DEFAULT TRUE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT payment_receipt_shape CHECK (
        (evidence_type = 'chain_output'
            AND provider_id = 'native-monero'
            AND tx_hash ~ '^[0-9a-f]{64}$'
            AND (output_id ~ '^[0-9a-f]{64}$' OR output_id ~ '^global:(0|[1-9][0-9]*)$')
            AND evidence_id = tx_hash || ':' || output_id
            AND address_index IS NOT NULL AND address_index >= 0)
        OR
        (evidence_type = 'provider_invoice'
            AND provider_id <> 'native-monero'
            AND tx_hash IS NULL
            AND output_id IS NULL
            AND address_index IS NULL
            AND LENGTH(evidence_id) > 0)
    )
);

-- Output/invoice evidence is globally consumable once for its provider. In particular, tx_hash
-- and address_index are deliberately absent: sibling outputs can share both values.
DROP INDEX IF EXISTS idx_payment_receipts_chain_output_once;
DROP INDEX IF EXISTS idx_payment_receipts_provider_invoice_once;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_receipts_evidence_once
    ON payment_receipts(provider_id, evidence_id);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_payment
    ON payment_receipts(payment_id, observed_at);

-- Late receipts are intentionally not entitlements. The bounded reconciliation worker records
-- their durable output evidence here for an operator to refund or adjudicate manually, while the
-- underlying payment remains expired.
CREATE TABLE IF NOT EXISTS payment_late_reviews (
    id BIGSERIAL PRIMARY KEY,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
    provider_id VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'needs_review'
        CHECK (status IN ('needs_review', 'resolved', 'ignored')),
    reason VARCHAR(40) NOT NULL DEFAULT 'late_confirmed_receipt'
        CHECK (reason IN ('late_confirmed_receipt')),
    observed_amount BIGINT NOT NULL CHECK (observed_amount > 0),
    expected_amount BIGINT NOT NULL CHECK (expected_amount > 0),
    receipt_count INTEGER NOT NULL CHECK (receipt_count > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_late_reviews_status
    ON payment_late_reviews(status, last_observed_at);

CREATE INDEX IF NOT EXISTS idx_payments_late_receipt_scan
    ON payments(late_receipt_checked_at, expires_at)
    WHERE status IN ('pending', 'expired');

-- Forward-only guard. Existing confirmed legacy rows (including rows with NULL tx_hash or an
-- old received_amount) remain readable because this trigger runs only on a new transition into
-- confirmed. Every new confirmation must have exact durable evidence covering the invoice.
CREATE OR REPLACE FUNCTION enforce_payment_confirmation_evidence()
RETURNS TRIGGER AS $$
DECLARE
    receipt_total BIGINT;
    receipt_count BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'confirmed' THEN
            RAISE EXCEPTION 'payment % must be inserted pending before receipt-backed confirmation', NEW.id
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        SELECT COALESCE(SUM(r.amount), 0), COUNT(*)
          INTO receipt_total, receipt_count
        FROM payment_receipts r
        WHERE r.payment_id = NEW.id
          AND r.provider_id = NEW.provider_id
          AND r.confirmed = TRUE
          AND (
              (NEW.provider_id = 'native-monero' AND r.evidence_type = 'chain_output')
              OR (NEW.provider_id <> 'native-monero' AND r.evidence_type = 'provider_invoice')
          );

        IF receipt_count = 0 OR receipt_total < NEW.expected_amount THEN
            RAISE EXCEPTION 'payment % lacks confirmed receipt coverage (% / %)',
                NEW.id, receipt_total, NEW.expected_amount
                USING ERRCODE = '23514';
        END IF;
        IF NEW.received_amount IS NULL OR NEW.received_amount < NEW.expected_amount
            OR NEW.received_amount > receipt_total THEN
            RAISE EXCEPTION 'payment % received_amount is not supported by receipts', NEW.id
                USING ERRCODE = '23514';
        END IF;
        NEW.confirmation_evidence_at = COALESCE(NEW.confirmation_evidence_at, NOW());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_require_confirmation_evidence ON payments;
CREATE TRIGGER trg_payments_require_confirmation_evidence
    BEFORE INSERT OR UPDATE OF status ON payments
    FOR EACH ROW
    EXECUTE FUNCTION enforce_payment_confirmation_evidence();
