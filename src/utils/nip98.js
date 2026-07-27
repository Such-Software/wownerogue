/**
 * Secure NIP-98 (HTTP Auth, kind:27235) event verification.
 *
 * Pure + side-effect free (no DB, no I/O) so it can be unit-tested with a plain
 * round-trip using nostr-tools. The route layer is responsible for issuing and
 * single-use-consuming the server challenge nonce; this module only proves that a
 * signed event is well-formed, authentic, fresh, and bound to the expected
 * method/URL/challenge.
 *
 * Security: nostr-tools verifyEvent() alone is not sufficient, because it memoizes
 * its result on the event object via an internal Symbol(verified), so a reused or
 * mutated already-"verified" object in the same process could bypass a re-check.
 * Two defences:
 *   1. A clean event object is rebuilt from only the canonical primitive fields, so
 *      it can never carry a stamped verified-symbol. Freshly-parsed wire JSON cannot
 *      carry a JS Symbol either; the rebuild makes the guarantee explicit.
 *   2. The event id is recomputed independently (getEventHash) and compared to the
 *      claimed id, catching content/tag tampering with no reliance on verifyEvent's
 *      memoization, ahead of the schnorr signature check.
 */

const { loadNostrTools } = require('./nostrLoader');

const { getEventHash, verifyEvent } = loadNostrTools();

const HEX_64 = /^[0-9a-f]{64}$/;   // x-only secp256k1 pubkey / event id
const HEX_128 = /^[0-9a-f]{128}$/; // BIP-340 schnorr signature
const NIP98_KIND = 27235;

function fail(reason) {
  return { ok: false, reason };
}

/**
 * @param {object} event  A NIP-98 kind:27235 event: { kind, created_at, pubkey, id, sig, content, tags }.
 * @param {object} opts
 * @param {string}  opts.challenge            Server nonce that the event's 'challenge' tag must equal.
 * @param {string} [opts.expectedPathSuffix]  The 'u' tag URL path must end with this. Default '/api/auth/smirk/verify'.
 * @param {string} [opts.expectedHost]        If set, the 'u' tag URL host must equal this.
 * @param {number} [opts.now]                 Current unix seconds (for freshness). Default Date.now()/1000.
 * @param {number} [opts.maxSkewSec]          Max allowed |now - created_at|. Default 120.
 * @returns {{ ok: boolean, pubkey?: string, reason?: string }}
 */
function verifyNip98Event(event, opts = {}) {
  const {
    challenge,
    expectedPathSuffix = '/api/auth/smirk/verify',
    expectedHost = null,
    now = Math.floor(Date.now() / 1000),
    maxSkewSec = 120,
  } = opts;

  if (!challenge || typeof challenge !== 'string') {
    return fail('missing-expected-challenge');
  }

  // (a) Shape/type validation. Nostr events carry kind & created_at as NUMBERS and
  // pubkey/id/sig/content as strings; tags is an array of string arrays.
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return fail('event-not-object');
  }
  if (typeof event.kind !== 'number') return fail('kind-not-number');
  if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at)) {
    return fail('created_at-not-number');
  }
  if (typeof event.pubkey !== 'string' || !HEX_64.test(event.pubkey)) return fail('bad-pubkey');
  if (typeof event.id !== 'string' || !HEX_64.test(event.id)) return fail('bad-id');
  if (typeof event.sig !== 'string' || !HEX_128.test(event.sig)) return fail('bad-sig');
  if (typeof event.content !== 'string') return fail('content-not-string');
  if (!Array.isArray(event.tags)) return fail('tags-not-array');
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.some((v) => typeof v !== 'string')) {
      return fail('malformed-tag');
    }
  }

  // (b) Must be a NIP-98 HTTP Auth event.
  if (event.kind !== NIP98_KIND) return fail('wrong-kind');

  // Primitives only: strips any inherited verified-symbol and any extra properties,
  // so verifyEvent() below is forced to actually verify.
  const clean = {
    kind: event.kind,
    created_at: event.created_at,
    pubkey: event.pubkey,
    id: event.id,
    sig: event.sig,
    content: event.content,
    tags: event.tags.map((t) => t.slice()),
  };

  // (c) Recomputing the id independently defeats content/tag tampering regardless of
  // any memoization inside verifyEvent.
  let recomputedId;
  try {
    recomputedId = getEventHash(clean);
  } catch (_e) {
    return fail('hash-error');
  }
  if (recomputedId !== clean.id) return fail('id-mismatch');

  // (d) BIP-340 schnorr signature over secp256k1 (x-only 64-hex pubkey, 128-hex sig).
  let sigOk = false;
  try {
    sigOk = verifyEvent(clean) === true;
  } catch (_e) {
    return fail('sig-verify-threw');
  }
  if (!sigOk) return fail('bad-signature');

  // (e) Freshness: rejects clock skew and replayed-late events.
  if (Math.abs(now - Number(clean.created_at)) > maxSkewSec) {
    return fail('expired');
  }

  // (f) Tag policy: exactly-one method(POST), exactly-one matching u, exactly-one challenge.
  const methodTags = clean.tags.filter((t) => t[0] === 'method');
  if (methodTags.length !== 1) return fail('method-tag-count');
  if (methodTags[0][1] !== 'POST') return fail('wrong-method');

  const uTags = clean.tags.filter((t) => t[0] === 'u');
  if (uTags.length !== 1) return fail('u-tag-count');
  let url;
  try {
    url = new URL(uTags[0][1]);
  } catch (_e) {
    return fail('bad-u-url');
  }
  if (!url.pathname.endsWith(expectedPathSuffix)) return fail('wrong-u-path');
  if (expectedHost && url.host !== expectedHost && url.hostname !== expectedHost) {
    return fail('wrong-u-host');
  }

  const challengeTags = clean.tags.filter((t) => t[0] === 'challenge');
  if (challengeTags.length !== 1) return fail('challenge-tag-count');
  if (challengeTags[0][1] !== challenge) return fail('challenge-mismatch');

  // (g) Returns the proven x-only pubkey, lowercased.
  return { ok: true, pubkey: clean.pubkey.toLowerCase() };
}

module.exports = { verifyNip98Event };
