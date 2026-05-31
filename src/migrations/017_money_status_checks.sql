-- Migration 017: CHECK constraints on money-table status/type columns
--
-- payments.status, payouts.status and payments.payment_type were free-form VARCHARs.
-- A typo in any one query (e.g. 'complete' vs 'completed') silently produces a row that
-- no index/predicate matches — orphaning money (a payout stuck in a misspelled status is
-- invisible to both the batcher and the retry candidate query). These CHECKs catch typos.
--
-- Added NOT VALID so they enforce all NEW writes without failing on any pre-existing rows,
-- and guarded by conname checks so the migration is idempotent / safe to re-run.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_check') THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_status_check
            CHECK (status IN ('pending', 'confirmed', 'expired', 'refunded')) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_payment_type_check') THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_payment_type_check
            CHECK (payment_type IN ('single_game', 'credits_package')) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_status_check') THEN
        ALTER TABLE payouts
            ADD CONSTRAINT payouts_status_check
            CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_review', 'permanently_failed', 'batched')) NOT VALID;
    END IF;
END $$;
