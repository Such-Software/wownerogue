/**
 * Smirk wallet auth routes (extracted from index.js).
 * DI via ctx so handler bodies stay identical. ctx: { db }
 */
const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { verifyNip98Event } = require('../utils/nip98');

module.exports = function createAuthRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  /**
   * Atomically consume a challenge nonce, single-use, bound to a socket.
   * A single UPDATE ... WHERE used=FALSE ... RETURNING flips FALSE->TRUE for exactly
   * one caller, so two concurrent requests can never both pass (no SELECT/UPDATE TOCTOU).
   * Returns true iff this call is the one that consumed a fresh, unexpired challenge.
   */
  async function consumeChallenge(challenge, socketId) {
    const consumed = await db.query(`
      UPDATE smirk_challenges
      SET used = TRUE
      WHERE challenge = $1 AND socket_id = $2 AND used = FALSE AND expires_at > NOW()
      RETURNING id
    `, [challenge, socketId]);
    return consumed.rows.length > 0;
  }

  /**
   * Link a proven wallet key to the user resolved from socketId, then send the
   * success response shape the client expects ({ success, linked }). Shared by the
   * NIP-98 and legacy Ed25519 paths.
   */
  async function linkSmirkKey(provenKey, socketId, res) {
    const userResult = await db.query(`
      SELECT id FROM users WHERE socket_id = $1
    `, [socketId]);

    if (userResult.rows.length === 0) {
      throw new NotFoundError('User session not found', {
        safeMessage: 'No active session found. Please connect to the game first.'
      });
    }

    const userId = userResult.rows[0].id;

    // Reject linking a wallet already bound to a different account.
    const existingLink = await db.query(`
      SELECT id FROM users WHERE smirk_public_key = $1 AND id != $2
    `, [provenKey, userId]);

    if (existingLink.rows.length > 0) {
      throw new ValidationError('Wallet already linked', {
        safeMessage: 'This wallet is already linked to another account.'
      });
    }

    await db.query(`
      UPDATE users SET smirk_public_key = $1 WHERE id = $2
    `, [provenKey, userId]);

    res.json({
      success: true,
      linked: true,
      message: 'Smirk wallet linked successfully'
    });
  }

/**
 * POST /api/auth/smirk/challenge
 * Generate a challenge for Smirk wallet signature verification
 * Body: { socketId: string }
 */
router.post('/api/auth/smirk/challenge', asyncHandler(async (req, res) => {
  const { socketId } = req.body || {};

  if (!socketId || typeof socketId !== 'string') {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId is required to generate a challenge.'
    });
  }

  // Generate a cryptographically secure challenge
  const challenge = crypto.randomBytes(32).toString('hex');

  // Store challenge in database (expires in 5 minutes)
  await db.query(`
    INSERT INTO smirk_challenges (challenge, socket_id)
    VALUES ($1, $2)
  `, [challenge, socketId]);

  // Clean up old/expired challenges periodically
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
router.post('/api/auth/smirk/verify', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { socketId } = body;

  if (!socketId || typeof socketId !== 'string') {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId is required.'
    });
  }

  // ---------------------------------------------------------------------------
  // NIP-98 path — a nostr event object is present.
  // ---------------------------------------------------------------------------
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

    // Atomic single-use consume (bound to this socket) — prevents replay/double-use.
    const consumed = await consumeChallenge(challenge, socketId);
    if (!consumed) {
      throw new ValidationError('Invalid or expired challenge', {
        safeMessage: 'The challenge is invalid, expired, or has already been used.'
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const result = verifyNip98Event(body.event, {
      challenge,
      expectedPathSuffix: '/api/auth/smirk/verify',
      now,
      maxSkewSec: 120
    });

    if (!result.ok) {
      throw new ValidationError('Invalid NIP-98 event', {
        safeMessage: 'The authentication event could not be verified.'
      });
    }

    // NOTE: result.pubkey is a nostr x-only secp256k1 key (64-hex) — a DIFFERENT
    // key namespace than the legacy Ed25519 spend key. A NIP-98 login therefore
    // re-registers the account under the nostr key (acceptable per the cutover spec).
    await linkSmirkKey(result.pubkey, socketId, res);
    return;
  }

  // ---------------------------------------------------------------------------
  // Legacy Ed25519 path — { challenge, publicKey, signature }.
  // ---------------------------------------------------------------------------
  const { challenge, publicKey, signature } = body;

  if (!challenge || !publicKey || !signature) {
    throw new ValidationError('Missing required fields', {
      safeMessage: 'socketId, challenge, publicKey, and signature are required.'
    });
  }

  // Consume the challenge single-use (atomic) before verifying the signature.
  const consumed = await consumeChallenge(challenge, socketId);
  if (!consumed) {
    throw new ValidationError('Invalid or expired challenge', {
      safeMessage: 'The challenge is invalid, expired, or has already been used.'
    });
  }

  // Verify Ed25519 signature over the RAW UTF-8 challenge bytes (RFC 8032).
  // The deprecated SHA256(challenge) pre-hash fallback was removed (past its
  // 2026-07-01 removal date) — only the raw-bytes verify remains.
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

  await linkSmirkKey(publicKey, socketId, res);
}));

/**
 * GET /api/auth/smirk/status
 * Check if a session has a linked Smirk wallet.
 * Query: socketId=string ; Auth: X-Session-Token header (fallback ?t=).
 *
 * BOLA fix: previously this disclosed { linked, hasPayoutAddress } for ANY socketId
 * with no auth, letting anyone probe another player's wallet-link state. We now
 * require the caller to prove ownership of the socketId via the session token
 * (users.anon_token) — the same guard used by /api/user/:socketId/* in index.js
 * (requireSessionOwnership). We only resolve the row whose socket_id AND anon_token
 * both match; a mismatch/absent token gets 401/403 and learns nothing.
 */
router.get('/api/auth/smirk/status', asyncHandler(async (req, res) => {
  const { socketId } = req.query;

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId query parameter is required.'
    });
  }

  const token = req.get('X-Session-Token') || req.query.t;
  if (!token) {
    return res.status(401).json({ error: 'Session token required' });
  }

  const result = await db.query(`
    SELECT smirk_public_key, payout_address
    FROM users
    WHERE socket_id = $1 AND anon_token = $2
  `, [socketId, token]);

  if (result.rows.length === 0) {
    // Do not disclose whether the socketId exists — ownership check failed.
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
