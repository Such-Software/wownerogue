/**
 * Smirk wallet auth routes. Dependencies arrive via ctx: { db, sessionManager }.
 */
const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError } = require('../utils/errors');
const { verifyNip98Event } = require('../utils/nip98');

const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_RATE_MAX_KEYS = 10000;

/**
 * The host a NIP-98 auth event must be signed for.
 *
 * `HOSTED_BY` is the operator's canonical public origin and is contract-enforced in operated
 * production profiles, so it is the authority whenever it is set: that keeps verification correct
 * behind a proxy and immune to a spoofed Host header. Unconfigured (dev / self-host) deployments
 * fall back to the request's own host, which still binds the event to the origin it was sent to.
 */
function expectedAuthHost(req) {
  const configured = typeof process.env.HOSTED_BY === 'string' ? process.env.HOSTED_BY.trim() : '';
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.host) return parsed.host;
    } catch (_) { /* malformed HOSTED_BY: fall through to the request host */ }
  }
  return (req && (req.get('host') || req.headers?.host)) || null;
}

/**
 * Per-IP auth rate limiter with a bounded key map.
 *
 * The bound is enforced by EVICTION, never by refusing new keys. Refusing would make the memory cap
 * a denial-of-service primitive: an attacker sourcing from many addresses could hold the map at
 * capacity so every legitimate first-time caller of /challenge or /verify gets a 429, locking the
 * whole population out of Smirk login. Eviction keeps the same memory ceiling while leaving the
 * limiter functional; the worst case is that a very old window's count is forgotten, which grants
 * one extra window to an attacker who was already being counted.
 */
function createIpRateLimiter({ max }) {
  const hits = new Map();
  let lastSweep = 0;

  const sweepExpired = (now) => {
    for (const [key, value] of hits) {
      if (now - value.windowStart >= AUTH_WINDOW_MS) hits.delete(key);
    }
    lastSweep = now;
  };

  // Discard the oldest live windows in one batch, so the O(n) pass is amortised rather than paid
  // on every request once the map is full.
  const evictOldest = (count) => {
    const oldest = Array.from(hits.entries())
      .sort((left, right) => left[1].windowStart - right[1].windowStart)
      .slice(0, count);
    for (const [key] of oldest) hits.delete(key);
  };

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep >= AUTH_WINDOW_MS) sweepExpired(now);

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
      if (!entry && hits.size >= AUTH_RATE_MAX_KEYS) {
        // Sweeping is otherwise lazy (once per window), so a map full of expired entries would
        // stay full. Reclaim first, and only evict live windows if that was not enough.
        sweepExpired(now);
        if (hits.size >= AUTH_RATE_MAX_KEYS) {
          evictOldest(Math.max(1, Math.ceil(AUTH_RATE_MAX_KEYS * 0.1)));
        }
      }
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil(
        (entry.windowStart + AUTH_WINDOW_MS - now) / 1000
      ));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many authentication attempts' });
    }
    return next();
  };
}

module.exports = function createAuthRoutes(ctx) {
  const { db, sessionManager } = ctx;
  if (!db || typeof db.query !== 'function' || typeof db.withTransaction !== 'function') {
    throw new TypeError('Smirk auth requires transactional database access');
  }
  if (!sessionManager
    || typeof sessionManager.generateSecureToken !== 'function'
    || typeof sessionManager.disconnectUserSessions !== 'function') {
    throw new TypeError('Smirk auth requires session revocation support');
  }
  const router = express.Router();
  const challengeRateLimit = createIpRateLimiter({ max: 10 });
  const verifyRateLimit = createIpRateLimiter({ max: 20 });

  function unauthorized(message = 'Session ownership verification failed') {
    return new AppError(message, {
      statusCode: 403,
      code: 'SESSION_OWNERSHIP_REQUIRED',
      safeMessage: 'Session ownership verification failed.'
    });
  }

  async function resolveSessionOwner(req, socketId) {
    const token = req.get('X-Session-Token');
    if (!token) {
      throw new AppError('Session token required', {
        statusCode: 401,
        code: 'SESSION_TOKEN_REQUIRED',
        safeMessage: 'Session token required.'
      });
    }
    if (typeof token !== 'string' || token.length > 512) throw unauthorized();

    const result = await db.query(`
      SELECT id, socket_id, anon_token
      FROM users
      WHERE socket_id = $1 AND anon_token = $2
      LIMIT 1
    `, [socketId, token]);
    if (result.rows.length !== 1) throw unauthorized();
    return { userId: result.rows[0].id, socketId, token };
  }

  /**
   * Atomically consume a challenge nonce, single-use, bound to the authenticated stable user.
   * A single UPDATE ... WHERE used=FALSE ... RETURNING flips FALSE->TRUE for exactly
   * one caller, so two concurrent requests can never both pass (no SELECT/UPDATE TOCTOU).
   * Returns true iff this call is the one that consumed a fresh, unexpired challenge.
   */
  async function consumeChallenge(challenge, session) {
    const consumed = await db.query(`
      UPDATE smirk_challenges
      SET used = TRUE
      WHERE challenge = $1
        AND user_id = $2
        AND socket_id = $3
        AND used = FALSE
        AND expires_at > NOW()
      RETURNING id
    `, [challenge, session.userId, session.socketId]);
    return consumed.rows.length > 0;
  }

  /**
   * Link a proven wallet key to the authenticated stable user. Wallet adoption is one
   * transaction: lock/re-check the presented session, revoke the temporary session,
   * rotate the wallet owner's bearer token, clear the displaced row, and assign the caller
   * socket to exactly one user. Live cached sockets are disconnected after the HTTP response.
   */
  async function linkSmirkKey(provenKey, session) {
    return db.withTransaction(async (client) => {
      const currentResult = await client.query(`
        SELECT id
        FROM users
        WHERE id = $1 AND socket_id = $2 AND anon_token = $3
        FOR UPDATE
      `, [session.userId, session.socketId, session.token]);
      if (currentResult.rows.length !== 1) throw unauthorized();

      const existingLink = await client.query(`
        SELECT id, socket_id, payout_address
        FROM users
        WHERE smirk_public_key = $1 AND id != $2
        LIMIT 1
        FOR UPDATE
      `, [provenKey, session.userId]);

      if (existingLink.rows.length > 0) {
        const owner = existingLink.rows[0];
        const ownerToken = sessionManager.generateSecureToken();
        const revokedTemporaryToken = sessionManager.generateSecureToken();

        const revoked = await client.query(`
          UPDATE users
          SET socket_id = NULL, anon_token = $1, last_seen = NOW()
          WHERE id = $2 AND socket_id = $3 AND anon_token = $4
          RETURNING id
        `, [revokedTemporaryToken, session.userId, session.socketId, session.token]);
        if (revoked.rows.length !== 1) throw unauthorized();

        const adopted = await client.query(`
          UPDATE users
          SET socket_id = $1, anon_token = $2, last_seen = NOW()
          WHERE id = $3 AND smirk_public_key = $4
          RETURNING id, payout_address
        `, [session.socketId, ownerToken, owner.id, provenKey]);
        if (adopted.rows.length !== 1) {
          throw new AppError('Wallet account adoption lost its ownership lock', {
            statusCode: 409,
            code: 'WALLET_ADOPTION_CONFLICT',
            safeMessage: 'Wallet sign-in conflicted with another request. Please retry.'
          });
        }

        const socketOwner = await client.query(`
          SELECT id
          FROM users
          WHERE socket_id = $1
          FOR UPDATE
        `, [session.socketId]);
        if (socketOwner.rows.length !== 1
          || String(socketOwner.rows[0].id) !== String(owner.id)) {
          throw new AppError('Adopted socket ownership is ambiguous', {
            statusCode: 409,
            code: 'SOCKET_OWNERSHIP_CONFLICT',
            safeMessage: 'Wallet sign-in conflicted with another session. Please retry.'
          });
        }

        return {
          adopted: true,
          currentUserId: session.userId,
          ownerUserId: owner.id,
          previousOwnerSocketId: owner.socket_id || null,
          sessionToken: ownerToken,
          address: adopted.rows[0].payout_address || null
        };
      }

      const linked = await client.query(`
        UPDATE users
        SET smirk_public_key = $1
        WHERE id = $2 AND socket_id = $3 AND anon_token = $4
        RETURNING id
      `, [provenKey, session.userId, session.socketId, session.token]);
      if (linked.rows.length !== 1) throw unauthorized();
      return { adopted: false, currentUserId: session.userId };
    });
  }

/**
 * POST /api/auth/smirk/challenge
 * Generate a challenge for Smirk wallet signature verification
 * Body: { socketId: string }
 */
router.post('/api/auth/smirk/challenge', challengeRateLimit, asyncHandler(async (req, res) => {
  const { socketId } = req.body || {};

  if (!socketId || typeof socketId !== 'string' || socketId.length > 255) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId is required to generate a challenge.'
    });
  }

  const session = await resolveSessionOwner(req, socketId);

  const challenge = crypto.randomBytes(32).toString('hex');

  // Store a stable user binding as well as the current socket. The user binding is what
  // prevents a public Tavern/Match socket id from being used to attach an attacker's key.
  const inserted = await db.query(`
    INSERT INTO smirk_challenges (challenge, socket_id, user_id)
    SELECT $1, $2, id
    FROM users
    WHERE id = $3 AND socket_id = $2 AND anon_token = $4
    RETURNING id
  `, [challenge, socketId, session.userId, session.token]);
  if (inserted.rows.length !== 1) throw unauthorized();

  // Opportunistic cleanup of expired and long-used challenges.
  await db.query(`
    DELETE FROM smirk_challenges
    WHERE expires_at < NOW() OR (used = TRUE AND created_at < NOW() - INTERVAL '1 hour')
  `);

  res.json({
    challenge,
    expiresIn: 300 // 5 minutes in seconds
  });
}));

/**
 * POST /api/auth/smirk/verify
 * Verify a Smirk wallet auth proof and link the wallet to the user session.
 * Two accepted request shapes:
 *  - NIP-98:  { socketId, event }            -> nostr kind:27235 HTTP-auth event (preferred)
 *  - Legacy:  { socketId, challenge, publicKey, signature }  -> Ed25519 challenge signing
 */
router.post('/api/auth/smirk/verify', verifyRateLimit, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { socketId } = body;

  if (!socketId || typeof socketId !== 'string' || socketId.length > 255) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId is required.'
    });
  }
  const session = await resolveSessionOwner(req, socketId);

  // NIP-98 path: a nostr event object is present.
  if (body.event && typeof body.event === 'object' && !Array.isArray(body.event)) {
    // Extract the challenge carried by the event's 'challenge' tag WITHOUT trusting
    // the rest of the event yet. We consume the server nonce single-use FIRST, then
    // cryptographically verify the event is bound to that exact nonce.
    const rawTags = Array.isArray(body.event.tags) ? body.event.tags : [];
    const challengeTags = rawTags.filter((t) => Array.isArray(t) && t[0] === 'challenge');
    const challenge = challengeTags.length === 1 ? challengeTags[0][1] : null;

    if (!challenge || typeof challenge !== 'string') {
      throw new ValidationError('Invalid NIP-98 event', {
        safeMessage: 'The authentication event is missing its challenge.'
      });
    }

    // Atomic single-use consume, bound to this socket, so the event cannot be replayed.
    const consumed = await consumeChallenge(challenge, session);
    if (!consumed) {
      throw new ValidationError('Invalid or expired challenge', {
        safeMessage: 'The challenge is invalid, expired, or has already been used.'
      });
    }

    const now = Math.floor(Date.now() / 1000);
    // Bind the signed event to THIS deployment's host. The 'u' tag path check alone is not an
    // authentication boundary: a kind:27235 event the same wallet signed for any other site whose
    // path happens to end in /api/auth/smirk/verify would otherwise verify here, and because the
    // link step ADOPTS whatever account already owns that pubkey and returns its session token, a
    // borrowed event would be a full account takeover.
    const result = verifyNip98Event(body.event, {
      challenge,
      expectedPathSuffix: '/api/auth/smirk/verify',
      expectedHost: expectedAuthHost(req),
      now,
      maxSkewSec: 120
    });

    if (!result.ok) {
      throw new ValidationError('Invalid NIP-98 event', {
        safeMessage: 'The authentication event could not be verified.'
      });
    }

    // result.pubkey is a nostr x-only secp256k1 key (64-hex), a different key namespace than the
    // legacy Ed25519 spend key, so a NIP-98 login registers the account under the nostr key.
    const outcome = await linkSmirkKey(result.pubkey, session);
    if (outcome.adopted) {
      res.json({
        success: true,
        linked: true,
        adopted: true,
        sessionToken: outcome.sessionToken,
        address: outcome.address,
        message: 'Signed in to your wallet-linked account.'
      });
      setImmediate(() => sessionManager.disconnectUserSessions(
        [outcome.currentUserId, outcome.ownerUserId],
        [socketId, outcome.previousOwnerSocketId].filter(Boolean)
      ));
      return;
    }
    res.json({ success: true, linked: true, message: 'Smirk wallet linked successfully' });
    return;
  }

  // Legacy Ed25519 path: { challenge, publicKey, signature }.
  const { challenge, publicKey, signature } = body;

  if (!challenge || !publicKey || !signature) {
    throw new ValidationError('Missing required fields', {
      safeMessage: 'socketId, challenge, publicKey, and signature are required.'
    });
  }

  // Consume the challenge single-use (atomic) before verifying the signature.
  const consumed = await consumeChallenge(challenge, session);
  if (!consumed) {
    throw new ValidationError('Invalid or expired challenge', {
      safeMessage: 'The challenge is invalid, expired, or has already been used.'
    });
  }

  // Ed25519 verification is over the RAW UTF-8 challenge bytes (RFC 8032). There is no
  // SHA256(challenge) pre-hash fallback.
  let isValidSignature = false;
  try {
    const nacl = require('tweetnacl');
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');
    const challengeBytes = Buffer.from(challenge, 'utf8');
    isValidSignature = nacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
  } catch (verifyError) {
    console.error('Signature verification error:', verifyError.message);
    throw new ValidationError('Signature verification failed', {
      safeMessage: 'Unable to verify the wallet signature.'
    });
  }

  if (!isValidSignature) {
    throw new ValidationError('Invalid signature', {
      safeMessage: 'The wallet signature is invalid.'
    });
  }

  const outcome = await linkSmirkKey(publicKey, session);
  if (outcome.adopted) {
    res.json({
      success: true,
      linked: true,
      adopted: true,
      sessionToken: outcome.sessionToken,
      address: outcome.address,
      message: 'Signed in to your wallet-linked account.'
    });
    setImmediate(() => sessionManager.disconnectUserSessions(
      [outcome.currentUserId, outcome.ownerUserId],
      [socketId, outcome.previousOwnerSocketId].filter(Boolean)
    ));
    return;
  }
  res.json({ success: true, linked: true, message: 'Smirk wallet linked successfully' });
}));

/**
 * GET /api/auth/smirk/status
 * Check if a session has a linked Smirk wallet.
 * Query: socketId=string ; Auth: X-Session-Token header.
 *
 * { linked, hasPayoutAddress } is owner-only state, so the caller must prove ownership with the
 * session token (users.anon_token), the same guard requireSessionOwnership applies to
 * /api/user/:socketId/* in index.js. An absent or unmatched token gets 401/403 and learns nothing.
 */
router.get('/api/auth/smirk/status', asyncHandler(async (req, res) => {
  const { socketId } = req.query;

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId query parameter is required.'
    });
  }

  const token = req.get('X-Session-Token');
  if (!token) {
    return res.status(401).json({ error: 'Session token required' });
  }

  // The caller is identified by anon_token ALONE: it is the unguessable ownership secret, so
  // matching on it already guarantees you can only read your OWN state. socket_id is deliberately
  // NOT part of the match because it is volatile (it changes on every refresh / reconnect), and
  // requiring it would 403 every post-refresh caller, leaving the client unlinked and disabling
  // Smirk one-click payment. socketId stays required in the query string for API shape.
  const result = await db.query(`
    SELECT smirk_public_key, payout_address
    FROM users
    WHERE anon_token = $1
  `, [token]);

  if (result.rows.length === 0) {
    // Unknown or rotated token: ownership is unproven, so disclose nothing.
    return res.status(403).json({ error: 'Session ownership verification failed' });
  }

  const user = result.rows[0];
  res.json({
    linked: !!user.smirk_public_key,
    hasPayoutAddress: !!user.payout_address
  });
}));

  return router;
};
