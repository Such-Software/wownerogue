/**
 * Smirk wallet auth routes (extracted from index.js).
 * DI via ctx so handler bodies stay identical. ctx: { db }
 */
const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');

module.exports = function createAuthRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

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
 * Verify a Smirk wallet signature and link to user session
 * Body: { socketId: string, challenge: string, publicKey: string, signature: string }
 */
router.post('/api/auth/smirk/verify', asyncHandler(async (req, res) => {
  const { socketId, challenge, publicKey, signature } = req.body || {};

  if (!socketId || !challenge || !publicKey || !signature) {
    throw new ValidationError('Missing required fields', {
      safeMessage: 'socketId, challenge, publicKey, and signature are required.'
    });
  }

  // 1. Verify challenge exists, is not used, and has not expired
  const challengeResult = await db.query(`
    SELECT * FROM smirk_challenges
    WHERE challenge = $1 AND socket_id = $2 AND used = FALSE AND expires_at > NOW()
  `, [challenge, socketId]);

  if (challengeResult.rows.length === 0) {
    throw new ValidationError('Invalid or expired challenge', {
      safeMessage: 'The challenge is invalid, expired, or has already been used.'
    });
  }

  // 2. Mark challenge as used immediately (prevent replay attacks)
  await db.query(`
    UPDATE smirk_challenges SET used = TRUE WHERE id = $1
  `, [challengeResult.rows[0].id]);

  // 3. Verify signature using tweetnacl
  // Accepts both formats during transition:
  // - RFC 8032 standard: signature over raw UTF-8 message bytes (new extension)
  // - Legacy: signature over SHA256(message) (old extension, remove after 2026-07-01)
  let isValidSignature = false;
  try {
    const nacl = require('tweetnacl');
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');

    // Try RFC 8032 standard first (raw message bytes)
    const challengeBytes = Buffer.from(challenge, 'utf8');
    isValidSignature = nacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);

    // Fall back to legacy SHA256 pre-hash (DEPRECATED — remove after 2026-07-01)
    if (!isValidSignature) {
      const challengeHash = crypto.createHash('sha256').update(challenge).digest();
      isValidSignature = nacl.sign.detached.verify(challengeHash, signatureBytes, publicKeyBytes);
    }
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

  // 4. Link public key to user session
  const userResult = await db.query(`
    SELECT id FROM users WHERE socket_id = $1
  `, [socketId]);

  if (userResult.rows.length === 0) {
    throw new NotFoundError('User session not found', {
      safeMessage: 'No active session found. Please connect to the game first.'
    });
  }

  const userId = userResult.rows[0].id;

  // Check if this public key is already linked to another user
  const existingLink = await db.query(`
    SELECT id FROM users WHERE smirk_public_key = $1 AND id != $2
  `, [publicKey, userId]);

  if (existingLink.rows.length > 0) {
    throw new ValidationError('Wallet already linked', {
      safeMessage: 'This wallet is already linked to another account.'
    });
  }

  // Link the wallet to this user
  await db.query(`
    UPDATE users SET smirk_public_key = $1 WHERE id = $2
  `, [publicKey, userId]);

  res.json({
    success: true,
    linked: true,
    message: 'Smirk wallet linked successfully'
  });
}));

/**
 * GET /api/auth/smirk/status
 * Check if a session has a linked Smirk wallet
 * Query: socketId=string
 */
router.get('/api/auth/smirk/status', asyncHandler(async (req, res) => {
  const { socketId } = req.query;

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId query parameter is required.'
    });
  }

  const result = await db.query(`
    SELECT smirk_public_key, payout_address FROM users WHERE socket_id = $1
  `, [socketId]);

  if (result.rows.length === 0) {
    res.json({
      linked: false,
      hasPayoutAddress: false
    });
    return;
  }

  const user = result.rows[0];
  res.json({
    linked: !!user.smirk_public_key,
    hasPayoutAddress: !!user.payout_address
  });
}));

  return router;
};
