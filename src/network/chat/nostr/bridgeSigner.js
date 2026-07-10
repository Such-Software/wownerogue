const { loadNostrTools } = require('../../../utils/nostrLoader');

/**
 * A signer produces signed nostr events for outbound chat. Contract:
 *   { pubkey: <64-hex x-only>, sign(template) -> signedEvent }   (template: {kind, created_at, tags, content})
 *
 * createBridgeSigner builds a SERVER bridge signer from a secret key (hex or nsec). This is the
 * drop-in model: the game server signs cross-server chat with one key. For global chat to be
 * ACCEPTED by relay.smirk.cash (default `inbox-outbox` policy → only registered npubs may publish),
 * this bridge pubkey must be registered as a Smirk npub (an ops step, like the BTCPay API key).
 * A future upgrade signs per-message with each player's OWN Smirk npub (window.smirk.signNostrEvent)
 * so chat identity == wallet identity cryptographically — the provider stays signer-agnostic, so
 * that path only swaps the signer.
 *
 * Returns null when no key is configured → outbound nostr disabled (the provider still receives).
 */
function createBridgeSigner(secret) {
    if (!secret) return null;
    let tools, sk, pubkey;
    try {
        tools = loadNostrTools();
        sk = normalizeSecret(secret, tools);
        pubkey = tools.getPublicKey(sk);
    } catch (err) {
        console.error('[nostr] bridge signer disabled — bad NOSTR_BRIDGE_SK:', err.message);
        return null;
    }
    return {
        pubkey,
        sign(template) {
            // finalizeEvent fills pubkey/id/sig and stamps created_at if absent.
            return tools.finalizeEvent(
                {
                    kind: template.kind,
                    created_at: template.created_at || Math.floor(Date.now() / 1000),
                    tags: template.tags || [],
                    content: template.content || ''
                },
                sk
            );
        }
    };
}

// Accept an nsec bech32 or a 64-hex string; return the Uint8Array secret nostr-tools expects.
function normalizeSecret(secret, tools) {
    const s = String(secret).trim();
    if (s.startsWith('nsec1')) {
        const dec = tools.nip19.decode(s);
        if (dec.type !== 'nsec') throw new Error('not an nsec');
        return dec.data; // Uint8Array
    }
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) bytes[i] = parseInt(s.substr(i * 2, 2), 16);
        return bytes;
    }
    throw new Error('expected nsec or 64-hex secret key');
}

module.exports = { createBridgeSigner };
