/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wowngeon game server
 */

const user = require('../db/user');
const Game = require('../game/game');
const MovementManager = require('../game/movementManager');
const QueueManager = require('./queueManager');
const PaymentHandlers = require('./paymentHandlers');

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
    // Legacy WAITING_PLAYERS removed; queueManager owns queue state
        this.mempoolNotified = new Set(); // track payment addresses already queued
        this.queueManager = new QueueManager({
            debugManager: this.debugManager,
            broadcastManager: this.broadcastManager,
            io: this.io,
            createGameForUser: (userObj, gameType, options) => this.createGameForUser(userObj, gameType, options),
            getUserBySocket: (socketId) => this.getUserBySocket(socketId),
            activeGames: this.activeGames,
            gameModeManager: this.gameModeManager,
            consoleLogging: this.debugManager.CONSOLE_LOGGING
        });
        this.paymentHandlers = new PaymentHandlers({
            io: this.io,
            gameModeManager: this.gameModeManager,
            walletService: this.walletService,
            debugManager: this.debugManager,
            queueManager: this.queueManager,
            broadcastManager: this.broadcastManager
        });
        // Movement manager abstraction
        this.movementManager = new MovementManager({
            activeGames: this.activeGames,
            io: this.io,
            debugManager: this.debugManager,
            moveCooldown: this.MOVE_COOLDOWN,
            postMoveHook: ({ socketId, game }) => this.afterPlayerMove(socketId, game)
        });
    }

    /**
     * Handle player movement input from client.
     * Expects moveData: { direction: 'up'|'down'|'left'|'right' }
     */
    handlePlayerMove(socket, moveData) {
        try {
            if (!moveData || typeof moveData.direction !== 'string') return;
            const now = Date.now();
            const last = this.playerMoveTimestamps.get(socket.id) || 0;
            if (now - last < this.MOVE_COOLDOWN) return; // rate limit moves
            this.playerMoveTimestamps.set(socket.id, now);

            const game = this.activeGames.get(socket.id);
            if (!game) return; // not in a game

            // Translate direction to delta
            const dir = moveData.direction;
            let dx = 0, dy = 0;
            switch (dir) {
                case 'up': dy = -1; break;
                case 'down': dy = 1; break;
                case 'left': dx = -1; break;
                case 'right': dx = 1; break;
                default: return; // ignore unknown
            }

            // Attempt move via game API (assuming game has movePlayer(dx,dy))
            if (typeof game.movePlayer === 'function') {
                game.movePlayer(dx, dy);
            } else if (game.player) {
                // Fallback direct mutation (legacy) with simple bounds check
                const newX = game.player.x + dx;
                const newY = game.player.y + dy;
                if (newX >= 0 && newY >= 0) {
                    game.player.x = newX;
                    game.player.y = newY;
                }
            }

            // Build updated state
            let state;
            if (typeof game.getState === 'function') {
                state = game.getState();
            } else {
                state = { player: game.player };
            }

            // Add block height context
            if (this.debugManager && typeof this.debugManager.getCurrentBlockHeight === 'function') {
                state.blockHeight = this.debugManager.getCurrentBlockHeight();
            }

            this.io.to(socket.id).emit('game_update', state);

        } catch (err) {
            console.error('handlePlayerMove error:', err);
        }
    }

    /**
     * Called after a successful player move (before update is emitted) via MovementManager postMoveHook.
     * Handles monster chasing logic and immediate game over if monster catches player.
     */
    afterPlayerMove(socketId, game) {
        // Move monster one step toward player each player action
        if (game && typeof game.moveMonster === 'function') {
            try {
                game.moveMonster();
            } catch (e) {
                console.error('Monster move error:', e);
            }
        }

        // Check if monster catches player
        try {
            if (game && game.monster && game.player && game.monster.x === game.player.x && game.monster.y === game.player.y) {
                const fakeSocket = { id: socketId };
                this.handleGameOver(fakeSocket, game, 'lost', 'monster', 'You were caught by the monster!', 0);
            }
        } catch (e) {
            console.error('Monster catch check error:', e);
        }
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
    this.io.to(socket.id).emit('blockheight', { blockHeight: currentBlock });
        
        // Send connection status
        this.broadcastManager.sendStatusUpdate(socket.id, 'connection', 'Connected to Wowngeon server');

        // Register event handlers
        socket.on('chat message', (msg) => this.handleChatMessage(socket, msg));
    socket.on('player_move', (moveData) => this.movementManager.handleMove(socket.id, moveData));
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('debug_ping', (data) => this.handleDebugPing(socket, data));
        socket.on('register_client', (data) => this.handleRegisterClient(socket, data));
        socket.on('auto_start', () => this.handleAutoStart(socket)); // New handler for start button
        
        // Payment system handlers
    socket.on('request_payment', (data) => this.paymentHandlers.handlePaymentRequest(socket, data));
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
                // Legacy payment command path removed; auto-create request if needed
                if (this.gameModeManager) {
                    this.paymentHandlers.createAndShowPaymentRequest(socket);
                } else {
                    this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Server is in FREE mode - no payment required.');
                }
                return;
                
            default:
                // Broadcast as chat message to all clients
                this.handleChatBroadcast(socket, msg);
        }
    }

    /**
     * Broadcast a generic chat message to all clients. Performs minimal sanitization
     * and rate limiting (simple cooldown per socket) to avoid spam / abuse.
     */
    handleChatBroadcast(socket, msg) {
        if (typeof msg !== 'string') return;
        const trimmed = msg.trim();
        if (!trimmed) return;

        // Basic rate limit: one broadcast per 750ms per socket
        const now = Date.now();
        if (!this._chatLastSent) this._chatLastSent = new Map();
        const last = this._chatLastSent.get(socket.id) || 0;
        if (now - last < 750) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'You are sending messages too fast.');
            return;
        }
        this._chatLastSent.set(socket.id, now);

        // Very light sanitization (escape < >)
        const safe = trimmed.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;').slice(0, 300);
        this.broadcastManager.broadcastChatMessage(socket.id.substring(0,6), safe, now, socket.id);
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
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            currentUser.blockRec = currentBlock;
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🕒 AUTO-ENTRY: Player enters on block ${currentUser.blockRec}, will die when block ${currentUser.blockRec + 1} starts`);
            }
            const game = this.createGameForUser(currentUser, 'standard');
            const gameState = game.getState();
            gameState.blockHeight = currentBlock;
            this.io.to(socket.id).emit('game_start', gameState);
        } catch (error) {
            console.error('Error creating game:', error);
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
        const existingIndex = this.queueManager.getPlayerIndex(socket.id);
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
                    await this.paymentHandlers.createAndShowPaymentRequest(socket);
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
        this.queueManager.addPlayer({
            serverId: socket.id,
            clientId: currentUser.clientId,
            requiresConfirmation: false,
            confirmed: true
        });

        const currentBlock = this.debugManager.getCurrentBlockHeight();
        const nextBlock = currentBlock + 1;
        this.broadcastManager.sendStatusUpdate(socket.id, 'queue', 
            `Added to queue! You will enter when block ${nextBlock} is found. Current block: ${currentBlock}`);
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`🕒 QUEUE ENTRY: Player ${socket.id} queued for block ${nextBlock}. Queue length: ${this.queueManager.getQueueLength()}`);
        }
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
        
        // Remove from queue manager (idempotent)
        this.queueManager.removePlayer(socket.id);
        
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
        this.queueManager.startGamesForWaiting(blockHeight);
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

    // ====== PAYMENT SYSTEM HANDLERS (delegated to paymentHandlers now) ======

    // (Address detection & direct payment monitoring removed; now handled by PaymentHandlers)
}

module.exports = SocketHandlers;
