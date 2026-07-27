-- Migration 002: Increase address field lengths for Wownero compatibility and add socket_id to payments inserts going forward
-- Wownero (WOW) standard & subaddresses are typically 97 chars (vs Monero 95); allow buffer.

ALTER TABLE payments
    ALTER COLUMN subaddress TYPE VARCHAR(110);

ALTER TABLE users
    ALTER COLUMN payout_address TYPE VARCHAR(110);

-- Optional: index remains valid; no changes needed.

-- End 002
