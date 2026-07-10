-- Migration 024: operator-owned cosmetic catalog (the 10× foundation stone).
--
-- Replaces the split-brain, hand-synced pack definitions that live in BOTH
--   src/multiplayer/entitlements.js  (server PACKS)  and
--   html/js/render/assetPacks.js     (client RK.PACKS)
-- with a single server-authoritative table the operator owns. The server snapshot and the
-- client renderer both read from this (the client gets it in the entitlement/config payload),
-- so an operator can define a new skin/tile pack, its price, tier, and unlock rule without
-- editing any JS.
--
-- UNLOCK MODEL (fixes the current "any purchase unlocks EVERY premium pack" short-circuit in
-- entitlements.js snapshotForUser). A user owns a pack if ANY of:
--   1. an explicit row in user_pack_entitlements (a grant or a direct cosmetic purchase), OR
--   2. unlock_min_credits IS NOT NULL AND users.total_credits_purchased >= unlock_min_credits, OR
--   3. the user's tier >= this pack's tier (ordered ladder; 0 = free).
-- This makes "buy 1 credit → unlock skin A, buy the 10-pack → unlock pack B" expressible:
--   skin A: unlock_min_credits = 1   |   pack B: unlock_min_credits = 10 (or grant_only + a
--   per-product grant on the 10-pack). Tiers cover blanket "supporter unlocks everything at
--   tier ≤ N" if the operator wants it.

CREATE TABLE IF NOT EXISTS cosmetic_catalog (
    pack_id             VARCHAR(64)  PRIMARY KEY,          -- 'iso-dungeon', 'generated-skins', …
    label               VARCHAR(120) NOT NULL,
    kind                VARCHAR(24)  NOT NULL DEFAULT 'render-pack', -- 'render-pack' | 'skin' | 'tile'
    projection          VARCHAR(24),                       -- 'topdown' | 'iso' | '3d' | NULL (any)
    tier                INTEGER      NOT NULL DEFAULT 0,    -- 0 = free; ordered ladder (1,2,…)
    unlock_min_credits  BIGINT,                            -- lifetime-spend threshold; NULL = not credit-unlockable
    grant_only          BOOLEAN      NOT NULL DEFAULT FALSE,-- true = only via explicit grant/purchase
    sort_order          INTEGER      NOT NULL DEFAULT 0,
    active              BOOLEAN      NOT NULL DEFAULT TRUE,
    metadata            JSONB        NOT NULL DEFAULT '{}', -- asset urls, render-mode binding, etc.
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT cosmetic_catalog_tier_nonneg CHECK (tier >= 0),
    CONSTRAINT cosmetic_catalog_min_credits_nonneg CHECK (unlock_min_credits IS NULL OR unlock_min_credits >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cosmetic_catalog_active ON cosmetic_catalog(active, sort_order);

-- Seed the four packs that exist today so nothing regresses on first migration. These mirror the
-- current hardcoded definitions (roguelike-interior free; the rest premium, credit-unlockable at
-- 1 lifetime credit — matching today's {kind:'credits_purchase', minTotalCreditsPurchased:1}).
INSERT INTO cosmetic_catalog (pack_id, label, kind, projection, tier, unlock_min_credits, grant_only, sort_order) VALUES
    ('roguelike-interior',   'Kenney Roguelike Interior', 'render-pack', 'topdown', 0, NULL, FALSE, 0),
    ('generated-skins',      'Premium Generated Skins',   'render-pack', 'topdown', 1, 1,    FALSE, 1),
    ('iso-dungeon',          'Kenney Isometric Dungeon',  'render-pack', 'iso',     1, 1,    FALSE, 2),
    ('kenney-3d-characters', 'Kenney Animated 3D Chars',  'render-pack', '3d',      1, 1,    FALSE, 3)
ON CONFLICT (pack_id) DO NOTHING;
