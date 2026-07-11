const { loadNostrTools } = require('./nostrLoader');

const { getEventHash, verifyEvent } = loadNostrTools();

const HEX_64 = /^[0-9a-f]{64}$/;   // x-only secp256k1 pubkey / event id
const HEX_128 = /^[0-9a-f]{128}$/; // BIP-340 schnorr signature

function fail(reason) { return { ok: false, reason }; }

/**
 * Verify a client-signed global-chat event before the server relays it to nostr (Phase 2 per-player
 * signing). Same defense posture as verifyNip98Event: rebuild a clean event from primitives,
 * INDEPENDENTLY recompute the id, verify the schnorr signature, check freshness — and, critically,
 * bind the author to the session's authenticated npub so a player can only ever post as THEMSELVES.
 *
 * @param {object} event  signed nostr event { kind, created_at, pubkey, id, sig, content, tags }
 * @param {object} opts
 * @param {string}  opts.expectedPubkey  64-hex x-only key the session is authenticated as (from NIP-98 login) — required
 * @param {string} [opts.channelTag]     't' tag the event must carry (default 'wowngeon-global')
 * @param {number} [opts.kind]           expected kind (default 1)
 * @param {number} [opts.maxLen]         max content length (default 280)
 * @param {number} [opts.now]            unix seconds (default now)
 * @param {number} [opts.maxSkewSec]     freshness window (default 120)
 * @returns {{ ok: boolean, reason?: string, pubkey?: string, content?: string }}
 */
function verifyChatEvent(event, opts = {}) {
    const {
        expectedPubkey,
        channelTag = 'wowngeon-global',
        kind = 1,
        maxLen = 280,
        now = Math.floor(Date.now() / 1000),
        maxSkewSec = 120
    } = opts;

    if (!expectedPubkey || !HEX_64.test(String(expectedPubkey).toLowerCase())) return fail('no-expected-pubkey');

    // Shape/type validation.
    if (!event || typeof event !== 'object' || Array.isArray(event)) return fail('event-not-object');
    if (typeof event.kind !== 'number') return fail('kind-not-number');
    if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at)) return fail('created_at-not-number');
    if (typeof event.pubkey !== 'string' || !HEX_64.test(event.pubkey.toLowerCase())) return fail('bad-pubkey');
    if (typeof event.id !== 'string' || !HEX_64.test(event.id.toLowerCase())) return fail('bad-id');
    if (typeof event.sig !== 'string' || !HEX_128.test(event.sig.toLowerCase())) return fail('bad-sig');
    if (typeof event.content !== 'string') return fail('content-not-string');
    if (!Array.isArray(event.tags)) return fail('tags-not-array');
    for (const t of event.tags) {
        if (!Array.isArray(t) || t.some((v) => typeof v !== 'string')) return fail('malformed-tag');
    }

    if (event.kind !== kind) return fail('wrong-kind');
    if (event.content.length > maxLen) return fail('too-long');

    // Author binding — the ONE that stops impersonation: the event must be signed by the npub this
    // session authenticated as (users.smirk_public_key from NIP-98 login). A valid signature by
    // SOME other key is not enough.
    if (event.pubkey.toLowerCase() !== String(expectedPubkey).toLowerCase()) return fail('pubkey-mismatch');

    // Rebuild a clean event from primitives only (strips any stamped verified-symbol / extras).
    const clean = {
        kind: event.kind,
        created_at: event.created_at,
        pubkey: event.pubkey.toLowerCase(),
        id: event.id.toLowerCase(),
        sig: event.sig.toLowerCase(),
        content: event.content,
        tags: event.tags.map((t) => t.slice())
    };

    // Independently recompute the id — defeats content/tag tampering regardless of memoization.
    let recomputed;
    try { recomputed = getEventHash(clean); } catch (_) { return fail('hash-error'); }
    if (recomputed !== clean.id) return fail('id-mismatch');

    // BIP-340 schnorr signature.
    let sigOk = false;
    try { sigOk = verifyEvent(clean) === true; } catch (_) { return fail('sig-verify-threw'); }
    if (!sigOk) return fail('bad-signature');

    // Freshness — reject replayed-late / skewed events.
    if (Math.abs(now - Number(clean.created_at)) > maxSkewSec) return fail('expired');

    // Must target OUR channel tag, so the server can't be used to relay arbitrary events.
    const tTags = clean.tags.filter((t) => t[0] === 't').map((t) => t[1]);
    if (!tTags.includes(channelTag)) return fail('wrong-channel');

    return { ok: true, pubkey: clean.pubkey, content: clean.content };
}

module.exports = { verifyChatEvent };
