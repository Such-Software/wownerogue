const Appearance = require('../multiplayer/appearance');
const Entitlements = require('../multiplayer/entitlements');
const CatalogService = require('../services/catalogService');
const SubscriptionService = require('../services/subscriptionService');

function parseAppearance(value) {
    if (!value) return Appearance.normalizeAppearance('default');
    if (typeof value === 'string') {
        try {
            return Appearance.normalizeAppearance(JSON.parse(value));
        } catch (_) {
            return Appearance.normalizeAppearance('default');
        }
    }
    return Appearance.normalizeAppearance(value);
}

class IdentityService {
    constructor({ db = null, gameModeManager = null, sessionManager = null, debugManager = null, catalogService = null, subscriptionService = null } = {}) {
        this.db = db || gameModeManager?.db || null;
        this.gameModeManager = gameModeManager;
        this.sessionManager = sessionManager;
        this.debugManager = debugManager;
        // Operator-owned cosmetic catalog (DB-backed, cached). Falls back to the built-in default
        // when the table is absent, so this never breaks a fresh/partly-migrated DB.
        this.catalogService = catalogService || (this.db ? new CatalogService({ db: this.db }) : null);
        // Resolves a premium-subscription tier by npub so a sub unlocks cosmetics. No source
        // configured (PREMIUM_NPUBS / SMIRK_PREMIUM_STATUS_URL) => inert (returns null).
        this.subscriptionService = subscriptionService || new SubscriptionService();
    }

    async _catalog() {
        if (!this.catalogService) return undefined; // snapshotForUser falls back to DEFAULT_CATALOG
        try {
            return await this.catalogService.getCatalog();
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.warn('[IdentityService] catalog load failed; using default:', err.message);
            }
            return undefined;
        }
    }

    async userForSocket(socket) {
        if (!socket) return null;
        if (this.gameModeManager && typeof this.gameModeManager.getOrCreateUser === 'function') {
            return this.gameModeManager.getOrCreateUser(socket.id);
        }
        if (this.sessionManager && typeof this.sessionManager.getBySocket === 'function') {
            return this.sessionManager.getBySocket(socket.id);
        }
        return null;
    }

    async packGrantsForUser(userId) {
        if (!this.db || userId == null) return [];
        try {
            const result = await this.db.query(`
                SELECT pack_id, source, granted_at, expires_at
                FROM user_pack_entitlements
                WHERE user_id = $1
                  AND (expires_at IS NULL OR expires_at > NOW())
            `, [userId]);
            return result.rows || [];
        } catch (err) {
            // Fresh deployments run migrations before sockets are accepted. This fallback keeps
            // tests and partially-migrated dev DBs from losing the whole connection path.
            if (err && (err.code === '42P01' || /user_pack_entitlements/i.test(err.message || ''))) {
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.warn('[IdentityService] user_pack_entitlements unavailable; using credit policy only.');
                }
                return [];
            }
            throw err;
        }
    }

    async entitlementsForUser(user) {
        const catalog = await this._catalog();
        if (!user) return Entitlements.snapshotForUser({}, [], catalog);
        const grants = await this.packGrantsForUser(user.id);
        // An active premium subscription (resolved by npub) sets subscription_tier, which unlocks
        // the cosmetic packs at/below that tier. Best-effort: any resolver failure leaves it unset.
        if (this.subscriptionService && user.smirk_public_key && user.subscription_tier == null) {
            try {
                const tier = await this.subscriptionService.tierForNpub(user.smirk_public_key);
                if (tier) user = { ...user, subscription_tier: tier };
            } catch (_) { /* leave unset */ }
        }
        return Entitlements.snapshotForUser(user, grants, catalog);
    }

    async entitlementsForSocket(socket) {
        const user = await this.userForSocket(socket);
        return this.entitlementsForUser(user);
    }

    async identityForSocket(socket) {
        const user = await this.userForSocket(socket);
        const entitlements = await this.entitlementsForUser(user);
        const appearance = Entitlements.normalizeAppearance(parseAppearance(user?.appearance), entitlements);
        return {
            appearance,
            entitlements
        };
    }

    async saveAppearanceForSocket(socket, input) {
        const user = await this.userForSocket(socket);
        const entitlements = await this.entitlementsForUser(user);
        const appearance = Entitlements.normalizeAppearance(input, entitlements);

        if (!this.db || !user?.id) {
            return { appearance, entitlements };
        }

        const result = await this.db.query(`
            UPDATE users
            SET appearance = $1::jsonb,
                updated_at = NOW()
            WHERE id = $2
            RETURNING *
        `, [JSON.stringify(appearance), user.id]);

        const updated = result.rows && result.rows[0] ? result.rows[0] : { ...user, appearance };
        this._refreshSessionCache(socket.id, updated);
        return {
            appearance: Entitlements.normalizeAppearance(parseAppearance(updated.appearance), entitlements),
            entitlements
        };
    }

    _refreshSessionCache(socketId, user) {
        if (!socketId || !user || !this.sessionManager?.sessions) return;
        if (this.sessionManager.sessions.has(socketId)) {
            this.sessionManager.sessions.set(socketId, user);
        }
    }

    // -------------------------------------------------------------------------
    // Helpers for match mode (user lookup by stable id, not socket)
    // -------------------------------------------------------------------------

    async userForId(userId) {
        if (!this.db || userId == null) return null;
        try {
            const result = await this.db.query(`
                SELECT * FROM users WHERE id = $1 LIMIT 1
            `, [userId]);
            return result.rows && result.rows[0] ? result.rows[0] : null;
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.warn('[IdentityService] userForId failed:', err.message);
            }
            return null;
        }
    }
}

module.exports = IdentityService;
