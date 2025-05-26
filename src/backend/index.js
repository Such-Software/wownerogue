const express = require('express');
const path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var rpc = require('./rpccalls.js');
var db = require('./dbcalls.js');
var user = require('./user');

// Function to get a user by socket ID
// Enhance the getUserBySocket function to try both IDs

function getUserBySocket(socketId) {
    console.log(`Looking up user with socketId: ${socketId}`);
    
    // Try direct lookup first
    let foundUser = user.getUserBySocketId(socketId);
    
    // If not found but we have a socket map, try the mapped ID
    if (!foundUser && clientSocketMap.has(socketId)) {
        const mappedId = clientSocketMap.get(socketId);
        console.log(`Socket ID ${socketId} not found directly, trying mapped ID: ${mappedId}`);
        foundUser = user.getUserBySocketId(mappedId);
    }
    
    console.log(`User lookup result for ${socketId}: ${foundUser ? "FOUND" : "NOT FOUND"}`);
    return foundUser;
}

const Game = require('./game');
const activeGames = new Map(); // Maps socketId to Game objects
const playerMoveTimestamps = new Map(); // Track last move time per player
const MOVE_COOLDOWN = 100; // Minimum 100ms between moves on server side

/**
 * Create a new game for a user and register it in activeGames
 * @param {User} user - The user object
 * @param {string} gameType - 'standard' or 'legacy'
 * @param {object} options - Additional game options
 */
function createGameForUser(user, gameType = 'standard', options = {}) {
    let game;
    
    if (gameType === 'legacy') {
        game = Game.createLegacyGame(user.id, user, options);
    } else {
        game = Game.createStandardGame(user.id, user, options);
    }
    
    // Register the game with the user and in activeGames
    user.joinGame(game);
    activeGames.set(user.id, game);
    
    console.log(`[createGameForUser] Created ${gameType} game ${game.id} for user ${user.id}`);
    return game;
}
let lastBlockHeight = 0; // Track last block height
const MIN_FEE = 10; // Minimum entrance fee in WOW
const MAX_FEE = 100; // Maximum entrance fee in WOW
const WAITING_PLAYERS = []; // Players waiting for the next block
const DEBUG_MODE = true; // Set to false to disable debug mode
let debugBlockHeight = 1;
const clientSocketMap = new Map(); // To track client-to-server socket ID mappings

// Use absolute path to html directory to ensure static files are served correctly
const htmlPath = path.join(__dirname, '../../html');
app.use(express.static(htmlPath));
app.get('/', function(req, res) {
   res.sendFile('index.html', { root: htmlPath });
});

// Replace your existing block check interval with this conditional version
if (DEBUG_MODE) {
  console.log("🐛 DEBUG MODE ENABLED - Simulating blocks every 30 seconds");
  
  // Initial debug block broadcast
  broadcastBlockHeight(debugBlockHeight);
  
  // Debug block height simulator - advances every 30 seconds
  setInterval(function() {
    debugBlockHeight++;
    console.log(`🐛 DEBUG: New simulated block: ${debugBlockHeight}`);
    broadcastBlockHeight(debugBlockHeight);
    
    // Start games for waiting players
    startGamesForWaiting(debugBlockHeight);
    
    // Check active games for timeout
    checkGamesTimeout(debugBlockHeight);
    
  }, 30000); // Every 30 seconds
  
  // Regular status broadcasting - sends current block height every 5 seconds
  // This ensures all clients stay up-to-date even if they miss a block change
  setInterval(function() {
    broadcastBlockHeight(debugBlockHeight);
  }, 5000); // Every 5 seconds
  
} else {
  // Your original block check code
  setInterval(function() {
    rpc.daemonCall("get_block_count", "", function(result) {
      const currentHeight = result.result.count;
      rpc.lastBlock.setHeight(currentHeight);
      
      // If new block found
      if (currentHeight > lastBlockHeight) {
        console.log(`New block found: ${currentHeight}`);
        io.emit('blockheight', currentHeight);
        
        // Start games for waiting players
        startGamesForWaiting(currentHeight);
        
        // Check active games for timeout
        checkGamesTimeout(currentHeight);
        
        lastBlockHeight = currentHeight;
      } else {
        io.emit('blockheight', currentHeight);
      }
    });
  }, 5000);
}

// Start games for waiting players (QUEUE ENTRY METHOD)
function startGamesForWaiting(blockHeight) {
    console.log(`Starting games for ${WAITING_PLAYERS.length} waiting players at block height ${blockHeight}`);
  
    while (WAITING_PLAYERS.length > 0) {
        const playerEntry = WAITING_PLAYERS.shift();
        const serverId = playerEntry.serverId;
        
        console.log(`Processing player: server=${serverId}`);
        
        const currentUser = getUserBySocket(serverId);
        
        if (currentUser) {
            // For queue entry, player gets 3 blocks starting from their entry block
            currentUser.blockRec = blockHeight;
            console.log(`🕒 QUEUE ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
            
            try {
                const game = createGameForUser(currentUser, 'standard');
                
                const gameState = game.getState();
                gameState.blockHeight = blockHeight;
                
                console.log(`🎮 SENDING GAME_START to ${serverId}`);
                
                // Send ONLY ONE message - the game state itself
                io.to(serverId).emit('game_start', gameState);
                
                console.log(`Game started for player ${serverId}`);
            } catch (error) {
                console.error(`Error creating game:`, error);
                io.to(serverId).emit('message', 'Error starting game: ' + error.message);
            }
        } else {
            console.error(`User not found for socket ${serverId}`);
            io.to(serverId).emit('message', 'Error: User not found');
        }
    }
}

// Check if any active games have timed out
function checkGamesTimeout(currentHeight) {
  activeGames.forEach((game, socketId) => {
    const user = getUserBySocket(socketId);
    
    // Players die the block after they enter
    // If they entered on block 1, they die when block 2 starts
    // If they entered on block 2, they die when block 3 starts
    if (user && user.blockRec && currentHeight > user.blockRec) {
      console.log(`💀 GAME TIMEOUT for player ${socketId}: entered on block ${user.blockRec}, died on block ${currentHeight}`);
      
      // Game has timed out - player didn't escape in time
      game.gameState = 'lost';
      io.to(socketId).emit('game_over', {
        status: 'lost',
        reason: 'timeout',
        message: 'You didn\'t escape before the block time limit!'
      });
      
      activeGames.delete(socketId);
    }
  });
}

// ====== SOCKET EVENT BROADCASTING HELPERS ======
// These functions abstract the broadcasting logic to support future features like spectating

/**
 * Send game state update to player and any spectators
 * @param {string} playerSocketId - The socket ID of the player
 * @param {object} gameState - The game state to broadcast
 */
function sendGameUpdate(playerSocketId, gameState) {
    // Debug logging for lighting data in updates
    console.log(`📡 sendGameUpdate to ${playerSocketId}:`);
    console.log(`  - Lighting data: ${!!gameState.lighting} (${gameState.lighting ? Object.keys(gameState.lighting).length : 0} rows)`);
    console.log(`  - Torch data: ${!!gameState.torches} (${gameState.torches ? gameState.torches.length : 0} torches)`);
    
    // Send to the player
    io.to(playerSocketId).emit('game_update', gameState);
    
    // TODO: Future spectator support
    // Get list of spectators for this game and broadcast to them too
    // const spectators = getSpectatorsForPlayer(playerSocketId);
    // spectators.forEach(spectatorId => {
    //     io.to(spectatorId).emit('spectator_update', {
    //         playerSocketId: playerSocketId,
    //         gameState: gameState
    //     });
    // });
}

/**
 * Broadcast block height to all connected clients
 * @param {number} blockHeight - Current block height
 */
function broadcastBlockHeight(blockHeight) {
    console.log(`📡 Broadcasting block height ${blockHeight} to all clients`);
    io.emit('blockheight', blockHeight);
}

/**
 * Send status update to a specific player
 * @param {string} socketId - The socket ID of the player
 * @param {string} type - Type of status (info, error, warning, etc.)
 * @param {string} message - The status message
 */
function sendStatusUpdate(socketId, type, message) {
    io.to(socketId).emit('status_update', {
        type: type,
        message: message,
        timestamp: Date.now()
    });
}

// Socket.io handlers
io.on('connection', function(socket) {
  console.log('A user connected');
  console.log(socket.client.id);
  console.log(socket.handshake.address);
  
  // Create and register user (automatically stored in registry)
  new user.User(socket.id, socket.handshake.address);
  // Also store socket.client.id as an attribute
  const newUser = getUserBySocket(socket.id);
  if (newUser) {
      newUser.clientId = socket.client.id;
      console.log(`User created with both socket.id (${socket.id}) and socket.client.id (${socket.client.id})`);
  }
  
  // Insert into visitors DB
  db.insertVisitor(socket.client.id, socket.handshake.address, 0);
  
  // Send welcome message and immediate status
  io.to(socket.client.id).emit('welcome', socket.client.id);
  
  // Send current block height immediately to new connections
  const currentBlock = DEBUG_MODE ? debugBlockHeight : lastBlockHeight;
  console.log(`📈 Sending current block height ${currentBlock} to new connection ${socket.id}`);
  io.to(socket.id).emit('blockheight', currentBlock);
  
  // Send connection status update (player-specific)
  sendStatusUpdate(socket.id, 'connection', 'Connected to Wowngeon server');

  socket.on('chat message', function(msg) {
    console.log('Message received:', msg);
    
    // Handle game commands (player-specific responses)
    if (msg.toLowerCase() == 'hello') {
      // Send status update to this player only
      sendStatusUpdate(socket.id, 'help', 
        'Welcome, to enter the dungeon type Enter, and you will be given a Wownero address, ' +
        'which you must send between 10-100 WOW to enter. The more you send, the more you can win.');
      return; // Don't broadcast commands as chat
    }
    
    // Handle game entry commands
    if (msg.toLowerCase() == 'enter') {
        console.log(`Player ${socket.id} requested to enter the dungeon - STARTING IMMEDIATELY`);
        
        // Use the updated user lookup function
        const currentUser = getUserBySocket(socket.id);
        
        if (currentUser) {
            console.log(`Found user for socket ${socket.id}, starting game immediately...`);
            
            // Start game immediately for faster testing
            try {
                // For auto-entry in debug mode, player enters on current block
                // They will die when the next block starts
                const currentBlock = debugBlockHeight || lastBlockHeight || 1;
                currentUser.blockRec = currentBlock; // Player enters on current block
                console.log(`🕒 AUTO-ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
                
                const game = createGameForUser(currentUser, 'standard');
                
                const gameState = game.getState();
                gameState.blockHeight = currentBlock;
                
                console.log(`🎮 SENDING IMMEDIATE GAME_START to ${socket.id}`);
                io.to(socket.id).emit('game_start', gameState);
                console.log(`Game started immediately for player ${socket.id}`);
            } catch (error) {
                console.error(`Error creating game:`, error);
                sendStatusUpdate(socket.id, 'error', 'Error starting game: ' + error.message);
            }
        } else {
            sendStatusUpdate(socket.id, 'error', 'Error: Could not start game. Please try again.');
        }
        return; // Don't broadcast commands as chat
    }
    // Add a handler for the 'cancel' command
    else if (msg.toLowerCase() == 'cancel') {
        // Remove player from waiting queue
        const index = WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        
        if (index !== -1) {
            WAITING_PLAYERS.splice(index, 1);
            sendStatusUpdate(socket.id, 'info', 'You have left the queue.');
            
            // Reset to welcome screen
            io.to(socket.id).emit('queue_cancelled');
        } else {
            // Send status update to this player only
            sendStatusUpdate(socket.id, 'error', 'You were not in the queue.');
        }
        return; // Don't broadcast commands as chat
    }
    
    // For all other messages (actual chat), broadcast to all clients
    else {
        console.log(`💬 Broadcasting chat message from ${socket.id}: "${msg}"`);
        
        // Get user info for chat display
        const currentUser = getUserBySocket(socket.id);
        const username = currentUser?.username || `User_${socket.id.substr(-4)}`;
        
        // Broadcast chat message to ALL clients
        io.emit('chat_broadcast', {
            username: username,
            message: msg,
            timestamp: Date.now(),
            socketId: socket.id
        });
    }
  });

  // Handle player movement
  socket.on('player_move', function(moveData) {
    console.log(`Player move event received from ${socket.id}:`, moveData);
    const currentUser = getUserBySocket(socket.id);
    const game = activeGames.get(socket.id);

    if (currentUser && game && game.gameState === 'active') {
      // Server-side movement throttling
      const now = Date.now();
      const lastMoveTime = playerMoveTimestamps.get(socket.id) || 0;
      
      if (now - lastMoveTime < MOVE_COOLDOWN) {
        console.log(`Move from ${socket.id} throttled - too soon after last move (${now - lastMoveTime}ms)`);
        return; // Ignore move if too soon
      }
      
      if (typeof moveData.dx === 'number' && typeof moveData.dy === 'number') {
        playerMoveTimestamps.set(socket.id, now); // Update timestamp before processing
        
        const moveResult = game.movePlayer(moveData.dx, moveData.dy); // This should update player pos and FOV

        if (moveResult && moveResult.status === 'moved') {
          // Move monster after player moves
          game.moveMonster(); 
          
          // Check if monster caught player
          const GameModule = require('./game');
          const checkMonsterKill = GameModule.checkMonsterKill || 
            ((player, monster) => monster.x === player.x && monster.y === player.y);
          
          if (checkMonsterKill(game.player, game.monster)) {
            game.gameState = 'lost';
            game.endGame('lost', { score: 0, reason: 'monster' });
            io.to(socket.id).emit('game_over', {
              status: 'lost',
              reason: 'monster',
              message: 'The monster caught you!'
            });
            activeGames.delete(socket.id);
            return;
          }
          
          // Check for treasure pickup
          if (moveResult.event === 'treasure_found') {
            io.to(socket.id).emit('message', 'You found the treasure!');
          }
          
          // Check for escape
          if (moveResult.event === 'escaped') {
            game.gameState = 'won';
            const score = game.player.hasTreasure ? 100 : 50; // Bonus for treasure
            game.endGame('won', { 
              score: score, 
              reason: 'escaped',
              treasuresFound: game.player.hasTreasure ? 1 : 0 
            });
            io.to(socket.id).emit('game_over', {
              status: 'won',
              reason: 'escaped',
              message: 'Congratulations! You escaped the dungeon!',
              score: score
            });
            activeGames.delete(socket.id);
            return;
          }

          const updatedGameState = game.getState(); // Get the new state
          
          // Debug logging for lighting data in game updates
          console.log(`🔍 GAME UPDATE DEBUG for ${socket.id}:`);
          console.log(`  - Player position: (${updatedGameState.player?.x}, ${updatedGameState.player?.y})`);
          console.log(`  - Visible tiles keys: ${Object.keys(updatedGameState.visibleTiles || {}).length} rows`);
          console.log(`  - Lighting data included: ${!!updatedGameState.lighting}`);
          if (updatedGameState.lighting) {
            const lightingTileCount = Object.keys(updatedGameState.lighting).reduce((acc, yKey) => 
              acc + Object.keys(updatedGameState.lighting[yKey] || {}).length, 0);
            console.log(`  - Lighting tiles count: ${lightingTileCount}`);
          }
          console.log(`  - Torch data included: ${!!updatedGameState.torches}`);
          if (updatedGameState.torches) {
            console.log(`  - Torch count: ${updatedGameState.torches.length}`);
          }
          
          // Log before sending to client for debugging
          console.log(`Sending game_update to ${socket.id} after player move.`);

          // Send game update to player (current implementation)
          // TODO: In future, also broadcast to spectators of this game
          sendGameUpdate(socket.id, updatedGameState);
        } else {
          console.log(`Player move from ${socket.id} was invalid or resulted in no change.`);
          // Optionally, send an update even for invalid moves if you want to provide feedback
          // const currentGameState = game.getState();
          // sendGameUpdate(socket.id, currentGameState);
        }
      } else {
        console.error(`Invalid moveData received from ${socket.id}:`, moveData);
      }
    } else {
      console.log(`Player move event from ${socket.id} ignored: No active game found for user.`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', function() {
    console.log('User disconnected', socket.client.id);
    
    // Clean up movement timestamps
    playerMoveTimestamps.delete(socket.id);
    
    // Clean up active games
    activeGames.delete(socket.id);
    
    // Remove from waiting players
    const waitingIndex = WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
    if (waitingIndex !== -1) {
      WAITING_PLAYERS.splice(waitingIndex, 1);
    }
    
    user.removeUser(socket.client.id);
  });

  // Add this to your socket handlers in index.js
  socket.on('debug_ping', function(data) {
      console.log(`Debug ping received from ${socket.client.id}`);
      socket.emit('debug_pong', {
          message: "Hello from server!",
          clientTime: data.time,
          serverTime: Date.now(),
          socketId: socket.client.id
      });
  });

  socket.on('register_client', function(data) {
    console.log(`Client registered: ${socket.id} (server) <-> ${data.clientId} (client)`);
    
    // Store both mappings for lookup
    clientSocketMap.set(data.clientId, socket.id);
    clientSocketMap.set(socket.id, data.clientId);
    
    // Send confirmation back to client
    socket.emit('socket_registered', {
        clientId: data.clientId,
        serverId: socket.id,
        success: true
    });
});

}); // End of io.on('connection') handler

// Add this debug function to check all registered users

function debugRegisteredUsers() {
    console.log("\n🔍 CHECKING ALL REGISTERED USERS:");
    const allUsers = user.getAllUsers ? user.getAllUsers() : null;
    
    if (!allUsers) {
        console.log("No getAllUsers function available or no users registered");
        return;
    }
    
    console.log(`Found ${allUsers.length} registered users:`);
    allUsers.forEach((u, i) => {
        console.log(`User ${i+1}:`, {
            id: u.id,
            clientId: u.clientId || 'undefined',
            address: u.address
        });
    });
    console.log(); // Empty line for readability
}

// Call this after a user registers and at intervals
setInterval(debugRegisteredUsers, 10000);

http.listen(3000, function() {
   console.log('listening on *:3000');
});

// Make sure this function is defined in your file
function startGameForPlayer(socketId, blockHeight) {
  console.log(`Starting game for player ${socketId} at block height ${blockHeight}`);
  
  const currentUser = getUserBySocket(socketId);
  if (!currentUser) {
    console.error(`User with socket ID ${socketId} not found`);
    return;
  }
  
  try {
    // Create a new game
    const game = createGameForUser(currentUser, 'legacy'); 
    if (!game) {
      console.error("Game creation failed");
      return;
    }
    
    // Store the game in activeGames map
    activeGames.set(socketId, game);
    
    // Get game state - ensure it has the required fields
    const gameState = {
      gameState: "active",  // Add this so frontend knows it's active
      player: {
        x: game.player.x,
        y: game.player.y,
        hasKey: !!game.player.hasKey,
        hasTreasure: !!game.player.hasTreasure
      },
      monster: game.monster,
      visibleTiles: game.calculateFOV ? game.calculateFOV() : {},
      entrance: [game.dungeon.entrance.x, game.dungeon.entrance.y],
      exit: [game.dungeon.exit.x, game.dungeon.exit.y],
      treasure: [game.dungeon.treasure.x, game.dungeon.treasure.y]
    };
    
    console.log("Sending game_start with state:", JSON.stringify(gameState, null, 2).substring(0, 200) + "...");
    
    // Add a small delay before sending (sometimes helps with socket timing issues)
    setTimeout(() => {
      debugSocket(socketId, 'game_start', gameState);
      // Send initial game state to client
      io.to(socketId).emit('game_start', gameState);
      console.log(`Game started for player ${socketId}`);
    }, 100);
  } catch (err) {
    console.error("Error starting game:", err);
    io.to(socketId).emit('message', 'Error starting game: ' + err.message);
  }
}

function debugSocket(socketId, eventName, data) {
  console.log(`🔌 SOCKET DEBUG: Sending ${eventName} to ${socketId.substring(0, 8)}...`);
  console.log(`📦 PAYLOAD (first 300 chars): ${JSON.stringify(data).substring(0, 300)}...`);
}

// Add express middleware to parse JSON
app.use(express.json());
app.use(express.static('html'));

// Debug endpoint to receive client-side debug info
app.post('/debug', (req, res) => {
  const debugData = req.body;
  console.log('🎯 CLIENT DEBUG:', debugData.message || debugData);
  res.json({ status: 'ok' });
});
