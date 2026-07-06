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
const { clientIp, stableId } = require('./rateLimitContext');
const ConnectionHandler = require('./connectionHandler');
const ChatHandler = require('./chatHandler');
const QueueHandler = require('./queueHandler');
const SpectatorManager = require('./spectatorManager');
const TavernManager = require('./tavernManager');
const IdentityService = require('./identityService');
const SuspendedGameManager = require('./suspendedGameManager');
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
                'identity:update': { window: 10000, max: 8 },
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

        // Initialize session manager first
        if (this.gameModeManager && this.gameModeManager.db) {
            this.sessionManager = new SessionManager({
                db: this.gameModeManager.db,
                debugManager: this.debugManager,
                gameModeManager: this.gameModeManager
            });
            // IDENTITY (Phase 2.1): give GameModeManager the session manager so getOrCreateUser
            // resolves through the stable anon_token identity instead of the mutable socket_id.
            this.gameModeManager.sessionManager = this.sessionManager;
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
            createGameForUser: async (userObj, gameType, options) => {
                const game = await this.gameManager.createGameForUser(userObj, gameType, options);
                // Stamp the stable DB user id onto the game at creation. Suspend/restore keys
                // on this id; capturing it now (when we reliably have the session) means the
                // disconnect path never needs a fresh, failure-prone DB lookup to preserve a
                // game — so ANY game, paid or free, is reconnectable.
                try {
                    const sid = userObj?.id;
                    const dbUid = sid != null ? this.sessionManager?.sessions?.get(sid)?.id : null;
                    if (game && dbUid != null) game.dbUserId = dbUid;
                } catch (_) {}
                return game;
            },
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

        this.identityService = new IdentityService({
            db: this.gameModeManager?.db,
            gameModeManager: this.gameModeManager,
            sessionManager: this.sessionManager,
            debugManager: this.debugManager
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

        // Initialize tavern manager (social hangout mode). Inert unless TAVERN_ENABLED=true.
        // Load the designed tavern room (imported .tmx); fall back to the procedural map if absent.
        let tavernRoomData = null;
        const tavernRoomUrl = 'assets/kenney/tavern_room.json';
        try {
            const roomPath = require('path').join(__dirname, '../../html', tavernRoomUrl);
            tavernRoomData = JSON.parse(require('fs').readFileSync(roomPath, 'utf8'));
        } catch (e) {
            if (this.debugManager.CONSOLE_LOGGING) console.log('Tavern room JSON not found; using default map:', e.message);
        }
        this.tavernManager = new TavernManager({
            io: this.io,
            debugManager: this.debugManager,
            roomData: tavernRoomData,
            roomUrl: tavernRoomData ? tavernRoomUrl : null,
            entitlementProvider: async (socket) => this._entitlementsForSocket(socket)
        });
        this.tavernManager.initialize();

        // Initialize suspended game manager for reconnection support
        this.suspendedGameManager = new SuspendedGameManager({
            debugManager: this.debugManager,
            activeGames: this.activeGames,
            cleanupTimeoutMs: 300000 // 5 minutes to reconnect before game is lost
        });

        // Movement manager abstraction (owns its own move-cooldown state)
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
        // (mempool-notification dedup + TTL eviction lives in PaymentHandlers, which owns
        // the actual dedup set; the old SocketHandlers copy here was unused and is removed.)

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
        const dbUserId = sessionInfo?.user?.id;
        
        // Check for suspended game to restore (must happen BEFORE queue restoration)
        let restoredGame = null;
        if (sessionInfo && sessionInfo.resumed && dbUserId && this.suspendedGameManager) {
            if (this.suspendedGameManager.hasSuspendedGame(dbUserId)) {
                const memUser = this.connectionHandler.getUserBySocket(socket.id);
                const restored = this.suspendedGameManager.restoreGame(dbUserId, socket.id, memUser);
                
                if (restored) {
                    restoredGame = restored.game;
                    const suspendedState = restored.suspendedState;
                    
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`🔄 [handleConnection] Restored game ${restoredGame.id} for user ${dbUserId}`);
                    }
                    
                    // Re-emit the game state to the reconnecting client
                    const gameState = restoredGame.getState();
                    gameState.restored = true;
                    gameState.restoredMessage = 'Game restored! Continue playing.';
                    
                    // Include provably fair commitment
                    if (restoredGame.getProofCommitment) {
                        gameState.proof = restoredGame.getProofCommitment();
                    }
                    
                    // Send game_start to resume the game on client
                    socket.emit('game_start', gameState);
                    
                    // Also send a status message
                    this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                        'Welcome back! Your game has been restored.');
                    
                    // Restore payment monitoring if it was active
                    if (suspendedState.paymentMonitoringActive && this.paymentHandlers) {
                        this._restorePaymentMonitoring(socket, dbUserId);
                    }
                }
            }
        }

        // Restore queue status if session resumed (only if no game was restored)
        if (!restoredGame && sessionInfo && sessionInfo.resumed && sessionInfo.user && this.queueManager) {
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
                    
                    // Check for pending payment and restore monitoring
                    this._restorePaymentMonitoring(socket, dbUserId);
                }
            }
        }

        // Send game mode info to client
        if (this.gameModeManager) {
            socket.emit('game_mode_info', this.gameModeManager.getGameModeInfo());
        }
        this._emitIdentity(socket).catch(err => {
            if (this.debugManager?.CONSOLE_LOGGING) console.warn('Failed to send identity snapshot:', err.message);
        });

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
        socket.on('register_client', async (data) => {
            this.connectionHandler.handleRegisterClient(socket, data);
            // Re-send game mode info after client registers handlers (fixes race condition)
            if (this.gameModeManager) {
                socket.emit('game_mode_info', this.gameModeManager.getGameModeInfo());
            }
            // Re-send credits_update (same race condition — event may arrive before handlers register)
            if (this.sessionManager) {
                try {
                    const sessionUser = await this.sessionManager.getBySocket(socket.id);
                    if (sessionUser) {
                        socket.emit('credits_update', {
                            balance: sessionUser.credits || 0,
                            totalCreditsPurchased: sessionUser.total_credits_purchased || 0,
                            creditsPerGame: this.gameModeManager?.creditsPerGameCost || 1
                        });
                    }
                } catch (e) { /* ignore — credits will update on next action */ }
            }
            this._emitIdentity(socket).catch(err => {
                if (this.debugManager?.CONSOLE_LOGGING) console.warn('Failed to re-send identity snapshot:', err.message);
            });
        });
        socket.on('auto_start', () => this.handleAutoStart(socket)); // New handler for start button
        socket.on('play_free', () => this.handleAutoStart(socket, { free: true })); // Explicit free-play choice
        socket.on('join_queue', () => this.handleJoinQueue(socket)); // Queue instead of auto-start
        socket.on('early_entry', () => this.handleEarlyEntry(socket)); // Early entry without waiting for block
        socket.on('address:prompt', () => this.handleAddressPrompt(socket));
        
        // Payment system handlers
        socket.on('request_payment', (data) => this.paymentHandlers.handlePaymentRequest(socket, data));
        socket.on('check_payment_status', (data) => this.handleCheckPaymentStatus(socket, data));
        socket.on('get_user_credits', () => this.handleGetUserCredits(socket));
        socket.on('address:update', (data) => this.handleAddressUpdate(socket, data));
        socket.on('identity:get', () => this.handleIdentityGet(socket));
        socket.on('identity:update', (data) => this.handleIdentityUpdate(socket, data));
        
        // Spectator handlers
        socket.on('get_active_games', (options) => this.handleGetActiveGames(socket, options));
        socket.on('spectate_game', (data) => this.handleSpectateGame(socket, data));
        socket.on('leave_spectate', () => this.handleLeaveSpectate(socket));

        // Tavern handlers (social hangout mode; refused server-side unless enabled)
        socket.on('tavern_join', (data) => {
            Promise.resolve(this.tavernManager.join(socket, data)).catch(err => {
                console.error('Tavern join failed:', err.message);
                socket.emit('tavern_error', { message: 'Could not enter the tavern.' });
            });
        });
        socket.on('tavern_move', (data) => this.tavernManager.move(socket, data));
        socket.on('tavern_chat', (data) => this.tavernManager.chat(socket, data));
        socket.on('tavern_leave', () => this.tavernManager.leave(socket));
    }

    /**
     * Handle immediate start button (auto_start)
     * Applies payment eligibility + payout address gating (for payout-eligible modes)
     * If eligible, starts game immediately (bypassing block queue) and processes game start (credit deduction / payment linkage)
     */
    async handleAutoStart(socket, opts = {}) {
        try {
            // The player explicitly chose FREE play (Pleb board, no payment/payout). Only
            // honoured when the instance allows free play; otherwise fall through to paid.
            const wantsFree = opts.free === true && this.gameModeManager?.freePlayEnabled;

            // Rate limiting for game starts — keyed on stable identity + IP so reconnecting
            // (new socket.id) can't reset the limit.
            const rlId = stableId(socket, this.sessionManager);
            const rlIp = clientIp(socket);
            const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'game:start', rlIp);
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
            // Free play skips all payment/credits/payout-address gating below.
            if (this.gameModeManager && !wantsFree) {
                // Payout address gating for modes that can payout
                const payoutEligible = (this.gameModeManager.gameMode === 'PAID_SINGLE') || (this.gameModeManager.gameMode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
                if (payoutEligible) {
                    try {
                        // Always do fresh DB lookup for payout address (cache may be stale after address update)
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
                    // Trigger payment request automatically for any payment-related action
                    if (canStart.action === 'make_payment' || canStart.action === 'purchase_credits' || canStart.action === 'choose_payment') {
                        await this.paymentHandlers.createAndShowPaymentRequest(socket);
                        return;
                    }
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', canStart.reason || 'Not allowed to start');
                    return;
                }
            }

            // Record the game start attempt (same stable id + IP as the check above)
            await this.rateLimiter.recordAttempt(rlId, 'game:start', rlIp);

            // Create game immediately
            const blockHeight = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
            memUser.blockRec = blockHeight; // keep legacy timeout logic consistent
            const game = await this.gameManager.createGameForUser(memUser, 'standard');
            const state = game.getState();
            state.blockHeight = blockHeight;
            
            // Include provably fair commitment
            if (game.getProofCommitment) {
                state.proof = game.getProofCommitment();
            }

            // Process start (free / credits deduction / payment link)
            if (this.gameModeManager) {
                const startRes = await this.gameModeManager.processGameStart(socket.id, game.id, { forceFree: wantsFree });
                if (!startRes.success) {
                    // Abort game
                    this.activeGames.delete(socket.id);
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', startRes.reason || 'Failed to start game.');
                    return;
                }
                // Emit credits_update if credits were spent
                if (startRes.creditsRemaining !== undefined) {
                    this.io.to(socket.id).emit('credits_update', {
                        balance: startRes.creditsRemaining,
                        totalCreditsPurchased: startRes.totalCreditsPurchased || 0
                    });
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
     * Handle join_queue request — adds player to block queue instead of starting immediately
     */
    async handleJoinQueue(socket) {
        try {
            await this.queueHandler.handleGameQueue(
                socket,
                this.connectionHandler.getUserBySocket.bind(this.connectionHandler)
            );
            // queueHandler already emits queue status and adds to queue
            // Client receives queue_joined event from broadcastManager
            const pos = this.queueManager.getPlayerIndex(socket.id);
            if (pos !== -1) {
                const currentBlock = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : 0;
                socket.emit('queue_joined', {
                    position: pos + 1,
                    currentBlock: currentBlock,
                    nextBlock: currentBlock + 1
                });
            }
        } catch (err) {
            console.error('handleJoinQueue error:', err);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Failed to join queue.');
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

            const rlId = stableId(socket, this.sessionManager);
            const rlIp = clientIp(socket);
            const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'address:set', rlIp);
            if (!rateLimitResult.allowed) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                    `Address changes are rate limited. Try again in ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds.`);
                this.io.to(socket.id).emit('address_update_error', { message: 'Address changes are temporarily rate limited.' });
                return;
            }

            await this.rateLimiter.recordAttempt(rlId, 'address:set', rlIp);

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
     * Preserves game state for reconnection when user has a valid session
     */
    handleDisconnect(socket) {
        // Use connection handler for main disconnect logic
        this.connectionHandler.handleDisconnect(socket, async (socket) => {
            const socketId = socket.id;
            
            const activeGame = this.activeGames.get(socketId);

            // Resolve the stable DB user id that suspend/restore keys on. Preference order:
            //   1. the id stamped on the game at creation (always present for any game
            //      started with a session) — no lookup, can't fail,
            //   2. the in-memory session cache,
            //   3. a DB lookup as a last resort.
            // Every game — paid or free — is preserved and reconnectable as long as a stable
            // id resolves, which it does whenever a session was ever established.
            let dbUserId = activeGame?.dbUserId || null;
            if (!dbUserId && this.sessionManager) {
                try { dbUserId = this.sessionManager.sessions?.get(socketId)?.id || null; } catch (_) {}
                if (!dbUserId) {
                    try { const u = await this.sessionManager.getBySocket(socketId); dbUserId = u?.id || null; } catch (_) {}
                }
            }

            if (activeGame && dbUserId && this.suspendedGameManager) {
                // Suspend the game so it can be restored on reconnect (keyed by dbUserId).
                const suspended = this.suspendedGameManager.suspendGame(dbUserId, socketId, activeGame, {
                    paymentMonitoringActive: this.paymentHandlers?.hasActiveMonitoring?.(socketId) || false
                });
                this.activeGames.delete(socketId);
                if (suspended) {
                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`[SocketHandlers] Game suspended for user ${dbUserId} (socket: ${socketId})`);
                    }
                } else {
                    console.error(`[SocketHandlers] suspendGame returned false for user ${dbUserId} (socket ${socketId}); game ${activeGame.id || 'unknown'} not restorable.`);
                }
            } else {
                if (activeGame) {
                    // Reachable only when no stable identity resolved at all — i.e. a session
                    // was never established (e.g. DB unavailable at connect), so there is
                    // genuinely no id to restore the game under. Record it for auditing.
                    console.error(`[SocketHandlers] Active game dropped without suspension — no stable user id `
                        + `(socket=${socketId}, mode=${activeGame.paymentMode || activeGame.gameMode || 'unknown'}, `
                        + `gameId=${activeGame.id || 'unknown'}). Cannot restore a game without a session identity.`);
                }
                this.activeGames.delete(socketId);
            }
            
            // Clean up payment monitoring (but remember it was active for restoration)
            if (this.paymentHandlers && typeof this.paymentHandlers.stopMonitoringForSocket === 'function') {
                this.paymentHandlers.stopMonitoringForSocket(socketId);
            }

            // NOTE: Do NOT call walletService.cleanupUserPayments() here.
            // addressToUser entries must persist so checkPaymentStatus() can query the wallet
            // RPC after session resumption. They get cleaned up when payments are confirmed or expired.
            
            // Preserve queue entry for users with session/payment
            // The queue entry's socketId will be updated on reconnection
            if (this.queueManager && typeof this.queueManager.removePlayer === 'function') {
                if (this.queueManager.isValuableEntry && !this.queueManager.isValuableEntry(socketId)) {
                    this.queueManager.removePlayer(socketId);
                } else if (this.debugManager.CONSOLE_LOGGING && this.queueManager.isValuableEntry && this.queueManager.isValuableEntry(socketId)) {
                    console.log(`[SocketHandlers] Preserving queue entry for ${socketId} (user has session/payment)`);
                } else if (!this.queueManager.isValuableEntry) {
                    // Fallback for safety if method not found
                    this.queueManager.removePlayer(socketId);
                }
            }
            
            // Clear any pending address confirmations
            if (this.chatHandler) {
                this.chatHandler.clearAddressConfirmation(socketId);
            }
            
            // Clean up spectator state
            if (this.spectatorManager) {
                this.spectatorManager.handleDisconnect(socketId);
            }

            // Clean up tavern presence
            if (this.tavernManager) {
                this.tavernManager.handleDisconnect(socketId);
            }

            // Evict the cached session row LAST (after the suspend logic above read it),
            // so the sessions map doesn't grow unbounded with every socket ever seen.
            if (this.sessionManager?.removeSocket) {
                this.sessionManager.removeSocket(socketId);
            }
        });
    }

    async _emitIdentity(socket, extra = {}) {
        if (!this.identityService || !socket) return null;
        const snapshot = await this.identityService.identityForSocket(socket);
        socket.emit('identity_update', { ...snapshot, ...extra });
        return snapshot;
    }

    async _entitlementsForSocket(socket) {
        if (!this.identityService || !socket) return { premium: false, level: 'free', packs: {}, totalCreditsPurchased: 0 };
        return this.identityService.entitlementsForSocket(socket);
    }

    async handleIdentityGet(socket) {
        try {
            await this._emitIdentity(socket);
        } catch (err) {
            socket.emit('identity_error', { message: 'Could not load character identity.' });
        }
    }

    async handleIdentityUpdate(socket, data = {}) {
        try {
            const rlId = stableId(socket, this.sessionManager);
            const rlIp = clientIp(socket);
            const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'identity:update', rlIp);
            if (!rateLimitResult.allowed) {
                socket.emit('identity_error', { message: 'Character changes are temporarily rate limited.' });
                return;
            }
            await this.rateLimiter.recordAttempt(rlId, 'identity:update', rlIp);

            const input = data && data.appearance ? data.appearance : data;
            const snapshot = await this.identityService.saveAppearanceForSocket(socket, input);
            socket.emit('identity_update', { ...snapshot, saved: true });
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to update character identity');
            socket.emit('identity_error', { message: normalized.safeMessage || 'Could not save character identity.' });
        }
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
     * Restore payment monitoring for a reconnecting user.
     * Queries DB for pending payments and restarts monitoring if found.
     * @param {Object} socket - The socket connection
     * @param {number} dbUserId - The DB user ID
     */
    async _restorePaymentMonitoring(socket, dbUserId) {
        if (!dbUserId || !this.paymentHandlers || !this.gameModeManager) {
            return;
        }

        try {
            // Query for pending (unpaid) payment requests for this user
            const pendingResult = await this.gameModeManager.db.query(`
                SELECT id, subaddress, expected_amount, payment_type, description, expires_at, address_index
                FROM payments
                WHERE user_id = $1
                  AND status = 'pending'
                  AND expires_at > NOW()
                ORDER BY created_at DESC
                LIMIT 1
            `, [dbUserId]);

            if (pendingResult.rows.length === 0) {
                // No pending payment to restore
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`[RestorePayment] No pending payment for user ${dbUserId}`);
                }
                return;
            }

            const payment = pendingResult.rows[0];
            const cryptoType = this.gameModeManager.cryptoType;
            const formattedAmount = this.gameModeManager.formatAtomicHuman 
                ? this.gameModeManager.formatAtomicHuman(payment.expected_amount, 3)
                : payment.expected_amount;

            // Generate QR code
            let qrDataUrl = null;
            try {
                const { generatePaymentQR } = require('../payments/qrService');
                qrDataUrl = await generatePaymentQR(
                    payment.subaddress,
                    payment.expected_amount,
                    cryptoType,
                    payment.description || 'Restored payment',
                    this.gameModeManager.currencyDecimals
                );
            } catch (qrErr) {
                console.warn('QR generation failed during restore:', qrErr.message);
            }

            // Re-emit payment_created to the client
            socket.emit('payment_created', {
                paymentId: payment.id,
                address: payment.subaddress,
                amount: payment.expected_amount,
                amountFormatted: formattedAmount,
                humanAmount: formattedAmount,
                paymentType: payment.payment_type,
                cryptoType: cryptoType,
                description: payment.description,
                expiresAt: payment.expires_at,
                qr: qrDataUrl,
                restored: true
            });

            // Get current user object for queue operations
            const currentUser = this.connectionHandler.getUserBySocket(socket.id) || { serverId: socket.id };

            // Create a mock paymentRequest object for _monitorAddress
            const paymentRequest = {
                id: payment.id,
                address: payment.subaddress,
                amount: payment.expected_amount,
                amountFormatted: formattedAmount,
                package: null
            };

            // Re-register address in wallet service so checkPaymentStatus() can query the wallet RPC.
            // This is essential after server restart or if the entry was lost during disconnect.
            if (this.walletService && payment.subaddress) {
                this.walletService.addressToUser.set(payment.subaddress, {
                    userId: String(dbUserId),
                    socketId: socket.id,
                    amount: Number(payment.expected_amount),
                    addressIndex: payment.address_index ?? 0,
                    accountIndex: 0,
                    detected: false,
                    confirmed: false,
                    status: 'pending'
                });
            }

            // Restart payment monitoring
            // First stop any existing monitoring (unlikely but safe)
            this.paymentHandlers.stopMonitoringForSocket(socket.id);

            // Restart monitoring via paymentHandlers internal method
            if (typeof this.paymentHandlers._monitorAddress === 'function') {
                this.paymentHandlers._monitorAddress(
                    socket, 
                    paymentRequest, 
                    payment.expected_amount, 
                    cryptoType, 
                    currentUser, 
                    payment.payment_type
                );
            }

            // Send status update
            this.broadcastManager.sendStatusUpdate(
                socket.id,
                'payment',
                `🔁 Restored pending payment request.\n\nAmount: ${formattedAmount} ${cryptoType}\nAddress: ${payment.subaddress}`
            );

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`💳 [RestorePayment] Restored monitoring for user ${dbUserId}, payment ${payment.id}`);
            }
        } catch (error) {
            console.error(`[RestorePayment] Error restoring payment for user ${dbUserId}:`, error.message);
        }
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
    async checkGamesTimeout(currentHeight) {
        // Snapshot the entries first: handleGameOver mutates activeGames (it deletes the
        // entry), so iterating the live Map could skip games. Process sequentially and
        // await each game-over rather than firing them all off concurrently on one tick.
        // Anti-instant-death guard ONLY (default 2s, set 0 to disable). Random block timing
        // is the game's core mechanic and is deliberately preserved — this is not a fairness
        // floor. It only avoids the degenerate case where a block lands in the same instant
        // the game starts and the player dies before the dungeon even renders / before their
        // first move is possible (100ms move cooldown).
        const graceMs = (() => { const v = parseInt(process.env.GAME_START_GRACE_MS, 10); return Number.isFinite(v) ? v : 2000; })();
        const now = Date.now();
        const snapshot = Array.from(this.activeGames.entries());
        for (const [socketId, game] of snapshot) {
            const user = this.connectionHandler.getUserBySocket(socketId);
            const elapsedMs = now - (game.startedAt || now);
            if (user && user.blockRec && currentHeight > user.blockRec && elapsedMs >= graceMs) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`💀 GAME TIMEOUT for player ${socketId}: entered on block ${user.blockRec}, died on block ${currentHeight}`);
                }
                game.gameState = 'lost';
                const fakeSocket = { id: socketId };
                try {
                    await this.handleGameOver(fakeSocket, game, 'lost', 'timeout', 'You didn\'t escape before the block time limit!');
                } catch (e) {
                    console.error(`checkGamesTimeout: handleGameOver failed for ${socketId}:`, e.message);
                }
            }
        }
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
            spectators: this.spectatorManager ? this.spectatorManager.getStats() : null,
            tavern: this.tavernManager ? this.tavernManager.getStats() : null
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
        if (this.tavernManager) {
            this.tavernManager.shutdown();
        }

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

        // Dispose components whose timers/maps would otherwise leak on shutdown.
        if (this.sessionManager?.dispose) this.sessionManager.dispose();
        if (this.suspendedGameManager?.cleanup) this.suspendedGameManager.cleanup();
        if (this.paymentHandlers?.dispose) this.paymentHandlers.dispose();

        // Clear remaining data structures
        this.activeGames.clear();

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('✅ SocketHandlers shutdown complete');
        }
    }
}

module.exports = SocketHandlers;
