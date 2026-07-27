-- Migration 021: Durable product grants on payments.
--
-- A payment product may grant credits, cosmetic/render packs, and/or a premium level.
-- Persist the product id and normalized grants on the payment row so confirmation/recovery
-- does not depend on in-memory socket state.

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS product_id VARCHAR(100);

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS product_grants JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_payments_product_id
    ON payments(product_id);

-- Allow standalone cosmetic purchases without granting a game entry or credits.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_type_check;
ALTER TABLE payments
    ADD CONSTRAINT payments_payment_type_check
    CHECK (payment_type IN ('single_game', 'credits_package', 'cosmetic_pack')) NOT VALID;

COMMENT ON COLUMN payments.product_id IS 'Operator product id used to create this payment request.';
COMMENT ON COLUMN payments.product_grants IS 'Normalized grant payload applied when this payment confirms.';
