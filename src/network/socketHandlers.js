/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wownerogue game server
 */

const user = require('../db/user');
const GameManager = require('../game/gameManager');
const MovementManager = require('../game/movementManager');
const QueueManager = require('./queueManager');
const PaymentHandlers = require('./paymentHandlers');
const AddressManager = require('./addressManager');
const SessionManager = require('./sessionManager');
const RateLimiter = require('./rateLimiter');
const ConnectionHandler = require('./connectionHandler');
const ChatHandler = require('./chatHandler');
const QueueHandler = require('./queueHandler');
const SpectatorManager = require('./spectatorManager');
const MemoryManager = require('../utils/memoryManager');
const { normalizeError } = require('../utils/errors');

class SocketHandlers {
    constructor(io, activeGames, broadcastManager, debugManager, gameModeManager = null, walletService = null) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.MOVE_COOLDOWN = 100; // Minimum 100ms between moves

        // Initialize rate limiter with debug mode matching debugManager
        this.rateLimiter = new RateLimiter({
            debugMode: this.debugManager.CONSOLE_LOGGING,
            limits: {
                'payment:create': { window: 60000, max: 3 },
                'game:start': { window: 60000, max: 15 },
                'game:queue': { window: 30000, max: 5 },
                'chat:message': { window: 10000, max: 12 },
                'address:set': { window: 300000, max: 3 },
                'connection:new': { window: 60000, max: 10 }
            }
        });

        // Initialize memory manager for cleanup
        this.memoryManager = new MemoryManager({
            debugMode: this.debugManager.CONSOLE_LOGGING,
            cleanupInterval: 300000 // 5 minutes
        });

        // Initialize game manager
        this.gameManager = new GameManager({
            activeGames: this.activeGames,
            io: this.io,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            gameModeManager: this.gameModeManager
        });

        // Legacy WAITING_PLAYERS removed; queueManager owns queue state
        this.mempoolNotified = new Set(); // track payment addresses already queued
        
        // Initialize session manager first
        if (this.gameModeManager && this.gameModeManager.db) {
            this.sessionManager = new SessionManager({
                db: this.gameModeManager.db,
                debugManager: this.debugManager,
                gameModeManager: this.gameModeManager
            });
            // Initialize cleanup timers
            this.sessionManager.initialize().catch(err => {
                console.error('Failed to initialize SessionManager:', err);
            });
        }

        // Initialize connection handler
        this.connectionHandler = new ConnectionHandler({
            io: this.io,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            sessionManager: this.sessionManager,
            rateLimiter: this.rateLimiter
        });

        this.queueManager = new QueueManager({
            debugManager: this.debugManager,
            broadcastManager: this.broadcastManager,
            io: this.io,
            createGameForUser: (userObj, gameType, options) => this.gameManager.createGameForUser(userObj, gameType, options),
            getUserBySocket: (socketId) => this.connectionHandler.getUserBySocket(socketId),
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
            broadcastManager: this.broadcastManager,
            sessionManager: this.sessionManager
        });

        // Address / payout handling encapsulated in AddressManager
        this.addressManager = new AddressManager({
            gameModeManager: this.gameModeManager,
            broadcastManager: this.broadcastManager,
            io: this.io,
            debugManager: this.debugManager,
            onConfirmed: (socketId, accepted) => {
                if (accepted) {
                    // Automatically proceed to payment creation after address confirmation
                    const sock = this._getLiveSocket(socketId);
                    if (sock) {
                        this.paymentHandlers.createAndShowPaymentRequest(sock);
                    }
                    if (this.chatHandler) {
                        this.chatHandler.clearAddressConfirmation(socketId);
                    }
                }
            }
        });

        // Initialize chat handler with database for persistent history
        this.chatHandler = new ChatHandler({
            io: this.io,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            addressManager: this.addressManager,
            paymentHandlers: this.paymentHandlers,
            queueManager: this.queueManager,
            gameModeManager: this.gameModeManager,
            rateLimiter: this.rateLimiter,
            db: this.gameModeManager?.db
        });
        
        // Initialize chat history (async, non-blocking)
        this.chatHandler.initialize().catch(err => {
            console.error('Failed to initialize chat handler:', err.message);
        });

        // Initialize queue handler
        this.queueHandler = new QueueHandler({
            queueManager: this.queueManager,
            gameModeManager: this.gameModeManager,
            paymentHandlers: this.paymentHandlers,
            activeGames: this.activeGames,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            rateLimiter: this.rateLimiter
        });

        // Initialize spectator manager for live game viewing
        this.spectatorManager = new SpectatorManager({
            io: this.io,
            activeGames: this.activeGames,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            queueManager: this.queueManager // For pending games list
        });
        this.spectatorManager.initialize();
        
        // Wire spectator manager to game manager (for game over notifications)
        this.gameManager.setSpectatorManager(this.spectatorManager);

        // Movement manager abstraction with memory cleanup
        this.playerMoveTimestamps = new Map();
        this.movementManager = new MovementManager({
            activeGames: this.activeGames,
            io: this.io,
            debugManager: this.debugManager,
            moveCooldown: this.MOVE_COOLDOWN,
            postMoveHook: ({ socketId, game, moveResult }) => this.afterPlayerMove(socketId, game, moveResult),
            spectatorManager: this.spectatorManager // Pass for spectator broadcasts
        });

        // Register memory cleanup functions
        this._registerMemoryCleanups();
    }

    /**
     * Register memory cleanup functions to prevent memory leaks
     */
    _registerMemoryCleanups() {
        // Cleanup player move timestamps (keep for 5 minutes)
        this.memoryManager.registerCleanup(
            'playerMoveTimestamps',
            () => {
                const now = Date.now();
                const maxAge = 300000; // 5 minutes
                let cleaned = 0;
                const toDelete = [];
                
                for (const [socketId, timestamp] of this.playerMoveTimestamps.entries()) {
                    if (now - timestamp > maxAge) {
                        toDelete.push(socketId);
                    }
                }
                
                for (const socketId of toDelete) {
                    if (this.playerMoveTimestamps.delete(socketId)) {
                        cleaned++;
                    }
                }
                
                return cleaned;
            },
            300000
        );

        // Cleanup mempool notifications (keep for 10 minutes)  
        this.memoryManager.registerCleanup(
            'mempoolNotifications', 
            MemoryManager.createSetCleanup(this.mempoolNotified, (addr) => {
                // This is a simple heuristic - in production you'd want to track timestamps
                return Math.random() < 0.1; // Randomly clean ~10% each cycle
            }),
            600000
        );

        // Let other components register their cleanups
        if (this.rateLimiter) {
            this.memoryManager.registerCleanup(
                'rateLimiterCleanup',
                () => { this.rateLimiter.cleanup(); return 0; },
                60000
            );
        }
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

            if (typeof game.moveMonster === 'function') {
                game.moveMonster();
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
    afterPlayerMove(socketId, game, moveResult) {
        // Check if player walked into monster (death by walking into monster)
        if (moveResult && moveResult.event === 'monster_caught') {
            const fakeSocket = { id: socketId };
            this.handleGameOver(fakeSocket, game, 'lost', 'monster', 'You walked into the monster!', 0);
            return;
        }

        // If player escaped, handle via game manager
        if (moveResult && moveResult.event === 'escaped') {
            const fakeSocket = { id: socketId };
            this.handleGameOver(fakeSocket, game, 'won', 'escaped', 'You escaped the dungeon!', 0);
            return;
        }

        let monsterResult = null;

        // Move monster one step toward player each player action
        if (game && typeof game.moveMonster === 'function') {
            try {
                monsterResult = game.moveMonster();
            } catch (e) {
                console.error('Monster move error:', e);
            }
        }

        // If the monster caught the player after moving, end the game immediately
        if (monsterResult && monsterResult.event === 'monster_caught') {
            const fakeSocket = { id: socketId };
            this.handleGameOver(fakeSocket, game, 'lost', 'monster', 'You were caught by the monster!', 0);
            return;
        }

        // Re-emit state if treasure collected without auto game_update (fallback)
        if (moveResult && moveResult.event === 'treasure_found') {
            this.movementManager.emitGameUpdate(socketId);
        }
    }

    /**
     * Initialize socket event handlers for a new connection
     */
    async handleConnection(socket) {
        const connectionResult = await this.connectionHandler.handleConnection(socket);
        if (!connectionResult) return; // Connection was rejected or failed

        const { sessionInfo } = connectionResult;

        // Restore queue status if session resumed
        if (sessionInfo && sessionInfo.resumed && sessionInfo.user && this.queueManager) {
            const wasUpdated = this.queueManager.updateSocketId(sessionInfo.user.id, socket.id);
            if (wasUpdated) {
                const position = this.queueManager.getQueuePosition(socket.id);
                if (position !== -1) {
                    this.broadcastManager.sendStatusUpdate(socket.id, 'queue', 
                        `Welcome back! You are still in the queue at position ${position}.`);
                    socket.emit('queue_joined', { 
                        position: position,
                        message: `Welcome back! You are still in queue.`,
                        currentBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null,
                        nextBlock: (this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : 0) + 1
                    });
                }
            }
        }

        // Send game mode info to client
        if (this.gameModeManager) {
            socket.emit('game_mode_info', this.gameModeManager.getGameModeInfo());
        }

        // Send chat history to new user
        if (this.chatHandler && typeof this.chatHandler.sendChatHistoryToUser === 'function') {
            this.chatHandler.sendChatHistoryToUser(socket.id).catch(err => {
                console.error('Failed to send chat history:', err.message);
            });
        }

        // Join the lobby room for game list broadcasts
        if (this.spectatorManager) {
            this.spectatorManager.joinLobby(socket.id);
            // Send initial game list
            const gameList = this.spectatorManager.getActiveGamesList({ page: 1, pageSize: 20 });
            socket.emit('active_games', gameList);
        }

        // Register event handlers
        socket.on('chat message', (msg) => this.chatHandler.handleChatMessage(socket, msg, {
            handleGameQueue: (socket) => this.queueHandler.handleGameQueue(socket, (socketId) => this.connectionHandler.getUserBySocket(socketId)),
            handleCancelEntry: (socket) => this.queueHandler.handleCancelEntry(socket),
            handleStatsRequest: (socket) => this.handleStatsRequest(socket)
        }));
    socket.on('player_move', (moveData) => this.movementManager.handleMove(socket.id, moveData));
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('debug_ping', (data) => this.handleDebugPing(socket, data));
        socket.on('register_client', (data) => {
            this.connectionHandler.handleRegisterClient(socket, data);
            // Re-send game mode info after client registers handlers (fixes race condition)
            if (this.gameModeManager) {
                socket.emit('game_mode_info', this.gameModeManager.getGameModeInfo());
            }
        });
        socket.on('auto_start', () => this.handleAutoStart(socket)); // New handler for start button
        socket.on('early_entry', () => this.handleEarlyEntry(socket)); // Early entry without waiting for block
        socket.on('address:prompt', () => this.handleAddressPrompt(socket));
        
        // Payment system handlers
        socket.on('request_payment', (data) => this.paymentHandlers.handlePaymentRequest(socket, data));
        socket.on('check_payment_status', (data) => this.handleCheckPaymentStatus(socket, data));
        socket.on('get_user_credits', () => this.handleGetUserCredits(socket));
        socket.on('address:update', (data) => this.handleAddressUpdate(socket, data));
        
        // Spectator handlers
        socket.on('get_active_games', (options) => this.handleGetActiveGames(socket, options));
        socket.on('spectate_game', (data) => this.handleSpectateGame(socket, data));
        socket.on('leave_spectate', () => this.handleLeaveSpectate(socket));
    }

    /**
     * Handle immediate start button (auto_start)
     * Applies payment eligibility + payout address gating (for payout-eligible modes)
     * If eligible, starts game immediately (bypassing block queue) and processes game start (credit deduction / payment linkage)
     */
    async handleAutoStart(socket) {
        try {
            // Rate limiting for game starts
            const rateLimitResult = await this.rateLimiter.checkLimit(socket.id, 'game:start');
            if (!rateLimitResult.allowed) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 
                    `Please wait ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds before starting another game. (${rateLimitResult.remaining} attempts remaining)`);
                return;
            }

            const existingGame = this.activeGames.get(socket.id);
            if (existingGame) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'You are already in a game!');
                return;
            }

            const memUser = this.connectionHandler.getUserBySocket(socket.id);
            if (!memUser) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Could not start game (user not found). Please reconnect.');
                return;
            }

            let canStart = { allowed: true, reason: 'Free mode' };
            if (this.gameModeManager) {
                // Payout address gating for modes that can payout
                const payoutEligible = (this.gameModeManager.gameMode === 'PAID_SINGLE') || (this.gameModeManager.gameMode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
                if (payoutEligible) {
                    try {
                        const dbUser = await this.gameModeManager.getOrCreateUser(socket.id);
                        if (!dbUser.payout_address) {
                            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '⚠️ Use the "Manage Payout Address" button or paste your payout address here and type confirm. Payment request will appear automatically.');
                            return;
                        }
                    } catch (e) {
                        console.error('Payout address pre-check failed:', e.message);
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Address check failed, try again.');
                        return;
                    }
                }

                try {
                    canStart = await this.gameModeManager.canUserStartGame(socket.id);
                } catch (e) {
                    console.error('Eligibility check failed:', e.message);
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Eligibility check failed.');
                    return;
                }

                if (!canStart.allowed) {
                    // Trigger payment request automatically
                    if (canStart.action === 'make_payment' || canStart.action === 'purchase_credits') {
                        await this.paymentHandlers.createAndShowPaymentRequest(socket);
                        return;
                    }
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', canStart.reason || 'Not allowed to start');
                    return;
                }
            }

            // Record the game start attempt
            await this.rateLimiter.recordAttempt(socket.id, 'game:start');

            // Create game immediately
            const blockHeight = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
            memUser.blockRec = blockHeight; // keep legacy timeout logic consistent
            const game = this.gameManager.createGameForUser(memUser, 'standard');
            const state = game.getState();
            state.blockHeight = blockHeight;
            
            // Include provably fair commitment
            if (game.getProofCommitment) {
                state.proof = game.getProofCommitment();
            }

            // Process start (credits deduction / payment link)
            if (this.gameModeManager) {
                const startRes = await this.gameModeManager.processGameStart(socket.id, game.id);
                if (!startRes.success) {
                    // Abort game
                    this.activeGames.delete(socket.id);
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', startRes.reason || 'Failed to start game.');
                    return;
                }
                // Emit credits_update if credits were spent
                if (startRes.creditsRemaining !== undefined) {
                    this.io.to(socket.id).emit('credits_update', { balance: startRes.creditsRemaining });
                }
            }

            this.io.to(socket.id).emit('game_start', state);
            this.broadcastManager.sendStatusUpdate(socket.id, 'success', 'Game started! Escape before the next block!');
        } catch (err) {
            console.error('handleAutoStart error:', err);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Unexpected error starting game.');
        }
    }

    /**
     * Handle early entry request - start game immediately without waiting for block
     * Only available for free mode and credits mode (not direct payment mode)
     */
    async handleEarlyEntry(socket) {
        try {
            const result = await this.queueHandler.handleEarlyEntry(
                socket, 
                this.connectionHandler.getUserBySocket.bind(this.connectionHandler)
            );
            
            if (result.success) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`⚡ Early entry successful for ${socket.id}`);
                }
            }
        } catch (err) {
            console.error('handleEarlyEntry error:', err);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Unexpected error with early entry.');
        }
    }

    async handleAddressPrompt(socket) {
        try {
            if (this.chatHandler && typeof this.chatHandler.promptAddress === 'function') {
                await this.chatHandler.promptAddress(socket);
                return;
            }

            let existingAddress = null;
            if (this.gameModeManager) {
                try {
                    const userRow = await this.gameModeManager.getOrCreateUser(socket.id);
                    existingAddress = userRow?.payout_address || null;
                } catch (err) {
                    if (this.debugManager?.CONSOLE_LOGGING) {
                        console.warn('Address prompt lookup failed:', err.message);
                    }
                }
            }

            this.io.to(socket.id).emit('address_prompt', {
                existingAddress,
                message: existingAddress ? 'Update your payout address anytime.' : 'Add a payout address to receive rewards.'
            });
        } catch (error) {
            const normalized = normalizeError(error, 'Unable to open address manager');
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', normalized.safeMessage || 'Address manager unavailable.');
        }
    }

    async handleAddressUpdate(socket, data) {
        try {
            const address = typeof data?.address === 'string' ? data.address.trim() : '';
            if (!address) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'Please enter a payout address before saving.');
                this.io.to(socket.id).emit('address_update_error', { message: 'Please enter a payout address before saving.' });
                return;
            }

            const rateLimitResult = await this.rateLimiter.checkLimit(socket.id, 'address:set');
            if (!rateLimitResult.allowed) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 
                    `Address changes are rate limited. Try again in ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds.`);
                this.io.to(socket.id).emit('address_update_error', { message: 'Address changes are temporarily rate limited.' });
                return;
            }

            await this.rateLimiter.recordAttempt(socket.id, 'address:set');

            await this.addressManager.saveAddress(socket.id, address);
        } catch (err) {
            const normalized = normalizeError?.(err, 'Failed to update payout address') || err;
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', normalized.safeMessage || 'Failed to update payout address.');
            this.io.to(socket.id).emit('address_update_error', { message: normalized.safeMessage || 'Failed to update payout address.' });
        }
    }

    /** Return the active socket instance by id (io.sockets.sockets Map) */
    _getLiveSocket(socketId) {
        try {
            return this.io.sockets.sockets.get(socketId) || null;
        } catch(_) { return null; }
    }

    /**
     * Handle game entry request (legacy method - now delegates to queue)
     */
    handleGameEntry(socket) {
        return this.handleGameQueue(socket);
    }

    /**
     * Handle game queue request (delegates to QueueHandler)
     */
    async handleGameQueue(socket) {
        return this.queueHandler.handleGameQueue(socket, (socketId) => this.connectionHandler.getUserBySocket(socketId));
    }

    /**
     * Handle queue cancellation (delegates to QueueHandler)
     */
    handleCancelEntry(socket) {
        return this.queueHandler.handleCancelEntry(socket);
    }

    /**
     * Handle stats request
     */
    async handleStatsRequest(socket) {
        try {
            const stats = {
                rateLimiter: this.rateLimiter.getStats(),
                memoryManager: this.memoryManager.getStats(),
                connections: this.connectionHandler.getStats(),
                chat: this.chatHandler.getStats(),
                activeGames: this.activeGames.size,
                queueLength: this.queueManager.getQueueLength()
            };

            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                `Server Stats: ${stats.activeGames} active games, ${stats.queueLength} in queue, ${stats.connections.clientSocketMappings} connections`);
        } catch (error) {
            console.error('handleStatsRequest error:', error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Failed to get stats.');
        }
    }

    /**
     * Handle game over scenarios (delegates to GameManager)
     */
    async handleGameOver(socket, game, status, reason, message, score = 0) {
        return this.gameManager.handleGameOver(socket, game, status, reason, message, score);
    }

    /**
     * Handle client disconnection with proper cleanup
     */
    handleDisconnect(socket) {
        // Use connection handler for main disconnect logic
        this.connectionHandler.handleDisconnect(socket, (socket) => {
            // Additional cleanup specific to socket handlers
            
            // Clean up payment monitoring
            if (this.paymentHandlers && typeof this.paymentHandlers.stopMonitoringForSocket === 'function') {
                this.paymentHandlers.stopMonitoringForSocket(socket.id);
            }
            
            // Clean up movement timestamps
            this.playerMoveTimestamps.delete(socket.id);
            
            // Clean up active games
            this.activeGames.delete(socket.id);
            
            // Remove from queue manager if not a "valuable" entry (persistent session or payment)
            // This allows users who paid but disconnected to stay in the queue for session resumption
            if (this.queueManager && typeof this.queueManager.removePlayer === 'function') {
                if (this.queueManager.isValuableEntry && !this.queueManager.isValuableEntry(socket.id)) {
                    this.queueManager.removePlayer(socket.id);
                } else if (this.debugManager.CONSOLE_LOGGING && this.queueManager.isValuableEntry && this.queueManager.isValuableEntry(socket.id)) {
                    console.log(`[SocketHandlers] Preserving queue entry for ${socket.id} (user has session/payment)`);
                } else if (!this.queueManager.isValuableEntry) {
                    // Fallback for safety if method not found
                    this.queueManager.removePlayer(socket.id);
                }
            }
            
            // Clear any pending address confirmations
            if (this.chatHandler) {
                this.chatHandler.clearAddressConfirmation(socket.id);
            }
            
            // Clean up spectator state
            if (this.spectatorManager) {
                this.spectatorManager.handleDisconnect(socket.id);
            }
        });
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

    // Helper methods

    /**
     * Get user by socket ID with fallback mapping (delegates to connection handler)
     */
    getUserBySocket(socketId) {
        return this.connectionHandler.getUserBySocket(socketId);
    }

    // Helper methods (delegated to other managers)

    /**
     * Create a new game for a user (delegates to GameManager)
     */
    createGameForUser(user, gameType = 'standard', options = {}) {
        return this.gameManager.createGameForUser(user, gameType, options);
    }

    /**
     * Check if monster caught player (delegates to GameManager)
     */
    checkMonsterKill(player, monster) {
        return this.gameManager.checkMonsterKill(player, monster);
    }

    /**
     * Log game update debug information (delegates to GameManager)
     */
    logGameUpdate(socketId, gameState) {
        return this.gameManager.logGameUpdate(socketId, gameState);
    }

    // Queue management methods (delegates to QueueHandler)
    
    /**
     * Start games for waiting players when a new block is found
     */
    async startGamesForWaiting(blockHeight) {
        return await this.queueHandler.startGamesForWaiting(blockHeight);
    }

    /**
     * Check for game timeouts based on block height
     */
    checkGamesTimeout(currentHeight) {
        this.activeGames.forEach((game, socketId) => {
            const user = this.connectionHandler.getUserBySocket(socketId);
            
            if (user && user.blockRec && currentHeight > user.blockRec) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`💀 GAME TIMEOUT for player ${socketId}: entered on block ${user.blockRec}, died on block ${currentHeight}`);
                }
                
                game.gameState = 'lost';
                const fakeSocket = { id: socketId };
                this.handleGameOver(fakeSocket, game, 'lost', 'timeout', 'You didn\'t escape before the block time limit!');
            }
        });
    }

    // Payment system handlers (placeholder for compatibility)
    async handleCheckPaymentStatus(socket, data) {
        if (this.paymentHandlers && typeof this.paymentHandlers.handleCheckPaymentStatus === 'function') {
            return this.paymentHandlers.handleCheckPaymentStatus(socket, data);
        }
    }

    async handleGetUserCredits(socket) {
        if (this.paymentHandlers && typeof this.paymentHandlers.handleGetUserCredits === 'function') {
            return this.paymentHandlers.handleGetUserCredits(socket);
        }
    }

    // ====== SPECTATOR HANDLERS ======

    /**
     * Handle request for active games list
     */
    handleGetActiveGames(socket, options = {}) {
        try {
            const gameList = this.spectatorManager.getActiveGamesList(options);
            socket.emit('active_games', gameList);
        } catch (err) {
            console.error('handleGetActiveGames error:', err);
            socket.emit('error', { message: 'Failed to get games list' });
        }
    }

    /**
     * Handle request to spectate a specific game
     */
    handleSpectateGame(socket, data) {
        try {
            if (!data || !data.gameId) {
                socket.emit('spectate_error', { message: 'Game ID is required' });
                return;
            }

            // Check if user is currently in a game (can't spectate while playing)
            if (this.activeGames.has(socket.id)) {
                socket.emit('spectate_error', { message: 'Cannot spectate while in a game' });
                return;
            }

            // Leave lobby when starting to spectate
            this.spectatorManager.leaveLobby(socket.id);

            const result = this.spectatorManager.addSpectator(socket.id, data.gameId);
            
            if (result.success) {
                socket.emit('spectate_start', {
                    gameId: result.gameId,
                    playerId: result.playerSocketId?.substring(0, 6),
                    initialState: result.initialState,
                    spectatorCount: result.spectatorCount
                });
                
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    `👁️ Now spectating game by player ${result.playerSocketId?.substring(0, 6)}`);
            } else {
                socket.emit('spectate_error', { message: result.reason });
                // Rejoin lobby if spectating failed
                this.spectatorManager.joinLobby(socket.id);
            }
        } catch (err) {
            console.error('handleSpectateGame error:', err);
            socket.emit('spectate_error', { message: 'Failed to join game as spectator' });
        }
    }

    /**
     * Handle request to leave spectating
     */
    handleLeaveSpectate(socket) {
        try {
            const wasSpectating = this.spectatorManager.removeSpectator(socket.id);
            
            if (wasSpectating) {
                socket.emit('spectate_ended', { reason: 'user_left' });
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', '👁️ Left spectator mode');
            }
            
            // Rejoin lobby
            this.spectatorManager.joinLobby(socket.id);
            
            // Send updated games list
            const gameList = this.spectatorManager.getActiveGamesList({ page: 1, pageSize: 20 });
            socket.emit('active_games', gameList);
        } catch (err) {
            console.error('handleLeaveSpectate error:', err);
        }
    }

    /**
     * Get comprehensive statistics
     */
    getStats() {
        return {
            activeGames: this.activeGames.size,
            rateLimiter: this.rateLimiter.getStats(),
            memoryManager: this.memoryManager.getStats(),
            connections: this.connectionHandler.getStats(),
            chat: this.chatHandler.getStats(),
            games: this.gameManager.getStats(),
            queue: this.queueHandler.getStats(),
            spectators: this.spectatorManager ? this.spectatorManager.getStats() : null
        };
    }

    /**
     * Shutdown method to clean up all resources and prevent memory leaks
     */
    async shutdown() {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('🛑 SocketHandlers shutting down...');
        }

        // Shutdown components in reverse order of initialization
        if (this.spectatorManager) {
            this.spectatorManager.shutdown();
        }

        if (this.chatHandler) {
            this.chatHandler.shutdown();
        }

        if (this.connectionHandler) {
            this.connectionHandler.shutdown();
        }

        if (this.rateLimiter) {
            this.rateLimiter.shutdown();
        }

        if (this.memoryManager) {
            // Force final cleanup before shutdown
            await this.memoryManager.forceCleanup();
            this.memoryManager.shutdown();
        }

        // Clear remaining data structures
        this.activeGames.clear();
        this.playerMoveTimestamps.clear();
        this.mempoolNotified.clear();

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('✅ SocketHandlers shutdown complete');
        }
    }
}

module.exports = SocketHandlers;
