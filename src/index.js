const express = require('express');
const path = require('path');
const crypto = require('crypto');
var app = express();
// Trust the reverse proxy (for correct req.ip / X-Forwarded-For handling) only when
// explicitly enabled, so client IPs can't be spoofed in a direct-exposure deployment.
if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', true);
}
var http = require('http').Server(app);
var io = require('socket.io')(http);

// Load environment configuration
require('dotenv').config();

// Import payment system components
const DatabaseManager = require('./db/databaseManager');
const WalletRPCService = require('./payments/walletRPCService');
const PayoutRetryService = require('./payments/payoutRetryService');
const AlertService = require('./services/alertService');
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
const { renderVerifyPage } = require('./views/verifyPage');
const createAdminRoutes = require('./routes/admin');
const createAuthRoutes = require('./routes/auth');

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
let alertService = null; // Initialized later when payment system starts
let payoutRetryService = null; // Initialized later when payment system starts
let batchPayoutInterval = null; // Initialized later when payment system starts
let paymentExpiryInterval = null; // Initialized later when payment system starts
const socketHandlers = new SocketHandlers(io, activeGames, broadcastManager, debugManager, gameModeManager, walletRPCService);
// Security headers (defense in depth alongside output escaping).
// CSP locks down where scripts/styles/connections may come from. Inline scripts/styles
// are still permitted ('unsafe-inline') because the current pages rely on them heavily;
// removing that is tracked as Phase 4.4 (nonce-based CSP). connect-src 'self' covers
// same-origin Socket.IO websockets under CSP Level 3. blob: is limited to render-kit
// GLB texture decoding; GLTFLoader turns embedded textures into blob URLs.
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' blob: https://smirk.cash https://cdn.socket.io https://cdn.jsdelivr.net",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'self'",
        "form-action 'self'"
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// Configure static file serving
const htmlPath = path.join(__dirname, '../html');
app.use(express.static(htmlPath, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));
app.use(express.json()); // Parse JSON for API endpoints

// Serve main page
app.get('/', function(req, res) {
   res.sendFile('index.html', { root: htmlPath });
});

// Human-friendly tavern route. The static file remains /tavern.html for direct asset serving.
app.get(['/tavern', '/tavern/'], function(req, res) {
   res.sendFile('tavern.html', { root: htmlPath });
});

// Serve admin panel
app.get('/admin', function(req, res) {
   res.sendFile('admin.html', { root: htmlPath });
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
app.get('/health', async (req, res) => {
  const memUsage = process.memoryUsage();

  // Get wallet balance - always attempt
  let walletBalance = null;
  let lowBalanceWarning = false;
  const lowBalanceThreshold = parseInt(process.env.LOW_BALANCE_THRESHOLD) || 100000000000; // 0.1 XMR default

  try {
    walletBalance = await walletRPCService.getBalance();
    if (walletBalance.error) {
      console.warn('Wallet balance returned error:', walletBalance.error);
    } else {
      lowBalanceWarning = walletBalance.unlocked_balance < lowBalanceThreshold;
    }
  } catch (e) {
    console.error('Failed to get wallet balance for health check:', e.message);
    walletBalance = { balance: 0, unlocked_balance: 0, error: e.message };
  }

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
      pendingPayouts: 0,
      balance: walletBalance,
      lowBalanceWarning
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
      `SELECT COALESCE(SUM(amount), 0) as total_received FROM payouts WHERE user_id = $1 AND status = 'completed'`,
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
// Smirk is a browser extension wallet for Wownero/Monero (mainnet only).
// Forced off on any test network (stagenet/testnet), regardless of SMIRK_ENABLED.
const { isTestNetworkFor } = require('./game/helpers/gameModeUtils');
const smirkEnabled = process.env.SMIRK_ENABLED !== 'false' && !isTestNetworkFor(process.env.MONERO_NETWORK);
if (smirkEnabled) {
  app.use(createAuthRoutes({ db: databaseManager }));
}


// =============================================================================
// Admin API Endpoints (see src/routes/admin.js) — DI ctx; alertService is set later
// =============================================================================
const adminRouteCtx = { db, gameModeManager, walletRPCService, socketHandlers, io, alertService: null };
app.use(createAdminRoutes(adminRouteCtx));

// =============================================================================
// LEADERBOARD
// =============================================================================
app.get('/api/leaderboard', asyncHandler(async (req, res) => {
  const period = req.query.period || 'all';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  let timeFilter = '';
  if (period === 'week') timeFilter = "AND g.completed_at > NOW() - INTERVAL '7 days'";
  else if (period === 'month') timeFilter = "AND g.completed_at > NOW() - INTERVAL '30 days'";

  // Per-game leaderboard split (whitelisted -> safe to interpolate):
  //   champions = games played with credits/entry-fee (Hall of Champions)
  //   pleb      = free games (Pleb board)
  //   all       = everyone (default, backward compatible)
  const board = req.query.board || 'all';
  let boardFilter = '';
  if (board === 'champions') boardFilter = "AND g.game_mode IN ('PAID_SINGLE','PAID_CREDITS')";
  else if (board === 'pleb') boardFilter = "AND g.game_mode = 'FREE'";

  const result = await db.query(`
    SELECT
      u.id,
      COALESCE(u.display_name,
        CASE WHEN u.payout_address IS NOT NULL
          THEN LEFT(u.payout_address, 4) || '...' || RIGHT(u.payout_address, 4)
          ELSE 'Anon#' || u.id
        END
      ) as name,
      MAX(g.score) as best_score,
      COUNT(*) FILTER (WHERE g.status = 'won') as wins,
      COUNT(*) as games_played
    FROM games g
    JOIN users u ON g.user_id = u.id
    WHERE g.status IN ('won', 'lost') AND g.score > 0 ${timeFilter} ${boardFilter}
    GROUP BY u.id, u.display_name, u.payout_address
    ORDER BY best_score DESC
    LIMIT $1
  `, [limit]);

  res.json({ leaderboard: result.rows, period, board });
}));

// Public "social proof" stats strip: players online, games + escapes in the last 24h, and
// total paid out. Cached in-memory for 10s so a public, unauthenticated endpoint can't hammer
// the DB (one query set per 10s regardless of traffic).
let _statsCache = { at: 0, data: null };
app.get('/api/stats', asyncHandler(async (req, res) => {
  const now = Date.now();
  const online = io.sockets.sockets.size || io.engine.clientsCount || 0;

  if (_statsCache.data && (now - _statsCache.at) < 10000) {
    return res.json({ ..._statsCache.data, online });
  }

  const config = paymentConfigManager.getConfig();
  const decimals = Number(config.currency?.decimals ?? 12);
  const divisor = Number.isFinite(decimals) ? Math.pow(10, decimals) : 1;
  const currencyLabel = gameModeManager.currencyLabel || config.currency?.symbol || 'WOW';

  let gamesToday = 0, escapesToday = 0, totalPaidOut = 0;
  try {
    const [games, payouts] = await Promise.all([
      db.query(`SELECT COUNT(*) AS games,
                       COUNT(*) FILTER (WHERE status = 'won') AS escapes
                FROM games WHERE created_at > NOW() - INTERVAL '24 hours'`),
      // Only count payouts that actually left the wallet.
      db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE status = 'completed'`)
    ]);
    gamesToday = parseInt(games.rows[0]?.games || 0, 10);
    escapesToday = parseInt(games.rows[0]?.escapes || 0, 10);
    // amount is atomic units (BIGINT); divide for display. Number() is safe at these magnitudes.
    totalPaidOut = Number(payouts.rows[0]?.total || 0) / divisor;
  } catch (e) {
    // Best-effort; serve whatever we have rather than 500 on a public widget.
  }

  const data = {
    gamesToday,
    escapesToday,
    totalPaidOut,
    currencyLabel,
    // Paid out is only meaningful where payouts are enabled (stagenet / payout instances).
    payoutsEnabled: !!(gameModeManager.directPayoutEnabled || gameModeManager.creditsPayoutEnabled)
  };
  _statsCache = { at: now, data };
  res.json({ ...data, online });
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
    // Free play is available when the instance is free-only OR when free play is offered
    // as a choice alongside paid options (FREE_PLAY_ENABLED).
    freePlayEnabled: !!gameModeManager.freePlayEnabled,
    FREE: {
      name: 'Free Play',
      cost: 0,
      payoutMultiplier: 0,
      enabled: !!gameModeManager.freePlayEnabled
    },
    PAID_SINGLE: {
      name: 'Paid Single Game',
      cost: toDisplay(directMode.price),
      enabled: !!directMode.enabled,
      payoutMultiplier: (directMode.enabled && config.payouts.rules.direct.enabled)
        ? config.payouts.rules.direct.multipliers
        : 0
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
  
  // Return the server-rendered HTML verification page (see src/views/verifyPage.js).
  // Pass an absolute base URL (honours the trusted reverse proxy) + a brand-specific social
  // card image so shared /verify links unfurl with a preview on Twitter/Discord/etc.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const ogImage = (process.env.CRYPTO_TYPE === 'XMR') ? 'og-card-xmr.png' : 'og-card-wow.png';
  res.send(renderVerifyPage(gameId, gameRecord, {
    gameName: gameModeManager.gameName,
    baseUrl,
    ogImage
  }));
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

  // PROVABLY FAIR (Phase 0.2): when the seed matches the commitment, regenerate the
  // dungeon from the seed and return a layout fingerprint so the player can confirm
  // the layout is a deterministic function of the committed seed (not crafted after payment).
  if (result.valid) {
    try {
      const DungeonGenerator = require('./game/dungeon');
      const dungeon = DungeonGenerator.regenerateFromSeed(seed, process.env.CRYPTO_TYPE || 'WOW');
      result.layoutFingerprint = DungeonGenerator.layoutFingerprint(dungeon);
      result.dungeonSize = { width: dungeon.map[0].length, height: dungeon.map.length };
      result.entrance = dungeon.entrance;
      result.exit = dungeon.exit;
      result.treasure = dungeon.treasure;
    } catch (e) {
      // Regeneration is best-effort; the hash check above is the primary verification.
    }
  }

  res.json(result);
});

// Initialize debug manager with new block callbacks
debugManager.onNewBlockCallback((blockHeight) => {
    // Start games for waiting players when new block detected
    socketHandlers.startGamesForWaiting(blockHeight);
    // Check active games for timeout
    Promise.resolve(socketHandlers.checkGamesTimeout(blockHeight)).catch(err => {
        console.error('❌ checkGamesTimeout error:', err.message);
    });
    // Flush any pending payouts (safety net for batch timer)
    gameModeManager._processPendingPayouts().catch(err => {
        console.error('❌ Block-triggered payout processing error:', err.message);
    });
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
        const PORT = process.env.PORT || 3000;
        http.listen(PORT, function() {
            console.log(`🚀 Wownerogue server listening on *:${PORT}`);
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
            batchPayoutInterval = setInterval(async () => {
                try {
                    await gameModeManager._processPendingPayouts();
                } catch (error) {
                    console.error('Error in batch payout processing:', error);
                }
            }, payoutIntervalMs);

            // Start payout retry service for failed/stuck payouts
            const maxRetries = Number(process.env.PAYOUT_MAX_RETRIES) || 3;
            const retryIntervalMs = Number(process.env.PAYOUT_RETRY_INTERVAL_MS) || 300000; // 5 minutes
            // Initialize alert service for email notifications
            alertService = new AlertService({
                walletService: walletRPCService,
                db: databaseManager,
                debugManager
            });

            // Make alertService available to gameModeManager/paymentHandlers for balance checks
            gameModeManager.alertService = alertService;
            // And to the admin routes (late-bound via the shared ctx object)
            adminRouteCtx.alertService = alertService;

            payoutRetryService = new PayoutRetryService({
                db: databaseManager,
                walletService: walletRPCService,
                debugManager,
                maxRetries,
                retryIntervalMs,
                alertService // Pass alert service for failure notifications
            });
            payoutRetryService.start();

            // Start periodic alert checks (every 5 minutes)
            alertService.startPeriodicChecks(300000);
        }

        // Periodic job: expire old pending payments (every 5 minutes)
        paymentExpiryInterval = setInterval(async () => {
            try {
                const result = await databaseManager.query(`
                    UPDATE payments SET status = 'expired'
                    WHERE status = 'pending' AND expires_at < NOW()
                    RETURNING id, subaddress
                `);
                if (result.rows.length > 0) {
                    for (const row of result.rows) {
                        walletRPCService.stopPaymentMonitoring(row.subaddress);
                        walletRPCService.addressToUser.delete(row.subaddress);
                        walletRPCService.addressToSocket.delete(row.subaddress);
                    }
                    console.log(`[PaymentExpiry] Expired ${result.rows.length} stale payment(s)`);
                }
            } catch (e) {
                console.error('[PaymentExpiry] Error:', e.message);
            }
        }, 5 * 60 * 1000);
        
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

// Graceful shutdown — clean up timers, wait for in-flight payouts, close DB pool
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // Stop accepting new connections
    http.close();

    // Stop scheduled timers
    if (batchPayoutInterval) clearInterval(batchPayoutInterval);
    if (paymentExpiryInterval) clearInterval(paymentExpiryInterval);
    if (gameModeManager._batchPayoutTimer) clearTimeout(gameModeManager._batchPayoutTimer);
    if (payoutRetryService) payoutRetryService.stop();
    if (alertService) alertService.stopPeriodicChecks?.();

    // Wait for in-flight batch processing to finish (up to 10 seconds)
    let waitMs = 0;
    while (gameModeManager._isBatchProcessing && waitMs < 10000) {
        await new Promise(r => setTimeout(r, 500));
        waitMs += 500;
    }
    if (waitMs > 0) {
        console.log(`  Waited ${waitMs}ms for in-flight payout processing`);
    }

    // Close database pool
    try {
        await databaseManager.close();
        console.log('  Database pool closed');
    } catch (err) {
        console.error('  Error closing database pool:', err.message);
    }

    console.log('Shutdown complete.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
