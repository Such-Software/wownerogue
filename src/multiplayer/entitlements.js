const Appearance = require('./appearance');

const PACKS = Object.freeze({
    'roguelike-interior': Object.freeze({
        id: 'roguelike-interior',
        label: 'Kenney Roguelike Interior',
        premium: false,
        projection: 'topdown'
    }),
    'generated-skins': Object.freeze({
        id: 'generated-skins',
        label: 'Premium Generated Skins',
        premium: true,
        projection: 'topdown',
        unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
    }),
    'iso-dungeon': Object.freeze({
        id: 'iso-dungeon',
        label: 'Kenney Isometric Dungeon',
        premium: true,
        projection: 'iso',
        unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
    }),
    'kenney-3d-characters': Object.freeze({
        id: 'kenney-3d-characters',
        label: 'Kenney Animated 3D Characters',
        premium: true,
        projection: '3d',
        unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
    })
});

const PREMIUM_LEVELS = new Set(['credits', 'supporter', 'premium', 'operator']);

function asNumber(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
}

function normalizePackGrants(grants = []) {
    const out = {};
    if (Array.isArray(grants)) {
        for (const g of grants) {
            const id = g && (g.pack_id || g.packId || g.id);
            if (id && PACKS[id]) out[id] = true;
        }
        return out;
    }
    if (grants && typeof grants === 'object') {
        for (const id of Object.keys(grants)) {
            if (PACKS[id] && grants[id]) out[id] = true;
        }
    }
    return out;
}

function levelForUser(user = {}) {
    const raw = String(user.premium_level || user.premiumLevel || '').trim().toLowerCase();
    if (raw) return raw;
    return asNumber(user.total_credits_purchased || user.totalCreditsPurchased) > 0 ? 'credits' : 'free';
}

function snapshotForUser(user = {}, packGrants = []) {
    const totalCreditsPurchased = asNumber(user.total_credits_purchased || user.totalCreditsPurchased);
    const credits = asNumber(user.credits);
    const level = levelForUser(user);
    const explicit = normalizePackGrants(packGrants);
    const hasCreditUnlock = totalCreditsPurchased > 0;
    const hasPremiumLevel = PREMIUM_LEVELS.has(level);
    const packs = {};

    for (const id of Object.keys(PACKS)) {
        const pack = PACKS[id];
        if (!pack.premium) {
            packs[id] = true;
            continue;
        }
        const unlock = pack.unlock || {};
        const unlockedByCredits = unlock.kind === 'credits_purchase'
            && hasCreditUnlock
            && totalCreditsPurchased >= (unlock.minTotalCreditsPurchased || 1);
        packs[id] = !!explicit[id] || unlockedByCredits || hasPremiumLevel;
    }

    const premiumPackUnlocked = Object.keys(packs).some(id => PACKS[id].premium && packs[id]);
    return {
        premium: hasCreditUnlock || hasPremiumLevel || premiumPackUnlocked,
        level: level === 'free' && hasCreditUnlock ? 'credits' : level,
        credits,
        totalCreditsPurchased,
        packs
    };
}

function canUsePack(entitlements = {}, packId) {
    const pack = PACKS[packId];
    if (!pack) return false;
    if (!pack.premium) return true;
    if (entitlements.packs && Object.prototype.hasOwnProperty.call(entitlements.packs, packId)) {
        return !!entitlements.packs[packId];
    }
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
    PACKS,
    PREMIUM_LEVELS,
    snapshotForUser,
    canUsePack,
    canUseAppearance,
    normalizeAppearance,
    normalizePackGrants
};
