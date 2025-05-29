const express = require('express');
const path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var db = require('./db/dbcalls.js');

// Import modular components
const BroadcastManager = require('./network/broadcastManager');
const DebugManager = require('./debug/debugManager');
const SocketHandlers = require('./network/socketHandlers');

// Initialize modular components
const broadcastManager = new BroadcastManager(io);
const debugManager = new DebugManager(broadcastManager);
const activeGames = new Map(); // Maps socketId to Game objects
const socketHandlers = new SocketHandlers(io, activeGames, broadcastManager, debugManager);
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

// Initialize debug manager with new block callbacks
debugManager.onNewBlockCallback((blockHeight) => {
    // Start games for waiting players when new block detected
    socketHandlers.startGamesForWaiting(blockHeight);
    // Check active games for timeout
    socketHandlers.checkGamesTimeout(blockHeight);
});

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
        allUsers.forEach(user => {
            console.log(`  - User ID: ${user.id}, Socket: ${user.socketId}, Client: ${user.clientId}`);
        });
        console.log(`Active games: ${activeGames.size}`);
    }
}

// Regular debug logging
setInterval(debugRegisteredUsers, 10000);

// Start server
http.listen(3000, function() {
   console.log('🚀 Wowngeon server listening on *:3000');
   console.log(`🐛 Debug mode: ${debugManager.getDebugStatus().debugMode ? 'ENABLED' : 'DISABLED'}`);
});
