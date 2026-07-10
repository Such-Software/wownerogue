const { loadNostrTools } = require('../../../utils/nostrLoader');

/**
 * Thin transport over nostr-tools SimplePool: connect to relays, publish signed events, subscribe
 * to filters. Isolated behind this class so NostrChatProvider can be unit-tested with a fake
 * transport (no network). Degrades to a warn-and-noop if nostr-tools/ws can't load, so enabling
 * chat can never crash the server.
 *
 * Reading (REQ/subscribe) is open on relay.smirk.cash; only publishing is policy-gated.
 */
class NostrTransport {
    constructor({ relays = ['wss://relay.smirk.cash'], debugManager = null } = {}) {
        this.relays = Array.isArray(relays) ? relays.filter(Boolean) : [];
        this.debugManager = debugManager;
        this.pool = null;
        this._sub = null;
        this._ok = false;
    }

    connect() {
        if (this.pool || !this.relays.length) return this._ok;
        try {
            const tools = loadNostrTools();
            if (typeof tools.useWebSocketImplementation === 'function') {
                try { tools.useWebSocketImplementation(require('ws')); } catch (_) { /* browser/global WS */ }
            }
            this.pool = new tools.SimplePool();
            this._ok = true;
        } catch (err) {
            console.error('[nostr] transport disabled (nostr-tools/ws unavailable):', err.message);
            this._ok = false;
        }
        return this._ok;
    }

    async publish(signedEvent) {
        if (!this.connect()) return;
        try {
            await Promise.any(this.pool.publish(this.relays, signedEvent));
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) console.error('[nostr] publish failed:', err?.message || err);
        }
    }

    subscribe(filters, onEvent) {
        if (!this.connect()) return;
        try {
            this._sub = this.pool.subscribeMany(this.relays, filters, {
                onevent: (ev) => { try { onEvent(ev); } catch (e) { console.error('[nostr] onEvent error:', e.message); } }
            });
        } catch (err) {
            console.error('[nostr] subscribe failed:', err.message);
        }
    }

    close() {
        try { if (this._sub && typeof this._sub.close === 'function') this._sub.close(); } catch (_) {}
        try { if (this.pool && typeof this.pool.close === 'function') this.pool.close(this.relays); } catch (_) {}
        this._sub = null;
        this.pool = null;
        this._ok = false;
    }
}

module.exports = NostrTransport;
