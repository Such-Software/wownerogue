const express = require('express');
const path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var db = require('./db/dbcalls.js');

// Load environment configuration
require('dotenv').config();

// Import payment system components
const DatabaseManager = require('./db/databaseManager');
const WalletRPCService = require('./payments/walletRPCService');
const GameModeManager = require('./game/gameModeManager');
const RpcService = require('./rpc/rpcService');

// Import modular components
const BroadcastManager = require('./network/broadcastManager');
const DebugManager = require('./debug/debugManager');
const SocketHandlers = require('./network/socketHandlers');

// Initialize modular components first
const broadcastManager = new BroadcastManager(io);
const debugManager = new DebugManager(broadcastManager);

// Initialize payment system components (debugManager is now available)
const databaseManager = new DatabaseManager();
const rpcService = new RpcService();
const walletRPCService = new WalletRPCService(debugManager);
const gameModeManager = new GameModeManager(databaseManager, walletRPCService, debugManager);

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
app.post('/api/payment/create', async (req, res) => {
  try {
    const { userId, gameMode } = req.body;
    if (!userId || !gameMode) {
      return res.status(400).json({ error: 'Missing userId or gameMode' });
    }

    const payment = await walletRPCService.createPaymentRequest(userId, gameMode);
    res.json(payment);
  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  try {
    const result = await walletRPCService.processCallback(req.body);
    res.json({ status: 'success', result });
  } catch (error) {
    console.error('Error processing callback:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payment/status/:paymentId', async (req, res) => {
  try {
    const status = await walletRPCService.checkPaymentStatus(req.params.paymentId);
    res.json(status);
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/:userId/credits', async (req, res) => {
  try {
    const credits = await gameModeManager.getUserCredits(req.params.userId);
    res.json({ credits });
  } catch (error) {
    console.error('Error getting user credits:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/game-modes', (req, res) => {
  res.json({
    FREE: { name: 'Free Play', cost: 0, payoutMultiplier: 0 },
    PAID_SINGLE: { 
      name: 'Paid Single Game', 
      cost: parseFloat(process.env.SINGLE_GAME_COST || '0.005'), 
      payoutMultiplier: { escape: 2, treasure: 3 }
    },
    PAID_CREDITS: { 
      name: 'Credits Package', 
      cost: parseFloat(process.env.CREDITS_PACKAGE_COST || '0.03'), 
      credits: parseInt(process.env.CREDITS_PER_PACKAGE || '10'),
      payoutMultiplier: 0
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

// Socket.io connection handler
io.on('connection', function(socket) {
    socketHandlers.handleConnection(socket);
});

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
        
        // Start HTTP server
        http.listen(3000, function() {
            console.log('🚀 Wowngeon server listening on *:3000');
            console.log(`🐛 Debug mode: ${debugManager.getDebugStatus().debugMode ? 'ENABLED' : 'DISABLED'}`);
            console.log(`💰 Payment system: ${paymentSystemReady ? 'ENABLED' : 'FREE MODE ONLY'}`);
            console.log(`🎮 Available game modes: ${paymentSystemReady ? 'FREE, PAID_SINGLE, PAID_CREDITS' : 'FREE ONLY'}`);
        });
        
        // Start batch payout processing if payment system is ready
        if (paymentSystemReady) {
            setInterval(async () => {
                try {
                    await walletRPCService.processBatchPayouts();
                } catch (error) {
                    console.error('Error in batch payout processing:', error);
                }
            }, 300000); // Every 5 minutes
        }
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
