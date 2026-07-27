-- 027: add the Roguelike Dungeon topdown tile pack as a catalog product.
-- Same sheet, a dungeon palette (a distinct 2D tileset). Cheap topdown-variety tier: 1 credit /
-- supporter (tier 1). Idempotent.
INSERT INTO cosmetic_catalog (pack_id, label, kind, projection, tier, unlock_min_credits, grant_only, active, sort_order, metadata)
VALUES ('roguelike-dungeon', 'Roguelike Dungeon (Tiles)', 'render-pack', 'topdown', 1, 1, false, true, 15, '{}'::jsonb)
ON CONFLICT (pack_id) DO UPDATE
   SET label = EXCLUDED.label, projection = EXCLUDED.projection, tier = EXCLUDED.tier,
       unlock_min_credits = EXCLUDED.unlock_min_credits, active = true;
