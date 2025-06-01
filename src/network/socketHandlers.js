/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wowngeon game server
 */

const user = require('../db/user');
const Game = require('../game/game');

class SocketHandlers {
    constructor(io, activeGames, broadcastManager, debugManager, gameModeManager = null) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
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
    handleGameQueue(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Player ${socket.id} requested to enter the dungeon - ADDING TO QUEUE`);
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

        // Add to waiting queue
        this.WAITING_PLAYERS.push({
            serverId: socket.id,
            clientId: currentUser.clientId,
            entryTime: Date.now()
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
        
        const currentUser = this.getUserBySocket(socket.id);
        if (!currentUser) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error: Could not start game. Please try again.');
            return;
        }

        // Check if already in a game
        if (this.activeGames.has(socket.id)) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'You are already in a game!');
            return;
        }

        // Check if payment system is available and validate eligibility
        if (this.gameModeManager) {
            try {
                const eligibility = await this.gameModeManager.canUserStartGame(socket.id);
                
                if (!eligibility.allowed) {
                    // Send payment requirement to client
                    this.io.to(socket.id).emit('payment_required', {
                        reason: eligibility.reason,
                        action: eligibility.action,
                        gameMode: this.gameModeManager.gameMode
                    });
                    return;
                }
                
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`✅ Payment validated for ${socket.id}: ${eligibility.reason}`);
                }
            } catch (error) {
                console.error('Error checking payment eligibility:', error);
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Payment system error. Playing in FREE mode.');
            }
        }

        // Remove from waiting queue if present
        const waitingIndex = this.WAITING_PLAYERS.findIndex(p => p.serverId === socket.id);
        if (waitingIndex !== -1) {
            this.WAITING_PLAYERS.splice(waitingIndex, 1);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🚀 AUTO-START: Removed ${socket.id} from waiting queue for immediate start`);
            }
        }

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Found user for socket ${socket.id}, starting game immediately...`);
        }
        
        try {
            // For auto-entry, player enters on current block
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            currentUser.blockRec = currentBlock;
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🕒 AUTO-START: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
            }
            
            const game = this.createGameForUser(currentUser, 'standard');
            
            const gameState = game.getState();
            gameState.blockHeight = currentBlock;
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🎮 SENDING IMMEDIATE GAME_START to ${socket.id} (AUTO-START)`);
            }
            this.io.to(socket.id).emit('game_start', gameState);
            
            // Register game with payment system if available
            if (this.gameModeManager) {
                try {
                    await this.gameModeManager.startGame(socket.id, game.id);
                } catch (error) {
                    console.error('Error registering game with payment system:', error);
                }
            }
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Game started immediately for player ${socket.id} via auto-start`);
            }
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
            payout: payoutInfo
        });
        
        this.activeGames.delete(socket.id);
    }

    /**
     * Handle client disconnection
     */
    handleDisconnect(socket) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('User disconnected', socket.client.id);
        }
        
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
      
        while (this.WAITING_PLAYERS.length > 0) {
            const playerEntry = this.WAITING_PLAYERS.shift();
            const serverId = playerEntry.serverId;
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Processing player: server=${serverId}`);
            }
            
            const currentUser = this.getUserBySocket(serverId);
            
            if (currentUser) {
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
            const payment = await this.gameModeManager.moneroPayService.createPaymentRequest(socket.id, gameMode);
            
            this.io.to(socket.id).emit('payment_created', {
                paymentId: payment.id,
                address: payment.address,
                amount: payment.amount,
                confirmations: payment.confirmations,
                gameMode: gameMode
            });
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment request created for ${socket.id}: ${payment.amount} XMR`);
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
            const { paymentId } = data;
            const status = await this.gameModeManager.moneroPayService.checkPaymentStatus(paymentId);
            
            this.io.to(socket.id).emit('payment_status', status);
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 Payment status checked for ${socket.id}: ${status.status}`);
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
}

module.exports = SocketHandlers;
