const { DEFAULT_CATALOG } = require('../multiplayer/entitlements');

/**
 * Loads the operator-owned cosmetic catalog (migration 024 `cosmetic_catalog`) — the single
 * server-authoritative source for pack definitions + unlock rules, replacing the split-brain
 * hardcoded PACKS in entitlements.js (server) and assetPacks.js (client, via the served snapshot).
 *
 * Cached with a short TTL. Falls back to the built-in DEFAULT_CATALOG when the table is absent
 * (fresh/partly-migrated DBs, tests) so nothing regresses without it.
 */
class CatalogService {
    constructor({ db = null, ttlMs = 60000 } = {}) {
        this.db = db;
        this.ttlMs = ttlMs;
        this._cache = null;
        this._cacheAt = 0;
    }

    async getCatalog() {
        const now = Date.now();
        if (this._cache && (now - this._cacheAt) < this.ttlMs) return this._cache;
        const loaded = await this._load();
        this._cache = loaded;
        this._cacheAt = now;
        return loaded;
    }

    invalidate() {
        this._cache = null;
        this._cacheAt = 0;
    }

    async _load() {
        if (!this.db || typeof this.db.query !== 'function') return DEFAULT_CATALOG;
        try {
            const res = await this.db.query(`
                SELECT pack_id, label, kind, projection, tier, unlock_min_credits, grant_only, active, metadata
                FROM cosmetic_catalog
                WHERE active = TRUE
                ORDER BY sort_order, pack_id
            `);
            const rows = (res && res.rows) || [];
            if (rows.length === 0) return DEFAULT_CATALOG;
            const out = {};
            for (const r of rows) {
                // Defend against non-catalog rows (e.g. a mock/query returning grant rows, which
                // have pack_id but no label). Real catalog rows have both NOT-NULL fields.
                if (!r || typeof r.pack_id !== 'string' || !r.pack_id || typeof r.label !== 'string' || !r.label) continue;
                const tier = Number(r.tier || 0);
                const minCredits = r.unlock_min_credits == null ? null : Number(r.unlock_min_credits);
                const grantOnly = !!r.grant_only;
                const premium = !(tier === 0 && minCredits == null && !grantOnly);
                out[r.pack_id] = {
                    id: r.pack_id,
                    label: r.label,
                    kind: r.kind || 'render-pack',
                    projection: r.projection || null,
                    tier,
                    unlockMinCredits: minCredits,
                    grantOnly,
                    premium,
                    metadata: r.metadata || {}
                };
            }
            if (Object.keys(out).length === 0) return DEFAULT_CATALOG; // no valid catalog rows
            return out;
        } catch (err) {
            // Table missing (fresh/partly-migrated DB) — degrade to the built-in default.
            if (err && (err.code === '42P01' || /cosmetic_catalog/i.test(err.message || ''))) {
                return DEFAULT_CATALOG;
            }
            throw err;
        }
    }
}

module.exports = CatalogService;
