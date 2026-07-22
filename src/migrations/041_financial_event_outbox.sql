-- Durable, backend-neutral accounting event export. Payment confirmation never waits for the
-- accounting receiver: this trigger only appends an outbox identity inside the payment transaction.

CREATE TABLE IF NOT EXISTS financial_event_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_kind VARCHAR(40) NOT NULL,
    aggregate_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_flight', 'delivered')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT financial_event_outbox_once UNIQUE (event_kind, aggregate_id),
    CONSTRAINT financial_event_outbox_state CHECK (
        (status = 'pending' AND lease_until IS NULL AND delivered_at IS NULL)
        OR (status = 'in_flight' AND lease_until IS NOT NULL AND delivered_at IS NULL)
        OR (status = 'delivered' AND lease_until IS NULL AND delivered_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_financial_event_outbox_due
    ON financial_event_outbox(next_attempt_at, created_at)
    WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION enqueue_confirmed_payment_financial_event()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'confirmed'
       AND COALESCE(NEW.received_amount, 0) > 0
       AND (
           TG_OP = 'INSERT'
           OR OLD.status IS DISTINCT FROM 'confirmed'
           OR COALESCE(OLD.received_amount, 0) <= 0
       ) THEN
        INSERT INTO financial_event_outbox (event_kind, aggregate_id)
        VALUES ('payment.confirmed', NEW.id)
        ON CONFLICT (event_kind, aggregate_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enqueue_confirmed_payment_financial_event ON payments;
CREATE TRIGGER trg_enqueue_confirmed_payment_financial_event
AFTER INSERT OR UPDATE OF status, received_amount ON payments
FOR EACH ROW EXECUTE FUNCTION enqueue_confirmed_payment_financial_event();

-- Backfill only receipt-valued rows. Legacy confirmed rows with received_amount=0 lack adequate
-- economic evidence and must not be manufactured into revenue events.
INSERT INTO financial_event_outbox (event_kind, aggregate_id)
SELECT 'payment.confirmed', id
FROM payments
WHERE status = 'confirmed' AND COALESCE(received_amount, 0) > 0
ON CONFLICT (event_kind, aggregate_id) DO NOTHING;
