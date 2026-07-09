const Entitlements = require('../multiplayer/entitlements');

function asInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizePremiumLevel(value) {
    if (typeof value !== 'string') return null;
    const level = value.trim().toLowerCase();
    if (!level || level === 'free') return null;
    return level;
}

function normalizePackGrant(input) {
    if (!input) return null;
    const grant = typeof input === 'string' ? { id: input } : input;
    const id = grant.id || grant.packId || grant.pack_id;
    if (!id || !Entitlements.PACKS[id]) return null;
    return {
        id,
        expiresAt: grant.expiresAt || grant.expires_at || null,
        source: grant.source || 'product_purchase'
    };
}

function normalizeProductGrants(product = {}, fallback = {}) {
    const explicit = product && typeof product.grants === 'object' && product.grants !== null
        ? product.grants
        : {};
    const fallbackCredits = asInt(
        fallback.credits != null
            ? fallback.credits
            : (asInt(product.credits, 0) + asInt(product.bonus, 0)),
        0
    );

    let credits = fallbackCredits;
    if (explicit.credits != null) {
        if (typeof explicit.credits === 'object') {
            credits = asInt(explicit.credits.amount, fallbackCredits);
        } else {
            credits = asInt(explicit.credits, fallbackCredits);
        }
    }

    let raceEntries = 0;
    if (explicit.race_entries != null || explicit.raceEntries != null) {
        raceEntries = asInt(explicit.race_entries || explicit.raceEntries, 0);
    }

    const packs = [];
    const packInputs = Array.isArray(explicit.packs) ? explicit.packs : [];
    for (const p of packInputs) {
        const normalized = normalizePackGrant(p);
        if (normalized && !packs.some(existing => existing.id === normalized.id)) {
            packs.push(normalized);
        }
    }

    return {
        credits: Math.max(0, credits),
        packs,
        raceEntries: Math.max(0, raceEntries),
        premiumLevel: normalizePremiumLevel(explicit.premiumLevel || explicit.premium_level)
    };
}

function serializeProductGrants(grants = {}) {
    return {
        credits: asInt(grants.credits, 0),
        raceEntries: asInt(grants.raceEntries || grants.race_entries, 0),
        packs: Array.isArray(grants.packs)
            ? grants.packs.map(normalizePackGrant).filter(Boolean)
            : [],
        premiumLevel: normalizePremiumLevel(grants.premiumLevel)
    };
}

function publicGrantSummary(grants = {}) {
    const normalized = serializeProductGrants(grants);
    return {
        credits: normalized.credits,
        raceEntries: normalized.raceEntries,
        packs: normalized.packs.map(p => p.id),
        premiumLevel: normalized.premiumLevel
    };
}

module.exports = {
    normalizeProductGrants,
    serializeProductGrants,
    publicGrantSummary
};
