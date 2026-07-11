-- 025: graduate the cosmetic ladder.
--
-- Migration 024 seeded every premium pack at tier 1 / unlock_min_credits 1, so buying ANY credit
-- unlocked skins + iso + 3D at once (flat, not tiered). Turn it into a real ladder — unlock by
-- lifetime credit spend OR by subscription tier, whichever comes first:
--   Fancy (generated-skins)      1 credit  / supporter (tier 1)
--   Iso   (iso-dungeon)         10 credits / premium   (tier 2)
--   3D    (kenney-3d-characters) 25 credits / operator  (tier 3)
-- Idempotent (plain UPDATEs); the free roguelike-interior pack is untouched.

UPDATE cosmetic_catalog SET tier = 1, unlock_min_credits = 1  WHERE pack_id = 'generated-skins';
UPDATE cosmetic_catalog SET tier = 2, unlock_min_credits = 10 WHERE pack_id = 'iso-dungeon';
UPDATE cosmetic_catalog SET tier = 3, unlock_min_credits = 25 WHERE pack_id = 'kenney-3d-characters';
