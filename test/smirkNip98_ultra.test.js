/**
 * Adversarial round-trip tests for the secure NIP-98 verifier (src/utils/nip98.js).
 *
 * We sign REAL kind:27235 events with nostr-tools (generateSecretKey / getPublicKey /
 * finalizeEvent) and then attack them: tamper content/tags, wrong kind/method/url,
 * stale timestamps, flipped signatures, and the memoization-bypass trick. The verifier
 * is exercised directly (no HTTP). Case (ix) — single-use / replay — is enforced at the
 * route layer, so we drive the real Express route with a mock DB for that one.
 */

// nostr-tools is installed under src/node_modules (the app package lives in src/).
// Load it resiliently: a normal require works under plain Node (>=22 require()s the
// ESM-only @noble deps), but Jest's CJS runtime can't parse those, so we fall back to
// nostr-tools' self-contained pre-bundled build (an esbuild IIFE with deps inlined).
const fs = require('fs');
const path = require('path');
function loadNostrTools() {
  const cjsIndex = require.resolve('nostr-tools', { paths: [path.join(__dirname, '..', 'src')] });
  try {
    return require(cjsIndex);
  } catch (_e) {
    const bundlePath = path.join(path.dirname(cjsIndex), '..', 'nostr.bundle.js');
    // eslint-disable-next-line no-new-func
    return new Function(`${fs.readFileSync(bundlePath, 'utf8')}\nreturn NostrTools;`)();
  }
}
const {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
} = loadNostrTools();

const { verifyNip98Event } = require('../src/utils/nip98');

const PATH_SUFFIX = '/api/auth/smirk/verify';
const HOST = 'game.example';
const U = `https://${HOST}${PATH_SUFFIX}`;
const NOW = 1_800_000_000; // fixed reference so freshness is deterministic
const CHALLENGE = 'server-nonce-abc123';

// Sign a fresh event; opts override any field. `tags` (if given) fully replaces the default trio.
function buildEvent(sk, opts = {}) {
  const {
    kind = 27235,
    created_at = NOW,
    content = '',
    challenge = CHALLENGE,
    u = U,
    method = 'POST',
    tags,
  } = opts;
  const template = {
    kind,
    created_at,
    content,
    tags: tags || [['u', u], ['method', method], ['challenge', challenge]],
  };
  return finalizeEvent(template, sk);
}

// The opts every "happy-path expected" call shares.
function baseOpts(extra = {}) {
  return {
    challenge: CHALLENGE,
    expectedPathSuffix: PATH_SUFFIX,
    now: NOW,
    maxSkewSec: 120,
    ...extra,
  };
}

describe('verifyNip98Event — adversarial round-trip', () => {
  test('(i) a valid, correctly-signed event is accepted and returns the x-only pubkey', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk);
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(true);
    expect(r.pubkey).toBe(getPublicKey(sk)); // nostr-tools returns lowercase 64-hex
    expect(r.pubkey).toMatch(/^[0-9a-f]{64}$/);

    // host binding also passes when the expected host matches
    expect(verifyNip98Event(ev, baseOpts({ expectedHost: HOST })).ok).toBe(true);
  });

  test('(ii) tampering with content after signing is rejected (independent id recompute)', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk);
    ev.content = 'malicious-payload'; // id no longer matches the (unchanged) claimed id
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('id-mismatch');
  });

  test('(iii) tampering with a tag value after signing is rejected', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk, { challenge: CHALLENGE });
    // Rewrite the challenge tag to a different value post-signature.
    ev.tags = ev.tags.map((t) => (t[0] === 'challenge' ? ['challenge', 'swapped-value'] : t));
    const r = verifyNip98Event(ev, baseOpts({ challenge: 'swapped-value' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('id-mismatch');
  });

  test('(iii-b) a validly-signed event bound to a DIFFERENT challenge than the server nonce is rejected', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk, { challenge: 'nonce-the-client-signed' });
    const r = verifyNip98Event(ev, baseOpts({ challenge: 'the-server-actually-issued-this' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('challenge-mismatch');
  });

  test('(iv) wrong kind is rejected even when the signature is valid', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk, { kind: 1 });
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong-kind');
  });

  test('(v) an expired created_at (beyond maxSkew) is rejected — past and future', () => {
    const sk = generateSecretKey();
    const stale = buildEvent(sk, { created_at: NOW - 10_000 });
    const past = verifyNip98Event(stale, baseOpts({ now: NOW }));
    expect(past.ok).toBe(false);
    expect(past.reason).toBe('expired');

    const future = buildEvent(sk, { created_at: NOW + 10_000 });
    expect(verifyNip98Event(future, baseOpts({ now: NOW })).reason).toBe('expired');

    // A timestamp exactly at the skew boundary is still accepted.
    const edge = buildEvent(sk, { created_at: NOW - 120 });
    expect(verifyNip98Event(edge, baseOpts({ now: NOW })).ok).toBe(true);
  });

  test('(vi) a wrong "u" path is rejected; a wrong host is rejected when expectedHost is set', () => {
    const sk = generateSecretKey();
    const wrongPath = buildEvent(sk, { u: `https://${HOST}/api/wrong/endpoint` });
    const rPath = verifyNip98Event(wrongPath, baseOpts());
    expect(rPath.ok).toBe(false);
    expect(rPath.reason).toBe('wrong-u-path');

    const wrongHost = buildEvent(sk, { u: `https://evil.example${PATH_SUFFIX}` });
    const rHost = verifyNip98Event(wrongHost, baseOpts({ expectedHost: HOST }));
    expect(rHost.ok).toBe(false);
    expect(rHost.reason).toBe('wrong-u-host');
  });

  test('(vii) a wrong method tag is rejected', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk, { method: 'GET' });
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong-method');
  });

  test('(viii) a flipped signature byte is rejected', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk);
    const first = ev.sig[0] === 'f' ? 'e' : 'f';
    ev.sig = first + ev.sig.slice(1); // stays 128-hex, but no longer a valid schnorr sig
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  test('exactly-one tag policy: duplicate or missing challenge/method tags are rejected', () => {
    const sk = generateSecretKey();

    const dupChallenge = buildEvent(sk, {
      tags: [['u', U], ['method', 'POST'], ['challenge', CHALLENGE], ['challenge', CHALLENGE]],
    });
    expect(verifyNip98Event(dupChallenge, baseOpts()).reason).toBe('challenge-tag-count');

    const noChallenge = buildEvent(sk, { tags: [['u', U], ['method', 'POST']] });
    expect(verifyNip98Event(noChallenge, baseOpts()).reason).toBe('challenge-tag-count');

    const dupMethod = buildEvent(sk, {
      tags: [['u', U], ['method', 'POST'], ['method', 'POST'], ['challenge', CHALLENGE]],
    });
    expect(verifyNip98Event(dupMethod, baseOpts()).reason).toBe('method-tag-count');
  });

  test('shape validation: non-27235 primitives / bad hex / non-object are rejected safely', () => {
    expect(verifyNip98Event(null, baseOpts()).ok).toBe(false);
    expect(verifyNip98Event('nope', baseOpts()).ok).toBe(false);
    expect(verifyNip98Event({}, baseOpts()).ok).toBe(false);
    const sk = generateSecretKey();
    const ev = buildEvent(sk);
    // Corrupt the pubkey to non-hex — must not throw, must reject.
    const bad = { ...ev, pubkey: 'zz' + ev.pubkey.slice(2) };
    const r = verifyNip98Event(bad, baseOpts());
    expect(r.ok).toBe(false);
  });

  test('CRITICAL: the nostr-tools verified-memo cannot bypass our re-verification', () => {
    const sk = generateSecretKey();
    const ev = buildEvent(sk);

    // Prime nostr-tools' internal memo by verifying the pristine event once.
    expect(verifyEvent(ev)).toBe(true);

    // Attacker mutates content AND repairs the id so a naive hash check would pass,
    // then leans on the STALE memo to skip re-verification.
    ev.content = 'tampered-after-memoization';
    ev.id = getEventHash({
      kind: ev.kind,
      created_at: ev.created_at,
      pubkey: ev.pubkey,
      tags: ev.tags,
      content: ev.content,
    });

    // Demonstrate the vulnerability we defend against: nostr-tools returns the stale
    // memoized `true` for the now-tampered object.
    expect(verifyEvent(ev)).toBe(true);

    // Our verifier rebuilds a clean event (no memo symbol) and re-runs schnorr, so the
    // signature — made over the ORIGINAL content — fails against the repaired id.
    const r = verifyNip98Event(ev, baseOpts());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });
});

describe('(ix) route layer — single-use challenge consume rejects replay', () => {
  const express = require('express');
  const http = require('http');
  const createAuthRoutes = require('../src/routes/auth');

  // Mock DB modelling the atomic single-use UPDATE ... WHERE used=FALSE ... RETURNING.
  function mockDb(challengeValue, socketId, token) {
    const user = { id: 77, socket_id: socketId, anon_token: token };
    const challenges = new Map([[
      challengeValue,
      { id: 1, socket_id: socketId, user_id: user.id, used: false }
    ]]);
    const query = async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT id, socket_id, anon_token FROM users/i.test(s)) {
        return params[0] === user.socket_id && params[1] === user.anon_token
          ? { rows: [user] }
          : { rows: [] };
      }
      if (/^UPDATE smirk_challenges SET used = TRUE/i.test(s)) {
        const [ch, userId, sock] = params;
        const row = challenges.get(ch);
        if (row && row.user_id === userId && row.socket_id === sock && row.used === false) {
          row.used = true; // atomic FALSE -> TRUE, exactly once
          return { rows: [{ id: row.id }] };
        }
        return { rows: [] };
      }
      if (/SELECT id FROM users WHERE id = \$1 AND socket_id = \$2 AND anon_token = \$3 FOR UPDATE/i.test(s)) {
        return params[0] === user.id && params[1] === user.socket_id && params[2] === user.anon_token
          ? { rows: [{ id: user.id }] }
          : { rows: [] };
      }
      if (/SELECT id, socket_id, payout_address FROM users WHERE smirk_public_key/i.test(s)) {
        return { rows: [] }; // not linked elsewhere
      }
      if (/^UPDATE users SET smirk_public_key = \$1/i.test(s)) {
        return { rows: [{ id: user.id }] };
      }
      return { rows: [] };
    };
    return {
      challenges,
      query,
      withTransaction: async (fn) => fn({ query }),
    };
  }

  function startServer(db) {
    const app = express();
    app.use(express.json());
    app.use(createAuthRoutes({
      db,
      sessionManager: {
        generateSecureToken: () => 'unused-test-token',
        disconnectUserSessions: jest.fn()
      }
    }));
    // Minimal error handler mirroring the app's (ValidationError -> 400, etc.).
    app.use((err, req, res, _next) => {
      res.status(err.statusCode || 500).json({ error: err.message });
    });
    return new Promise((resolve) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  async function postJson(server, path, body, token) {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  test('a valid NIP-98 event links once, then the identical replay is rejected', async () => {
    const sk = generateSecretKey();
    const socketId = 'sock-xyz-1';
    const token = 'route-session-token';
    const challenge = 'route-nonce-9f8e7d';
    // created_at must be genuinely fresh — the route uses real Date.now().
    const ev = buildEvent(sk, { created_at: Math.floor(Date.now() / 1000), challenge });

    const db = mockDb(challenge, socketId, token);
    const server = await startServer(db);
    try {
      const first = await postJson(server, PATH_SUFFIX, { socketId, event: ev }, token);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ success: true, linked: true });
      expect(db.challenges.get(challenge).used).toBe(true);

      // Replay the exact same event: the single-use consume now fails -> 400.
      const second = await postJson(server, PATH_SUFFIX, { socketId, event: ev }, token);
      expect(second.status).toBe(400);
      expect(second.json.error).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
