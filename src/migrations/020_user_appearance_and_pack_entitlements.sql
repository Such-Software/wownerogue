-- Migration 020: Canonical cosmetic identity and pack entitlements.
--
-- `users.appearance` stores the normalized public cosmetic identity used by tavern,
-- future PvP rooms, and eventually single-player rendering. `user_pack_entitlements`
-- is the operator/admin override table for individual premium pack unlocks. The
-- current default premium policy still comes from users.total_credits_purchased > 0.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS appearance JSONB NOT NULL DEFAULT
    '{"avatar":"default","tint":"none","equipment":{"body":"none","head":"none","shield":"none","weapon":"none"}}'::jsonb;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS premium_level VARCHAR(32) NOT NULL DEFAULT 'free';

CREATE TABLE IF NOT EXISTS user_pack_entitlements (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id VARCHAR(80) NOT NULL,
    source VARCHAR(40) NOT NULL DEFAULT 'operator',
    granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (user_id, pack_id)
);

CREATE INDEX IF NOT EXISTS idx_user_pack_entitlements_user_id
    ON user_pack_entitlements(user_id);

CREATE INDEX IF NOT EXISTS idx_user_pack_entitlements_active
    ON user_pack_entitlements(user_id, pack_id)
    WHERE expires_at IS NULL;

COMMENT ON COLUMN users.appearance IS 'Normalized cosmetic identity: avatar, tint, equipment.';
COMMENT ON COLUMN users.premium_level IS 'Operator-defined premium tier; free by default. Credit purchases also unlock preview premium packs.';
COMMENT ON TABLE user_pack_entitlements IS 'Per-user premium cosmetic/render pack grants for future individual pack purchases or operator unlocks.';
