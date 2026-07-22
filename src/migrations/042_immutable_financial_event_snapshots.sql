-- Correct the migration-041 accounting outbox before it is used in production.
--
-- The payment/refund transaction only appends an immutable, non-PII source snapshot.  Network
-- policy and HTTP delivery remain asynchronous in FinancialEventExporter, so a slow or failed
-- accounting sink can never hold a payment-confirmation transaction open.  The exporter writes
-- the exact delivery document once and PostgreSQL prevents either snapshot from being rewritten.

ALTER TABLE financial_event_outbox
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(32),
    ADD COLUMN IF NOT EXISTS source_id BIGINT,
    ADD COLUMN IF NOT EXISTS event_id VARCHAR(120),
    ADD COLUMN IF NOT EXISTS payload_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS delivery_payload JSONB,
    ADD COLUMN IF NOT EXISTS ignored_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ignored_reason VARCHAR(80),
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

-- Migration 041 had a three-state constraint.  Drop it before converting malformed legacy rows
-- to an explicit terminal state; a replacement five-state constraint is installed below.
ALTER TABLE financial_event_outbox
    DROP CONSTRAINT IF EXISTS financial_event_outbox_status_check,
    DROP CONSTRAINT IF EXISTS financial_event_outbox_state;

-- Snapshot every 041 identity without consulting the payment again at delivery time.  Confirmed
-- receipt totals are preferred for old rows because receipt evidence is append-only; received_amount
-- is the compatibility fallback for pre-receipt history.  A missing confirmed_at is not allowed to
-- poison the queue: the durable outbox/payment creation timestamp is used instead.
WITH payment_source AS (
    SELECT
        o.id AS outbox_id,
        p.id AS payment_id,
        COALESCE(
            NULLIF((
                SELECT COALESCE(SUM(r.amount), 0)
                FROM payment_receipts r
                WHERE r.payment_id = p.id AND r.confirmed = TRUE
            ), 0),
            p.received_amount
        ) AS atomic_amount,
        COALESCE(p.confirmed_at, p.created_at, o.created_at, NOW()) AS occurred_at,
        p.payment_type,
        p.product_id,
        p.provider_id,
        (
            SELECT COUNT(*)
            FROM payment_receipts r
            WHERE r.payment_id = p.id AND r.confirmed = TRUE
        ) AS receipt_count
    FROM financial_event_outbox o
    JOIN payments p ON p.id = o.aggregate_id
    WHERE o.event_kind = 'payment.confirmed'
)
UPDATE financial_event_outbox o
SET source_type = 'payment',
    source_id = s.payment_id,
    event_id = 'payment-confirmed-' || s.payment_id::text,
    payload_snapshot = jsonb_build_object(
        'schema', 'financial-event-source/v1',
        'event_id', 'payment-confirmed-' || s.payment_id::text,
        'event_kind', 'payment.confirmed',
        'source_type', 'payment',
        'source_id', s.payment_id,
        'aggregate_id', s.payment_id,
        'occurred_at', s.occurred_at,
        'atomic_amount', COALESCE(s.atomic_amount, 0)::text,
        'payment_type', COALESCE(s.payment_type, ''),
        'product_id', COALESCE(s.product_id, ''),
        'provider_id', COALESCE(s.provider_id, ''),
        'receipt_count', s.receipt_count
    ),
    updated_at = NOW()
FROM payment_source s
WHERE o.id = s.outbox_id
  AND o.payload_snapshot IS NULL;

-- A 041 row whose historical amount has become unusable must terminate safely instead of being
-- retried forever.  Already-delivered rows are retained as delivered audit history.
UPDATE financial_event_outbox
SET status = 'ignored',
    source_type = COALESCE(source_type, 'payment'),
    source_id = COALESCE(source_id, aggregate_id),
    event_id = COALESCE(event_id, 'ignored-legacy-outbox-' || id::text),
    payload_snapshot = COALESCE(payload_snapshot, jsonb_build_object(
        'schema', 'financial-event-source/v1',
        'event_id', COALESCE(event_id, 'ignored-legacy-outbox-' || id::text),
        'event_kind', event_kind,
        'source_type', COALESCE(source_type, 'payment'),
        'source_id', COALESCE(source_id, aggregate_id),
        'aggregate_id', aggregate_id,
        'occurred_at', COALESCE(created_at, NOW()),
        'atomic_amount', '0'
    )),
    lease_until = NULL,
    ignored_at = NOW(),
    ignored_reason = 'malformed_legacy_snapshot',
    last_error = 'Malformed legacy financial-event snapshot was suppressed',
    updated_at = NOW()
WHERE delivered_at IS NULL
  AND (
      payload_snapshot IS NULL
      OR payload_snapshot->>'atomic_amount' !~ '^[1-9][0-9]*$'
  );

-- Build the exact safe source document at the confirmation boundary for all future payments.
CREATE OR REPLACE FUNCTION enqueue_confirmed_payment_financial_event()
RETURNS TRIGGER AS $$
DECLARE
    safe_occurred_at TIMESTAMPTZ;
    safe_receipt_count BIGINT;
    stable_event_id TEXT;
BEGIN
    IF NEW.status = 'confirmed'
       AND COALESCE(NEW.received_amount, 0) > 0
       AND (
           TG_OP = 'INSERT'
           OR OLD.status IS DISTINCT FROM 'confirmed'
           OR COALESCE(OLD.received_amount, 0) <= 0
       ) THEN
        safe_occurred_at := COALESCE(NEW.confirmed_at, NEW.created_at, NOW());
        stable_event_id := 'payment-confirmed-' || NEW.id::text;
        SELECT COUNT(*) INTO safe_receipt_count
        FROM payment_receipts r
        WHERE r.payment_id = NEW.id AND r.confirmed = TRUE;

        INSERT INTO financial_event_outbox (
            event_kind, aggregate_id, source_type, source_id, event_id, payload_snapshot
        ) VALUES (
            'payment.confirmed',
            NEW.id,
            'payment',
            NEW.id,
            stable_event_id,
            jsonb_build_object(
                'schema', 'financial-event-source/v1',
                'event_id', stable_event_id,
                'event_kind', 'payment.confirmed',
                'source_type', 'payment',
                'source_id', NEW.id,
                'aggregate_id', NEW.id,
                'occurred_at', safe_occurred_at,
                'atomic_amount', NEW.received_amount::text,
                'payment_type', COALESCE(NEW.payment_type, ''),
                'product_id', COALESCE(NEW.product_id, ''),
                'provider_id', COALESCE(NEW.provider_id, ''),
                'receipt_count', safe_receipt_count
            )
        )
        ON CONFLICT (event_kind, aggregate_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enqueue_confirmed_payment_financial_event ON payments;
CREATE TRIGGER trg_enqueue_confirmed_payment_financial_event
AFTER INSERT OR UPDATE OF status, received_amount ON payments
FOR EACH ROW EXECUTE FUNCTION enqueue_confirmed_payment_financial_event();

-- If migration 041 was applied while writes continued, add any valid confirmation identity it
-- missed.  This backfill is deliberately receipt/value based and never copies customer identity,
-- invoice destinations, wallet addresses, transaction hashes, provider invoice IDs, or metadata.
INSERT INTO financial_event_outbox (
    event_kind, aggregate_id, source_type, source_id, event_id, payload_snapshot
)
SELECT
    'payment.confirmed',
    p.id,
    'payment',
    p.id,
    'payment-confirmed-' || p.id::text,
    jsonb_build_object(
        'schema', 'financial-event-source/v1',
        'event_id', 'payment-confirmed-' || p.id::text,
        'event_kind', 'payment.confirmed',
        'source_type', 'payment',
        'source_id', p.id,
        'aggregate_id', p.id,
        'occurred_at', COALESCE(p.confirmed_at, p.created_at, NOW()),
        'atomic_amount', p.received_amount::text,
        'payment_type', COALESCE(p.payment_type, ''),
        'product_id', COALESCE(p.product_id, ''),
        'provider_id', COALESCE(p.provider_id, ''),
        'receipt_count', (
            SELECT COUNT(*) FROM payment_receipts r
            WHERE r.payment_id = p.id AND r.confirmed = TRUE
        )
    )
FROM payments p
WHERE p.status = 'confirmed' AND COALESCE(p.received_amount, 0) > 0
ON CONFLICT (event_kind, aggregate_id) DO NOTHING;

-- A refund produces exactly one final reversal identity.  `recorded` is the terminal bookkeeping
-- reversal used when no wallet transfer was requested; `completed` is the terminal wallet refund.
-- requested/processing/needs_review states are intentionally never accounting events.
CREATE OR REPLACE FUNCTION enqueue_final_payment_refund_financial_event()
RETURNS TRIGGER AS $$
DECLARE
    stable_event_id TEXT;
    safe_occurred_at TIMESTAMPTZ;
BEGIN
    IF NEW.status IN ('recorded', 'completed')
       AND (
           TG_OP = 'INSERT'
           OR OLD.status IS DISTINCT FROM NEW.status
       ) THEN
        stable_event_id := 'payment-refund-' || NEW.id::text;
        safe_occurred_at := CASE
            WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_at, NEW.updated_at, NOW())
            ELSE COALESCE(NEW.created_at, NEW.updated_at, NOW())
        END;

        INSERT INTO financial_event_outbox (
            event_kind, aggregate_id, source_type, source_id, event_id, payload_snapshot
        ) VALUES (
            'payment.refund',
            NEW.payment_id,
            'payment_refund',
            NEW.id,
            stable_event_id,
            jsonb_build_object(
                'schema', 'financial-event-source/v1',
                'event_id', stable_event_id,
                'event_kind', 'payment.refund',
                'source_type', 'payment_refund',
                'source_id', NEW.id,
                'aggregate_id', NEW.payment_id,
                'occurred_at', safe_occurred_at,
                'atomic_amount', NEW.amount::text,
                'refund_status', NEW.status
            )
        )
        ON CONFLICT (event_kind, aggregate_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enqueue_final_payment_refund_financial_event ON payment_refunds;
CREATE TRIGGER trg_enqueue_final_payment_refund_financial_event
AFTER INSERT OR UPDATE OF status ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION enqueue_final_payment_refund_financial_event();

INSERT INTO financial_event_outbox (
    event_kind, aggregate_id, source_type, source_id, event_id, payload_snapshot
)
SELECT
    'payment.refund',
    r.payment_id,
    'payment_refund',
    r.id,
    'payment-refund-' || r.id::text,
    jsonb_build_object(
        'schema', 'financial-event-source/v1',
        'event_id', 'payment-refund-' || r.id::text,
        'event_kind', 'payment.refund',
        'source_type', 'payment_refund',
        'source_id', r.id,
        'aggregate_id', r.payment_id,
        'occurred_at', CASE
            WHEN r.status = 'completed' THEN COALESCE(r.completed_at, r.updated_at, NOW())
            ELSE COALESCE(r.created_at, r.updated_at, NOW())
        END,
        'atomic_amount', r.amount::text,
        'refund_status', r.status
    )
FROM payment_refunds r
WHERE r.status IN ('recorded', 'completed')
ON CONFLICT (event_kind, aggregate_id) DO NOTHING;

-- All 041 rows now have a complete identity or are terminally ignored.  Require new writes to
-- carry one, constrain the source document to the deliberately small non-PII key set, and make
-- each source/event identity globally stable.
ALTER TABLE financial_event_outbox
    ALTER COLUMN source_type SET NOT NULL,
    ALTER COLUMN source_id SET NOT NULL,
    ALTER COLUMN event_id SET NOT NULL,
    ALTER COLUMN payload_snapshot SET NOT NULL;

ALTER TABLE financial_event_outbox
    ADD CONSTRAINT financial_event_outbox_event_id_once UNIQUE (event_id),
    ADD CONSTRAINT financial_event_outbox_source_once UNIQUE (event_kind, source_type, source_id),
    ADD CONSTRAINT financial_event_outbox_source_shape CHECK (
        source_type IN ('payment', 'payment_refund')
        AND jsonb_typeof(payload_snapshot) = 'object'
        AND (payload_snapshot->>'schema') IS NOT DISTINCT FROM 'financial-event-source/v1'
        AND (payload_snapshot->>'event_id') IS NOT DISTINCT FROM event_id
        AND (payload_snapshot->>'event_kind') IS NOT DISTINCT FROM event_kind
        AND (payload_snapshot->>'source_type') IS NOT DISTINCT FROM source_type
        AND (payload_snapshot->>'source_id') IS NOT DISTINCT FROM source_id::text
        AND (payload_snapshot->>'aggregate_id') IS NOT DISTINCT FROM aggregate_id::text
        AND (payload_snapshot - ARRAY[
            'schema', 'event_id', 'event_kind', 'source_type', 'source_id', 'aggregate_id',
            'occurred_at', 'atomic_amount', 'payment_type', 'product_id', 'provider_id',
            'receipt_count', 'refund_status'
        ]) = '{}'::jsonb
    ),
    ADD CONSTRAINT financial_event_outbox_delivery_shape CHECK (
        delivery_payload IS NULL
        OR (
            jsonb_typeof(delivery_payload) = 'object'
            AND (delivery_payload->>'schema') IS NOT DISTINCT FROM 'financial-event/v1'
            AND (delivery_payload->>'id') IS NOT DISTINCT FROM event_id
        )
    ),
    ADD CONSTRAINT financial_event_outbox_status_check CHECK (
        status IN ('pending', 'in_flight', 'delivered', 'ignored', 'dead_letter')
    ),
    ADD CONSTRAINT financial_event_outbox_state CHECK (
        (status = 'pending'
            AND lease_until IS NULL AND delivered_at IS NULL
            AND ignored_at IS NULL AND dead_lettered_at IS NULL)
        OR (status = 'in_flight'
            AND lease_until IS NOT NULL AND delivered_at IS NULL
            AND ignored_at IS NULL AND dead_lettered_at IS NULL)
        OR (status = 'delivered'
            AND lease_until IS NULL AND delivered_at IS NOT NULL
            AND ignored_at IS NULL AND dead_lettered_at IS NULL)
        OR (status = 'ignored'
            AND lease_until IS NULL AND delivered_at IS NULL
            AND ignored_at IS NOT NULL AND ignored_reason IS NOT NULL
            AND dead_lettered_at IS NULL)
        OR (status = 'dead_letter'
            AND lease_until IS NULL AND delivered_at IS NULL
            AND ignored_at IS NULL AND dead_lettered_at IS NOT NULL)
    );

-- The source snapshot and stable identity are immutable immediately.  The delivery document has
-- one allowed transition (NULL -> exact payload) so the worker can bind the deployment's mainnet
-- asset/network/account reference before its first HTTP attempt.  Retries must reuse that document.
CREATE OR REPLACE FUNCTION reject_financial_event_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.event_kind IS DISTINCT FROM OLD.event_kind
        OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
        OR NEW.source_type IS DISTINCT FROM OLD.source_type
        OR NEW.source_id IS DISTINCT FROM OLD.source_id
        OR NEW.event_id IS DISTINCT FROM OLD.event_id
        OR NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot
        OR (OLD.delivery_payload IS NOT NULL
            AND NEW.delivery_payload IS DISTINCT FROM OLD.delivery_payload)
        OR (OLD.delivery_payload IS NULL AND NEW.delivery_payload IS NOT NULL
            AND (OLD.status IS DISTINCT FROM 'in_flight'
                OR NEW.status IS DISTINCT FROM 'in_flight'))
        OR (OLD.delivery_payload IS NULL AND NEW.delivery_payload IS NULL
            AND NEW.status IN ('delivered'))
    THEN
        RAISE EXCEPTION 'financial event identity/payload is immutable for outbox row %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_financial_event_identity_immutable ON financial_event_outbox;
CREATE TRIGGER trg_financial_event_identity_immutable
BEFORE UPDATE ON financial_event_outbox
FOR EACH ROW EXECUTE FUNCTION reject_financial_event_identity_mutation();

DROP INDEX IF EXISTS idx_financial_event_outbox_due;
CREATE INDEX idx_financial_event_outbox_due
    ON financial_event_outbox(next_attempt_at, created_at, id)
    WHERE status IN ('pending', 'in_flight');

CREATE INDEX idx_financial_event_outbox_terminal_health
    ON financial_event_outbox(status, updated_at)
    WHERE status IN ('dead_letter', 'ignored');
