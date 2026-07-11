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
            return Promise.resolve(smirk.signNostrEvent(tmpl)).then(function (signed) {
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
