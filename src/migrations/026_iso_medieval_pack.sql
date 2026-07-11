-- 026: add the Medieval Town isometric pack as a catalog product.
-- A second iso environment (interchangeable across tavern + dungeon), sold at iso-tier: unlock by
-- 15 lifetime credits OR premium (tier 2). Idempotent.
INSERT INTO cosmetic_catalog (pack_id, label, kind, projection, tier, unlock_min_credits, grant_only, active, sort_order, metadata)
VALUES ('iso-medieval', 'Medieval Town (Isometric)', 'render-pack', 'iso', 2, 15, false, true, 40, '{}'::jsonb)
ON CONFLICT (pack_id) DO UPDATE
   SET label = EXCLUDED.label, projection = EXCLUDED.projection, tier = EXCLUDED.tier,
       unlock_min_credits = EXCLUDED.unlock_min_credits, active = true;
