const express = require('express');
const path = require('path');
const crypto = require('crypto');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);

// Load environment configuration
require('dotenv').config();

// Import payment system components
const DatabaseManager = require('./db/databaseManager');
const WalletRPCService = require('./payments/walletRPCService');
const PayoutRetryService = require('./payments/payoutRetryService');
const GameModeManager = require('./game/gameModeManager');
const RpcService = require('./rpc/rpcService');
const PaymentConfigManager = require('./config/paymentConfig');
const EnvironmentValidator = require('./config/environmentValidator');
const asyncHandler = require('./middleware/asyncHandler');
const createErrorMiddleware = require('./middleware/errorHandler');
const { AppError, ValidationError, NotFoundError } = require('./utils/errors');

// Import modular components
const BroadcastManager = require('./network/broadcastManager');
const DebugManager = require('./debug/debugManager');
const SocketHandlers = require('./network/socketHandlers');
const { verifyGame, hashSeed } = require('./game/provablyFair');

// Initialize payment configuration
const paymentConfigManager = new PaymentConfigManager({ logger: console });
const environmentValidator = new EnvironmentValidator({ logger: console });
environmentValidator.validate(paymentConfigManager.getConfig());
process.env.GAME_MODE = paymentConfigManager.getLegacyGameMode();

// Initialize modular components first
const broadcastManager = new BroadcastManager(io);
const debugManager = new DebugManager(broadcastManager);
broadcastManager.setDebugManager(debugManager);

// Initialize payment system components (debugManager is now available)
const databaseManager = new DatabaseManager();
const db = databaseManager; // Alias for convenience in API endpoints
const rpcService = new RpcService();
const walletRPCService = new WalletRPCService(debugManager);
const gameModeManager = new GameModeManager(databaseManager, walletRPCService, debugManager, paymentConfigManager);
// Provide io reference so GameModeManager can emit events (e.g., credits_update)
gameModeManager.io = io;

// Initialize remaining components
const activeGames = new Map(); // Maps socketId to Game objects
const socketHandlers = new SocketHandlers(io, activeGames, broadcastManager, debugManager, gameModeManager, walletRPCService);
// Configure static file serving
const htmlPath = path.join(__dirname, '../html');
app.use(express.static(htmlPath));
app.use(express.json()); // Parse JSON for API endpoints

// Serve main page
app.get('/', function(req, res) {
   res.sendFile('index.html', { root: htmlPath });
});

// Debug endpoint to receive client-side debug info
app.post('/debug', (req, res) => {
  if (debugManager.CONSOLE_LOGGING) {
    console.log('📝 CLIENT DEBUG INFO:', req.body);
  }
  res.json({ received: true, timestamp: Date.now() });
});

// Payment system API endpoints
app.post('/api/payment/create', asyncHandler(async (req, res) => {
  const { userId, gameMode } = req.body || {};
  if (!userId || !gameMode) {
    throw new ValidationError('Missing userId or gameMode', {
      safeMessage: 'userId and gameMode are required to create a payment.'
    });
  }

  throw new AppError('REST payment creation endpoint is not implemented for unified payments', {
    statusCode: 501,
    code: 'NOT_IMPLEMENTED',
    safeMessage: 'Payment creation via REST API is not available. Please use the in-game flow.'
  });
}));

const restNotImplemented = () => new AppError('Endpoint not available in unified payment system', {
  statusCode: 501,
  code: 'NOT_IMPLEMENTED',
  safeMessage: 'This API endpoint is not available. Please use the supported in-game flow.'
});

app.post('/api/payment/callback', asyncHandler(async (req, res) => {
  throw restNotImplemented();
}));

app.get('/api/payment/status/:paymentId', asyncHandler(async (req, res) => {
  throw restNotImplemented();
}));

app.get('/api/user/:socketId/credits', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    const user = await gameModeManager.getOrCreateUser(socketId);
    res.json({
      socketId,
      credits: user.credits || 0,
      totalCreditsPurchased: user.total_credits_purchased || 0
    });
  } catch (error) {
    throw new AppError('Failed to retrieve credits', {
      statusCode: 500,
      safeMessage: 'Unable to retrieve credit balance.',
      cause: error
    });
  }
}));

app.get('/api/user/:socketId/mode', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    const user = await gameModeManager.getOrCreateUser(socketId);
    res.json({
      socketId,
      preferredPaymentMode: user.preferred_payment_mode || 'direct',
      hasPayoutAddress: !!user.payout_address,
      paymentsEnabled: gameModeManager.paymentsEnabled,
      directModeEnabled: gameModeManager.directModeEnabled,
      creditsModeEnabled: gameModeManager.creditsModeEnabled
    });
  } catch (error) {
    throw new AppError('Failed to retrieve user mode', {
      statusCode: 500,
      safeMessage: 'Unable to retrieve user mode.',
      cause: error
    });
  }
}));

app.post('/api/user/:socketId/address', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  const { address } = req.body || {};

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  if (!address || typeof address !== 'string') {
    throw new ValidationError('Missing or invalid address', {
      safeMessage: 'A valid payout address is required.'
    });
  }

  // Basic address validation (XMR/WOW addresses)
  const ADDRESS_REGEX = /((?:4|8)[1-9A-HJ-NP-Za-km-z]{90,110}|(?:Wo|WO|ww|WW)[0-9A-Za-z]{88,112}|W[0-9A-Za-z]{90,112})/;
  if (!ADDRESS_REGEX.test(address.trim())) {
    throw new ValidationError('Invalid address format', {
      safeMessage: 'The provided address does not appear to be a valid XMR/WOW address.'
    });
  }

  try {
    const success = await gameModeManager.setUserPayoutAddress(socketId, address.trim());
    if (!success) {
      throw new AppError('Failed to save address', {
        statusCode: 500,
        safeMessage: 'Unable to save payout address.'
      });
    }
    res.json({
      success: true,
      message: 'Payout address saved successfully.'
    });
  } catch (error) {
    if (error instanceof AppError || error instanceof ValidationError) {
      throw error;
    }
    throw new AppError('Failed to save address', {
      statusCode: 500,
      safeMessage: 'Unable to save payout address.',
      cause: error
    });
  }
}));

// Health check endpoint - enhanced for monitoring dashboard
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    
    // Memory details
    memory: {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external || 0
    },
    
    // Game statistics
    games: {
      active: activeGames.size,
      queued: socketHandlers?.queueManager?.getQueueLength?.() || 0,
      connected: io.sockets.sockets.size || 0,
      mode: gameModeManager.gameMode
    },
    
    // Blockchain
    blockHeight: debugManager.getCurrentBlockHeight(),
    blockSource: process.env.BLOCK_SOURCE || 'daemon',
    network: process.env.MONERO_NETWORK || 'mainnet',
    
    // Wallet status
    wallet: {
      available: gameModeManager.paymentsEnabled,
      status: walletRPCService.isHealthy ? 'connected' : 'disconnected',
      endpoint: process.env.PRIMARY_WALLET_ENDPOINT ? '...' + process.env.PRIMARY_WALLET_ENDPOINT.slice(-15) : null,
      pendingPayouts: 0 // Could track this in gameModeManager
    },
    
    // Rate limiter stats (if available)
    rateLimiter: socketHandlers?.rateLimiter ? {
      trackedEntries: socketHandlers.rateLimiter.getTrackedCount?.() || 0,
      blockedCount: socketHandlers.rateLimiter.getBlockedCount?.() || 0
    } : null,
    
    // Limits
    limits: {
      maxGamesPerHour: parseInt(process.env.MAX_GAMES_PER_HOUR) || 60,
      maxPayoutsPerDay: parseInt(process.env.MAX_PAYOUTS_PER_DAY) || 100
    },
    
    // Legacy fields for compatibility
    gameMode: gameModeManager.gameMode,
    paymentsEnabled: gameModeManager.paymentsEnabled,
    directModeEnabled: gameModeManager.directModeEnabled,
    creditsModeEnabled: gameModeManager.creditsModeEnabled,
    walletHealthy: walletRPCService.isHealthy,
    activeGames: activeGames.size,
    debugMode: debugManager.getDebugStatus().debugMode
  };
  res.json(health);
});

// Get payment options for a user (mixed mode support)
app.get('/api/user/:socketId/payment-options', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    const options = await gameModeManager.getPaymentOptionsForUser(socketId);
    res.json(options);
  } catch (error) {
    throw new AppError('Failed to retrieve payment options', {
      statusCode: 500,
      safeMessage: 'Unable to retrieve payment options.',
      cause: error
    });
  }
}));

// Get payment history for a user
app.get('/api/user/:socketId/payments', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    const user = await gameModeManager.getOrCreateUser(socketId);
    const result = await db.query(`
      SELECT 
        id, 
        payment_type, 
        expected_amount, 
        status, 
        credits_purchased,
        created_at, 
        confirmed_at,
        description
      FROM payments 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `, [user.id, limit, offset]);
    
    const countResult = await db.query(
      `SELECT COUNT(*) as total, 
              COALESCE(SUM(CASE WHEN status = 'confirmed' THEN expected_amount ELSE 0 END), 0) as total_paid 
       FROM payments WHERE user_id = $1`,
      [user.id]
    );
    
    const totalPaid = parseInt(countResult.rows[0].total_paid, 10) || 0;
    
    res.json({
      payments: result.rows.map(row => ({
        id: row.id,
        type: row.payment_type,
        amount: row.expected_amount,
        amountFormatted: gameModeManager.formatAtomicHuman(row.expected_amount, 4),
        status: row.status,
        creditsReceived: row.credits_purchased || 0,
        createdAt: row.created_at,
        confirmedAt: row.confirmed_at,
        description: row.description
      })),
      total: parseInt(countResult.rows[0].total, 10),
      totalPaid: totalPaid,
      totalPaidFormatted: gameModeManager.formatAtomicHuman(totalPaid, 4),
      limit,
      offset,
      currency: gameModeManager.cryptoType
    });
  } catch (error) {
    throw new AppError('Failed to retrieve payment history', {
      statusCode: 500,
      safeMessage: 'Unable to retrieve payment history.',
      cause: error
    });
  }
}));

// Get payout history for a user
app.get('/api/user/:socketId/payouts', asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    const user = await gameModeManager.getOrCreateUser(socketId);
    const result = await db.query(`
      SELECT 
        p.id,
        p.amount,
        p.multiplier,
        p.reason,
        p.status,
        p.tx_hash,
        p.created_at,
        p.processed_at,
        g.outcome as game_outcome
      FROM payouts p
      LEFT JOIN games g ON p.game_id = g.id
      WHERE p.user_id = $1 
      ORDER BY p.created_at DESC 
      LIMIT $2 OFFSET $3
    `, [user.id, limit, offset]);
    
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM payouts WHERE user_id = $1`,
      [user.id]
    );
    
    // Calculate total received (confirmed payouts)
    const totalResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total_received FROM payouts WHERE user_id = $1 AND status = 'confirmed'`,
      [user.id]
    );
    
    res.json({
      payouts: result.rows.map(row => ({
        id: row.id,
        amount: row.amount,
        amountFormatted: gameModeManager.formatAtomicHuman(row.amount, 4),
        multiplier: parseFloat(row.multiplier) || 0,
        reason: row.reason,
        status: row.status,
        txHash: row.tx_hash,
        createdAt: row.created_at,
        processedAt: row.processed_at,
        gameOutcome: row.game_outcome
      })),
      total: parseInt(countResult.rows[0].total, 10),
      totalReceived: parseInt(totalResult.rows[0].total_received, 10),
      totalReceivedFormatted: gameModeManager.formatAtomicHuman(totalResult.rows[0].total_received, 4),
      limit,
      offset,
      currency: gameModeManager.cryptoType
    });
  } catch (error) {
    throw new AppError('Failed to retrieve payout history', {
      statusCode: 500,
      safeMessage: 'Unable to retrieve payout history.',
      cause: error
    });
  }
}));

// =============================================================================
// Smirk Wallet Authentication Endpoints
// =============================================================================

/**
 * POST /api/auth/smirk/challenge
 * Generate a challenge for Smirk wallet signature verification
 * Body: { socketId: string }
 */
app.post('/api/auth/smirk/challenge', asyncHandler(async (req, res) => {
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
app.post('/api/auth/smirk/verify', asyncHandler(async (req, res) => {
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
  // The signature should be the challenge signed by the wallet's private key
  let isValidSignature = false;
  try {
    const nacl = require('tweetnacl');
    const challengeBytes = Buffer.from(challenge, 'hex');
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');

    // tweetnacl.sign.detached.verify(message, signature, publicKey)
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
app.get('/api/auth/smirk/status', asyncHandler(async (req, res) => {
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
app.post('/api/admin/refund/payment', adminAuth, asyncHandler(async (req, res) => {
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
      const userResult = await client.query(`
        SELECT credits FROM users WHERE id = $1
      `, [payment.user_id]);
      
      const currentCredits = userResult.rows[0]?.credits || 0;
      creditsDeducted = Math.min(payment.credits_purchased, currentCredits);
      
      if (creditsDeducted > 0) {
        const newBalance = currentCredits - creditsDeducted;
        await client.query(`
          UPDATE users SET credits = $1 WHERE id = $2
        `, [newBalance, payment.user_id]);
        
        // Record credit transaction
        await client.query(`
          INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
          VALUES ($1, $2, $3, $4, 'refund')
        `, [payment.user_id, -creditsDeducted, `Refund for payment ${paymentId}`, newBalance]);
      }
    }
    
    await client.query('COMMIT');
    
    // Optionally send funds back via wallet RPC
    let fundsSent = false;
    let txHash = null;
    if (sendFunds && payment.payout_address && payment.expected_amount > 0) {
      try {
        if (walletRPCService && typeof walletRPCService.sendPayment === 'function') {
          const result = await walletRPCService.sendPayment(
            payment.payout_address, 
            payment.expected_amount
          );
          fundsSent = true;
          txHash = result?.tx_hash || null;
        }
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
app.post('/api/admin/credits/adjust', adminAuth, asyncHandler(async (req, res) => {
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
  const newBalance = Math.max(0, currentCredits + amount); // Prevent negative balance
  const actualAdjustment = newBalance - currentCredits;
  
  if (actualAdjustment === 0) {
    return res.json({
      success: false,
      message: 'No adjustment made (would result in same balance).',
      user: { credits: currentCredits }
    });
  }
  
  // Update credits
  await db.query(`
    UPDATE users SET credits = $1, updated_at = NOW() WHERE id = $2
  `, [newBalance, user.id]);
  
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
 * GET /api/admin/users/search
 * Search for users by socket ID prefix or payout address
 * Query: ?q=searchterm&limit=20
 */
app.get('/api/admin/users/search', adminAuth, asyncHandler(async (req, res) => {
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

app.get('/api/game-modes', (req, res) => {
  const config = paymentConfigManager.getConfig();
  const decimals = Number(config.currency?.decimals ?? 12);
  const divisor = Number.isFinite(decimals) ? Math.pow(10, decimals) : 1;
  const toDisplay = (value) => {
    if (value === null || value === undefined) {
      return 0;
    }
    const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(numeric) ? numeric / divisor : 0;
  };

  const directMode = config.modes.direct;
  const creditsMode = config.modes.credits;

  // Include hosted by info if configured
  let hostedBy = null;
  if (process.env.HOSTED_BY) {
    let hostname = process.env.HOSTED_BY_NAME;
    if (!hostname) {
      try {
        hostname = new URL(process.env.HOSTED_BY).hostname;
      } catch (e) {
        hostname = process.env.HOSTED_BY; // Use raw value if URL parsing fails
      }
    }
    hostedBy = {
      url: process.env.HOSTED_BY,
      name: hostname
    };
  }

  res.json({
    FREE: {
      name: 'Free Play',
      cost: 0,
      payoutMultiplier: 0,
      enabled: !config.paymentsEnabled
    },
    PAID_SINGLE: {
      name: 'Paid Single Game',
      cost: toDisplay(directMode.price),
      enabled: !!directMode.enabled,
      payoutMultiplier: config.payouts.rules.direct.multipliers
    },
    PAID_CREDITS: {
      name: 'Credits Package',
      cost: toDisplay(creditsMode.packages?.[0]?.price ?? 0),
      credits: creditsMode.packages?.[0]?.credits ?? creditsMode.creditsPerGame,
      enabled: !!creditsMode.enabled,
      payoutMultiplier: creditsMode.enabled && config.payouts.rules.credits.enabled
        ? config.payouts.rules.credits.multipliers
        : 0
    },
    hostedBy
  });
});

// ============================================================================
// Provably Fair Verification Endpoint
// ============================================================================

/**
 * Verify a game's fairness by checking if the seed matches the commitment hash
 * 
 * GET /verify/:gameId - Returns HTML verification page
 * GET /api/verify - Verify seed and commitment (query params: seed, commitment)
 */
app.get('/verify/:gameId', asyncHandler(async (req, res) => {
  const { gameId } = req.params;
  
  // Try to look up the game in the database
  let gameRecord = null;
  try {
    const result = await databaseManager.query(
      'SELECT dungeon_seed, status, treasure_found, moves_made, duration_seconds, created_at FROM games WHERE dungeon_seed = $1',
      [gameId]
    );
    if (result.rows.length > 0) {
      gameRecord = result.rows[0];
    }
  } catch (err) {
    // Database lookup failed, continue without game record
  }
  
  // Return a simple HTML verification page
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Wownerogue - Game Verification</title>
  <style>
    body { background: #0a0a0a; color: #0f0; font-family: monospace; padding: 20px; max-width: 800px; margin: 0 auto; }
    h1 { color: #0ff; }
    .box { background: #001a00; border: 1px solid #0f0; padding: 15px; margin: 10px 0; border-radius: 5px; }
    input, button { font-family: monospace; padding: 8px; margin: 5px 0; }
    input { background: #001a00; color: #0f0; border: 1px solid #0f0; width: 100%; box-sizing: border-box; }
    button { background: #0a5c0a; color: #ff0; border: 2px solid #0f0; cursor: pointer; }
    button:hover { background: #0f0; color: #000; }
    .success { color: #4ade80; }
    .error { color: #f00; }
    #result { margin-top: 15px; padding: 10px; }
    code { background: #002200; padding: 2px 6px; border-radius: 3px; }
    .info { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🔐 Wownerogue Provably Fair Verification</h1>
  
  <div class="box">
    <h3>How it works:</h3>
    <ol>
      <li>Before game start, you received a <strong>commitment hash</strong> (SHA-256)</li>
      <li>After the game, you received the <strong>seed</strong></li>
      <li>This page verifies: <code>SHA256(seed) === commitment</code></li>
      <li>The seed deterministically generated your dungeon layout</li>
    </ol>
  </div>
  
  <div class="box">
    <h3>Verify Game</h3>
    <label>Game Seed (revealed after game):</label>
    <input type="text" id="seed" placeholder="64 character hex string">
    
    <label>Commitment Hash (shown before game):</label>
    <input type="text" id="commitment" placeholder="64 character hex string">
    
    <button onclick="verify()">🔍 Verify</button>
    
    <div id="result"></div>
  </div>
  
  ${gameRecord ? `
  <div class="box">
    <h3>Game Record</h3>
    <p><strong>Game ID:</strong> ${gameId}</p>
    <p><strong>Status:</strong> ${gameRecord.status}</p>
    <p><strong>Treasure Found:</strong> ${gameRecord.treasure_found ? 'Yes' : 'No'}</p>
    <p><strong>Moves:</strong> ${gameRecord.moves_made || 'N/A'}</p>
    <p><strong>Duration:</strong> ${gameRecord.duration_seconds ? gameRecord.duration_seconds + 's' : 'N/A'}</p>
    <p><strong>Created:</strong> ${gameRecord.created_at}</p>
  </div>
  ` : ''}
  
  <div class="box info">
    <p>For technical verification, you can also use the API:</p>
    <code>GET /api/verify?seed=YOUR_SEED&commitment=YOUR_COMMITMENT</code>
  </div>
  
  <script>
    async function verify() {
      const seed = document.getElementById('seed').value.trim();
      const commitment = document.getElementById('commitment').value.trim();
      const result = document.getElementById('result');
      
      if (!seed || !commitment) {
        result.innerHTML = '<p class="error">Please enter both seed and commitment.</p>';
        return;
      }
      
      try {
        const response = await fetch('/api/verify?seed=' + encodeURIComponent(seed) + '&commitment=' + encodeURIComponent(commitment));
        const data = await response.json();
        
        if (data.valid) {
          result.innerHTML = '<p class="success">✅ ' + data.message + '</p>' +
            '<p>Computed hash: <code>' + data.computedHash + '</code></p>';
        } else {
          result.innerHTML = '<p class="error">❌ ' + data.message + '</p>' +
            '<p>Expected: <code>' + data.expectedCommitment + '</code></p>' +
            '<p>Got: <code>' + data.computedHash + '</code></p>';
        }
      } catch (err) {
        result.innerHTML = '<p class="error">Error: ' + err.message + '</p>';
      }
    }
  </script>
</body>
</html>
  `);
}));

// API endpoint for programmatic verification
app.get('/api/verify', (req, res) => {
  const { seed, commitment } = req.query;
  
  if (!seed || !commitment) {
    return res.status(400).json({
      valid: false,
      error: 'Missing required parameters: seed and commitment'
    });
  }
  
  const result = verifyGame(seed, commitment);
  res.json(result);
});

// Initialize debug manager with new block callbacks
debugManager.onNewBlockCallback((blockHeight) => {
    // Start games for waiting players when new block detected
    socketHandlers.startGamesForWaiting(blockHeight);
    // Check active games for timeout
    socketHandlers.checkGamesTimeout(blockHeight);
});

// Initialize payment system
async function initializePaymentSystem() {
    try {
        console.log('🔧 Initializing payment system...');
        const walletInitialized = await walletRPCService.initialize();
        if (!walletInitialized) {
            console.log('⚠️ Wallet RPC not available - falling back to FREE mode');
            process.env.GAME_MODE = 'FREE';
      paymentConfigManager.refresh();
      gameModeManager.setLegacyGameMode('FREE');
      gameModeManager.paymentsEnabled = false;
      gameModeManager.directModeEnabled = false;
      gameModeManager.creditsModeEnabled = false;
        }
        
        // Initialize database connection and run migrations
        await databaseManager.initialize();
        console.log('✅ Database initialized successfully');
        
        // Test RPC service connectivity
        const rpcHealth = await rpcService.healthCheck();
        console.log(`✅ RPC Service: ${rpcHealth.healthy ? 'Connected' : 'Warning - using fallback'}`);
        
        console.log('🚀 Payment system ready!');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize payment system:', error);
        console.log('⚠️  Server will continue in FREE mode only');
        return false;
    }
}

// Start the debug/production system
debugManager.initialize();

// Debug function for registered users
function debugRegisteredUsers() {
    if (debugManager.CONSOLE_LOGGING) {
        console.log("📊 REGISTERED USERS DEBUG:");
        const allUsers = require('./db/user').getAllUsers();
        console.log(`Total registered users: ${allUsers.length}`);
        allUsers.forEach(u => {
            // u.id is the socket/server id; there is no separate socketId property on User
            console.log(`  - User ID: ${u.id}, Socket: ${u.id}, Client: ${u.clientId}`);
        });
        console.log(`Active games: ${activeGames.size}`);
    }
}

// Regular debug logging
setInterval(debugRegisteredUsers, 10000);

// Start server
async function startServer() {
    try {
        // Initialize payment system first
        const paymentSystemReady = await initializePaymentSystem();
        
        // Socket.io connection handler - ONLY after payment system is ready
        io.on('connection', function(socket) {
            socketHandlers.handleConnection(socket);
        });
        
        // Start HTTP server
        http.listen(3000, function() {
            console.log('🚀 Wownerogue server listening on *:3000');
            console.log(`🐛 Debug mode: ${debugManager.getDebugStatus().debugMode ? 'ENABLED' : 'DISABLED'}`);
            console.log(`💰 Payment system: ${paymentSystemReady ? 'ENABLED' : 'FREE MODE ONLY'}`);
            const summary = paymentConfigManager.summarize();
            const enabledModes = [];
            if (!summary.paymentsEnabled || !paymentSystemReady) {
                enabledModes.push('FREE');
            }
            if (summary.directEnabled && paymentSystemReady) {
                enabledModes.push('PAID_SINGLE');
            }
            if (summary.creditsEnabled && paymentSystemReady) {
                enabledModes.push('PAID_CREDITS');
            }
            if (enabledModes.length === 0) {
                enabledModes.push(summary.legacyMode || 'FREE');
            }
            console.log(`🎮 Available game modes: ${enabledModes.join(', ')}`);
        });
        
        // Start batch payout processing if payment system is ready
        if (paymentSystemReady) {
            const payoutConfig = paymentConfigManager.getConfig().payouts?.processing || {};
            const payoutIntervalSeconds = Math.max(1, Number(payoutConfig.batchInterval || 300));
            const payoutIntervalMs = payoutIntervalSeconds * 1000;
            setInterval(async () => {
                try {
                    await walletRPCService.processBatchPayouts();
                } catch (error) {
                    console.error('Error in batch payout processing:', error);
                }
            }, payoutIntervalMs);

            // Start payout retry service for failed/stuck payouts
            const maxRetries = Number(process.env.PAYOUT_MAX_RETRIES) || 3;
            const retryIntervalMs = Number(process.env.PAYOUT_RETRY_INTERVAL_MS) || 300000; // 5 minutes
            const payoutRetryService = new PayoutRetryService({
                db: databaseManager,
                walletService: walletRPCService,
                debugManager,
                maxRetries,
                retryIntervalMs
            });
            payoutRetryService.start();
        }
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Attach 404 and error handlers last
app.use((req, res, next) => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`, {
    safeMessage: 'The requested resource was not found.'
  }));
});

app.use(createErrorMiddleware({ logger: console }));

startServer();
