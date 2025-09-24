/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wowngeon game server
 */

const user = require('../db/user');
const Game = require('../game/game');

class SocketHandlers {
    constructor(io, activeGames, broadcastManager, debugManager, gameModeManager = null, walletService = null) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.playerMoveTimestamps = new Map();
        this.clientSocketMap = new Map();
        this.MOVE_COOLDOWN = 100; // Minimum 100ms between moves
        this.WAITING_PLAYERS = []; // Players waiting for the next block
    }

    /**
     * Initialize socket event handlers for a new connection
     */
    handleConnection(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('A user connected');
            console.log(socket.client.id);
            console.log(socket.handshake.address);
        }
        
        // Create and register user
        new user.User(socket.id, socket.handshake.address);
        const newUser = this.getUserBySocket(socket.id);
        if (newUser) {
            newUser.clientId = socket.client.id;
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`User created with both socket.id (${socket.id}) and socket.client.id (${socket.client.id})`);
            }
        }
        
        // Send welcome and current status
        this.io.to(socket.client.id).emit('welcome', socket.client.id);
        
        // Send current block height
        const currentBlock = this.debugManager.getCurrentBlockHeight();
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`📈 Sending current block height ${currentBlock} to new connection ${socket.id}`);
        }
        this.io.to(socket.id).emit('blockheight', currentBlock);
        
        // Send connection status
        this.broadcastManager.sendStatusUpdate(socket.id, 'connection', 'Connected to Wowngeon server');

        // Register event handlers
        socket.on('chat message', (msg) => this.handleChatMessage(socket, msg));
        socket.on('player_move', (moveData) => this.handlePlayerMove(socket, moveData));
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('debug_ping', (data) => this.handleDebugPing(socket, data));
        socket.on('register_client', (data) => this.handleRegisterClient(socket, data));
        socket.on('auto_start', () => this.handleAutoStart(socket)); // New handler for start button
        
        // Payment system handlers
        socket.on('request_payment', (data) => this.handlePaymentRequest(socket, data));
        socket.on('check_payment_status', (data) => this.handleCheckPaymentStatus(socket, data));
        socket.on('get_user_credits', () => this.handleGetUserCredits(socket));
    }

    /**
     * Handle chat messages and game commands
     */
    handleChatMessage(socket, msg) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('Message received:', msg);
        }
        
        const command = msg.toLowerCase();
        
        // Check for XMR/WOW address in the message
        const xmrAddressMatch = this.detectXMRAddress(msg);
        if (xmrAddressMatch) {
            this.handleAddressDetection(socket, xmrAddressMatch);
            return;
        }
        
        // Handle game commands
        switch (command) {
            case 'hello':
                this.broadcastManager.sendStatusUpdate(socket.id, 'help', 
                    'Welcome! Type "enter" to join the queue for the next block, or use the START button for immediate entry. ' +
                    'Paste your XMR/WOW address in chat to set your payout address.');
                return;
                
            case 'enter':
                this.handleGameQueue(socket);
                return;
                
            case 'cancel':
                // Check if this is for address confirmation
                if (this.pendingAddresses && this.pendingAddresses.has(socket.id)) {
                    this.handleAddressConfirmation(socket, false);
                    return;
                }
                // Otherwise handle queue cancellation
                this.handleCancelEntry(socket);
                return;
                
            case 'confirm':
                this.handleAddressConfirmation(socket, true);
                return;
                
            case 'address':
            case 'payout':
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    'Please paste your XMR/WOW address directly in chat. The system will automatically detect and confirm it.');
                return;
                
            case 'payment':
            case 'pay':
                this.handlePaymentCommand(socket);
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Player ${socket.id} requested to enter the dungeon - STARTING IMMEDIATELY`);
        }
        
        const currentUser = this.getUserBySocket(socket.id);
        if (!currentUser) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error: Could not start game. Please try again.');
            return;
        }

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Found user for socket ${socket.id}, starting game immediately...`);
        }
        
        try {
            // For auto-entry in debug mode, player enters on current block
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            currentUser.blockRec = currentBlock;
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🕒 AUTO-ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
            }
            
            const game = this.createGameForUser(currentUser, 'standard');
            
            const gameState = game.getState();
            gameState.blockHeight = currentBlock;
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🎮 SENDING IMMEDIATE GAME_START to ${socket.id}`);
            }
            this.io.to(socket.id).emit('game_start', gameState);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Game started immediately for player ${socket.id}`);
            }
        } catch (error) {
            console.error(`Error creating game:`, error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error starting game: ' + error.message);
        }
    }

    /**
     * Handle game queue request (typing "enter")
     */
    async handleGameQueue(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Player ${socket.id} requested to enter the dungeon`);
        }
        
        const currentUser = this.getUserBySocket(socket.id);
        if (!currentUser) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error: Could not add to queue. Please try again.');
            return;
        }

        // Check if already waiting
        const existingIndex = this.WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        if (existingIndex !== -1) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'You are already in the queue!');
            return;
        }

        // Check if already in a game
        if (this.activeGames.has(socket.id)) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'You are already in a game!');
            return;
        }

        // Check payment eligibility if payment system is available
        if (this.gameModeManager) {
            try {
                const eligibility = await this.gameModeManager.canUserStartGame(socket.id);
                
                if (!eligibility.allowed) {
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`❌ Payment required for ${socket.id}: ${eligibility.reason}`);
                    }
                    
                    // Create payment request immediately instead of asking user to type 'payment'
                    await this.createAndShowPaymentRequest(socket);
                    return;
                }
                
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`✅ Payment validated for ${socket.id}: ${eligibility.reason}`);
                }
            } catch (error) {
                console.error('Error checking payment eligibility:', error);
                
                // In paid mode, don't add to queue if payment check fails
                if (this.gameModeManager.gameMode !== 'FREE') {
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                        'Payment system error. Please try again or contact support.');
                    return;
                }
                
                // Only in FREE mode, continue to queue on payment system errors
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'Payment system unavailable. Playing in FREE mode.');
            }
        }

        // Add to waiting queue (in free mode or already authorized paid mode)
        this.WAITING_PLAYERS.push({
            serverId: socket.id,
            clientId: currentUser.clientId,
            entryTime: Date.now(),
            // For paid modes, this path only executes if payment already confirmed (canUserStartGame returned allowed)
            requiresConfirmation: false,
            confirmed: true
        });

        const currentBlock = this.debugManager.getCurrentBlockHeight();
        const nextBlock = currentBlock + 1;
        
        this.broadcastManager.sendStatusUpdate(socket.id, 'queue', 
            `Added to queue! You will enter when block ${nextBlock} is found. Current block: ${currentBlock}`);
        
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`🕒 QUEUE ENTRY: Player ${socket.id} queued for block ${nextBlock}. Queue length: ${this.WAITING_PLAYERS.length}`);
        }
    }

    /**
     * Handle auto start request (start button)
     */
    async handleAutoStart(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Player ${socket.id} requested auto-start via start button`);
        }
        
        // Use the same logic as handleGameQueue for consistency
        // This ensures both START GAME button and typing 'enter' behave the same way
        await this.handleGameQueue(socket);
    }

    /**
     * Handle entry cancellation
     */

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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`💬 Broadcasting chat message from ${socket.id}: "${msg}"`);
        }
        
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Player move event received from ${socket.id}:`, moveData);
        }
        const currentUser = this.getUserBySocket(socket.id);
        const game = this.activeGames.get(socket.id);

        if (!currentUser || !game || game.gameState !== 'active') {
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Player move event from ${socket.id} ignored: No active game found for user.`);
            }
            return;
        }

        // Server-side movement throttling
        const now = Date.now();
        const lastMoveTime = this.playerMoveTimestamps.get(socket.id) || 0;
        
        if (now - lastMoveTime < this.MOVE_COOLDOWN) {
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Move from ${socket.id} throttled - too soon after last move (${now - lastMoveTime}ms)`);
            }
            return;
        }
        
        if (typeof moveData.dx !== 'number' || typeof moveData.dy !== 'number') {
            console.error(`Invalid moveData received from ${socket.id}:`, moveData);
            return;
        }

        this.playerMoveTimestamps.set(socket.id, now);
        const moveResult = game.movePlayer(moveData.dx, moveData.dy);

        if (!moveResult || moveResult.status !== 'moved') {
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Player move from ${socket.id} was invalid or resulted in no change.`);
            }
            return;
        }

        // Persist move count if DB available
        if (this.gameModeManager && this.gameModeManager.db) {
            const db = this.gameModeManager.db;
            db.query(`
                UPDATE games SET moves_made = moves_made + 1
                WHERE socket_id = $1 AND dungeon_seed = $2
            `, [socket.id, game.id]).catch(err => {
                if (this.debugManager.CONSOLE_LOGGING) console.warn('moves_made update failed:', err.message);
            });
        }

        // Check collision if player moved onto monster BEFORE monster reacts
        if (this.checkMonsterKill(game.player, game.monster)) {
            this.handleGameOver(socket, game, 'lost', 'monster', 'The monster caught you!');
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
    async handleGameOver(socket, game, status, reason, message, score = 0) {
        game.gameState = status;
        const gameStats = { 
            score: score, 
            reason: reason,
            treasuresFound: game.player.hasTreasure ? 1 : 0 
        };
        game.endGame(status, gameStats);
        
        // Process game completion with payment system
        let payoutInfo = null;
        if (this.gameModeManager) {
            try {
                payoutInfo = await this.gameModeManager.completeGame(
                    socket.id, 
                    game.id, 
                    status === 'won', 
                    game.player.hasTreasure || false
                );
                
                if (this.debugManager.CONSOLE_LOGGING && payoutInfo) {
                    console.log(`💰 Payout processed for ${socket.id}:`, payoutInfo);
                }
            } catch (error) {
                console.error('Error processing game completion:', error);
            }
        }
        
        this.io.to(socket.id).emit('game_over', {
            status: status,
            reason: reason,
            message: message,
            score: score,
            payout: payoutInfo,
            treasure: game.player.hasTreasure || false
        });

        // Persist completion details if DB available
        if (this.gameModeManager && this.gameModeManager.db) {
            const db = this.gameModeManager.db;
            const outcome = reason === 'escaped' ? 'escaped' : (reason === 'monster' ? 'caught_by_monster' : reason);
            db.query(`
                UPDATE games SET status = $1, outcome = $2, treasure_found = $3, completed_at = NOW()
                WHERE dungeon_seed = $4 AND socket_id = $5
            `, [status, outcome, game.player.hasTreasure, game.id, socket.id])
            .catch(err => console.error('Game completion update failed:', err.message));
        }
        
        this.activeGames.delete(socket.id);
    }

    /**
     * Handle client disconnection
     */
    handleDisconnect(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('User disconnected', socket.client.id);
        }
        
        // Clean up payment monitoring
        this.stopPaymentMonitoring(socket.id);
        
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Debug ping received from ${socket.client.id}`);
        }
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Client registered: ${socket.id} (server) <-> ${data.clientId} (client)`);
        }
        
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Looking up user with socketId: ${socketId}`);
        }
        
        let foundUser = user.getUserBySocketId(socketId);
        
        if (!foundUser && this.clientSocketMap.has(socketId)) {
            const mappedId = this.clientSocketMap.get(socketId);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Socket ID ${socketId} not found directly, trying mapped ID: ${mappedId}`);
            }
            foundUser = user.getUserBySocketId(mappedId);
        }
        
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`User lookup result for ${socketId}: ${foundUser ? "FOUND" : "NOT FOUND"}`);
        }
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

        // Insert a DB record for this game (best effort)
        if (this.gameModeManager && this.gameModeManager.db) {
            const db = this.gameModeManager.db;
            const gameMode = this.gameModeManager.gameMode || 'FREE';
            const blockHeight = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
            const socketId = user.id; // user.id is the socket id string
            db.query(`
                INSERT INTO games (user_id, socket_id, game_mode, status, start_block_height, dungeon_seed, created_at)
                VALUES ((SELECT id FROM users WHERE socket_id = $1), $1, $2, 'active', $3, $4, NOW())
            `, [socketId, gameMode, blockHeight, game.id])
            .catch(err => console.error('Game insert failed:', err.message));
        }
        
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`[createGameForUser] Created ${gameType} game ${game.id} for user ${user.id}`);
        }
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
        if (this.debugManager.CONSOLE_LOGGING) {
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
    }

    // Queue management methods (for future block-based game entry)
    
    /**
     * Start games for waiting players when a new block is found
     */
    startGamesForWaiting(blockHeight) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Starting games for ${this.WAITING_PLAYERS.length} waiting players at block height ${blockHeight}`);
        }
      
        // We may skip some entries if they are not yet confirmed (paid mode, mempool only)
        const remainingQueue = [];
        while (this.WAITING_PLAYERS.length > 0) {
            const playerEntry = this.WAITING_PLAYERS.shift();
            const serverId = playerEntry.serverId;
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Processing player: server=${serverId}`);
            }
            
            const currentUser = this.getUserBySocket(serverId);
            
            if (currentUser) {
                // If this entry requires confirmation and is not confirmed yet, keep it in queue
                if (playerEntry.requiresConfirmation && !playerEntry.confirmed) {
                    remainingQueue.push(playerEntry); // re-queue for next block
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`⏳ Skipping unconfirmed paid entry for ${serverId}, still waiting for confirmation.`);
                    }
                    continue;
                }
                currentUser.blockRec = blockHeight;
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`🕒 QUEUE ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
                }
                
                try {
                    const game = this.createGameForUser(currentUser, 'standard');
                    
                    const gameState = game.getState();
                    gameState.blockHeight = blockHeight;
                    
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`🎮 SENDING GAME_START to ${serverId}`);
                    }
                    this.io.to(serverId).emit('game_start', gameState);
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`Game started for player ${serverId}`);
                    }
                } catch (error) {
                    console.error(`Error creating game:`, error);
                    this.io.to(serverId).emit('message', 'Error starting game: ' + error.message);
                }
            } else {
                console.error(`User not found for socket ${serverId}`);
                this.io.to(serverId).emit('message', 'Error: User not found');
            }
        }
        // Put back any remaining (unconfirmed) entries
        if (remainingQueue.length > 0) {
            this.WAITING_PLAYERS = remainingQueue.concat(this.WAITING_PLAYERS);
        }
    }

    /**
     * Check for game timeouts based on block height
     */
    checkGamesTimeout(currentHeight) {
        this.activeGames.forEach((game, socketId) => {
            const user = this.getUserBySocket(socketId);
            
            if (user && user.blockRec && currentHeight > user.blockRec) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`💀 GAME TIMEOUT for player ${socketId}: entered on block ${user.blockRec}, died on block ${currentHeight}`);
                }
                
                game.gameState = 'lost';
                this.handleGameOver(socket, game, 'lost', 'timeout', 'You didn\'t escape before the block time limit!');
            }
        });
    }

    // ====== PAYMENT SYSTEM HANDLERS ======

    /**
     * Handle payment request from client
     */
    async handlePaymentRequest(socket, data) {
        if (!this.gameModeManager) {
            this.io.to(socket.id).emit('payment_error', { 
                error: 'Payment system not available' 
            });
            return;
        }

        try {
            const { gameMode } = data;
            // Use gameModeManager to create payment request with proper amount
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, gameMode);
            
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                gameMode: gameMode
            });
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment request created for ${socket.id}: ${paymentRequest.amount} atomic units`);
            }
        } catch (error) {
            console.error('Error creating payment request:', error);
            this.io.to(socket.id).emit('payment_error', { 
                error: error.message 
            });
        }
    }

    /**
     * Handle payment status check from client
     */
    async handleCheckPaymentStatus(socket, data) {
        if (!this.gameModeManager) {
            this.io.to(socket.id).emit('payment_error', { 
                error: 'Payment system not available' 
            });
            return;
        }

        try {
            const { address } = data;
            const status = await this.walletService.checkPaymentStatus(address);
            
            this.io.to(socket.id).emit('payment_status', status);
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment status checked for ${socket.id}: ${status.complete ? 'complete' : 'pending'}`);
            }
        } catch (error) {
            console.error('Error checking payment status:', error);
            this.io.to(socket.id).emit('payment_error', { 
                error: error.message 
            });
        }
    }

    /**
     * Handle get user credits request
     */
    async handleGetUserCredits(socket) {
        if (!this.gameModeManager) {
            this.io.to(socket.id).emit('credits_info', { credits: 0 });
            return;
        }

        try {
            const credits = await this.gameModeManager.getUserCredits(socket.id);
            
            this.io.to(socket.id).emit('credits_info', { credits });
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💰 Credits checked for ${socket.id}: ${credits}`);
            }
        } catch (error) {
            console.error('Error getting user credits:', error);
            this.io.to(socket.id).emit('credits_info', { credits: 0 });
        }
    }

    // ====== ADDRESS DETECTION SYSTEM ======

    /**
     * Detect XMR/WOW address in chat message using regex
     */
    detectXMRAddress(message) {
        // XMR mainnet addresses start with 4, 8, A, or B and are 95 characters  
        // WOW addresses start with W and are 97 characters
        const xmrRegex = /\b[48AB][1-9A-HJ-NP-Za-km-z]{94}\b/;
        const wowRegex = /\bW[1-9A-HJ-NP-Za-km-z]{96}\b/;
        
        const xmrMatch = message.match(xmrRegex);
        const wowMatch = message.match(wowRegex);
        
        if (xmrMatch) {
            return { address: xmrMatch[0], type: 'XMR' };
        }
        if (wowMatch) {
            return { address: wowMatch[0], type: 'WOW' };
        }
        
        return null;
    }

    /**
     * Handle detected address and confirm with user
     */
    async handleAddressDetection(socket, addressMatch) {
        const { address, type } = addressMatch;
        
        // Store pending address for confirmation
        if (!this.pendingAddresses) {
            this.pendingAddresses = new Map();
        }
        
        this.pendingAddresses.set(socket.id, {
            address: address,
            type: type,
            timestamp: Date.now()
        });

        // Send confirmation request to user
        this.io.to(socket.id).emit('address_detected', {
            address: address,
            type: type,
            message: `⚠️  DETECTED ${type} ADDRESS: ${address}\n\n` +
                    `⚠️  WARNING: Please verify this is YOUR address before confirming!\n` +
                    `⚠️  Clipboard viruses can change addresses - double check carefully!\n\n` +
                    `Type "confirm" to set this as your payout address, or "cancel" to reject.`,
            confirmationRequired: true
        });

        // Auto-expire pending address after 5 minutes
        setTimeout(() => {
            if (this.pendingAddresses && this.pendingAddresses.has(socket.id)) {
                this.pendingAddresses.delete(socket.id);
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    'Address confirmation expired. Please paste your address again if needed.');
            }
        }, 300000); // 5 minutes

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`💰 Address detected for ${socket.id}: ${type} ${address}`);
        }
    }

    /**
     * Handle address confirmation
     */
    async handleAddressConfirmation(socket, confirmed) {
        if (!this.pendingAddresses || !this.pendingAddresses.has(socket.id)) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                'No pending address to confirm. Please paste your address first.');
            return;
        }

        const pendingAddress = this.pendingAddresses.get(socket.id);
        this.pendingAddresses.delete(socket.id);

        if (!confirmed) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                'Address rejected. Paste a new address if you want to set a payout address.');
            return;
        }

        // Save address to payment system
        if (this.gameModeManager) {
            try {
                await this.gameModeManager.setUserPayoutAddress(socket.id, pendingAddress.address);
                
                this.io.to(socket.id).emit('address_confirmed', {
                    address: pendingAddress.address,
                    type: pendingAddress.type,
                    message: `✅ Payout address confirmed: ${pendingAddress.address}\n\n` +
                            `Future winnings will be sent to this address.`
                });

                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`✅ Address confirmed for ${socket.id}: ${pendingAddress.address}`);
                }
            } catch (error) {
                console.error('Error saving payout address:', error);
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                    'Error saving address. Please try again.');
            }
        } else {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                `Address noted: ${pendingAddress.address} (Payment system not active)`);
        }
    }

    /**
     * Create payment request immediately when user types 'enter' in paid mode
     * User stays on welcome screen until payment is detected
     */
    async createAndShowPaymentRequest(socket) {
        try {
            const currentUser = this.getUserBySocket(socket.id);
            if (!currentUser) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                    'Error: Could not process payment request. Please try again.');
                return;
            }

            // Get game mode information
            const gameMode = this.gameModeManager.gameMode;
            const cryptoType = this.gameModeManager.cryptoType;

            // Determine payment type and amount based on game mode
            let paymentType, amount, description;
            
            if (gameMode === 'PAID_SINGLE') {
                paymentType = 'single_game';
                amount = this.gameModeManager.singleGamePrice;
                description = 'Single game entry';
            } else if (gameMode === 'PAID_CREDITS') {
                paymentType = 'credits_package';
                amount = this.gameModeManager.creditsPackagePrice;
                description = '10 game credits package';
            } else {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                    'Invalid game mode configuration.');
                return;
            }

            // Create payment request
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType);
            
            // Convert atomic units to human readable amount
            const humanAmount = (amount / 1000000000000).toFixed(3);
            
            // Send payment information to client (for UI)
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                paymentType: paymentType,
                gameMode: gameMode,
                cryptoType: cryptoType,
                humanAmount: humanAmount,
                description: description,
                expiresAt: paymentRequest.expiresAt
            });

            // Send status message to chat with payment details
            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', 
                `💳 PAYMENT REQUIRED (${description})\n\n` +
                `Amount: ${humanAmount} ${cryptoType}\n` +
                `Address: ${paymentRequest.address}\n\n` +
                `⚠️  Send EXACTLY ${humanAmount} ${cryptoType} to the address above.\n` +
                `🔄 You will be added to the game queue once payment is detected in mempool.\n` +
                `⏰ Payment expires in 30 minutes.`);

            // Start monitoring the payment address
            this.walletService.startPaymentMonitoring(
                paymentRequest.address,
                async (status) => {
                    if (status.in_mempool && !status.confirmed) {
                        // Payment detected in mempool - add to queue
                        socket.emit('payment_detected', {
                            message: 'Payment detected! Adding you to the game queue...',
                            amount: status.amount,
                            confirmations: 0
                        });
                        
                        // Add user to waiting queue (requires confirmation before starting)
                        this.WAITING_PLAYERS.push({
                            serverId: socket.id,
                            clientId: currentUser.clientId,
                            entryTime: Date.now(),
                            paymentId: paymentRequest.id,
                            requiresConfirmation: true,
                            confirmed: false
                        });
                        
                        // Show waiting screen
                        socket.emit('queue_joined', {
                            position: this.WAITING_PLAYERS.length,
                            message: 'Payment received! Waiting for next block to start game...'
                        });
                        
                    } else if (status.confirmed) {
                        // Payment confirmed - game can start
                        socket.emit('payment_confirmed', {
                            message: 'Payment confirmed!',
                            confirmations: status.confirmations
                        });
                        // Mark any existing waiting queue entry as confirmed
                        const entry = this.WAITING_PLAYERS.find(p => p.serverId === socket.id);
                        if (entry) {
                            entry.confirmed = true;
                        }
                    }
                },
                2000 // Check every 2 seconds
            );

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment request created for ${socket.id}: ${humanAmount} ${cryptoType} (${paymentType})`);
                console.log(`👀 Started monitoring address: ${paymentRequest.address}`);
            }

        } catch (error) {
            console.error('Error creating payment request:', error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                'Failed to create payment request. Please try again or contact support.');
        }
    }

    /**
     * Start monitoring a payment address for incoming payments
     */
    startPaymentMonitoring(socketId, paymentRequest) {
        if (!this.paymentMonitors) {
            this.paymentMonitors = new Map();
        }

        // Clear any existing monitor for this user
        this.stopPaymentMonitoring(socketId);

        const monitor = {
            paymentId: paymentRequest.id,
            address: paymentRequest.address,
            socketId: socketId,
            startTime: Date.now(),
            interval: setInterval(async () => {
                try {
                    const status = await this.walletService.checkPaymentStatus(paymentRequest.address);
                    
                    if (status.confirmed || status.in_mempool) {
                        // Payment detected! 
                        this.handlePaymentDetected(socketId, paymentRequest, status);
                    }
                } catch (error) {
                    console.error(`Error checking payment status for ${socketId}:`, error);
                }
            }, 5000) // Check every 5 seconds
        };

        this.paymentMonitors.set(socketId, monitor);

        // Auto-expire after 30 minutes
        setTimeout(() => {
            this.stopPaymentMonitoring(socketId);
            this.broadcastManager.sendStatusUpdate(socketId, 'warning', 
                'Payment request expired. Type \'enter\' again to create a new payment request.');
        }, 30 * 60 * 1000); // 30 minutes
    }

    /**
     * Stop monitoring a payment address
     */
    stopPaymentMonitoring(socketId) {
        if (this.paymentMonitors && this.paymentMonitors.has(socketId)) {
            const monitor = this.paymentMonitors.get(socketId);
            clearInterval(monitor.interval);
            this.paymentMonitors.delete(socketId);
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🛑 Stopped payment monitoring for ${socketId}`);
            }
        }
    }

    /**
     * Handle payment detection - add user to queue
     */
    async handlePaymentDetected(socketId, paymentRequest, paymentStatus) {
        this.stopPaymentMonitoring(socketId);

        const currentUser = this.getUserBySocket(socketId);
        if (!currentUser) {
            console.error(`Payment detected but user not found: ${socketId}`);
            return;
        }

        // Check if user is already in queue or game
        const existingIndex = this.WAITING_PLAYERS.findIndex(p => p.serverId === socketId);
        if (existingIndex !== -1) {
            this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Payment confirmed, you are already in the queue!');
            return;
        }

        if (this.activeGames.has(socketId)) {
            this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Payment confirmed, but you are already in a game!');
            return;
        }

        // Add to waiting queue. If only mempool detected, require confirmation.
        this.WAITING_PLAYERS.push({
            serverId: socketId,
            clientId: currentUser.clientId,
            entryTime: Date.now(),
            paymentId: paymentRequest.id,
            requiresConfirmation: paymentStatus.in_mempool && !paymentStatus.confirmed,
            confirmed: paymentStatus.confirmed
        });

        const currentBlock = this.debugManager.getCurrentBlockHeight();
        const nextBlock = currentBlock + 1;
        
        if (paymentStatus.in_mempool && !paymentStatus.confirmed) {
            // Payment in mempool but not confirmed yet
            this.broadcastManager.sendStatusUpdate(socketId, 'success', 
                `💰 PAYMENT DETECTED IN MEMPOOL!\n\n` +
                `✅ You have been added to the game queue.\n` +
                `🕒 Your game will start when block ${nextBlock} is found.\n` +
                `📦 Current block: ${currentBlock}`);
            this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Waiting for block confirmation before starting...');
        } else if (paymentStatus.confirmed) {
            // Payment already confirmed
            this.broadcastManager.sendStatusUpdate(socketId, 'success', 
                `💰 PAYMENT CONFIRMED!\n\n` +
                `✅ You have been added to the game queue.\n` +
                `🕒 Your game will start when block ${nextBlock} is found.\n` +
                `📦 Current block: ${currentBlock}`);
        }

        // Send user to waiting screen
        this.io.to(socketId).emit('payment_confirmed', {
            paymentId: paymentRequest.id,
            status: paymentStatus,
            nextBlock: nextBlock,
            currentBlock: currentBlock
        });

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`💰 Payment detected for ${socketId}: Added to queue for block ${nextBlock}`);
        }
    }

    /**
     * Handle payment command - create payment request for user
     */
    async handlePaymentCommand(socket) {
        if (!this.gameModeManager) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                'Payment system is not available. Server is running in FREE mode.');
            return;
        }

        try {
            const currentUser = this.getUserBySocket(socket.id);
            if (!currentUser) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                    'Error: Could not process payment request. Please try again.');
                return;
            }

            // Get game mode information
            const gameMode = this.gameModeManager.gameMode;
            const cryptoType = this.gameModeManager.cryptoType;

            if (gameMode === 'FREE') {
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    'Server is in FREE mode - no payment required to play!');
                return;
            }

            // Determine payment type and amount based on game mode
            let paymentType, amount, description;
            
            if (gameMode === 'PAID_SINGLE') {
                paymentType = 'single_game';
                amount = this.gameModeManager.singleGamePrice;
                description = `Single game entry (${cryptoType})`;
            } else if (gameMode === 'PAID_CREDITS') {
                paymentType = 'credits_package';
                amount = this.gameModeManager.creditsPackagePrice;
                description = `10 game credits package (${cryptoType})`;
            } else {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                    'Invalid game mode configuration.');
                return;
            }

            // Create payment request
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType);
            
            // Convert atomic units to human readable amount
            const humanAmount = (amount / 1000000000000).toFixed(3);
            
            // Send payment information to client
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                paymentType: paymentType,
                gameMode: gameMode,
                cryptoType: cryptoType,
                humanAmount: humanAmount,
                description: description,
                expiresAt: paymentRequest.expiresAt
            });

            // Send status message to chat
            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', 
                `💳 Payment Request Created!\n\n` +
                `Amount: ${humanAmount} ${cryptoType}\n` +
                `Type: ${description}\n` +
                `Address: ${paymentRequest.address}\n\n` +
                `⚠️  Send the EXACT amount to the address above.\n` +
                `⏰ Payment will expire in 30 minutes.\n` +
                `🔄 Your game will start automatically after payment confirmation.`);

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment request created for ${socket.id}: ${humanAmount} ${cryptoType} (${paymentType})`);
            }

        } catch (error) {
            console.error('Error creating payment request:', error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                'Failed to create payment request. Please try again or contact support.');
        }
    }
}

module.exports = SocketHandlers;
