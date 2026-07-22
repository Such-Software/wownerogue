/**
 * Admin API routes (extracted from index.js).
 * Dependency-injected via ctx so the handler bodies stay byte-for-byte identical.
 * ctx: { db, gameModeManager, walletRPCService, socketHandlers, io, alertService }
 * (alertService is late-bound: read as ctx.alertService at request time.)
 */
const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const PaymentRefundService = require('../services/paymentRefundService');

const PAYOUT_STATUSES = Object.freeze([
  'pending',
  'processing',
  'completed',
  'failed',
  'needs_review',
  'permanently_failed',
  'batched'
]);
const PAYOUT_ATTENTION_STATUSES = Object.freeze([
  'pending',
  'processing',
  'failed',
  'needs_review',
  'permanently_failed'
]);
const REFUND_STATUSES = Object.freeze([
  'recorded',
  'requested',
  'processing',
  'completed',
  'needs_review'
]);
const REFUND_ATTENTION_STATUSES = Object.freeze([
  'requested',
  'processing',
  'needs_review'
]);

module.exports = function createAdminRoutes(ctx) {
  const { db, gameModeManager, walletRPCService, socketHandlers, io } = ctx;
  const router = express.Router();
  const paymentRefundService = ctx.paymentRefundService || new PaymentRefundService({
    db,
    walletService: walletRPCService,
    isSendEnabled: ctx.canDispatchPayouts
  });

// =============================================================================
// Admin API Endpoints (requires ADMIN_API_KEY)
// =============================================================================

/**
 * Admin authentication middleware
 * Requires X-Admin-Key header to match ADMIN_API_KEY env variable
 */
const adminAuth = (req, res, next) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({
      error: 'Admin API not configured',
      message: 'Set ADMIN_API_KEY environment variable to enable admin endpoints.'
    });
  }

  // Origin check — reject cross-origin requests to admin endpoints
  // Same-origin requests (Origin matches Host) are always allowed
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const requestOrigin = new URL(origin).origin;
      const host = req.headers.host;
      const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const selfOrigin = `${protocol}://${host}`;

      // Allow same-origin requests (admin.html served from same server)
      if (requestOrigin !== selfOrigin) {
        // Check explicit allowlist for cross-origin requests
        const allowedOrigins = process.env.ALLOWED_ORIGINS
          ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
          : [`http://localhost:${process.env.PORT || 3000}`, `http://127.0.0.1:${process.env.PORT || 3000}`];
        if (!allowedOrigins.includes(requestOrigin)) {
          return res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed.' });
        }
      }
    } catch (e) {
      return res.status(403).json({ error: 'Forbidden', message: 'Invalid origin.' });
    }
  }

  const providedKey = req.headers['x-admin-key'];
  const providedKeyBuffer = typeof providedKey === 'string' ? Buffer.from(providedKey) : null;
  const adminKeyBuffer = Buffer.from(adminKey);
  if (!providedKeyBuffer ||
      providedKeyBuffer.length !== adminKeyBuffer.length ||
      !crypto.timingSafeEqual(providedKeyBuffer, adminKeyBuffer)) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing X-Admin-Key header.'
    });
  }

  next();
};

/**
 * POST /api/admin/refund/payment
 * Refund a payment - marks it as refunded and optionally sends funds back
 * Body: { paymentId: number, reason?: string, sendFunds?: boolean }
 */
router.post('/api/admin/refund/payment', adminAuth, asyncHandler(async (req, res) => {
  const { paymentId, reason, sendFunds } = req.body || {};

  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
    throw new ValidationError('Invalid paymentId', {
      safeMessage: 'paymentId (positive integer) is required.'
    });
  }
  if (sendFunds !== undefined && typeof sendFunds !== 'boolean') {
    throw new ValidationError('Invalid sendFunds', {
      safeMessage: 'sendFunds must be a boolean when provided.'
    });
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
    throw new ValidationError('Invalid refund reason', {
      safeMessage: 'reason must be a string of at most 500 characters.'
    });
  }

  const result = await paymentRefundService.refundPayment({ paymentId, reason, sendFunds });
  res.json(PaymentRefundService.toApiResult(result, gameModeManager));
}));

/**
 * POST /api/admin/credits/adjust
 * Adjust a user's credit balance (add or subtract)
 * Body: { socketId: string, amount: number, reason?: string }
 * amount can be positive (add) or negative (subtract)
 */
router.post('/api/admin/credits/adjust', adminAuth, asyncHandler(async (req, res) => {
  const { socketId, amount, reason } = req.body || {};
  
  if (!socketId || typeof socketId !== 'string' || socketId.length > 200) {
    throw new ValidationError('Invalid socketId', {
      safeMessage: 'socketId (string) is required.'
    });
  }
  
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) {
    throw new ValidationError('Invalid amount', {
      safeMessage: 'amount must be a non-zero safe integer between -1000000 and 1000000.'
    });
  }
  
  // Get user
  const user = await gameModeManager.getOrCreateUser(socketId);
  if (!user) {
    throw new NotFoundError('User not found', {
      safeMessage: `User with socket ${socketId} not found.`
    });
  }
  
  const currentCredits = user.credits || 0;

  // SECURITY: Use atomic UPDATE to prevent race conditions
  // For negative adjustments, ensure user has enough credits
  let updateResult;
  let actualAdjustment;
  let newBalance;

  if (amount < 0) {
    // Deduction: atomic check that credits >= amount to deduct
    const deductAmount = Math.abs(amount);
    updateResult = await db.query(`
      UPDATE users
      SET credits = credits - $1, updated_at = NOW()
      WHERE id = $2 AND credits >= $1
      RETURNING credits
    `, [deductAmount, user.id]);

    if (updateResult.rows.length === 0) {
      return res.json({
        success: false,
        message: `Cannot deduct ${deductAmount} credits - user only has ${currentCredits} credits.`,
        user: { credits: currentCredits }
      });
    }

    newBalance = updateResult.rows[0].credits;
    actualAdjustment = newBalance - currentCredits;
  } else {
    // Addition: always succeeds
    updateResult = await db.query(`
      UPDATE users
      SET credits = credits + $1, updated_at = NOW()
      WHERE id = $2
      RETURNING credits
    `, [amount, user.id]);

    newBalance = updateResult.rows[0]?.credits ?? (currentCredits + amount);
    actualAdjustment = amount;
  }

  if (actualAdjustment === 0) {
    return res.json({
      success: false,
      message: 'No adjustment made.',
      user: { credits: currentCredits }
    });
  }
  
  // Record transaction
  const transactionType = actualAdjustment > 0 ? 'admin_credit' : 'admin_debit';
  await db.query(`
    INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
    VALUES ($1, $2, $3, $4, $5)
  `, [user.id, actualAdjustment, reason || 'Admin adjustment', newBalance, transactionType]);
  
  // Notify user if connected
  try {
    io.to(socketId).emit('credits_update', { 
      balance: newBalance,
      creditsPerGame: gameModeManager.creditsPerGameCost
    });
  } catch (_) {}
  
  res.json({
    success: true,
    message: `Credits ${actualAdjustment > 0 ? 'added' : 'deducted'} successfully.`,
    adjustment: {
      userId: user.id,
      previousBalance: currentCredits,
      adjustment: actualAdjustment,
      newBalance,
      reason: reason || 'Admin adjustment'
    }
  });
}));

/**
 * POST /api/admin/alerts/test-email
 * Send a test email to verify alert service configuration
 * Requires: X-Admin-Key header
 */
router.post('/api/admin/alerts/test-email', adminAuth, asyncHandler(async (req, res) => {
  if (!ctx.alertService) {
    return res.status(503).json({
      success: false,
      message: 'Alert service not initialized. Payment system may not be enabled.'
    });
  }

  const result = await ctx.alertService.sendAlert('test_email', {
    subject: `🧪 Wownerogue Alert Test - ${process.env.NODE_ENV || 'development'}`,
    html: `
      <h2>Alert Service Test</h2>
      <p>If you received this email, the alert notifications are working correctly!</p>
      <hr>
      <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      <p><strong>Server:</strong> ${process.env.CRYPTO_TYPE || 'WOW'}</p>
    `
  });

  res.json({
    success: result.sent,
    message: result.sent ? 'Test email sent successfully!' : (result.reason || 'Failed to send'),
    details: result
  });
}));

// =============================================================================
// Admin Queue Management
// =============================================================================

/**
 * GET /api/admin/queue
 * Get current queue details for admin dashboard
 * Returns full queue entries (not anonymized)
 */
router.get('/api/admin/queue', adminAuth, asyncHandler(async (req, res) => {
  if (!socketHandlers?.queueManager) {
    return res.status(503).json({
      success: false,
      message: 'Queue manager not available'
    });
  }

  const queueDetails = socketHandlers.queueManager.getQueueDetailsForAdmin();

  res.json({
    success: true,
    queue: queueDetails,
    count: queueDetails.length
  });
}));

/**
 * POST /api/admin/queue/remove
 * Remove a stuck queue entry by serverId
 * Body: { serverId: string, reason?: string }
 */
router.post('/api/admin/queue/remove', adminAuth, asyncHandler(async (req, res) => {
  const { serverId, reason } = req.body || {};

  if (!serverId || typeof serverId !== 'string') {
    throw new ValidationError('Missing serverId', {
      safeMessage: 'serverId is required to remove a queue entry.'
    });
  }

  if (!socketHandlers?.queueManager) {
    return res.status(503).json({
      success: false,
      message: 'Queue manager not available'
    });
  }

  // Check if entry exists first
  const isQueued = socketHandlers.queueManager.isPlayerQueued(serverId);
  if (!isQueued) {
    return res.status(404).json({
      success: false,
      message: `No queue entry found for serverId: ${serverId}`
    });
  }

  // Remove the entry
  const removed = socketHandlers.queueManager.removePlayer(serverId);

  // Log admin action
  console.log(`[Admin] Queue entry removed: serverId=${serverId}, reason="${reason || 'No reason provided'}", by admin at ${new Date().toISOString()}`);

  // Optionally notify the user via socket (if still connected)
  try {
    io.to(serverId).emit('queue_cancelled', {
      reason: 'admin_removed',
      message: 'Your queue entry was removed by an administrator.'
    });
  } catch (notifyErr) {
    // Ignore errors - user may be disconnected
  }

  res.json({
    success: removed,
    message: removed ? 'Queue entry removed successfully' : 'Failed to remove queue entry',
    serverId: serverId
  });
}));

// =============================================================================
// ADMIN CHAT MODERATION ENDPOINTS
// =============================================================================

/**
 * GET /api/admin/chat
 * List recent chat messages for moderation
 * Query: ?limit=100&includeDeleted=false
 */
router.get('/api/admin/chat', adminAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const includeDeleted = req.query.includeDeleted === 'true';

  const messages = await socketHandlers.chatHandler.chatHistory.getMessagesForAdmin(limit, includeDeleted);

  res.json({
    messages,
    count: messages.length
  });
}));

/**
 * DELETE /api/admin/chat/:id
 * Soft delete a chat message
 * Body: { reason?: string }
 */
router.delete('/api/admin/chat/:id', adminAuth, asyncHandler(async (req, res) => {
  const messageId = parseInt(req.params.id);
  const { reason } = req.body;

  if (!messageId || isNaN(messageId)) {
    throw new ValidationError('Invalid message ID');
  }

  const deleted = await socketHandlers.chatHandler.chatHistory.deleteMessage(
    messageId,
    'admin',
    reason || 'Admin deleted'
  );

  if (deleted) {
    // Broadcast deletion to all connected clients
    io.emit('chat_deleted', { messageId });
    console.log(`[Admin] Chat message deleted: id=${messageId}, reason="${reason || 'No reason provided'}"`);
  }

  res.json({
    success: deleted,
    message: deleted ? 'Message deleted' : 'Message not found or already deleted'
  });
}));

/**
 * POST /api/admin/users/:id/chat-ban
 * Ban or unban a user from chat
 * Body: { banned: boolean, reason?: string }
 */
router.post('/api/admin/users/:id/chat-ban', adminAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { banned, reason } = req.body;

  if (!userId || isNaN(userId)) {
    throw new ValidationError('Invalid user ID');
  }

  if (typeof banned !== 'boolean') {
    throw new ValidationError('banned must be a boolean');
  }

  await db.query(`
    UPDATE users
    SET chat_banned = $2,
        chat_banned_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
        chat_banned_reason = $3
    WHERE id = $1
  `, [userId, banned, reason || null]);

  console.log(`[Admin] User ${userId} chat ${banned ? 'banned' : 'unbanned'}: reason="${reason || 'No reason provided'}"`);

  res.json({
    success: true,
    userId,
    banned,
    reason: reason || null
  });
}));

/**
 * GET /api/admin/users/search
 * Search for users by socket ID prefix or payout address
 * Query: ?q=searchterm&limit=20
 */
router.get('/api/admin/users/search', adminAuth, asyncHandler(async (req, res) => {
  const { q, limit = 20 } = req.query;
  
  if (!q || q.length < 3) {
    throw new ValidationError('Invalid search query', {
      safeMessage: 'Search query must be at least 3 characters.'
    });
  }
  
  const searchLimit = Math.min(parseInt(limit, 10) || 20, 100);
  
  const result = await db.query(`
    SELECT id, socket_id, payout_address, credits, total_games_played, total_credits_purchased, created_at
    FROM users
    WHERE socket_id ILIKE $1 OR payout_address ILIKE $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [`%${q}%`, searchLimit]);
  
  res.json({
    users: result.rows.map(u => ({
      id: u.id,
      socketId: u.socket_id,
      payoutAddress: u.payout_address ? `${u.payout_address.substring(0, 10)}...` : null,
      credits: u.credits || 0,
      gamesPlayed: u.total_games_played || 0,
      createdAt: u.created_at
    })),
    total: result.rows.length
  });
}));

// =============================================================================
// Admin Stats Endpoints
// =============================================================================

// GET /api/admin/stats/overview - Server-wide statistics
router.get('/api/admin/stats/overview', adminAuth, asyncHandler(async (req, res) => {
  // Get user counts
  const userStats = await db.query(`
    SELECT
      COUNT(*) as total_users,
      SUM(total_games_played) as total_games,
      SUM(total_games_won) as total_wins,
      SUM(total_amount_won) as total_payout_volume,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as new_users_24h
    FROM users
  `);

  // Get payout counts
  const payoutStats = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending_payouts,
      COUNT(*) FILTER (WHERE status = 'processing') as processing_payouts,
      COUNT(*) FILTER (WHERE status = 'failed') as failed_payouts,
      COUNT(*) FILTER (WHERE status = 'needs_review') as review_payouts,
      COUNT(*) FILTER (WHERE status = 'permanently_failed') as permanently_failed_payouts,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_payouts,
      COUNT(*) FILTER (WHERE status = 'completed' AND processed_at > NOW() - INTERVAL '24 hours') as payouts_24h
    FROM payouts
  `);

  // Refund transfers have their own durable outbox. `processing` and `needs_review`
  // are intentionally non-retryable, so they must be visible beside payout liabilities.
  const refundStats = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'requested') as requested_refunds,
      COUNT(*) FILTER (WHERE status = 'processing') as processing_refunds,
      COUNT(*) FILTER (WHERE status = 'needs_review') as review_refunds,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_refunds
    FROM payment_refunds
  `);

  // Get game counts for last 24h
  const gameStats = await db.query(`
    SELECT
      COUNT(*) as games_24h,
      COUNT(*) FILTER (WHERE status = 'won') as wins_24h,
      COUNT(*) FILTER (WHERE status = 'lost') as losses_24h
    FROM games
    WHERE created_at > NOW() - INTERVAL '24 hours'
  `);

  // Get wallet balance - always attempt, even if isHealthy is false
  let walletBalance = null;
  try {
    walletBalance = await walletRPCService.getBalance();
    if (walletBalance.error) {
      console.warn('Wallet balance returned error:', walletBalance.error);
    }
  } catch (e) {
    console.error('Failed to get wallet balance for admin stats:', e.message);
    walletBalance = { balance: 0, unlocked_balance: 0, error: e.message };
  }

  const user = userStats.rows[0];
  const payout = payoutStats.rows[0];
  const refund = refundStats.rows[0];
  const game = gameStats.rows[0];

  const cryptoType = gameModeManager.cryptoType || process.env.CRYPTO_TYPE || 'WOW';
  const { inferCurrencyDecimals, getDecimalDivisor } = require('../game/helpers/gameModeUtils');
  const atomicDivisor = getDecimalDivisor(inferCurrencyDecimals(cryptoType));

  res.json({
    totalUsers: parseInt(user.total_users) || 0,
    totalGamesPlayed: parseInt(user.total_games) || 0,
    totalGamesWon: parseInt(user.total_wins) || 0,
    totalPayoutVolume: user.total_payout_volume || '0',
    pendingPayouts: parseInt(payout.pending_payouts) || 0,
    processingPayouts: parseInt(payout.processing_payouts) || 0,
    failedPayouts: parseInt(payout.failed_payouts) || 0,
    payoutsNeedsReview: parseInt(payout.review_payouts) || 0,
    permanentlyFailedPayouts: parseInt(payout.permanently_failed_payouts) || 0,
    completedPayouts: parseInt(payout.completed_payouts) || 0,
    refunds: {
      requested: parseInt(refund.requested_refunds) || 0,
      processing: parseInt(refund.processing_refunds) || 0,
      needsReview: parseInt(refund.review_refunds) || 0,
      completed: parseInt(refund.completed_refunds) || 0
    },
    walletBalance: walletBalance,
    cryptoType,
    atomicDivisor,
    last24h: {
      games: parseInt(game.games_24h) || 0,
      wins: parseInt(game.wins_24h) || 0,
      losses: parseInt(game.losses_24h) || 0,
      payouts: parseInt(payout.payouts_24h) || 0,
      newUsers: parseInt(user.new_users_24h) || 0
    }
  });
}));

// GET /api/admin/stats/payouts - Payout details
router.get('/api/admin/stats/payouts', adminAuth, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  let whereClause = '';
  const params = [limitNum, offsetNum];

  if (status === 'attention') {
    whereClause = 'WHERE status = ANY($3::varchar[])';
    params.push(PAYOUT_ATTENTION_STATUSES);
  } else if (status && PAYOUT_STATUSES.includes(status)) {
    whereClause = 'WHERE status = $3';
    params.push(status);
  }

  const result = await db.query(`
    SELECT p.id, p.game_id, p.user_id, p.amount, p.payout_address, p.status,
           p.tx_hash, p.fee, p.retry_count, p.last_error, p.created_at, p.processed_at
    FROM payouts p
    ${whereClause}
    ORDER BY p.created_at DESC
    LIMIT $1 OFFSET $2
  `, params);

  // Get totals
  const totals = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
      COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
      COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
      COUNT(*) FILTER (WHERE status = 'needs_review') as review_count,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
      COUNT(*) FILTER (WHERE status = 'permanently_failed') as permanently_failed_count,
      COUNT(*) FILTER (WHERE status = 'batched') as batched_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as total_volume
    FROM payouts
  `);

  res.json({
    payouts: result.rows.map(p => ({
      id: p.id,
      gameId: p.game_id,
      userId: p.user_id,
      amount: p.amount,
      address: p.payout_address,
      status: p.status,
      txHash: p.tx_hash,
      fee: p.fee,
      retryCount: p.retry_count,
      lastError: p.last_error,
      createdAt: p.created_at,
      processedAt: p.processed_at
    })),
    totals: {
      pending: parseInt(totals.rows[0].pending_count) || 0,
      processing: parseInt(totals.rows[0].processing_count) || 0,
      failed: parseInt(totals.rows[0].failed_count) || 0,
      needsReview: parseInt(totals.rows[0].review_count) || 0,
      completed: parseInt(totals.rows[0].completed_count) || 0,
      permanentlyFailed: parseInt(totals.rows[0].permanently_failed_count) || 0,
      batched: parseInt(totals.rows[0].batched_count) || 0,
      totalVolume: totals.rows[0].total_volume || '0'
    }
  });
}));

// GET /api/admin/stats/refunds - Durable payment-refund outbox details
router.get('/api/admin/stats/refunds', adminAuth, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  let whereClause = '';
  const params = [limitNum, offsetNum];
  if (status === 'attention') {
    whereClause = 'WHERE r.status = ANY($3::varchar[])';
    params.push(REFUND_ATTENTION_STATUSES);
  } else if (status && REFUND_STATUSES.includes(status)) {
    whereClause = 'WHERE r.status = $3';
    params.push(status);
  }

  const result = await db.query(`
    SELECT r.id, r.payment_id, r.user_id, r.status, r.amount, r.payout_address,
           r.credits_deducted, r.purchase_progress_deducted,
           r.race_entries_deducted, r.tx_hash, r.error_message, r.reason,
           r.requested_at, r.processing_started_at, r.completed_at,
           r.needs_review_at, r.created_at, r.updated_at,
           p.status AS payment_status
    FROM payment_refunds r
    JOIN payments p ON p.id = r.payment_id
    ${whereClause}
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT $1 OFFSET $2
  `, params);

  const totals = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'recorded') as recorded_count,
      COUNT(*) FILTER (WHERE status = 'requested') as requested_count,
      COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
      COUNT(*) FILTER (WHERE status = 'needs_review') as review_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as completed_volume
    FROM payment_refunds
  `);

  res.json({
    refunds: result.rows.map(r => ({
      id: r.id,
      paymentId: r.payment_id,
      userId: r.user_id,
      paymentStatus: r.payment_status,
      status: r.status,
      amount: r.amount,
      address: r.payout_address,
      creditsDeducted: r.credits_deducted,
      purchaseProgressDeducted: r.purchase_progress_deducted,
      raceEntriesDeducted: r.race_entries_deducted,
      txHash: r.tx_hash,
      error: r.error_message,
      reason: r.reason,
      requestedAt: r.requested_at,
      processingStartedAt: r.processing_started_at,
      completedAt: r.completed_at,
      needsReviewAt: r.needs_review_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    totals: {
      recorded: parseInt(totals.rows[0].recorded_count) || 0,
      requested: parseInt(totals.rows[0].requested_count) || 0,
      processing: parseInt(totals.rows[0].processing_count) || 0,
      completed: parseInt(totals.rows[0].completed_count) || 0,
      needsReview: parseInt(totals.rows[0].review_count) || 0,
      completedVolume: totals.rows[0].completed_volume || '0'
    }
  });
}));

// GET /api/admin/stats/games - Game statistics
router.get('/api/admin/stats/games', adminAuth, asyncHandler(async (req, res) => {
  const { period = '24h', limit = 50 } = req.query;
  const limitNum = Math.min(parseInt(limit) || 50, 200);

  // Parse period
  let interval = '24 hours';
  if (period === '7d') interval = '7 days';
  else if (period === '30d') interval = '30 days';

  // Summary stats
  const summary = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'won') as won,
      COUNT(*) FILTER (WHERE status = 'lost') as lost,
      COUNT(*) FILTER (WHERE outcome = 'escaped') as escaped,
      COUNT(*) FILTER (WHERE outcome = 'caught_by_monster') as caught,
      COUNT(*) FILTER (WHERE outcome = 'expired') as expired,
      AVG(duration_seconds) as avg_duration
    FROM games
    WHERE created_at > NOW() - INTERVAL '${interval}'
  `);

  // By game mode
  const byMode = await db.query(`
    SELECT game_mode, COUNT(*) as count
    FROM games
    WHERE created_at > NOW() - INTERVAL '${interval}'
    GROUP BY game_mode
  `);

  // Top winners
  const topWinners = await db.query(`
    SELECT u.socket_id, u.total_games_won as wins, u.total_amount_won as total_won
    FROM users u
    WHERE u.total_games_won > 0
    ORDER BY u.total_amount_won DESC
    LIMIT 10
  `);

  // Recent games
  const recentGames = await db.query(`
    SELECT g.id, g.game_mode, g.status, g.outcome, g.duration_seconds, g.created_at,
           p.amount as payout_amount
    FROM games g
    LEFT JOIN payouts p ON p.game_id = g.id AND p.status = 'completed'
    ORDER BY g.created_at DESC
    LIMIT $1
  `, [limitNum]);

  const s = summary.rows[0];
  const modeMap = {};
  byMode.rows.forEach(r => { modeMap[r.game_mode] = parseInt(r.count) || 0; });

  res.json({
    summary: {
      total: parseInt(s.total) || 0,
      won: parseInt(s.won) || 0,
      lost: parseInt(s.lost) || 0,
      escaped: parseInt(s.escaped) || 0,
      caught: parseInt(s.caught) || 0,
      expired: parseInt(s.expired) || 0
    },
    avgDuration: parseFloat(s.avg_duration) || 0,
    byMode: modeMap,
    topWinners: topWinners.rows.map(w => ({
      socketId: w.socket_id?.substring(0, 20) + '...',
      wins: parseInt(w.wins) || 0,
      totalWon: w.total_won || '0'
    })),
    recentGames: recentGames.rows.map(g => ({
      id: g.id,
      mode: g.game_mode,
      status: g.status,
      outcome: g.outcome,
      duration: g.duration_seconds,
      payoutAmount: g.payout_amount,
      createdAt: g.created_at
    }))
  });
}));

// GET /api/admin/users - Paginated user list
router.get('/api/admin/users', adminAuth, asyncHandler(async (req, res) => {
  const { search, limit = 50, offset = 0 } = req.query;
  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  let whereClause = '';
  const params = [limitNum, offsetNum];

  if (search && search.length >= 3) {
    whereClause = 'WHERE socket_id ILIKE $3 OR payout_address ILIKE $3';
    params.push(`%${search}%`);
  }

  const result = await db.query(`
    SELECT id, socket_id, payout_address, credits, total_games_played, total_games_won,
           total_amount_paid, total_amount_won, total_credits_purchased, created_at
    FROM users
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, params);

  // Build the count query from the SAME params list as the main query so the
  // shared ${whereClause} (which references $3 when searching) always has its
  // parameter supplied. Passing a one-element array here threw for any search term.
  const countResult = await db.query(`
    SELECT COUNT(*) as total FROM users ${whereClause}
  `, search && search.length >= 3 ? params : []);

  res.json({
    users: result.rows.map(u => ({
      id: u.id,
      socketId: u.socket_id,
      payoutAddress: u.payout_address ? `${u.payout_address.substring(0, 15)}...` : null,
      credits: u.credits || 0,
      gamesPlayed: parseInt(u.total_games_played) || 0,
      gamesWon: parseInt(u.total_games_won) || 0,
      totalPaid: u.total_amount_paid || '0',
      totalWon: u.total_amount_won || '0',
      creditsPurchased: parseInt(u.total_credits_purchased) || 0,
      createdAt: u.created_at
    })),
    total: parseInt(countResult.rows[0]?.total) || 0,
    limit: limitNum,
    offset: offsetNum
  });
}));

// GET /api/admin/users/:id - Detailed user info
router.get('/api/admin/users/:id', adminAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const userResult = await db.query(`
    SELECT * FROM users WHERE id = $1
  `, [id]);

  if (!userResult.rows.length) {
    throw new NotFoundError('User not found');
  }

  const user = userResult.rows[0];

  // Get user's games
  const gamesResult = await db.query(`
    SELECT id, game_mode, status, outcome, treasure_found, moves_made, duration_seconds, created_at
    FROM games
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [id]);

  // Get user's payments
  const paymentsResult = await db.query(`
    SELECT id, amount, status, tx_hash, credits_purchased, created_at
    FROM payments
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [id]);

  // Get user's payouts
  const payoutsResult = await db.query(`
    SELECT id, amount, status, tx_hash, fee, payout_address, created_at, processed_at
    FROM payouts
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [id]);

  res.json({
    user: {
      id: user.id,
      socketId: user.socket_id,
      payoutAddress: user.payout_address,
      credits: user.credits || 0,
      gamesPlayed: parseInt(user.total_games_played) || 0,
      gamesWon: parseInt(user.total_games_won) || 0,
      totalPaid: user.total_amount_paid || '0',
      totalWon: user.total_amount_won || '0',
      creditsPurchased: parseInt(user.total_credits_purchased) || 0,
      createdAt: user.created_at
    },
    games: gamesResult.rows,
    payments: paymentsResult.rows,
    payouts: payoutsResult.rows
  });
}));

// POST /api/admin/payouts/:id/retry - Manually retry a failed payout
router.post('/api/admin/payouts/:id/retry', adminAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const confirm = req.query.confirm === 'true' || !!(req.body && req.body.confirm === true);
  const payoutId = Number(id);
  if (!Number.isSafeInteger(payoutId) || payoutId <= 0) {
    throw new ValidationError('Payout id must be a positive integer');
  }

  const payoutResult = await db.query(`
    SELECT * FROM payouts WHERE id = $1
  `, [payoutId]);

  if (!payoutResult.rows.length) {
    throw new NotFoundError('Payout not found');
  }

  const payout = payoutResult.rows[0];

  // A transaction hash, processing claim, or needs_review state is evidence that a wallet call
  // may have happened. "Not found" is not proof of non-broadcast, so these rows are deliberately
  // reconciliation-only and can never be resent through this endpoint.
  if (payout.tx_hash) {
    return res.status(409).json({
      success: false,
      message: 'Payout has transaction evidence and requires manual reconciliation; it cannot be resent.'
    });
  }
  if (!['failed', 'permanently_failed'].includes(payout.status)) {
    return res.status(409).json({
      success: false,
      message: `Payout status ${payout.status} is not retryable. Only hashless failed rows may be requeued.`
    });
  }
  if (!confirm) {
    return res.status(400).json({
      success: false,
      message: 'Pass ?confirm=true (or {confirm:true}) after reviewing the failure before requeueing.',
      requiresConfirm: true
    });
  }

  // The predicate repeats every safety condition so a concurrent worker/status change cannot be
  // overwritten after the row was read.
  const reset = await db.query(`
    UPDATE payouts
    SET status = 'pending', last_error = 'Manual retry requested after reviewed pre-broadcast failure'
    WHERE id = $1
      AND status IN ('failed', 'permanently_failed')
      AND tx_hash IS NULL
    RETURNING id
  `, [payoutId]);
  if (reset.rowCount !== 1) {
    return res.status(409).json({
      success: false,
      message: 'Payout changed while it was being reviewed and was not requeued.'
    });
  }

  res.json({
    success: true,
    message: 'Payout queued for retry',
    payoutId
  });
}));

  return router;
};
