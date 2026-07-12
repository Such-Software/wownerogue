-- 028: lock the cosmetic ladder (loyalty model — unlock by lifetime credits purchased, cumulative).
-- Adds the FREE `original` bare-tiles baseline and reprices the ladder: Interior 1, skins 5, iso 10,
-- +tilepack 20, +iso 40, 3D 50. Mirrors DEFAULT_CATALOG in src/multiplayer/entitlements.js.
-- Idempotent. See docs/MONETIZATION.md.
INSERT INTO cosmetic_catalog (pack_id, label, kind, projection, tier, unlock_min_credits, grant_only, active, sort_order, metadata) VALUES
    ('original',             'Original Tiles',                'render-pack', 'topdown', 0, NULL, false, true,  0,  '{}'::jsonb),
    ('roguelike-interior',   'Kenney Roguelike Interior',     'render-pack', 'topdown', 1, 1,    false, true,  10, '{}'::jsonb),
    ('generated-skins',      'Premium Character Skins',       'render-pack', 'topdown', 1, 5,    false, true,  15, '{}'::jsonb),
    ('iso-dungeon',          'Kenney Isometric Dungeon',      'render-pack', 'iso',     2, 10,   false, true,  20, '{}'::jsonb),
    ('roguelike-dungeon',    'Roguelike Dungeon (Tiles)',     'render-pack', 'topdown', 2, 20,   false, true,  25, '{}'::jsonb),
    ('iso-medieval',         'Medieval Town (Isometric)',     'render-pack', 'iso',     3, 40,   false, true,  30, '{}'::jsonb),
    ('kenney-3d-characters', 'Kenney Animated 3D Characters', 'render-pack', '3d',      3, 50,   false, true,  40, '{}'::jsonb)
ON CONFLICT (pack_id) DO UPDATE
   SET label = EXCLUDED.label, kind = EXCLUDED.kind, projection = EXCLUDED.projection, tier = EXCLUDED.tier,
       unlock_min_credits = EXCLUDED.unlock_min_credits, grant_only = EXCLUDED.grant_only,
       active = true, sort_order = EXCLUDED.sort_order;
