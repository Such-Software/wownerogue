const { loadNostrTools } = require('../utils/nostrLoader');

/**
 * Resolves a player's premium-subscription TIER by their nostr pubkey, so an active subscription
 * unlocks cosmetics (see docs/MONETIZATION.md). The game can't read the Smirk backend's self-only
 * /premium/status by npub, so this resolves from two sources, in order:
 *
 *   1. PREMIUM_NPUBS — an operator allowlist ("npub1…|hex[:tier],…"). Works TODAY, zero backend
 *      dependency: mark specific npubs premium and they get the tier immediately.
 *   2. SMIRK_PREMIUM_STATUS_URL — an optional HTTP endpoint that answers premium-by-npub, for full
 *      automation once the Smirk backend exposes a service lookup ({active, tier?}). Degrades to (1).
 *
 * Results are cached (TTL). With no source configured, tierForNpub() returns null → unchanged
 * legacy behavior (no one is auto-promoted).
 */
class SubscriptionService {
    constructor({ env = process.env, fetchImpl = null, ttlMs = 300000, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.cache = new Map(); // pubkeyHex -> { tier, exp }
        this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
        this.defaultTier = String(env.PREMIUM_DEFAULT_TIER || 'premium').trim().toLowerCase();
        this.allowlist = parseAllowlist(env.PREMIUM_NPUBS, this.defaultTier);
        this.statusUrl = env.SMIRK_PREMIUM_STATUS_URL || null;
        this.statusKey = env.SMIRK_PREMIUM_STATUS_KEY || null;
    }

    get enabled() { return this.allowlist.size > 0 || !!this.statusUrl; }

    /** @returns {Promise<string|null>} a premium tier name (e.g. 'premium') or null. */
    async tierForNpub(pubkey) {
        if (!pubkey) return null;
        const key = String(pubkey).toLowerCase();
        const hit = this.cache.get(key);
        if (hit && hit.exp > this.now()) return hit.tier;

        let tier = this.allowlist.get(key) || null;
        if (!tier && this.statusUrl && this.fetch) tier = await this._httpTier(key);

        this.cache.set(key, { tier, exp: this.now() + this.ttlMs });
        return tier;
    }

    async _httpTier(pubkeyHex) {
        try {
            const sep = this.statusUrl.includes('?') ? '&' : '?';
            const res = await this.fetch(`${this.statusUrl}${sep}npub=${encodeURIComponent(pubkeyHex)}`, {
                headers: this.statusKey ? { Authorization: `Bearer ${this.statusKey}` } : {}
            });
            if (!res || !res.ok) return null;
            const j = await res.json();
            if (j && j.active) return String(j.tier || this.defaultTier).toLowerCase();
            return null;
        } catch (_) { return null; }
    }
}

// "npub1…|64hex[:tier], …" -> Map(pubkeyHex -> tier). npub1 entries are decoded to x-only hex so
// they match users.smirk_public_key. Bad entries are skipped.
function parseAllowlist(raw, defaultTier) {
    const map = new Map();
    if (!raw) return map;
    let tools = null;
    for (const entry of String(raw).split(',')) {
        const [idRaw, tierRaw] = entry.split(':').map((s) => (s || '').trim());
        if (!idRaw) continue;
        let hex = null;
        if (/^[0-9a-fA-F]{64}$/.test(idRaw)) {
            hex = idRaw.toLowerCase();
        } else if (idRaw.startsWith('npub1')) {
            try {
                tools = tools || loadNostrTools();
                const dec = tools.nip19.decode(idRaw);
                if (dec.type === 'npub' && typeof dec.data === 'string') hex = dec.data.toLowerCase();
            } catch (_) { /* skip */ }
        }
        if (hex) map.set(hex, (tierRaw || '').toLowerCase() || defaultTier);
    }
    return map;
}

module.exports = SubscriptionService;
