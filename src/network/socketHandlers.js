/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wowngeon game server
 */

const user = require('../db/user');
const Game = require('../game/game');

class SocketHandlers {
    constructor(io, activeGames, broadcastManager, debugManager) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.playerMoveTimestamps = new Map();
        this.clientSocketMap = new Map();
        this.MOVE_COOLDOWN = 100; // Minimum 100ms between moves
        this.WAITING_PLAYERS = []; // Players waiting for the next block
    }

    /**
     * Initialize socket event handlers for a new connection
     */
    handleConnection(socket) {
        console.log('A user connected');
        console.log(socket.client.id);
        console.log(socket.handshake.address);
        
        // Create and register user
        new user.User(socket.id, socket.handshake.address);
        const newUser = this.getUserBySocket(socket.id);
        if (newUser) {
            newUser.clientId = socket.client.id;
            console.log(`User created with both socket.id (${socket.id}) and socket.client.id (${socket.client.id})`);
        }
        
        // Send welcome and current status
        this.io.to(socket.client.id).emit('welcome', socket.client.id);
        
        // Send current block height
        const currentBlock = this.debugManager.getCurrentBlockHeight();
        console.log(`📈 Sending current block height ${currentBlock} to new connection ${socket.id}`);
        this.io.to(socket.id).emit('blockheight', currentBlock);
        
        // Send connection status
        this.broadcastManager.sendStatusUpdate(socket.id, 'connection', 'Connected to Wowngeon server');

        // Register event handlers
        socket.on('chat message', (msg) => this.handleChatMessage(socket, msg));
        socket.on('player_move', (moveData) => this.handlePlayerMove(socket, moveData));
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('debug_ping', (data) => this.handleDebugPing(socket, data));
        socket.on('register_client', (data) => this.handleRegisterClient(socket, data));
    }

    /**
     * Handle chat messages and game commands
     */
    handleChatMessage(socket, msg) {
        console.log('Message received:', msg);
        
        const command = msg.toLowerCase();
        
        // Handle game commands
        switch (command) {
            case 'hello':
                this.broadcastManager.sendStatusUpdate(socket.id, 'help', 
                    'Welcome, to enter the dungeon type Enter, and you will be given a Wownero address, ' +
                    'which you must send between 10-100 WOW to enter. The more you send, the more you can win.');
                return;
                
            case 'enter':
                this.handleGameEntry(socket);
                return;
                
            case 'cancel':
                this.handleCancelEntry(socket);
                return;
                
            default:
                // Broadcast as chat message to all clients
                this.handleChatBroadcast(socket, msg);
        }
    }

    /**
     * Handle game entry request
     */
    handleGameEntry(socket) {
        console.log(`Player ${socket.id} requested to enter the dungeon - STARTING IMMEDIATELY`);
        
        const currentUser = this.getUserBySocket(socket.id);
        if (!currentUser) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error: Could not start game. Please try again.');
            return;
        }

        console.log(`Found user for socket ${socket.id}, starting game immediately...`);
        
        try {
            // For auto-entry in debug mode, player enters on current block
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            currentUser.blockRec = currentBlock;
            console.log(`🕒 AUTO-ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
            
            const game = this.createGameForUser(currentUser, 'standard');
            
            const gameState = game.getState();
            gameState.blockHeight = currentBlock;
            
            console.log(`🎮 SENDING IMMEDIATE GAME_START to ${socket.id}`);
            this.io.to(socket.id).emit('game_start', gameState);
            console.log(`Game started immediately for player ${socket.id}`);
        } catch (error) {
            console.error(`Error creating game:`, error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error starting game: ' + error.message);
        }
    }

    /**
     * Handle cancel entry request
     */
    handleCancelEntry(socket) {
        const index = this.WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        
        if (index !== -1) {
            this.WAITING_PLAYERS.splice(index, 1);
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'You have left the queue.');
            this.io.to(socket.id).emit('queue_cancelled');
        } else {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'You were not in the queue.');
        }
    }

    /**
     * Handle chat broadcast to all clients
     */
    handleChatBroadcast(socket, msg) {
        console.log(`💬 Broadcasting chat message from ${socket.id}: "${msg}"`);
        
        const currentUser = this.getUserBySocket(socket.id);
        const username = currentUser?.username || `User_${socket.id.substr(-4)}`;
        
        this.io.emit('chat_broadcast', {
            username: username,
            message: msg,
            timestamp: Date.now(),
            socketId: socket.id
        });
    }

    /**
     * Handle player movement
     */
    handlePlayerMove(socket, moveData) {
        console.log(`Player move event received from ${socket.id}:`, moveData);
        const currentUser = this.getUserBySocket(socket.id);
        const game = this.activeGames.get(socket.id);

        if (!currentUser || !game || game.gameState !== 'active') {
            console.log(`Player move event from ${socket.id} ignored: No active game found for user.`);
            return;
        }

        // Server-side movement throttling
        const now = Date.now();
        const lastMoveTime = this.playerMoveTimestamps.get(socket.id) || 0;
        
        if (now - lastMoveTime < this.MOVE_COOLDOWN) {
            console.log(`Move from ${socket.id} throttled - too soon after last move (${now - lastMoveTime}ms)`);
            return;
        }
        
        if (typeof moveData.dx !== 'number' || typeof moveData.dy !== 'number') {
            console.error(`Invalid moveData received from ${socket.id}:`, moveData);
            return;
        }

        this.playerMoveTimestamps.set(socket.id, now);
        const moveResult = game.movePlayer(moveData.dx, moveData.dy);

        if (!moveResult || moveResult.status !== 'moved') {
            console.log(`Player move from ${socket.id} was invalid or resulted in no change.`);
            return;
        }

        // Move monster after player moves
        game.moveMonster();
        
        // Check if monster caught player
        if (this.checkMonsterKill(game.player, game.monster)) {
            this.handleGameOver(socket, game, 'lost', 'monster', 'The monster caught you!');
            return;
        }
        
        // Check for treasure pickup
        if (moveResult.event === 'treasure_found') {
            this.io.to(socket.id).emit('message', 'You found the treasure!');
        }
        
        // Check for escape
        if (moveResult.event === 'escaped') {
            const score = game.player.hasTreasure ? 100 : 50;
            this.handleGameOver(socket, game, 'won', 'escaped', 'Congratulations! You escaped the dungeon!', score);
            return;
        }

        // Send game update
        const updatedGameState = game.getState();
        this.logGameUpdate(socket.id, updatedGameState);
        this.broadcastManager.sendGameUpdate(socket.id, updatedGameState);
    }

    /**
     * Handle game over scenarios
     */
    handleGameOver(socket, game, status, reason, message, score = 0) {
        game.gameState = status;
        const gameStats = { 
            score: score, 
            reason: reason,
            treasuresFound: game.player.hasTreasure ? 1 : 0 
        };
        game.endGame(status, gameStats);
        
        this.io.to(socket.id).emit('game_over', {
            status: status,
            reason: reason,
            message: message,
            score: score
        });
        
        this.activeGames.delete(socket.id);
    }

    /**
     * Handle client disconnection
     */
    handleDisconnect(socket) {
        console.log('User disconnected', socket.client.id);
        
        // Clean up movement timestamps
        this.playerMoveTimestamps.delete(socket.id);
        
        // Clean up active games
        this.activeGames.delete(socket.id);
        
        // Remove from waiting players
        const waitingIndex = this.WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        if (waitingIndex !== -1) {
            this.WAITING_PLAYERS.splice(waitingIndex, 1);
        }
        
        user.removeUser(socket.client.id);
    }

    /**
     * Handle debug ping
     */
    handleDebugPing(socket, data) {
        console.log(`Debug ping received from ${socket.client.id}`);
        socket.emit('debug_pong', {
            message: "Hello from server!",
            clientTime: data.time,
            serverTime: Date.now(),
            socketId: socket.client.id
        });
    }

    /**
     * Handle client registration
     */
    handleRegisterClient(socket, data) {
        console.log(`Client registered: ${socket.id} (server) <-> ${data.clientId} (client)`);
        
        this.clientSocketMap.set(data.clientId, socket.id);
        this.clientSocketMap.set(socket.id, data.clientId);
        
        socket.emit('socket_registered', {
            clientId: data.clientId,
            serverId: socket.id,
            success: true
        });
    }

    // Helper methods

    /**
     * Get user by socket ID with fallback mapping
     */
    getUserBySocket(socketId) {
        console.log(`Looking up user with socketId: ${socketId}`);
        
        let foundUser = user.getUserBySocketId(socketId);
        
        if (!foundUser && this.clientSocketMap.has(socketId)) {
            const mappedId = this.clientSocketMap.get(socketId);
            console.log(`Socket ID ${socketId} not found directly, trying mapped ID: ${mappedId}`);
            foundUser = user.getUserBySocketId(mappedId);
        }
        
        console.log(`User lookup result for ${socketId}: ${foundUser ? "FOUND" : "NOT FOUND"}`);
        return foundUser;
    }

    /**
     * Create a new game for a user
     */
    createGameForUser(user, gameType = 'standard', options = {}) {
        let game;
        
        if (gameType === 'legacy') {
            game = Game.createLegacyGame(user.id, user, options);
        } else {
            game = Game.createStandardGame(user.id, user, options);
        }
        
        user.joinGame(game);
        this.activeGames.set(user.id, game);
        
        console.log(`[createGameForUser] Created ${gameType} game ${game.id} for user ${user.id}`);
        return game;
    }

    /**
     * Check if monster caught player
     */
    checkMonsterKill(player, monster) {
        return monster.x === player.x && monster.y === player.y;
    }

    /**
     * Log game update debug information
     */
    logGameUpdate(socketId, gameState) {
        console.log(`🔍 GAME UPDATE DEBUG for ${socketId}:`);
        console.log(`  - Player position: (${gameState.player?.x}, ${gameState.player?.y})`);
        console.log(`  - Visible tiles keys: ${Object.keys(gameState.visibleTiles || {}).length} rows`);
        console.log(`  - Lighting data included: ${!!gameState.lighting}`);
        if (gameState.lighting) {
            const lightingTileCount = Object.keys(gameState.lighting).reduce((acc, yKey) => 
                acc + Object.keys(gameState.lighting[yKey] || {}).length, 0);
            console.log(`  - Lighting tiles count: ${lightingTileCount}`);
        }
        console.log(`  - Torch data included: ${!!gameState.torches}`);
        if (gameState.torches) {
            console.log(`  - Torch count: ${gameState.torches.length}`);
        }
        console.log(`Sending game_update to ${socketId} after player move.`);
    }

    // Queue management methods (for future block-based game entry)
    
    /**
     * Start games for waiting players when a new block is found
     */
    startGamesForWaiting(blockHeight) {
        console.log(`Starting games for ${this.WAITING_PLAYERS.length} waiting players at block height ${blockHeight}`);
      
        while (this.WAITING_PLAYERS.length > 0) {
            const playerEntry = this.WAITING_PLAYERS.shift();
            const serverId = playerEntry.serverId;
            
            console.log(`Processing player: server=${serverId}`);
            
            const currentUser = this.getUserBySocket(serverId);
            
            if (currentUser) {
                currentUser.blockRec = blockHeight;
                console.log(`🕒 QUEUE ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
                
                try {
                    const game = this.createGameForUser(currentUser, 'standard');
                    
                    const gameState = game.getState();
                    gameState.blockHeight = blockHeight;
                    
                    console.log(`🎮 SENDING GAME_START to ${serverId}`);
                    this.io.to(serverId).emit('game_start', gameState);
                    console.log(`Game started for player ${serverId}`);
                } catch (error) {
                    console.error(`Error creating game:`, error);
                    this.io.to(serverId).emit('message', 'Error starting game: ' + error.message);
                }
            } else {
                console.error(`User not found for socket ${serverId}`);
                this.io.to(serverId).emit('message', 'Error: User not found');
            }
        }
    }

    /**
     * Check for game timeouts based on block height
     */
    checkGamesTimeout(currentHeight) {
        this.activeGames.forEach((game, socketId) => {
            const user = this.getUserBySocket(socketId);
            
            if (user && user.blockRec && currentHeight > user.blockRec) {
                console.log(`💀 GAME TIMEOUT for player ${socketId}: entered on block ${user.blockRec}, died on block ${currentHeight}`);
                
                game.gameState = 'lost';
                this.io.to(socketId).emit('game_over', {
                    status: 'lost',
                    reason: 'timeout',
                    message: 'You didn\'t escape before the block time limit!'
                });
                
                this.activeGames.delete(socketId);
            }
        });
    }
}

module.exports = SocketHandlers;
