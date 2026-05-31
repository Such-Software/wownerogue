-- Migration 018: Widen credit columns to BIGINT
--
-- users.credits and credit_transactions.amount/balance_after were INTEGER (max ~2.1e9),
-- inconsistent with the BIGINT atomic-money columns and a latent overflow risk since
-- CREDITS_PACKAGES is admin-configurable with no upper bound. ALTER ... TYPE BIGINT is a
-- no-op when the column is already BIGINT, so this is safe to re-run.
ALTER TABLE users ALTER COLUMN credits TYPE BIGINT;

ALTER TABLE credit_transactions ALTER COLUMN amount TYPE BIGINT;
ALTER TABLE credit_transactions ALTER COLUMN balance_after TYPE BIGINT;
