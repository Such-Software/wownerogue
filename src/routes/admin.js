/**
 * Admin API routes (extracted from index.js).
 * Dependency-injected via ctx so the handler bodies stay byte-for-byte identical.
 * ctx: { db, gameModeManager, walletRPCService, socketHandlers, io, alertService }
 * (alertService is late-bound: read as ctx.alertService at request time.)
 */
const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError, NotFoundError } = require('../utils/errors');

module.exports = function createAdminRoutes(ctx) {
  const { db, gameModeManager, walletRPCService, socketHandlers, io } = ctx;
  const router = express.Router();

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
  if (!providedKey ||
      providedKey.length !== adminKey.length ||
      !crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(adminKey))) {
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
  
  if (!paymentId || typeof paymentId !== 'number') {
    throw new ValidationError('Invalid paymentId', {
      safeMessage: 'paymentId (number) is required.'
    });
  }
  
  // Get payment record
  const paymentResult = await db.query(`
    SELECT p.*, u.payout_address, u.socket_id
    FROM payments p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = $1
  `, [paymentId]);
  
  if (paymentResult.rows.length === 0) {
    throw new NotFoundError('Payment not found', {
      safeMessage: `Payment ${paymentId} not found.`
    });
  }
  
  const payment = paymentResult.rows[0];
  
  if (payment.status === 'refunded') {
    return res.json({
      success: false,
      message: 'Payment already refunded.',
      payment: { id: payment.id, status: payment.status }
    });
  }
  
  // Begin transaction
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // Mark payment as refunded
    await client.query(`
      UPDATE payments 
      SET status = 'refunded', 
          description = COALESCE(description, '') || ' | Refunded: ' || $2
      WHERE id = $1
    `, [paymentId, reason || 'Admin refund']);
    
    // If credits were purchased, deduct them
    let creditsDeducted = 0;
    if (payment.credits_purchased > 0 && payment.user_id) {
      // SECURITY: Use FOR UPDATE to lock the row and prevent race conditions
      const userResult = await client.query(`
        SELECT credits FROM users WHERE id = $1 FOR UPDATE
      `, [payment.user_id]);

      const currentCredits = userResult.rows[0]?.credits || 0;
      creditsDeducted = Math.min(payment.credits_purchased, currentCredits);

      if (creditsDeducted > 0) {
        // SECURITY: Use atomic decrement with guard to prevent negative balance
        const updateResult = await client.query(`
          UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1
          RETURNING credits
        `, [creditsDeducted, payment.user_id]);

        let newBalance = updateResult.rows[0]?.credits;

        // If update failed (race condition changed credits), recalculate
        if (updateResult.rows.length === 0) {
          const recheckResult = await client.query(`SELECT credits FROM users WHERE id = $1 FOR UPDATE`, [payment.user_id]);
          const actualCredits = recheckResult.rows[0]?.credits || 0;
          creditsDeducted = Math.min(payment.credits_purchased, actualCredits);
          if (creditsDeducted > 0) {
            const retryResult = await client.query(`
              UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits
            `, [creditsDeducted, payment.user_id]);
            newBalance = retryResult.rows[0]?.credits ?? (actualCredits - creditsDeducted);
          } else {
            newBalance = actualCredits;
          }
        }

        // Record credit transaction
        if (creditsDeducted > 0) {
          await client.query(`
            INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
            VALUES ($1, $2, $3, $4, 'refund')
          `, [payment.user_id, -creditsDeducted, `Refund for payment ${paymentId}`, newBalance]);
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Optionally send funds back via wallet RPC. Refund what the user ACTUALLY paid
    // (received_amount, recorded at confirmation) when available, falling back to the
    // expected amount for older records.
    let fundsSent = false;
    let txHash = null;
    const refundAmount = (payment.received_amount != null && Number(payment.received_amount) > 0)
      ? payment.received_amount
      : payment.expected_amount;
    if (sendFunds && payment.payout_address && Number(refundAmount) > 0) {
      try {
        // processPayout validates the address and performs the transfer; returns
        // { success, txHash, fee }. (The previous code called a nonexistent sendPayment(),
        // so refunds were silently never sent while still reporting success.)
        const result = await walletRPCService.processPayout({
          address: payment.payout_address,
          amount: refundAmount,
          userId: payment.user_id,
          description: `Refund for payment ${paymentId}`
        });
        fundsSent = !!(result && result.success);
        txHash = (result && result.txHash) || null;
      } catch (err) {
        console.error('Failed to send refund funds:', err.message);
        // Don't fail the request - refund is recorded, funds can be sent manually
      }
    }
    
    res.json({
      success: true,
      message: 'Payment refunded successfully.',
      refund: {
        paymentId,
        originalAmount: payment.expected_amount,
        originalAmountFormatted: gameModeManager.formatAtomicHuman(payment.expected_amount, 4),
        creditsDeducted,
        fundsSent,
        txHash,
        reason: reason || 'Admin refund'
      }
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * POST /api/admin/credits/adjust
 * Adjust a user's credit balance (add or subtract)
 * Body: { socketId: string, amount: number, reason?: string }
 * amount can be positive (add) or negative (subtract)
 */
router.post('/api/admin/credits/adjust', adminAuth, asyncHandler(async (req, res) => {
  const { socketId, amount, reason } = req.body || {};
  
  if (!socketId || typeof socketId !== 'string') {
    throw new ValidationError('Invalid socketId', {
      safeMessage: 'socketId (string) is required.'
    });
  }
  
  if (typeof amount !== 'number' || amount === 0) {
    throw new ValidationError('Invalid amount', {
      safeMessage: 'amount (non-zero number) is required. Positive to add, negative to subtract.'
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
      COUNT(*) FILTER (WHERE status = 'failed') as failed_payouts,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_payouts,
      COUNT(*) FILTER (WHERE status = 'completed' AND processed_at > NOW() - INTERVAL '24 hours') as payouts_24h
    FROM payouts
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
    failedPayouts: parseInt(payout.failed_payouts) || 0,
    completedPayouts: parseInt(payout.completed_payouts) || 0,
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

  if (status && ['pending', 'failed', 'completed', 'permanently_failed'].includes(status)) {
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
      COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
      COUNT(*) FILTER (WHERE status = 'permanently_failed') as permanently_failed_count,
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
      failed: parseInt(totals.rows[0].failed_count) || 0,
      completed: parseInt(totals.rows[0].completed_count) || 0,
      permanentlyFailed: parseInt(totals.rows[0].permanently_failed_count) || 0,
      totalVolume: totals.rows[0].total_volume || '0'
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

  const countResult = await db.query(`
    SELECT COUNT(*) as total FROM users ${whereClause}
  `, search && search.length >= 3 ? [`%${search}%`] : []);

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

  const payoutResult = await db.query(`
    SELECT * FROM payouts WHERE id = $1
  `, [id]);

  if (!payoutResult.rows.length) {
    throw new NotFoundError('Payout not found');
  }

  const payout = payoutResult.rows[0];

  if (payout.status === 'completed') {
    throw new ValidationError('Payout already completed');
  }

  // Reset status to pending for retry
  await db.query(`
    UPDATE payouts SET status = 'pending', last_error = 'Manual retry requested' WHERE id = $1
  `, [id]);

  res.json({
    success: true,
    message: 'Payout queued for retry',
    payoutId: id
  });
}));

  return router;
};
