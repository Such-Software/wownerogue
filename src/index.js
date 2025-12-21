const express = require('express');
const path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);

// Load environment configuration
require('dotenv').config();

// Import payment system components
const DatabaseManager = require('./db/databaseManager');
const WalletRPCService = require('./payments/walletRPCService');
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

// Initialize payment configuration
const paymentConfigManager = new PaymentConfigManager({ logger: console });
const environmentValidator = new EnvironmentValidator({ logger: console });
environmentValidator.validate(paymentConfigManager.getConfig());
process.env.GAME_MODE = paymentConfigManager.getLegacyGameMode();

// Initialize modular components first
const broadcastManager = new BroadcastManager(io);
const debugManager = new DebugManager(broadcastManager);

// Initialize payment system components (debugManager is now available)
const databaseManager = new DatabaseManager();
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

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
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
    }
  });
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
