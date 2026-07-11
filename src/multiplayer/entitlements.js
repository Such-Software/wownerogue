const Appearance = require('./appearance');

// Built-in default catalog. This is the FALLBACK used when the DB `cosmetic_catalog` table
// (migration 024) isn't available (fresh/partly-migrated dev DBs, unit tests). In production the
// operator-owned DB catalog is loaded by CatalogService and passed into snapshotForUser(); this
// object just mirrors the four seed packs so nothing regresses without the table.
//
// Each entry: { id, label, kind, projection, tier, unlockMinCredits, grantOnly, premium }.
//   tier            — 0 = free tier; ordered ladder (1,2,3) for premium subscriptions.
//   unlockMinCredits — lifetime-spend threshold to unlock, or null (not credit-unlockable).
//   grantOnly       — only obtainable via an explicit grant/purchase.
//   premium         — derived convenience flag: true unless the pack is free (no gate at all).
const DEFAULT_CATALOG = Object.freeze({
    'roguelike-interior': Object.freeze({
        id: 'roguelike-interior', label: 'Kenney Roguelike Interior', kind: 'render-pack',
        projection: 'topdown', tier: 0, unlockMinCredits: null, grantOnly: false, premium: false
    }),
    // Graduated ladder — unlock by lifetime credit spend OR by subscription tier, whichever comes
    // first: Fancy(skins) at 1 credit / supporter, Iso at 10 / premium, 3D at 25 / operator.
    'generated-skins': Object.freeze({
        id: 'generated-skins', label: 'Premium Generated Skins', kind: 'render-pack',
        projection: 'topdown', tier: 1, unlockMinCredits: 1, grantOnly: false, premium: true
    }),
    'iso-dungeon': Object.freeze({
        id: 'iso-dungeon', label: 'Kenney Isometric Dungeon', kind: 'render-pack',
        projection: 'iso', tier: 2, unlockMinCredits: 10, grantOnly: false, premium: true
    }),
    'iso-medieval': Object.freeze({
        id: 'iso-medieval', label: 'Medieval Town (Isometric)', kind: 'render-pack',
        projection: 'iso', tier: 2, unlockMinCredits: 15, grantOnly: false, premium: true
    }),
    'kenney-3d-characters': Object.freeze({
        id: 'kenney-3d-characters', label: 'Kenney Animated 3D Characters', kind: 'render-pack',
        projection: '3d', tier: 3, unlockMinCredits: 25, grantOnly: false, premium: true
    })
});

// Ordered premium-tier ladder. Buying credits does NOT put you on this ladder (that was the old
// bug — any purchase → level 'credits' → every premium pack unlocked). 'credits' maps to tier 0.
const TIER_OF = Object.freeze({ free: 0, credits: 0, supporter: 1, premium: 2, operator: 3 });

// Backwards-compatible alias: productGrants.js and older callers validate pack ids against PACKS.
const PACKS = DEFAULT_CATALOG;
// Legacy: the set of premium level names (still referenced by a couple of callers).
const PREMIUM_LEVELS = new Set(['credits', 'supporter', 'premium', 'operator']);

function asNumber(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
}

function tierForLevel(level) {
    const t = TIER_OF[String(level || '').toLowerCase()];
    return t == null ? 0 : t;
}

function isFreePack(pack) {
    return asNumber(pack.tier) === 0 && (pack.unlockMinCredits == null) && !pack.grantOnly;
}

function normalizePackGrants(grants = [], catalog = DEFAULT_CATALOG) {
    const out = {};
    if (Array.isArray(grants)) {
        for (const g of grants) {
            const id = g && (g.pack_id || g.packId || g.id);
            if (id && catalog[id]) out[id] = true;
        }
        return out;
    }
    if (grants && typeof grants === 'object') {
        for (const id of Object.keys(grants)) {
            if (catalog[id] && grants[id]) out[id] = true;
        }
    }
    return out;
}

// Only a REAL premium tier (supporter/premium/operator) counts as a level; buying credits does not.
// The tier is the HIGHEST of the stored premium_level and any active-subscription tier: a live
// wowne.ro premium sub sets subscription_tier (e.g. 'premium') and thereby unlocks the cosmetic
// packs at/below that tier — one subscription drives both chat perks and tile/customization unlocks.
// (The subscription_tier field is populated by the user loader from a subscription check; absent =
// unchanged legacy behavior.)
function levelForUser(user = {}) {
    const candidates = [user.premium_level, user.premiumLevel, user.subscription_tier, user.subscriptionTier]
        .map(v => String(v || '').trim().toLowerCase())
        .filter(l => tierForLevel(l) > 0);
    if (!candidates.length) return 'free';
    return candidates.reduce((a, b) => (tierForLevel(b) > tierForLevel(a) ? b : a));
}

// A pack is unlocked for a user if ANY of: it's free, an explicit grant, the user's lifetime
// spend crosses the pack's threshold, or the user's premium tier is >= the pack's tier.
function snapshotForUser(user = {}, packGrants = [], catalog = DEFAULT_CATALOG) {
    catalog = catalog && typeof catalog === 'object' ? catalog : DEFAULT_CATALOG;
    const totalCreditsPurchased = asNumber(user.total_credits_purchased || user.totalCreditsPurchased);
    const credits = asNumber(user.credits);
    const level = levelForUser(user);
    const userTier = tierForLevel(level);
    const explicit = normalizePackGrants(packGrants, catalog);

    const packs = {};
    let anyPremiumUnlocked = false;
    for (const id of Object.keys(catalog)) {
        const pack = catalog[id];
        const tier = asNumber(pack.tier);
        const minCredits = pack.unlockMinCredits;
        const free = isFreePack(pack);
        const unlocked = free
            || !!explicit[id]
            || (minCredits != null && totalCreditsPurchased >= asNumber(minCredits))
            || (tier > 0 && userTier >= tier);
        packs[id] = unlocked;
        if (!free && unlocked) anyPremiumUnlocked = true;
    }

    return {
        premium: userTier > 0 || anyPremiumUnlocked,
        level,
        tier: userTier,
        credits,
        totalCreditsPurchased,
        packs,
        catalog: catalogSummary(catalog)
    };
}

// Display-facing catalog the client renders (labels/projection/gating) — replaces the hardcoded
// client RK.PACKS so the operator owns the catalog from one place (the DB).
function catalogSummary(catalog = DEFAULT_CATALOG) {
    const out = [];
    for (const id of Object.keys(catalog)) {
        const p = catalog[id];
        out.push({
            id: p.id || id,
            label: p.label || id,
            kind: p.kind || 'render-pack',
            projection: p.projection || null,
            tier: asNumber(p.tier),
            premium: !isFreePack(p),
            unlockMinCredits: p.unlockMinCredits == null ? null : asNumber(p.unlockMinCredits)
        });
    }
    return out;
}

// Gating reads the user's computed snapshot (which already contains every catalog pack). Unknown
// packs default to the built-in catalog's free-check (deny premium, allow free).
function canUsePack(entitlements = {}, packId) {
    if (!packId) return true;
    // A full snapshot's packs map is authoritative (the three-way rule already ran).
    if (entitlements.packs && Object.prototype.hasOwnProperty.call(entitlements.packs, packId)) {
        return !!entitlements.packs[packId];
    }
    // No granular packs map (a coarse/legacy entitlement): free packs are always allowed; else
    // fall back to the coarse premium flag. Production entitlements always carry the packs map,
    // so this branch never weakens real gating.
    const def = DEFAULT_CATALOG[packId];
    if (def && isFreePack(def)) return true;
    return !!entitlements.premium;
}

function canUseAppearance(entitlements = {}, appearanceOrAvatar = {}) {
    const appearance = Appearance.normalizeAppearance(appearanceOrAvatar);
    const packId = Appearance.avatarPack(appearance.avatar);
    return !packId || canUsePack(entitlements, packId);
}

function normalizeAppearance(input = {}, entitlements = {}) {
    const appearance = Appearance.normalizeAppearance(input);
    if (!canUseAppearance(entitlements, appearance)) {
        return Appearance.normalizeAppearance('default');
    }
    return appearance;
}

module.exports = {
    DEFAULT_CATALOG,
    PACKS,
    PREMIUM_LEVELS,
    TIER_OF,
    tierForLevel,
    snapshotForUser,
    catalogSummary,
    canUsePack,
    canUseAppearance,
    normalizeAppearance,
    normalizePackGrants
};
