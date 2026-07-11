(function (root) {
    'use strict';
    // Per-player nostr identity (Phase 2). Sign a global-chat message with the player's OWN Smirk
    // npub (window.smirk.signNostrEvent) and emit it as `chat_signed`; the server verifies it's
    // signed by this session's authenticated npub, then relays it to nostr under that npub.
    //
    // Returns a Promise<boolean>: true if it signed + emitted, false if Smirk signing is
    // unavailable or declined — in which case the caller falls back to the normal unsigned send.
    // Feature-detected end to end, so it's a no-op (always false) until the page has a connected
    // Smirk wallet; wiring it into a send site is therefore always safe.
    // Sign an event, granting the Nostr scope on demand. Signing FIRST means a returning user
    // (scope already granted for this origin — e.g. from the game's NIP-98 login) gets a single
    // approval; only a first-time origin hits NOT_AUTHORIZED and needs the one-time scope grant.
    // Same pattern as SmirkAuth (html/js/network/smirkAuth.js).
    function signWithScope(smirk, tmpl) {
        return Promise.resolve()
            .then(function () { return smirk.signNostrEvent(tmpl); })
            .catch(function (err) {
                var needsScope = (err && err.code === 'NOT_AUTHORIZED')
                    || /nostr scope|getNostrPublicKey/i.test((err && err.message) || '');
                if (!needsScope || typeof smirk.getNostrPublicKey !== 'function') throw err;
                return smirk.getNostrPublicKey().then(function () { return smirk.signNostrEvent(tmpl); });
            });
    }

    function smirkChatSign(socket, text, tag) {
        try {
            var smirk = root.smirk;
            if (!socket || !smirk || typeof smirk.signNostrEvent !== 'function') return Promise.resolve(false);
            var tmpl = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['t', tag || 'wowngeon-global']],
                content: String(text)
            };
            return signWithScope(smirk, tmpl).then(function (signed) {
                if (!signed || !signed.id || !signed.sig || !signed.pubkey) return false;
                socket.emit('chat_signed', { event: signed });
                return true;
            }).catch(function () { return false; });
        } catch (e) {
            return Promise.resolve(false);
        }
    }
    root.smirkChatSign = smirkChatSign;
})(typeof window !== 'undefined' ? window : this);
