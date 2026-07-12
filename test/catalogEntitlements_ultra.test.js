/**
 * Operator-owned catalog + three-way unlock model (migration 024).
 *
 * The old snapshotForUser unlocked EVERY premium pack the moment total_credits_purchased > 0
 * (any purchase → level 'credits' → hasPremiumLevel → all packs). The new rule unlocks a pack via
 * exactly one of: it's free · an explicit grant · lifetime spend >= its threshold · tier >= its tier.
 */

const Entitlements = require('../src/multiplayer/entitlements');
const CatalogService = require('../src/services/catalogService');
const { snapshotForUser, DEFAULT_CATALOG } = Entitlements;

describe('three-way unlock — default (seed) catalog', () => {
    test('free pack is always unlocked; premium packs are locked with no spend', () => {
        const s = snapshotForUser({ credits: 0, total_credits_purchased: 0 });
        expect(s.packs['original']).toBe(true);             // free baseline
        expect(s.packs['roguelike-interior']).toBe(false);  // now 1-credit premium
        expect(s.packs['generated-skins']).toBe(false);     // threshold 5, no spend
        expect(s.packs['iso-dungeon']).toBe(false);
        expect(s.packs['kenney-3d-characters']).toBe(false);
        expect(s.premium).toBe(false);
        expect(s.level).toBe('free');
        expect(s.tier).toBe(0);
    });

    test('graduated ladder: 1 credit unlocks the first tilepack only, not skins/iso/3D', () => {
        const s = snapshotForUser({ credits: 5, total_credits_purchased: 1 });
        expect(s.packs['roguelike-interior']).toBe(true);        // threshold 1
        expect(s.packs['generated-skins']).toBe(false);          // threshold 5
        expect(s.packs['iso-dungeon']).toBe(false);              // threshold 10
        expect(s.packs['kenney-3d-characters']).toBe(false);     // threshold 50
        expect(s.premium).toBe(true);                            // a premium pack IS unlocked
    });

    test('graduated ladder: 50 credits unlocks the whole ladder', () => {
        const s = snapshotForUser({ credits: 0, total_credits_purchased: 50 });
        expect(s.packs['roguelike-interior']).toBe(true);
        expect(s.packs['generated-skins']).toBe(true);
        expect(s.packs['iso-dungeon']).toBe(true);
        expect(s.packs['roguelike-dungeon']).toBe(true);
        expect(s.packs['iso-medieval']).toBe(true);
        expect(s.packs['kenney-3d-characters']).toBe(true);
    });

    test('a credit buyer is NOT auto-promoted to a premium tier', () => {
        const s = snapshotForUser({ total_credits_purchased: 100 });
        expect(s.level).toBe('free'); // spend gives unlocks, not a tier
        expect(s.tier).toBe(0);
    });

    test('explicit grant unlocks a pack with zero spend', () => {
        const s = snapshotForUser({ total_credits_purchased: 0 }, [{ pack_id: 'iso-dungeon' }]);
        expect(s.packs['iso-dungeon']).toBe(true);
        expect(s.packs['generated-skins']).toBe(false); // not granted, not bought
    });
});

describe('THE bug fix — differentiated thresholds', () => {
    const catalog = {
        'skin-a': { id: 'skin-a', label: 'A', tier: 0, unlockMinCredits: 1, grantOnly: false },
        'pack-b': { id: 'pack-b', label: 'B', tier: 0, unlockMinCredits: 10, grantOnly: false }
    };

    test('buying below the higher threshold unlocks only the cheaper pack', () => {
        const s = snapshotForUser({ total_credits_purchased: 5 }, [], catalog);
        expect(s.packs['skin-a']).toBe(true);   // spent 5 >= 1
        expect(s.packs['pack-b']).toBe(false);  // spent 5 < 10  (old code wrongly unlocked this)
    });

    test('crossing the higher threshold unlocks the bigger pack', () => {
        const s = snapshotForUser({ total_credits_purchased: 10 }, [], catalog);
        expect(s.packs['skin-a']).toBe(true);
        expect(s.packs['pack-b']).toBe(true);
    });
});

describe('tier ladder', () => {
    const catalog = {
        't2-pack': { id: 't2-pack', label: 'T2', tier: 2, unlockMinCredits: null, grantOnly: false }
    };
    test('supporter (tier 1) cannot use a tier-2 pack; premium (tier 2) can', () => {
        expect(snapshotForUser({ premium_level: 'supporter' }, [], catalog).packs['t2-pack']).toBe(false);
        expect(snapshotForUser({ premium_level: 'premium' }, [], catalog).packs['t2-pack']).toBe(true);
        expect(snapshotForUser({ premium_level: 'operator' }, [], catalog).packs['t2-pack']).toBe(true);
    });
    test('spend never crosses a tier-only pack', () => {
        expect(snapshotForUser({ total_credits_purchased: 9999 }, [], catalog).packs['t2-pack']).toBe(false);
    });
});

describe('grant-only packs', () => {
    const catalog = {
        'exclusive': { id: 'exclusive', label: 'X', tier: 0, unlockMinCredits: null, grantOnly: true }
    };
    test('grant-only is not unlocked by spend or tier — only an explicit grant', () => {
        expect(snapshotForUser({ total_credits_purchased: 9999, premium_level: 'operator' }, [], catalog).packs['exclusive']).toBe(false);
        expect(snapshotForUser({}, [{ pack_id: 'exclusive' }], catalog).packs['exclusive']).toBe(true);
    });
});

describe('canUsePack reads the snapshot', () => {
    test('gates on the computed packs map', () => {
        const locked = snapshotForUser({ total_credits_purchased: 0 });
        expect(Entitlements.canUsePack(locked, 'original')).toBe(true);            // free
        expect(Entitlements.canUsePack(locked, 'iso-dungeon')).toBe(false);        // locked
        const unlocked = snapshotForUser({ total_credits_purchased: 10 }); // iso threshold is 10
        expect(Entitlements.canUsePack(unlocked, 'iso-dungeon')).toBe(true);
    });
});

describe('CatalogService', () => {
    test('falls back to the built-in default when the table is missing', async () => {
        const db = { query: async () => { const e = new Error('relation "cosmetic_catalog" does not exist'); e.code = '42P01'; throw e; } };
        const svc = new CatalogService({ db });
        expect(await svc.getCatalog()).toBe(DEFAULT_CATALOG);
    });

    test('maps DB rows into the catalog shape', async () => {
        const db = { query: async () => ({ rows: [
            { pack_id: 'skin-a', label: 'A', kind: 'skin', projection: 'topdown', tier: 0, unlock_min_credits: '3', grant_only: false, active: true, metadata: {} },
            { pack_id: 'free-x', label: 'Free', kind: 'render-pack', projection: null, tier: 0, unlock_min_credits: null, grant_only: false, active: true, metadata: {} }
        ] }) };
        const cat = await new CatalogService({ db }).getCatalog();
        expect(cat['skin-a'].unlockMinCredits).toBe(3);
        expect(cat['skin-a'].premium).toBe(true);
        expect(cat['free-x'].premium).toBe(false);
    });

    test('caches within the TTL', async () => {
        let calls = 0;
        const db = { query: async () => { calls++; return { rows: [] }; } };
        const svc = new CatalogService({ db, ttlMs: 10000 });
        await svc.getCatalog();
        await svc.getCatalog();
        expect(calls).toBe(1);
    });
});
