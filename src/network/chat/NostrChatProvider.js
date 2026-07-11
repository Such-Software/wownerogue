const ChatProvider = require('./ChatProvider');
const { escapeChatText } = require('../../utils/escapeChat');

/**
 * NostrChatProvider — global cross-server chat over nostr, layered on the existing ChatProvider seam.
 *
 * It DECORATES a local provider (SocketChatProvider): every message is still delivered in-game +
 * persisted exactly as before, and on top of that a global message is fanned out to nostr relays
 * (relay.smirk.cash) so other game servers/modes see it. Messages arriving from the relay are
 * delivered locally-only (never re-published), so there are no echo loops.
 *
 *   publish(local msg)  → local.publish (in-game + history)  +  sign & relay.publish (global fan-out)
 *   relay event (remote)→ local.publish only (in-game + history), text/username escaped
 *
 * Topology: client → server → relay. The server stays the moderation authority (bans, rate-limit,
 * history in Postgres via the local provider); the relay is transport + fan-out. Signing with a
 * registered Smirk npub (the bridge key, or later each player's own) is what the relay's
 * inbox-outbox policy requires to publish — so global chat is a concrete reason to sign in with Smirk.
 *
 * Behavior-preserving: with no transport/signer (nostr disabled) this is exactly the local provider.
 */
class NostrChatProvider extends ChatProvider {
    constructor({
        local,
        transport = null,
        signer = null,
        scope = 'global',
        channelTag = 'wowngeon-global',
        kind = 1,
        serverOrigin = null,
        debugManager = null,
        maxRemotePerMin = 120,
        now = () => Date.now()
    } = {}) {
        super();
        if (!local) throw new Error('NostrChatProvider requires a local provider');
        this.local = local;
        this.transport = transport;
        this.signer = signer;
        this.scope = scope;
        this.channelTag = channelTag;
        this.kind = kind;
        this.serverOrigin = serverOrigin;
        this.debugManager = debugManager;
        this.maxRemotePerMin = maxRemotePerMin;
        this.now = now;

        this._seen = new Set();       // event ids we've delivered/published, for echo dedupe
        this._seenOrder = [];         // bounded FIFO of the same ids
        this._remoteTimes = [];       // recent remote-delivery timestamps (rate limit)
    }

    _globalEnabled() {
        return this.scope === 'global' && !!this.transport;
    }

    async initialize() {
        await this.local.initialize();
        if (!this._globalEnabled()) return;
        const since = Math.floor(this.now() / 1000);
        // Only future messages — no history flood on connect (local history covers the past).
        this.transport.subscribe([{ kinds: [this.kind], '#t': [this.channelTag], since }], (ev) => this._onRemote(ev));
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`[nostr] chat subscribed: tag=${this.channelTag} kind=${this.kind} publish=${this.signer ? 'on' : 'read-only'}`);
        }
    }

    async publish(msg = {}) {
        // 1) Always deliver + persist locally, exactly as before.
        await this.local.publish(msg);

        // 2) Fan out global messages to nostr (skip room-scoped and skip messages we received
        //    from the relay, which arrive here only via local delivery — never through publish).
        if (msg.remote || msg.scope !== 'global' || !this._globalEnabled() || !this.signer) return;
        try {
            const template = {
                kind: this.kind,
                created_at: Math.floor((msg.ts || this.now()) / 1000),
                tags: [['t', this.channelTag], ['n', String(msg.username || '').slice(0, 32)]],
                content: String(msg.text == null ? '' : msg.text)
            };
            if (this.serverOrigin) template.tags.push(['origin', String(this.serverOrigin)]);
            const signed = this.signer.sign(template);
            if (signed && signed.id) this._markSeen(signed.id); // our own echo will be ignored
            await this.transport.publish(signed);
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) console.error('[nostr] fan-out failed:', err.message);
        }
    }

    // A message arriving from the relay: deliver locally only (no re-publish → no loop).
    _onRemote(event) {
        if (!event || typeof event !== 'object') return;
        if (typeof event.content !== 'string' || !Array.isArray(event.tags)) return;
        // Ours (echo) or already seen → drop.
        if (this.signer && event.pubkey === this.signer.pubkey) return;
        if (event.id && !this._markSeen(event.id)) return;
        // Rate-limit remote delivery so a hostile relay can't flood in-game clients.
        if (!this._allowRemote()) return;

        const nTag = event.tags.find(t => Array.isArray(t) && t[0] === 'n');
        const rawName = (nTag && nTag[1]) || (typeof event.pubkey === 'string' ? event.pubkey.slice(0, 8) : 'nostr');
        const username = escapeChatText(rawName, 32) || 'nostr';
        const text = escapeChatText(event.content, 200);
        const ts = Number.isFinite(event.created_at) ? event.created_at * 1000 : this.now();

        // remote:true prevents re-fan-out; local.publish delivers to in-game clients + persists.
        this.local.publish({ scope: 'global', username, text, ts, userId: null, remote: true })
            .catch(err => console.error('[nostr] local deliver of remote failed:', err.message));
    }

    _allowRemote() {
        const cutoff = this.now() - 60000;
        this._remoteTimes = this._remoteTimes.filter(t => t >= cutoff);
        if (this._remoteTimes.length >= this.maxRemotePerMin) return false;
        this._remoteTimes.push(this.now());
        return true;
    }

    // Returns true if the id is new (and records it); false if already seen. Bounded FIFO.
    _markSeen(id) {
        if (this._seen.has(id)) return false;
        this._seen.add(id);
        this._seenOrder.push(id);
        if (this._seenOrder.length > 1000) {
            const old = this._seenOrder.shift();
            this._seen.delete(old);
        }
        return true;
    }

    // Relay a CLIENT-signed event (per-player identity, Phase 2). Delivers the message in-game
    // (escaped text, exactly like a normal global message) and publishes the pre-signed event to
    // the relays WITHOUT re-signing — so it carries the player's OWN npub, not the bridge. The
    // signed id is marked seen so the relay round-trip doesn't re-deliver it.
    async relaySignedEvent({ event, username, text, ts, socketId, userId } = {}) {
        await this.local.publish({ scope: 'global', username, text, ts, socketId, userId });
        if (this._globalEnabled() && event && event.id) {
            this._markSeen(event.id);
            try { await this.transport.publish(event); }
            catch (err) { if (this.debugManager?.CONSOLE_LOGGING) console.error('[nostr] signed relay failed:', err.message); }
        }
    }

    async getHistory(opts) {
        return this.local.getHistory(opts);
    }

    async shutdown() {
        try { if (this.transport) this.transport.close(); } catch (_) {}
        await this.local.shutdown();
    }
}

module.exports = NostrChatProvider;
