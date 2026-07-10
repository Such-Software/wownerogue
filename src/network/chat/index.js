const NostrChatProvider = require('./NostrChatProvider');
const NostrTransport = require('./nostr/NostrTransport');
const { createBridgeSigner } = require('./nostr/bridgeSigner');

function parseBool(v) {
    if (v == null) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

/**
 * Build the chat provider for the given local (in-game) provider. Single opt-in seam for Pillar 5.
 *
 * Behavior-preserving: with NOSTR_CHAT_ENABLED unset (today) the plain local provider is returned
 * unchanged. Enable to layer global cross-server chat over nostr:
 *   NOSTR_CHAT_ENABLED=true
 *   NOSTR_CHAT_SCOPE=global|local   (local == plain local chat; global fans out over relays)
 *   NOSTR_RELAYS=wss://relay.smirk.cash[,...]
 *   NOSTR_CHAT_TAG=wowngeon-global  (the shared channel topic)
 *   NOSTR_CHAT_KIND=1
 *   NOSTR_BRIDGE_SK=<nsec|hex>      (server bridge key; must be a registered Smirk npub to publish.
 *                                    Omit → receive-only global chat.)
 */
function buildChatProvider({ local, env = process.env, debugManager = null } = {}) {
    if (!local) throw new Error('buildChatProvider requires a local provider');
    if (!parseBool(env.NOSTR_CHAT_ENABLED)) return local;

    const scope = (env.NOSTR_CHAT_SCOPE || 'global').toLowerCase();
    if (scope !== 'global') return local; // local-only is exactly the plain provider

    const relays = (env.NOSTR_RELAYS || 'wss://relay.smirk.cash').split(',').map(s => s.trim()).filter(Boolean);
    const transport = new NostrTransport({ relays, debugManager });
    const signer = createBridgeSigner(env.NOSTR_BRIDGE_SK);

    return new NostrChatProvider({
        local,
        transport,
        signer,
        scope: 'global',
        channelTag: env.NOSTR_CHAT_TAG || 'wowngeon-global',
        kind: parseInt(env.NOSTR_CHAT_KIND || '1', 10) || 1,
        serverOrigin: env.NOSTR_SERVER_ORIGIN || env.SERVER_ID || null,
        debugManager
    });
}

module.exports = { buildChatProvider, NostrChatProvider, NostrTransport };
