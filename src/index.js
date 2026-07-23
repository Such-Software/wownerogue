// Load .env before reading any process setting (notably TRUST_PROXY). systemd's
// EnvironmentFile masked this ordering bug in production, while `npm run dev` did not.
require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createSocketOriginAllowRequest } = require('./network/socketOriginPolicy');
var app = express();
app.disable('x-powered-by');
// Trust the reverse proxy (for correct req.ip / X-Forwarded-For handling) only when
// explicitly enabled, so client IPs can't be spoofed in a direct-exposure deployment.
if (process.env.TRUST_PROXY === 'true') {
    // Trust only the configured number of closest proxy hops. `true` trusts every value in
    // X-Forwarded-For, allowing a client-supplied leftmost address to spoof req.ip. NPM is one
    // hop in the production topology; multi-proxy deployments must opt in explicitly.
    const trustedProxyHops = Math.max(1, Math.min(8, parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1));
    app.set('trust proxy', trustedProxyHops);
}
var http = require('http').Server(app);
var io = require('socket.io')(http, {
    allowRequest: createSocketOriginAllowRequest(process.env)
});

// Import payment system components
const DatabaseManager = require('./db/databaseManager');
const WalletRPCService = require('./payments/walletRPCService');
const PayoutRetryService = require('./payments/payoutRetryService');
const AlertService = require('./services/alertService');
const HealthService = require('./services/healthService');
const LatePaymentReconciler = require('./services/latePaymentReconciler');
const FinancialEventExporter = require('./services/financialEventExporter');
const GameModeManager = require('./game/gameModeManager');
const PaymentConfigManager = require('./config/paymentConfig');
const EnvironmentValidator = require('./config/environmentValidator');
const RuntimePolicy = require('./config/runtimePolicy');
const { loadReleaseIdentity } = require('./config/releaseIdentity');
const asyncHandler = require('./middleware/asyncHandler');
const createErrorMiddleware = require('./middleware/errorHandler');
const noStore = require('./middleware/noStore');
const { createCanaryDatabaseIdentityHandler } = require('./services/canaryDatabaseIdentity');
const { AppError, ValidationError, NotFoundError } = require('./utils/errors');
const money = require('./money/atomic');

// Import modular components
const BroadcastManager = require('./network/broadcastManager');
const DebugManager = require('./debug/debugManager');
const SocketHandlers = require('./network/socketHandlers');
const { verifyGame, verifyGameProof } = require('./game/provablyFair');
const { attachDungeonVerification } = require('./game/fairnessVerifier');
const { renderVerifyPage } = require('./views/verifyPage');
const { renderPrivacy, renderResponsiblePlay, renderTerms } = require('./views/legalPages');
const { buildCommerceDisclosure } = require('./config/commerceDisclosurePolicy');
const createAdminRoutes = require('./routes/admin');
const createAuthRoutes = require('./routes/auth');
const { createLeaderboardHandler } = require('./routes/leaderboard');
const { isSmirkEnabled } = require('./auth/smirkPolicy');

// Initialize payment configuration
const paymentConfigManager = new PaymentConfigManager({ logger: console });
const environmentValidator = new EnvironmentValidator({ logger: console });
let releaseIdentity;
try {
    releaseIdentity = loadReleaseIdentity();
    environmentValidator.assertValid(paymentConfigManager.getConfig());
} catch (error) {
    console.error(`❌ Startup aborted: ${error.message}`);
    process.exit(1);
}
process.env.GAME_MODE = paymentConfigManager.getLegacyGameMode();

// Initialize modular components first
const broadcastManager = new BroadcastManager(io);
const debugManager = new DebugManager(broadcastManager);
broadcastManager.setDebugManager(debugManager);

// Initialize payment system components (debugManager is now available)
const databaseManager = new DatabaseManager();
const db = databaseManager; // Alias for convenience in API endpoints
const financialEventExporter = new FinancialEventExporter({ db: databaseManager });
const walletRPCService = new WalletRPCService(debugManager, {
    minConfirmations: paymentConfigManager.getConfig().payouts.processing.confirmations
});
const gameModeManager = new GameModeManager(databaseManager, walletRPCService, debugManager, paymentConfigManager);
gameModeManager.releaseIdentity = releaseIdentity;
// Provide io reference so GameModeManager can emit events (e.g., credits_update)
gameModeManager.io = io;

// One effective payout gate used by every dispatcher. PAYOUTS_ENABLED is the master switch;
// per-mode flags cannot turn dispatch back on underneath it.
function isPayoutProcessingEnabled() {
    return RuntimePolicy.isPayoutProcessingEnabled(
      paymentConfigManager.getConfig(),
      gameModeManager,
      { settleAcceptedLiabilities: true }
    );
}

// Set only after startup has authenticated and probed the wallet. Every dispatch path also
// rechecks live health so a later outage cannot keep sending from a stale startup result.
let payoutDispatchReady = false;
// Readiness, paid admission, and every payout dispatcher stay closed until all durable startup
// recovery passes have completed without an unresolved financial row.
let financialRecoveryReady = false;
function isFinancialRecoveryReady() {
    return financialRecoveryReady
        && socketHandlers?.isFinancialRecoveryReady?.() === true;
}
function canDispatchPayouts() {
    return isFinancialRecoveryReady()
        && payoutDispatchReady
        && walletRPCService.getHealthStatus().healthy === true
        && isPayoutProcessingEnabled();
}
// Match/solo completion can request the manager's debounced dispatcher directly. Give that
// internal path the same startup, liveness, and operator-policy predicate as timers/retries.
gameModeManager.payoutDispatchAllowed = canDispatchPayouts;
// Invoice creation and paid solo entry consume value too; close both whenever startup or
// periodic liability reconciliation is incomplete. Explicit free play remains available.
gameModeManager.financialAdmissionAllowed = isFinancialRecoveryReady;
// Last-line guard shared by every wallet caller, including manual refunds and provider adapters.
// Dispatchers still check earlier so they do not claim durable rows while the gate is closed.
walletRPCService.transferAllowed = canDispatchPayouts;

// Initialize remaining components
const activeGames = new Map(); // Maps socketId to Game objects
let alertService = null; // Initialized later when payment system starts
let payoutRetryService = null; // Initialized later when payment system starts
let batchPayoutInterval = null; // Initialized later when payment system starts
let paymentExpiryInterval = null; // Initialized later when payment system starts
let latePaymentReconciler = null;
let walletHealthInterval = null; // Keeps readiness tied to a live wallet, not startup state
let databaseHealthInterval = null; // Detects a database outage after startup
const socketHandlers = new SocketHandlers(io, activeGames, broadcastManager, debugManager, gameModeManager, walletRPCService);
// Third-party renderer code executes with the same privileges as the game/payment UI. Keep CDN
// execution off by default; production operators must make the supply-chain tradeoff explicit.
const rendererCdnEnabled = /^true$/i.test(String(process.env.RENDERER_CDN_ENABLED || 'false'));
if (rendererCdnEnabled && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ RENDERER_CDN_ENABLED=true: third-party jsDelivr code is trusted by the production CSP');
}
// Security headers (defense in depth alongside output escaping).
// CSP locks down where scripts/styles/connections may come from. Inline scripts/styles
// are still permitted ('unsafe-inline') because the current pages rely on them heavily;
// removing that is tracked as Phase 4.4 (nonce-based CSP). connect-src 'self' covers
// same-origin Socket.IO websockets under CSP Level 3. blob: is limited to render-kit
// GLB texture decoding; GLTFLoader turns embedded textures into blob URLs.
app.use((req, res, next) => {
    const scriptSources = ["'self'", "'unsafe-inline'"];
    const connectSources = ["'self'", 'blob:', 'https://smirk.cash'];
    if (rendererCdnEnabled) {
        scriptSources.push('https://cdn.jsdelivr.net');
        connectSources.push('https://cdn.jsdelivr.net');
    }
    const csp = [
        "default-src 'self'",
        `script-src ${scriptSources.join(' ')}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src ${connectSources.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'self'",
        "form-action 'self'"
    ];
    if (process.env.NODE_ENV === 'production') csp.push('upgrade-insecure-requests');
    res.setHeader('Content-Security-Policy', csp.join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// These surfaces return bearer-authenticated account, payment, or operator data. Tell both
// browsers and reverse proxies never to retain a response, including errors.
app.use(['/api/user', '/api/auth', '/api/admin', '/api/payment'], noStore);

// Same-origin, non-secret browser policy. Loading this before renderModes.js prevents an optional
// renderer selection from even attempting a third-party fetch when CDN execution is disabled.
app.get('/runtime-config.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.type('application/javascript').send(
        `window.WOWNGEON_RUNTIME=Object.freeze({rendererCdnEnabled:${rendererCdnEnabled}});`
    );
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

function currentCommerceDisclosure() {
   return buildCommerceDisclosure(gameModeManager, process.env);
}

// These pages intentionally describe the active server instead of claiming every deployment has
// the same money rules. They are product disclosures, not a substitute for operator legal review.
app.get('/terms', function(req, res) {
   res.setHeader('Cache-Control', 'no-cache');
   res.type('html').send(renderTerms(currentCommerceDisclosure()));
});
app.get('/privacy', function(req, res) {
   res.setHeader('Cache-Control', 'no-cache');
   res.type('html').send(renderPrivacy(currentCommerceDisclosure()));
});
app.get('/responsible-play', function(req, res) {
   res.setHeader('Cache-Control', 'no-cache');
   res.type('html').send(renderResponsiblePlay(currentCommerceDisclosure()));
});

app.get('/api/disclosures', noStore, function(req, res) {
   res.json(currentCommerceDisclosure());
});

// This route is absent unless an isolated XMR stagenet canary opts in with a protected one-run
// nonce. It lets the financial harness bind the application process to the exact PostgreSQL
// database it independently audited before any value-bearing action.
const canaryDatabaseIdentityHandler = createCanaryDatabaseIdentityHandler({
   db: databaseManager,
   env: process.env
});
if (canaryDatabaseIdentityHandler) {
   app.get('/api/canary/database-identity', noStore,
      asyncHandler(canaryDatabaseIdentityHandler));
}

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

// =============================================================================
// /api/user/* protection (S1 / S2 / S3, contract C2)
// =============================================================================

// S3: simple in-memory IP rate limiter for the /api/user/* REST surface. Each of these
// endpoints hits the DB, so cap requests per IP over a short window. Best-effort only (the
// socket layer has its own limiter and nginx can add another); the map is pruned lazily so
// it can't grow unbounded.
const _userApiHits = new Map(); // ip -> { count, windowStart }
const USER_API_WINDOW_MS = 60 * 1000;
const USER_API_MAX = Number(process.env.USER_API_RATE_MAX) || 120;
function userApiRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let rec = _userApiHits.get(ip);
  if (!rec || (now - rec.windowStart) > USER_API_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
    _userApiHits.set(ip, rec);
  }
  rec.count += 1;
  if (_userApiHits.size > 5000) {
    for (const [k, v] of _userApiHits) {
      if ((now - v.windowStart) > USER_API_WINDOW_MS) _userApiHits.delete(k);
    }
  }
  if (rec.count > USER_API_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}
app.use('/api/user', userApiRateLimit);

// C2: session-ownership guard for /api/user/:socketId/*. The caller must present the session
// token (users.anon_token — emitted to the client as the 'session_token'/'session_resumed'
// event and stored as localStorage['wownerogue_token']) via the 'X-Session-Token' header.
// Tokens are never accepted in URLs because reverse proxies and browser history log them.
// We only proceed for the row whose socket_id AND anon_token both match, so
// one client can't read or mutate another player's payments/payouts/address. failStatus is
// 403 for mutations, 401 for reads.
function requireSessionOwnership(failStatus) {
  return async (req, res, next) => {
    try {
      const { socketId } = req.params;
      const token = req.get('X-Session-Token');
      if (!socketId || !token) {
        return res.status(failStatus).json({ error: 'Session token required' });
      }
      const result = await databaseManager.query(
        'SELECT id FROM users WHERE socket_id = $1 AND anon_token = $2',
        [socketId, token]
      );
      if (result.rows.length === 0) {
        return res.status(failStatus).json({ error: 'Session ownership verification failed' });
      }
      req.sessionUserId = result.rows[0].id;
      next();
    } catch (err) {
      console.error('[requireSessionOwnership] verification error:', err.message);
      return res.status(failStatus).json({ error: 'Session verification failed' });
    }
  };
}

app.get('/api/user/:socketId/credits', requireSessionOwnership(401), asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    // C1: read-only route — never mint a user row for a stranger's socketId.
    const user = await gameModeManager.getOrCreateUser(socketId, { create: false });
    if (!user) {
      return res.json({});
    }
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

app.get('/api/user/:socketId/mode', requireSessionOwnership(401), asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    // C1: read-only route — do not create a user row here.
    const user = await gameModeManager.getOrCreateUser(socketId, { create: false });
    if (!user) {
      return res.json({});
    }
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

app.post('/api/user/:socketId/address', requireSessionOwnership(403), asyncHandler(async (req, res) => {
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

  try {
    // Keep REST and Socket.IO on the same network-aware validation path. AddressManager checks
    // XMR prefixes for mainnet/stagenet/testnet, then asks wallet-rpc to verify checksum/nettype
    // before persistence.
    const success = await socketHandlers.addressManager.saveAddress(socketId, address, { autoConfirm: true });
    if (!success) {
      throw new AppError('Failed to save address', {
        statusCode: 400,
        safeMessage: 'That address is not valid for this server network.'
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

function publicHealthSnapshot() {
  const walletHealth = walletRPCService.getHealthStatus();
  const health = HealthService.buildPublicHealth({
    databaseReady: databaseManager.isHealthy(),
    blockHeight: debugManager.getCurrentBlockHeight(),
    simulatedBlocks: debugManager.SIMULATED_BLOCKS,
    chainHealthy: debugManager.isChainHealthy?.(),
    blockSource: process.env.BLOCK_SOURCE || (debugManager.SIMULATED_BLOCKS ? 'simulated' : 'daemon'),
    network: process.env.MONERO_NETWORK || 'mainnet',
    paymentsEnabled: gameModeManager.paymentsEnabled,
    payoutsEnabled: isPayoutProcessingEnabled(),
    walletHealthy: walletHealth.healthy,
    identityRequired: process.env.NODE_ENV === 'production',
    daemonIdentity: debugManager.getChainIdentity(),
    walletIdentity: walletHealth.identity,
    financialRecoveryReady: isFinancialRecoveryReady(),
    activeGames: activeGames.size,
    queuedGames: socketHandlers?.queueManager?.getQueueLength?.() || 0,
    connectedPlayers: io.sockets.sockets.size || 0,
    gameMode: gameModeManager.gameMode,
    releaseIdentity,
    uptime: process.uptime()
  });
  // Informational only: an optional accounting sink must not make gameplay readiness fail.
  // The exporter exposes a deliberately sanitized view with no endpoint/token/error/event data.
  health.financialEvents = financialEventExporter.getPublicHealth();
  return health;
}

// Public probes intentionally omit balances, RPC addresses, secrets, memory details, and abuse
// thresholds. Those remain available through the authenticated admin stats endpoints.
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicHealthSnapshot());
});

app.get('/health/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/health/ready', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const health = publicHealthSnapshot();
  res.status(health.ready ? 200 : 503).json(health);
});

// Get payment options for a user (mixed mode support)
app.get('/api/user/:socketId/payment-options', requireSessionOwnership(401), asyncHandler(async (req, res) => {
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
app.get('/api/user/:socketId/payments', requireSessionOwnership(401), asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    // C1: read-only route — do not create a user row here.
    const user = await gameModeManager.getOrCreateUser(socketId, { create: false });
    if (!user) {
      return res.json({ payments: [], total: 0, totalPaid: 0, limit, offset });
    }
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
    
    const totalPaid = money.toSafe(money.toBig(countResult.rows[0].total_paid || 0));
    
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
app.get('/api/user/:socketId/payouts', requireSessionOwnership(401), asyncHandler(async (req, res) => {
  const { socketId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  if (!socketId) {
    throw new ValidationError('Missing socketId', {
      safeMessage: 'socketId parameter is required.'
    });
  }

  try {
    // C1: read-only route — do not create a user row here.
    const user = await gameModeManager.getOrCreateUser(socketId, { create: false });
    if (!user) {
      return res.json({ payouts: [], total: 0, totalReceived: 0, limit, offset });
    }
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
      totalReceived: money.toSafe(money.toBig(totalResult.rows[0].total_received || 0)),
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
const smirkEnabled = isSmirkEnabled(process.env);
if (smirkEnabled) {
  app.use(createAuthRoutes({
    db: databaseManager,
    sessionManager: socketHandlers.sessionManager
  }));
}


// =============================================================================
// Admin API Endpoints (see src/routes/admin.js) — DI ctx; alertService is set later
// =============================================================================
const adminRouteCtx = {
  db,
  gameModeManager,
  walletRPCService,
  socketHandlers,
  io,
  alertService: null,
  canDispatchPayouts
};
app.use(createAdminRoutes(adminRouteCtx));

// =============================================================================
// LEADERBOARD
// =============================================================================
app.get('/api/leaderboard', asyncHandler(createLeaderboardHandler({
  db,
  getOperatedProductProfileId: () => currentCommerceDisclosure().operatedProduct?.id || null
})));

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
    // Keep the aggregate exact across PostgreSQL BIGINT -> JSON. It is a decimal string in
    // whole currency units; browsers can display/coerce it without losing server-side units.
    totalPaidOut = money.format(payouts.rows[0]?.total || 0, decimals);
  } catch (e) {
    // Best-effort; serve whatever we have rather than 500 on a public widget.
  }

  const data = {
    gamesToday,
    escapesToday,
    totalPaidOut,
    currencyLabel,
    // Paid out is only meaningful where payouts are enabled (stagenet / payout instances).
    payoutsEnabled: isPayoutProcessingEnabled()
  };
  _statsCache = { at: now, data };
  res.json({ ...data, online });
}));

app.get('/api/game-modes', (req, res) => {
  const config = paymentConfigManager.getConfig();
  const disclosure = currentCommerceDisclosure();
  const publicModeInfo = gameModeManager.getGameModeInfo();
  const decimals = Number(config.currency?.decimals ?? 12);
  const toDisplay = (value) => {
    if (value === null || value === undefined) {
      return 0;
    }
    try {
      return money.format(value, decimals);
    } catch (_) {
      return 0;
    }
  };

  const directMode = config.modes.direct;
  const creditsMode = config.modes.credits;

  // Include hosted by info if configured
  let hostedBy = null;
  if (process.env.HOSTED_BY) {
    try {
      const hostedUrl = new URL(process.env.HOSTED_BY);
      if (hostedUrl.protocol === 'https:' || hostedUrl.protocol === 'http:') {
        hostedBy = {
          url: hostedUrl.href,
          name: process.env.HOSTED_BY_NAME || hostedUrl.hostname
        };
      }
    } catch (_) {
      // Environment validation reports malformed production values. Never reflect an unsafe URL.
    }
  }

  res.json({
    operatedProductProfileId: disclosure.operatedProduct?.id || null,
    cryptoMatchPayoutsEnabled: disclosure.service.cryptoMatchPayoutsEnabled,
    soloEnabled: publicModeInfo.modes?.solo === true,
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
      payoutMultiplier: (isPayoutProcessingEnabled() && directMode.enabled && config.payouts.rules.direct.enabled)
        ? gameModeManager.getImplementedPayoutMultipliersForMode('PAID_SINGLE')
        : 0
    },
    PAID_CREDITS: {
      name: 'Credits Package',
      cost: toDisplay(creditsMode.packages?.[0]?.price ?? 0),
      credits: creditsMode.packages?.[0]?.credits ?? creditsMode.creditsPerGame,
      enabled: !!creditsMode.enabled,
      payoutMultiplier: isPayoutProcessingEnabled() && creditsMode.enabled && config.payouts.rules.credits.enabled
        ? gameModeManager.getImplementedPayoutMultipliersForMode('PAID_CREDITS')
        : 0
    },
    match: {
      enabled: publicModeInfo.modes?.match?.enabled === true,
      economies: publicModeInfo.modes?.match?.economies || {}
    },
    rendererCdnEnabled,
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
      `SELECT dungeon_seed, status, treasure_found, moves_made, duration_seconds, created_at,
              completed_at, proof_version, fairness_offer_id, fairness_offer_issued_at,
              proof_commitment, client_seed, effective_seed, layout_fingerprint,
              layout_fingerprints, generator_version, proof_context,
              CASE WHEN completed_at IS NOT NULL THEN server_seed ELSE NULL END AS server_seed
       FROM games WHERE dungeon_seed = $1`,
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

// Authoritative one-click verification by game UUID. Active games never reveal serverSeed.
app.get('/api/verify/:gameId', asyncHandler(async (req, res) => {
  const proofResult = await databaseManager.query(
    `SELECT dungeon_seed, status, completed_at, proof_version, fairness_offer_id,
            fairness_offer_issued_at, proof_commitment, server_seed, client_seed,
            effective_seed, layout_fingerprint, layout_fingerprints,
            generator_version, proof_context
     FROM games WHERE dungeon_seed = $1 LIMIT 1`,
    [req.params.gameId]
  );
  const record = proofResult.rows[0];
  if (!record) throw new NotFoundError('Game proof not found', { safeMessage: 'Game proof not found.' });
  if (!record.completed_at) {
    return res.status(409).json({ valid: false, error: 'Proof is revealed only after the game ends.' });
  }
  if (!record.server_seed || !record.proof_commitment || !record.effective_seed) {
    return res.status(422).json({ valid: false, error: 'This legacy game does not have a complete v2 proof.' });
  }

  const result = verifyGameProof({
    serverSeed: record.server_seed.trim(),
    clientSeed: record.client_seed || '',
    effectiveSeed: record.effective_seed.trim(),
    commitment: record.proof_commitment.trim()
  });
  attachDungeonVerification(result, {
    effectiveSeed: record.effective_seed.trim(),
    proofContext: record.proof_context,
    expectedFingerprint: record.layout_fingerprint?.trim(),
    expectedFingerprints: record.layout_fingerprints,
    generatorVersion: record.generator_version
  });
  result.gameId = record.dungeon_seed;
  result.proofVersion = record.proof_version;
  result.offerId = record.fairness_offer_id;
  result.offerIssuedAt = record.fairness_offer_issued_at;
  res.json(result);
}));

// API endpoint for programmatic verification
app.get('/api/verify', (req, res) => {
  const { seed, serverSeed, clientSeed, effectiveSeed, commitment } = req.query;

  // V2: verify the server's precommit AND the client-derived effective dungeon seed.
  if (serverSeed || effectiveSeed || clientSeed !== undefined) {
    if (!serverSeed || !effectiveSeed || !commitment) {
      return res.status(400).json({
        valid: false,
        error: 'Missing required parameters: serverSeed, effectiveSeed, and commitment'
      });
    }
    return res.json(verifyGameProof({ serverSeed, clientSeed: clientSeed || '', effectiveSeed, commitment }));
  }
  
  if (!seed || !commitment) {
    return res.status(400).json({
      valid: false,
      error: 'Missing required parameters: seed and commitment'
    });
  }
  
  const result = verifyGame(seed, commitment);

  // Legacy v1 path: when the seed matches the commitment, regenerate the
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
    // Flush pending payouts only when the master switch and at least one per-mode policy are on.
    if (canDispatchPayouts()) {
        gameModeManager._processPendingPayouts().catch(err => {
            console.error('❌ Block-triggered payout processing error:', err.message);
        });
    }
});

// Initialize payment system
async function initializePaymentSystem() {
    try {
        const production = process.env.NODE_ENV === 'production';
        let paymentsRequested = Boolean(paymentConfigManager.getConfig().paymentsEnabled);
        const walletRequired = RuntimePolicy.isWalletRequired(
            paymentConfigManager.getConfig(),
            gameModeManager,
            { settleAcceptedLiabilities: true }
        );
        let walletReady = false;

        if (walletRequired) {
            console.log('🔧 Initializing authenticated wallet boundary...');
            walletReady = Boolean(await walletRPCService.initialize());
            if (!walletReady) {
                if (production) {
                    throw new Error('Wallet RPC is unavailable while payment intake or payout settlement is enabled.');
                }
                if (paymentsRequested) {
                    console.log('⚠️ Wallet RPC not available - falling back to FREE mode');
                    process.env.GAME_MODE = 'FREE';
                    paymentConfigManager.refresh();
                    gameModeManager.setLegacyGameMode('FREE');
                    gameModeManager.paymentsEnabled = false;
                    gameModeManager.directModeEnabled = false;
                    gameModeManager.creditsModeEnabled = false;
                    paymentsRequested = false;
                } else {
                    console.log('⚠️ Wallet RPC not available - payout-only settlement remains stopped');
                }
            }
            // A successful startup probe is not permanent health. Refresh the wallet liveness
            // bit in the background so /health/ready turns degraded after an RPC outage.
            let walletProbeRunning = false;
            const requestedWalletProbeMs = Number(process.env.WALLET_HEALTH_INTERVAL_MS);
            const walletProbeMs = Math.max(1000, Math.min(
                Number.isFinite(requestedWalletProbeMs) && requestedWalletProbeMs > 0
                    ? requestedWalletProbeMs
                    : 10000,
                Math.max(1000, Math.floor(walletRPCService.identityMaxAgeMs / 2))
            ));
            walletHealthInterval = setInterval(async () => {
                if (walletProbeRunning) return;
                walletProbeRunning = true;
                try {
                    // A transport-only get_version response must never revive readiness. Recheck
                    // the wallet's validated chain/nettype identity on every liveness probe.
                    await walletRPCService.ensureNetworkIdentity({ force: true });
                } catch (_) {
                    // ensureNetworkIdentity records isHealthy=false; readiness is fail-closed.
                } finally {
                    walletProbeRunning = false;
                }
            }, walletProbeMs);
            walletHealthInterval.unref?.();
        } else {
            console.log('ℹ️ Payments disabled; wallet RPC initialization skipped.');
        }
        
        // Initialize database connection and run migrations
        await databaseManager.initialize();
        if (!databaseManager.isConnected()) {
            throw new Error('PostgreSQL is unavailable.');
        }
        console.log('✅ Database initialized successfully');
        databaseHealthInterval = setInterval(() => {
            databaseManager.healthCheck().catch?.(() => {});
        }, Number(process.env.DB_HEALTH_INTERVAL_MS) || 15000);
        databaseHealthInterval.unref?.();
        
        // Probe the exact RpcService instance that drives block callbacks. A second independent
        // client could pass startup while the polling instance points at the wrong chain.
        const rpcHealth = debugManager.SIMULATED_BLOCKS
            ? { healthy: true, identity: debugManager.getChainIdentity() }
            : await debugManager.rpcService.healthCheck();
        if (production && (!rpcHealth.healthy || rpcHealth.identity?.verified !== true)) {
            throw new Error('No configured blockchain daemon RPC has the expected chain/network identity.');
        }
        console.log(`${rpcHealth.healthy ? '✅' : '⚠️'} RPC Service: ${rpcHealth.healthy ? 'Connected' : 'Unavailable'}`);
        
        const paymentSystemReady = paymentsRequested && walletReady;
        console.log(paymentSystemReady ? '🚀 Payment system ready!' : '🚀 Free-play services ready!');
        return { paymentSystemReady, paymentsRequested, walletRequired, walletReady };
    } catch (error) {
        console.error('❌ Failed to initialize payment system:', error?.message || String(error));
        if (process.env.NODE_ENV === 'production') {
            throw error;
        }
        console.log('⚠️  Server will continue in FREE mode only');
        return {
            paymentSystemReady: false,
            paymentsRequested: false,
            walletRequired: false,
            walletReady: false
        };
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
        const financialRuntime = await initializePaymentSystem();
        const { paymentSystemReady } = financialRuntime;

        // No listener or paid dispatcher is enabled until every due financial row has been
        // reconciled. Recovery is idempotent and throws FINANCIAL_RECOVERY_INCOMPLETE with a
        // sanitized unresolved-row summary on either a scan or per-row failure.
        const sm = socketHandlers.sessionManager;
        if (!sm || typeof sm.recoverOrphanedGames !== 'function') {
            throw new Error('Orphaned solo-game financial recovery is unavailable.');
        }
        // A graceful predecessor may have frozen exact nonterminal solo runtime state. Rebuild
        // those games into the reconnect cache before orphan recovery scans active rows; invalid
        // or drifted snapshots abort startup before a listener or financial dispatcher exists.
        const restartRestore = await socketHandlers.rehydrateSoloRestartSnapshots();
        if (restartRestore.restored > 0) {
            console.log(`🔄 Rehydrated ${restartRestore.restored} durable solo restart snapshot(s)`);
        }
        await sm.recoverOrphanedGames();

        // Match queue recovery and payout-liability reconciliation require the migrations that
        // initializePaymentSystem() just applied. Await them before accepting any sockets.
        await socketHandlers.initializeMatchMode();
        financialRecoveryReady = true;
        payoutDispatchReady = financialRuntime.walletReady && isPayoutProcessingEnabled();
        financialEventExporter.start();

        // Socket.io connection handler - ONLY after payment system is ready
        io.on('connection', function(socket) {
            socketHandlers.handleConnection(socket);
        });
        
        // Start HTTP server.
        // Bind all interfaces by default: the reverse proxy (Nginx Proxy Manager) is off-host /
        // containerized and reaches this app over a non-loopback address, so a loopback-only bind
        // makes the public site 502. Operators whose proxy runs on THIS host can set HOST=127.0.0.1.
        // The real "don't expose :3000" hardening is a firewall rule limiting the port to the
        // proxy's source, not the bind address; and X-Forwarded-For is already validated (rightmost
        // hop) so a direct hit can't spoof the client IP.
        const PORT = process.env.PORT || 3000;
        const HOST = process.env.HOST || '0.0.0.0';
        http.listen(PORT, HOST, function() {
            console.log(`🚀 Wownerogue server listening on ${HOST}:${PORT}`);
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
        
        // Payout dispatch/retry is intentionally independent from payment intake. A prestige
        // instance may accept paid credits while PAYOUTS_ENABLED=false and must never start a
        // worker capable of sending old queued rows.
        if (canDispatchPayouts()) {
            const payoutConfig = paymentConfigManager.getConfig().payouts?.processing || {};
            const payoutIntervalSeconds = Math.max(1, Number(payoutConfig.batchInterval || 300));
            const payoutIntervalMs = payoutIntervalSeconds * 1000;
            batchPayoutInterval = setInterval(async () => {
                try {
                    await gameModeManager._processPendingPayouts();
                } catch (error) {
                    console.error('Error in batch payout processing:', error?.message || String(error));
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
                alertService, // Pass alert service for failure notifications
                isEnabled: canDispatchPayouts
            });
            payoutRetryService.start();

            // Start periodic alert checks (every 5 minutes)
            alertService.startPeriodicChecks(300000);
        }

        // Reconcile transfers that mined just after invoice expiry into durable manual review.
        // This worker never confirms an invoice or grants an entitlement.
        if (financialRuntime.walletReady) {
            latePaymentReconciler = new LatePaymentReconciler({
                db: databaseManager,
                gameModeManager,
                walletService: walletRPCService,
                lookbackHours: process.env.LATE_PAYMENT_RECONCILE_HOURS,
                batchSize: process.env.LATE_PAYMENT_RECONCILE_BATCH
            });
            latePaymentReconciler.runOnce().catch(error => {
                console.error('[LatePayment] Startup reconciliation error:', error.message);
            });
        }

        // Periodic job: reconcile, then expire old pending payments (every 5 minutes).
        paymentExpiryInterval = setInterval(async () => {
            try {
                if (latePaymentReconciler) await latePaymentReconciler.runOnce();
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
let shutdownStarted = false;
async function gracefulShutdown(signal, exitCode = 0) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    payoutDispatchReady = false;
    // Freeze solo input first. Any game-over callback already executing has synchronously
    // installed its settlement intent; no new terminal result can appear after the drain sees an
    // empty map.
    socketHandlers?.beginShutdown?.();
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // A broken dependency must not leave a corrupt process hanging forever. systemd will
    // restart the service after this bounded drain window.
    const forcedExit = setTimeout(() => {
        console.error('Graceful shutdown timed out; forcing process exit.');
        process.exit(exitCode || 1);
    }, 15000);
    forcedExit.unref?.();

    // Stop accepting new connections
    http.close();

    // Stop scheduled timers
    if (batchPayoutInterval) clearInterval(batchPayoutInterval);
    if (paymentExpiryInterval) clearInterval(paymentExpiryInterval);
    if (walletHealthInterval) clearInterval(walletHealthInterval);
    if (databaseHealthInterval) clearInterval(databaseHealthInterval);
    financialEventExporter.stop();

    // Work that crossed the synchronous shutdown gate may still be completing a game start or a
    // sequential block-timeout pass. Drain every such producer before GameManager snapshots its
    // terminal settlement set; otherwise a paused timeout pass could add a later result behind it.
    if (socketHandlers?.drainShutdownProducers) {
        await socketHandlers.drainShutdownProducers();
    }

    // Terminal solo games are held in a serialized settlement-pending state when their atomic
    // completion transaction fails. Drain those retries before disabling GameModeManager or
    // closing PostgreSQL so a normal deploy/restart cannot turn a known result into an orphan.
    if (socketHandlers?.gameManager?.shutdown) {
        const soloDrain = await socketHandlers.gameManager.shutdown({ timeoutMs: 4000 });
        if (soloDrain.pending > 0) {
            console.error(`  ${soloDrain.pending} solo settlement(s) remain unresolved after shutdown drain`);
            const error = new Error('Refusing graceful restart with unresolved solo settlements');
            error.code = 'SOLO_SETTLEMENT_DRAIN_INCOMPLETE';
            throw error;
        } else if (soloDrain.initial > 0) {
            console.log(`  Settled ${soloDrain.settled} terminal solo game(s) during shutdown drain`);
        }
    }

    // Only controlled termination signals may serialize live runtime objects. After an uncaught
    // exception/rejection process state is not trustworthy; startup's orphan recovery remains the
    // explicit economic fallback for those crash paths.
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
        const restartSnapshots = await socketHandlers.persistSoloRestartSnapshots();
        if (restartSnapshots.captured > 0) {
            console.log(`  Persisted ${restartSnapshots.captured} active solo game(s) for restart`);
        }
    }
    // Snapshot ownership is now durable. Close Socket.IO transports so no existing connection
    // survives into DB teardown; disconnect cleanup may adjust in-memory maps but cannot erase the
    // PostgreSQL restart snapshots.
    await new Promise((resolve) => io.close(() => resolve()));
    gameModeManager.shutdown();
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
    clearTimeout(forcedExit);
    process.exit(exitCode);
}

// Last-resort process guards. After an uncaught exception, Node process state is not trustworthy.
// Payout claims are durable/ambiguous-safe, so drain briefly and let the service manager restart.
process.on('uncaughtException', (err) => {
    console.error('❌ uncaughtException (fatal):', err && err.stack ? err.stack : err);
    try {
        alertService?.sendAlert?.('process_uncaught_exception', {
            subject: 'uncaughtException (server restarting)',
            body: String(err && err.stack ? err.stack : err),
            level: 'error'
        })?.catch?.(() => {});
    } catch (_) {}
    gracefulShutdown('uncaughtException', 1).catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ unhandledRejection (fatal):', reason && reason.stack ? reason.stack : reason);
    try {
        alertService?.sendAlert?.('process_unhandled_rejection', {
            subject: 'unhandledRejection (server restarting)',
            body: String(reason && reason.stack ? reason.stack : reason),
            level: 'error'
        })?.catch?.(() => {});
    } catch (_) {}
    gracefulShutdown('unhandledRejection', 1).catch(() => process.exit(1));
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0).catch((error) => {
    console.error('Graceful SIGTERM failed:', error?.message || error);
    process.exit(1);
}));
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0).catch((error) => {
    console.error('Graceful SIGINT failed:', error?.message || error);
    process.exit(1);
}));
