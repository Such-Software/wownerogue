const express = require('express');
var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var rpc = require('./rpccalls.js');
var db = require('./dbcalls.js');
var user = require('./user.js');
const Game = require('./game');
const activeGames = new Map(); // Maps socketId to Game objects
let lastBlockHeight = 0; // Track last block height
const MIN_FEE = 10; // Minimum entrance fee in WOW
const MAX_FEE = 100; // Maximum entrance fee in WOW
const WAITING_PLAYERS = []; // Players waiting for the next block

var users = [];
var players = [];

app.use(express.static('html'));
app.get('/', function(req, res) {
   res.sendfile('index.html');
});

// Function to get a user by socket ID
function getUserBySocket(socketId) {
  return users.find(user => user.socketid === socketId);
}

// Modified block check function
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
}, 10000);

// Start games for waiting players
function startGamesForWaiting(blockHeight) {
  while (WAITING_PLAYERS.length > 0) {
    const userId = WAITING_PLAYERS.shift();
    const user = getUserBySocket(userId);
    
    if (user) {
      user.blockRec = blockHeight;
      const game = user.startGame(80, 40); // Create a new game
      activeGames.set(userId, game);
      
      io.to(userId).emit('game_start', {
        map: game.dungeon.map,
        player: game.player,
        monster: game.monster,
        entrance: game.dungeon.entrance,
        exit: game.dungeon.exit,
        treasure: game.dungeon.treasure,
        blockHeight: blockHeight
      });
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
  
  db.insertVisitor(socket.client.id, socket.handshake.address, 0);
  users.push(new user.User(socket.client.id, socket.handshake.address));
  
  io.to(`${socket.client.id}`).emit('welcome', socket.client.id);

  socket.on('chat message', function(msg) {
    console.log(msg);
    
    if (msg.toLowerCase() == 'hello') {
      io.to(`${socket.client.id}`).emit('message', 
        'Welcome, to enter the dungeon type Enter, and you will be given a Wownero address, ' +
        'which you must send between 10-100 WOW to enter. The more you send, the more you can win.');
    }
    else if (msg.toLowerCase() == 'enter') {
      const currentUser = getUserBySocket(socket.client.id);
      
      if (currentUser) {
        // FOR TESTING: Skip payment and directly queue the player
        currentUser.verifyPayment(10); // Minimal test fee
        WAITING_PLAYERS.push(socket.client.id);
        
        io.to(`${socket.client.id}`).emit('message', 
          'For testing: You will enter the dungeon when the next block is found.');
          
        // To test without waiting for a block, immediately start a game
        startGameForPlayer(socket.client.id, lastBlockHeight || 1);
      }
    }
    else {
      io.emit('message', msg);
    }
  });

  // Handle player movement
  socket.on('move', function(direction) {
    const game = activeGames.get(socket.client.id);
    
    if (game) {
      let dx = 0, dy = 0;
      
      // Convert direction to dx,dy
      switch(direction) {
        case 'up': dy = -1; break;
        case 'down': dy = 1; break;
        case 'left': dx = -1; break;
        case 'right': dx = 1; break;
      }
      
      const result = game.movePlayer(dx, dy);
      
      // Send updated game state
      socket.emit('game_update', {
        player: game.player,
        monster: game.monster,
        status: result.status
      });
      
      // Handle win/lose conditions
      if (result.status === 'won') {
        const user = getUserBySocket(socket.client.id);
        const reward = user.calculateReward();
        
        socket.emit('game_over', {
          status: 'won',
          hasTreasure: game.player.hasTreasure,
          reward: reward
        });
        
        // TODO: Process payout
        
        activeGames.delete(socket.client.id);
      }
      else if (result.status === 'lost') {
        socket.emit('game_over', {
          status: 'lost',
          reason: result.reason
        });
        
        activeGames.delete(socket.client.id);
      }
    }
  });

  // Handle disconnection
  socket.on('disconnect', function () {
    console.log('A user disconnected');
    
    // Clean up any active games
    if (activeGames.has(socket.client.id)) {
      activeGames.delete(socket.client.id);
    }
    
    users = spliceOut(socket.client.id, "socketid", users);
  });
});

http.listen(3000, function() {
   console.log('listening on *:3000');
});


// Remove objects from an array if one attribute matches
function spliceOut(target, field, array) {
  for (var i = array.length - 1; i >= 0; --i) {
    if (array[i][field] == target) {
      array.splice(i,1);
    }
  }
  return array;
}
// Check if objects are in an array if one attribute matches
function checkArray(target, field, array) {
  for (var i = array.length - 1; i >= 0; --i) {
    if (array[i][field] == target) {
      return true;
    }
  }
  return false;
}

// Add this function to generate a dungeon
function generateDungeon(width, height) {
  // Create a new instance of ROT.Map.Digger
  const digger = new ROT.Map.Digger(width, height, {
    roomWidth: [3, 9],
    roomHeight: [3, 5],
    corridorLength: [2, 5],
    dugPercentage: 0.2
  });
  
  // Create a map representation
  const map = Array(height).fill().map(() => Array(width).fill(1)); // 1 = wall
  
  // Callback to dig out rooms and corridors
  digger.create((x, y, value) => {
    map[y][x] = value; // 0 = floor, 1 = wall
  });
  
  // Get rooms and place special features
  const rooms = digger.getRooms();
  let entrance = null;
  let exit = null;
  let treasure = null;
  
  if (rooms.length > 0) {
    // Place entrance in the first room
    entrance = rooms[0].getCenter();
    
    // Place exit in the last room
    exit = rooms[rooms.length-1].getCenter();
    
    // Place treasure in a middle room
    const treasureRoom = rooms[Math.floor(rooms.length/2)];
    treasure = treasureRoom.getCenter();
  }
  
  return {
    map: map,
    entrance: entrance,
    exit: exit,
    treasure: treasure,
    rooms: rooms
  };
}

// Add this helper function to start a game for a specific player immediately:
function startGameForPlayer(socketId, blockHeight) {
  const user = getUserBySocket(socketId);
  
  if (user) {
    user.blockRec = blockHeight;
    const game = user.startGame(25, 19); // Create a new game with dimensions matching our display
    activeGames.set(socketId, game);
    
    io.to(socketId).emit('game_start', {
      map: game.dungeon.map,
      player: game.player,
      monster: game.monster,
      entrance: game.dungeon.entrance,
      exit: game.dungeon.exit,
      treasure: game.dungeon.treasure,
      blockHeight: blockHeight
    });
  }
}
