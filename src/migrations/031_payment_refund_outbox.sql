-- Durable, idempotent admin payment refunds.
--
-- Only `requested` rows may be claimed by the application. A `processing` row means a
-- wallet call may have been made and must never be retried automatically: if the process
-- dies or loses the wallet response, an operator must reconcile it first.

CREATE TABLE IF NOT EXISTS payment_refunds (
    id BIGSERIAL PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL,
    amount BIGINT NOT NULL,
    payout_address VARCHAR(200),
    credits_deducted BIGINT NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    tx_hash VARCHAR(128),
    error_message TEXT,
    requested_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    needs_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT payment_refunds_payment_once UNIQUE (payment_id),
    CONSTRAINT payment_refunds_status_check
        CHECK (status IN ('recorded', 'requested', 'processing', 'completed', 'needs_review')),
    CONSTRAINT payment_refunds_amount_check CHECK (amount >= 0),
    CONSTRAINT payment_refunds_credits_check CHECK (credits_deducted >= 0),
    CONSTRAINT payment_refunds_state_shape_check CHECK (
        (status = 'recorded')
        OR (status = 'requested' AND requested_at IS NOT NULL)
        OR (
            status = 'processing'
            AND requested_at IS NOT NULL
            AND processing_started_at IS NOT NULL
        )
        OR (
            status = 'completed'
            AND requested_at IS NOT NULL
            AND processing_started_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND tx_hash IS NOT NULL
            AND LENGTH(tx_hash) > 0
        )
        OR (
            status = 'needs_review'
            AND requested_at IS NOT NULL
            AND error_message IS NOT NULL
            AND LENGTH(error_message) > 0
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_status
    ON payment_refunds(status, created_at);
