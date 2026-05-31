-- Migration 016: Snapshot payout terms on the game at start
--
-- Payout amounts were computed at completion time from LIVE config, so an admin changing
-- multipliers mid-game would change the payout of an already-in-progress game ("what you
-- saw at entry" was not honoured). Snapshot the resolved payout amounts (and the
-- multipliers, for audit) onto the games row at start; completion reads the snapshot.
--
-- Amounts are atomic units (BIGINT, exact). Multipliers are stored for the audit trail.
ALTER TABLE games
    ADD COLUMN IF NOT EXISTS payout_escape_amount   BIGINT,
    ADD COLUMN IF NOT EXISTS payout_treasure_amount BIGINT,
    ADD COLUMN IF NOT EXISTS payout_escape_mult     NUMERIC(8,3),
    ADD COLUMN IF NOT EXISTS payout_treasure_mult   NUMERIC(8,3);
