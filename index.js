const express = require('express');
var app = require('express')();
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
let lastBlockHeight = 0; // Track last block height
const MIN_FEE = 10; // Minimum entrance fee in WOW
const MAX_FEE = 100; // Maximum entrance fee in WOW
const WAITING_PLAYERS = []; // Players waiting for the next block
const DEBUG_MODE = true; // Set to false to disable debug mode
let debugBlockHeight = 1;
const clientSocketMap = new Map(); // To track client-to-server socket ID mappings

app.use(express.static('html'));
app.get('/', function(req, res) {
   res.sendfile('index.html');
});

// Replace your existing block check interval with this conditional version
if (DEBUG_MODE) {
  console.log("🐛 DEBUG MODE ENABLED - Simulating blocks every 30 seconds");
  
  // Initial debug block
  io.emit('blockheight', debugBlockHeight);
  
  // Debug block height simulator
  setInterval(function() {
    debugBlockHeight++;
    console.log(`🐛 DEBUG: New simulated block: ${debugBlockHeight}`);
    io.emit('blockheight', debugBlockHeight);
    
    // Start games for waiting players
    startGamesForWaiting(debugBlockHeight);
    
    // Check active games for timeout
    checkGamesTimeout(debugBlockHeight);
    
  }, 30000); // Every 30 seconds
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

// Start games for waiting players
function startGamesForWaiting(blockHeight) {
    console.log(`Starting games for ${WAITING_PLAYERS.length} waiting players at block height ${blockHeight}`);
  
    while (WAITING_PLAYERS.length > 0) {
        const playerEntry = WAITING_PLAYERS.shift();
        const serverId = playerEntry.serverId;
        
        console.log(`Processing player: server=${serverId}`);
        
        const currentUser = getUserBySocket(serverId);
        
        if (currentUser) {
            currentUser.blockRec = blockHeight;
            
            try {
                const game = currentUser.startGame(80, 40);
                activeGames.set(serverId, game);
                
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
    
    if (user && user.blockRec && currentHeight > user.blockRec + 1) {
      // Game has timed out - player didn't escape in time
      game.gameState = 'lost';
      io.to(socketId).emit('game_over', {
        status: 'lost',
        reason: 'timeout',
        message: 'You didn\'t escape before the next block was found!'
      });
      
      activeGames.delete(socketId);
    }
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
  
  // Send welcome message
  io.to(socket.client.id).emit('welcome', socket.client.id);

  socket.on('chat message', function(msg) {
    console.log('Message received:', msg);
    
    if (msg.toLowerCase() == 'hello') {
      io.to(`${socket.client.id}`).emit('message', 
        'Welcome, to enter the dungeon type Enter, and you will be given a Wownero address, ' +
        'which you must send between 10-100 WOW to enter. The more you send, the more you can win.');
    }
    // Update the 'enter' command handler to send waiting_status
    if (msg.toLowerCase() == 'enter') {
        console.log(`Player ${socket.id} requested to enter the dungeon`);
        
        // Use the updated user lookup function
        const currentUser = getUserBySocket(socket.id);
        
        if (currentUser) {
            console.log(`Found user for socket ${socket.id}, adding to queue...`);
            
            // Add to waiting players queue
            if (!WAITING_PLAYERS.some(p => p.serverId === socket.id)) {
                WAITING_PLAYERS.push({
                    serverId: socket.id,
                    clientId: socket.id,
                    user: currentUser,
                    joinedAt: Date.now()
                });
                
                // Send waiting status data for display - THIS IS THE KEY PART
                io.to(socket.id).emit('waiting_status', { 
                    status: 'waiting',
                    message: 'Waiting for the next block to be found...',
                    position: WAITING_PLAYERS.length,
                    currentBlock: debugBlockHeight || lastBlockHeight || 0,
                    joinTime: Date.now()
                });
                
                console.log(`Added player to queue. Current queue: ${WAITING_PLAYERS.length} players`);
            } else {
                io.to(socket.id).emit('message', 'You are already in the queue. Please wait.');
            }
        } else {
            io.to(socket.id).emit('message', 'Error: Could not add you to the game queue. Please try again.');
        }
    }
    // Add a handler for the 'cancel' command
    else if (msg.toLowerCase() == 'cancel') {
        // Remove player from waiting queue
        const index = WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        
        if (index !== -1) {
            WAITING_PLAYERS.splice(index, 1);
            io.to(socket.id).emit('message', 'You have left the queue.');
            
            // Reset to welcome screen
            io.to(socket.id).emit('queue_cancelled');
        } else {
            io.to(socket.id).emit('message', 'You were not in the queue.');
        }
    }
    else {
      io.emit('message', msg);
    }
  });

  // Handle player movement
  socket.on('move', function(direction) {
    console.log(`Player ${socket.id} moved: ${direction}`);
    
    // Find the active game
    let game = activeGames.get(socket.id);
    
    if (!game) {
        // Try fallback methods to find the game
        console.log(`Game not found for ${socket.id}, trying client.id: ${socket.client.id}`);
        game = activeGames.get(socket.client.id);
    }
    
    if (!game) {
        const mappedId = clientSocketMap.get(socket.id);
        if (mappedId) {
            console.log(`Game not found, trying mapped ID: ${mappedId}`);
            game = activeGames.get(mappedId);
        }
    }
    
    if (game) {
        let dx = 0, dy = 0;
        
        // Convert direction to dx,dy
        switch(direction) {
            case 'up': dy = -1; break;
            case 'down': dy = 1; break;
            case 'left': dx = -1; break;
            case 'right': dx = 1; break;
        }
        
        // Server still uses absolute coordinates internally
        console.log(`Moving player ${dx},${dy} from (${game.player.x},${game.player.y})`);
        const result = game.movePlayer(dx, dy);
        console.log(`Move result: ${result.status}`);
        
        if (result.status === 'won') {
            io.to(socket.id).emit('game_over', {
                status: 'won', 
                hasTreasure: game.player.hasTreasure
            });
        } else if (result.status === 'lost') {
            io.to(socket.id).emit('game_over', {
                status: 'lost', 
                reason: result.reason
            });
        } else {
            // Get updated game state (now with relative coordinates)
            const updatedState = game.getState();
            
            // Send updated game state back to client
            console.log(`Sending updated game state to ${socket.id}`);
            io.to(socket.id).emit('game_update', updatedState);
        }
    } else {
        console.log(`No active game found for player ${socket.id}`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', function() {
    console.log('User disconnected', socket.client.id);
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
    const game = currentUser.startGame(25, 19); 
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
