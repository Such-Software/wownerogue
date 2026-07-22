/**
 * Socket Event Handlers Module
 * Handles all socket.io event processing for the Wownerogue game server
 */

const user = require('../db/user');
const GameManager = require('../game/gameManager');
const MovementManager = require('../game/movementManager');
const QueueManager = require('./queueManager');
const MatchQueue = require('./matchQueue');
const MatchScheduler = require('./matchScheduler');
const MatchManager = require('./matchManager');
const TavernMatchBridge = require('./tavernMatchBridge');
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
const FairnessOfferManager = require('../game/fairnessOfferManager');
const {
    SNAPSHOT_VERSION: SOLO_RESTART_SNAPSHOT_VERSION,
    captureSoloRestartSnapshot,
    restoreSoloRestartSnapshot
} = require('../game/soloRestartSnapshot');
const { normalizeError } = require('../utils/errors');
const money = require('../money/atomic');
const {
    buildCommerceDisclosure,
    validatePaidAcknowledgement
} = require('../config/commerceDisclosurePolicy');

function requirePaidActionAcknowledgement(context, socket, raw, errorEvent = null) {
    const disclosure = buildCommerceDisclosure(context.gameModeManager, process.env);
    // Every call site represents a value-bearing action. This action-level requirement must not
    // disappear when invoice intake is paused: already-owned credits and race tickets still have
    // value and may still be consumed.
    const result = validatePaidAcknowledgement(raw, disclosure, { required: true });
    if (result.ok) return true;
    const payload = {
        message: result.message,
        error: result.message,
        code: result.code,
        policyVersion: disclosure.policyVersion
    };
    socket.emit('commerce_ack_required', payload);
    if (errorEvent) socket.emit(errorEvent, payload);
    context.broadcastManager?.sendStatusUpdate?.(socket.id, 'warning', result.message);
    return false;
}

class SocketHandlers {
    constructor(io, activeGames, broadcastManager, debugManager, gameModeManager = null, walletService = null) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.MOVE_COOLDOWN = 100; // Minimum 100ms between moves
        this.fairnessOffers = new FairnessOfferManager();
        this._isShuttingDown = false;
        this._admissionsInFlight = new Set();

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
                gameModeManager: this.gameModeManager,
                io: this.io
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
        // The imported .tmx room renders as a block-scatter in the browser (the client falls back to
        // the walkable grid), so use the hand-built procedural tavern (tavernMap.js) — which renders
        // reliably through the theme atlas — by default. Opt back into the .tmx with TAVERN_DESIGNED_ROOM=true.
        if (process.env.TAVERN_DESIGNED_ROOM === 'true') {
            try {
                const roomPath = require('path').join(__dirname, '../../html', tavernRoomUrl);
                tavernRoomData = JSON.parse(require('fs').readFileSync(roomPath, 'utf8'));
            } catch (e) {
                if (this.debugManager.CONSOLE_LOGGING) console.log('Tavern room JSON not found; using default map:', e.message);
            }
        }
        this.tavernManager = new TavernManager({
            io: this.io,
            debugManager: this.debugManager,
            roomData: tavernRoomData,
            roomUrl: tavernRoomData ? tavernRoomUrl : null,
            entitlementProvider: async (socket) => this._entitlementsForSocket(socket),
            // Share the lobby's global chat provider so the tavern joins one global chat with
            // persistent history (and nostr fan-out when enabled), instead of ephemeral room chat.
            globalChatProvider: this.chatHandler.chatProvider
        });
        this.tavernManager.initialize();
        // Initialize match mode queue, scheduler, and manager. Inert unless MATCH_ENABLED=true.
        this.matchQueue = new MatchQueue({
            db: this.gameModeManager?.db || null,
            gameModeManager: this.gameModeManager,
            debugManager: this.debugManager,
            isFinancialRecoveryReady: () => this.matchManager?.financialRecoveryReady === true
        });
        this.matchManager = new MatchManager({
            io: this.io,
            db: this.gameModeManager?.db || null,
            debugManager: this.debugManager,
            identityService: this.identityService,
            gameModeManager: this.gameModeManager
        });
        this.matchScheduler = new MatchScheduler({
            matchQueue: this.matchQueue,
            matchManager: this.matchManager,
            debugManager: this.debugManager
        });
        // Database connection + migrations happen later in startServer(). Initializing the
        // durable queue here raced that lifecycle and silently left production match mode dead.
        // initializeMatchMode() is awaited after DatabaseManager.initialize() instead.
        this._matchInitializePromise = null;



        // Initialize suspended game manager for reconnection support
        this.suspendedGameManager = new SuspendedGameManager({
            debugManager: this.debugManager,
            activeGames: this.activeGames,
            cleanupTimeoutMs: 300000 // 5 minutes to reconnect before game is lost
        });
        this.gameManager.setSuspendedGameManager(this.suspendedGameManager);

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

    /** Initialize durable match state only after the database is connected and migrated. */
    async initializeMatchMode() {
        if (this._matchInitializePromise) return this._matchInitializePromise;
        this._matchInitializePromise = (async () => {
            await this.matchQueue.initialize();
            await this.matchManager.initialize?.();
            this.tavernMatchBridge = new TavernMatchBridge({
                matchManager: this.matchManager,
                tavernManager: this.tavernManager,
                io: this.io,
                debugManager: this.debugManager
            });
            this.tavernMatchBridge.initialize();
        })();
        try {
            await this._matchInitializePromise;
        } catch (error) {
            this._matchInitializePromise = null;
            throw error;
        }
    }

    /** Stop new solo movement before taking the graceful-shutdown settlement snapshot. */
    beginShutdown() {
        // This flag is the synchronous boundary: every admission wrapper and lower-level game
        // creator observes it before any shutdown await can yield back to a client callback.
        this._isShuttingDown = true;
        this.gameManager?.beginShutdown?.();
        this.gameModeManager?.beginGameAdmissionShutdown?.();
        this.paymentHandlers?.beginShutdown?.();
        this.movementManager?.shutdown?.();
    }

    _emitShutdownAdmissionRefusal(socket, kind = 'admission') {
        const payload = {
            code: 'SERVER_SHUTTING_DOWN',
            message: 'The server is restarting; new entries are temporarily closed.'
        };
        try { socket?.emit?.('server_restarting', { ...payload, kind }); } catch (_) {}
        try { this.broadcastManager?.sendStatusUpdate?.(socket?.id, 'warning', payload.message); } catch (_) {}
        return payload;
    }

    _rejectAdmissionDuringShutdown(socket, kind) {
        if (!this._isShuttingDown) return false;
        this._emitShutdownAdmissionRefusal(socket, kind);
        return true;
    }

    _runAdmission(socket, kind, task) {
        if (this._rejectAdmissionDuringShutdown(socket, kind)) return Promise.resolve(null);
        const token = {};
        this._admissionsInFlight.add(token);
        let work;
        try {
            work = Promise.resolve(task());
        } catch (error) {
            work = Promise.reject(error);
        }
        token.work = work;
        return work.finally(() => this._admissionsInFlight.delete(token));
    }

    async drainAdmissionHandlers() {
        while (this._admissionsInFlight.size > 0) {
            await Promise.allSettled(Array.from(this._admissionsInFlight, token => token.work));
        }
        return { pending: 0 };
    }

    /**
     * Drain every operation that could still create a game or install a terminal solo result.
     * This must finish before GameManager.shutdown() snapshots/retries its settlement map: an
     * already-running block timeout pass is itself an admission producer and can otherwise resume
     * after an await and add a new settlement behind the drain.
     */
    async drainShutdownProducers() {
        await this.drainAdmissionHandlers();
        await this.paymentHandlers?.drainShutdownWork?.();
        await this.gameModeManager?.drainGameStartAdmissions?.();
        await this.gameManager?.drainAdmissions?.();
        return { pending: 0 };
    }

    /**
     * Persist every nonterminal solo run that currently exists only as a live Game object.
     * Movement is already frozen by beginShutdown(), and the caller drains terminal settlement
     * intents before invoking this method. One transaction prevents a partial restart boundary:
     * either every eligible run has a guarded snapshot or none of the new snapshots commit.
     */
    async persistSoloRestartSnapshots() {
        const db = this.gameModeManager?.db;
        if (!db || typeof db.withTransaction !== 'function') {
            throw new Error('Solo restart snapshots require a transactional database handle');
        }

        // Work that crossed the synchronous gate is allowed to reach a stable DB/in-memory state;
        // nothing new can enter behind it. Only then enumerate the complete snapshot set.
        await this.drainShutdownProducers();

        const captures = new Map();
        const addGame = (game, socketId, paymentMonitoringActive) => {
            if (!game) return;
            if (game.settlementPending || game.settlementCommitted || game.gameState === 'ended') {
                throw new Error(`Refusing to snapshot terminal solo game ${game.id || 'unknown'}`);
            }
            // A snapshot rehydrated earlier in this same process remains durable until its owner
            // claims it; it does not need (and must not receive) a second write on shutdown.
            const captured = captureSoloRestartSnapshot(game, { paymentMonitoringActive });
            const previous = captures.get(captured.gameId);
            if (previous && previous.dungeonSeed !== captured.dungeonSeed) {
                throw new Error(`Conflicting restart snapshot identity for game row ${captured.gameId}`);
            }
            captures.set(captured.gameId, captured);
        };

        for (const [socketId, game] of this.activeGames.entries()) {
            addGame(game, socketId, this.paymentHandlers?.hasActiveMonitoring?.(socketId) === true);
        }
        for (const suspended of this.suspendedGameManager?.suspendedGames?.values?.() || []) {
            if (suspended?.durableRestartSnapshot === true) continue;
            addGame(suspended?.game, suspended?.originalSocketId,
                suspended?.paymentMonitoringActive === true);
        }

        if (captures.size === 0) return { captured: 0 };

        await db.withTransaction(async (client) => {
            for (const snapshot of captures.values()) {
                const result = await client.query(`
                    INSERT INTO solo_restart_snapshots (
                        game_id, user_id, dungeon_seed, snapshot_version, original_socket_id,
                        payment_monitoring_active, state, created_at
                    )
                    SELECT g.id, g.user_id, g.dungeon_seed, $4, $5, $6, $7::jsonb, NOW()
                    FROM games g
                    WHERE g.id = $1 AND g.user_id = $2 AND g.dungeon_seed = $3
                      AND g.status = 'active' AND g.completed_at IS NULL
                    ON CONFLICT (game_id) DO UPDATE SET
                        snapshot_version = EXCLUDED.snapshot_version,
                        original_socket_id = EXCLUDED.original_socket_id,
                        payment_monitoring_active = EXCLUDED.payment_monitoring_active,
                        state = EXCLUDED.state,
                        created_at = EXCLUDED.created_at
                    WHERE solo_restart_snapshots.user_id = EXCLUDED.user_id
                      AND solo_restart_snapshots.dungeon_seed = EXCLUDED.dungeon_seed
                    RETURNING game_id
                `, [
                    snapshot.gameId,
                    snapshot.userId,
                    snapshot.dungeonSeed,
                    snapshot.snapshotVersion,
                    snapshot.originalSocketId,
                    snapshot.paymentMonitoringActive,
                    JSON.stringify(snapshot.state)
                ]);
                if (result.rowCount !== 1) {
                    throw new Error(`Active solo game ${snapshot.gameId} changed during restart snapshot`);
                }
            }
        });

        return { captured: captures.size };
    }

    /** Reconstruct durable graceful-restart snapshots before orphan recovery or admission. */
    async rehydrateSoloRestartSnapshots() {
        const db = this.gameModeManager?.db;
        if (!db || typeof db.query !== 'function') {
            throw new Error('Solo restart rehydration requires a database handle');
        }
        const result = await db.query(`
            SELECT s.game_id, s.user_id, s.dungeon_seed, s.snapshot_version,
                   s.original_socket_id, s.payment_monitoring_active, s.state, s.created_at,
                   g.id AS joined_game_id, g.user_id AS game_user_id,
                   g.dungeon_seed AS game_dungeon_seed,
                   g.status, g.completed_at, g.game_mode, g.start_block_height,
                   g.proof_version, g.fairness_offer_id, g.fairness_offer_issued_at,
                   g.proof_commitment, g.server_seed, g.client_seed, g.effective_seed,
                   g.layout_fingerprint, g.layout_fingerprints, g.generator_version,
                   g.proof_context
            FROM solo_restart_snapshots s
            LEFT JOIN games g
              ON g.id = s.game_id
             AND g.user_id = s.user_id
             AND g.dungeon_seed = s.dungeon_seed
            ORDER BY s.game_id ASC
        `, []);

        let restored = 0;
        for (const row of result.rows || []) {
            const state = restoreSoloRestartSnapshot(row, { db });
            if (this.suspendedGameManager.hasSuspendedGame(state.userId)) {
                throw new Error(`Duplicate suspended solo identity ${state.userId}`);
            }
            const accepted = this.suspendedGameManager.suspendGame(
                state.userId,
                state.originalSocketId,
                state.game,
                {
                    paymentMonitoringActive: state.paymentMonitoringActive,
                    durableRestartSnapshot: true,
                    snapshotVersion: SOLO_RESTART_SNAPSHOT_VERSION,
                    blockRec: state.game.blockRec
                }
            );
            if (!accepted) throw new Error(`Failed to rehydrate solo game ${state.game.id}`);
            restored += 1;
        }
        return { restored };
    }

    /** Dynamic financial-recovery gate used by readiness and paid admission. */
    isFinancialRecoveryReady() {
        return this.matchQueue?.initialized === true
            && this.matchManager?.financialRecoveryReady === true;
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

        // Player took the stairs down to a deeper level — the fresh level was already generated in
        // movePlayer and rides out in the normal game_update. Don't end the game, and don't advance
        // the new level's monster on the arrival turn.
        if (moveResult && moveResult.event === 'descend') {
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

    _emitFairnessOffer(socket) {
        if (!socket || !this.fairnessOffers) return null;
        const offer = this.fairnessOffers.ensureOffer(socket.id);
        socket.emit('fairness_offer', offer);
        return offer;
    }

    /**
     * Atomically consume the precommit echoed by a start request. The replacement offer is
     * published immediately for the next attempt, but the returned private proof input remains
     * bound to the consumed commitment and is the only value passed into Game.
     */
    _consumeFairnessAttempt(socket, opts = {}) {
        const result = this.fairnessOffers.consume(socket.id, {
            offerId: typeof opts.fairnessOfferId === 'string' ? opts.fairnessOfferId : null,
            clientSeed: typeof opts.clientSeed === 'string' ? opts.clientSeed : ''
        });
        if (!result.success) {
            socket.emit('fairness_error', { code: result.code, message: result.reason });
            this._emitFairnessOffer(socket);
            return null;
        }
        this._emitFairnessOffer(socket);
        return result.proofInput;
    }

    /** Refuse value-bearing actions unless the player echoed the current public disclosures. */
    _requirePaidActionAcknowledgement(socket, raw, errorEvent = null) {
        return requirePaidActionAcknowledgement(this, socket, raw, errorEvent);
    }

    /**
     * Initialize socket event handlers for a new connection
     */
    async handleConnection(socket) {
        if (this._isShuttingDown) {
            this._emitShutdownAdmissionRefusal(socket, 'connection');
            socket.disconnect(true);
            return;
        }
        const connectionResult = await this.connectionHandler.handleConnection(socket);
        if (!connectionResult) return; // Connection was rejected or failed
        // A connection may have entered just before beginShutdown() and awaited its DB session.
        // Recheck before restoring state or registering any mutating event handlers.
        if (this._isShuttingDown) {
            this._emitShutdownAdmissionRefusal(socket, 'connection');
            socket.disconnect(true);
            return;
        }

        // Publish the server commitment before the client can submit a client seed. register_client
        // re-emits this same offer (never swaps it) in case the browser attached listeners late.
        this._emitFairnessOffer(socket);

        const { sessionInfo } = connectionResult;
        const dbUserId = sessionInfo?.user?.id;
        
        // Check for suspended game to restore (must happen BEFORE queue restoration)
        let restoredGame = null;
        if (sessionInfo && sessionInfo.resumed && dbUserId && this.suspendedGameManager) {
            if (this.suspendedGameManager.hasSuspendedGame(dbUserId)) {
                const memUser = this.connectionHandler.getUserBySocket(socket.id);
                let restored;
                try {
                    restored = await this.suspendedGameManager.restoreGame(dbUserId, socket.id, memUser);
                } catch (error) {
                    // Never let a failed durable claim fall through to queue/new-game admission:
                    // the database still owns an active run for this identity. A reconnect can
                    // retry after the transient fault or an operator can resolve the snapshot.
                    console.error(`[handleConnection] Suspended game restore failed for user ${dbUserId}:`,
                        normalizeError(error).message);
                    socket.emit('session_restore_failed', {
                        code: 'ACTIVE_GAME_RESTORE_FAILED',
                        message: 'Your active game could not be restored safely. Please reconnect shortly.'
                    });
                    socket.disconnect(true);
                    return;
                }
                
                if (restored) {
                    restoredGame = restored.game;
                    const suspendedState = restored.suspendedState;

                    // G1/C3: resume the block-timeout clock from the ORIGINAL entry block,
                    // not the reconnect height. suspendedGameManager persists the entry block
                    // and hands it back here; restore it onto the in-memory user so
                    // checkGamesTimeout continues counting from where it left off. If it's
                    // missing, leave blockRec unset — checkGamesTimeout records the first
                    // observed height rather than treating the game as instant-death.
                    const entryBlock = (restored.blockRec ?? suspendedState?.blockRec ?? null);
                    if (memUser && entryBlock != null) {
                        memUser.blockRec = entryBlock;
                    }

                    if (this.debugManager.CONSOLE_LOGGING) {
                        console.log(`🔄 [handleConnection] Restored game ${restoredGame.id} for user ${dbUserId}`);
                    }
                    
                    if (restoredGame.settlementPending) {
                        // A terminal run is retained solely to retry its atomic DB completion. Do
                        // not render it as playable after reconnect or reveal a second result.
                        socket.emit('game_settlement_pending', {
                            gameId: restoredGame.id,
                            code: 'GAME_FINISH_NOT_DURABLE',
                            retrying: true
                        });
                        this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                            'Your finished game is being saved. A new game will be available when settlement completes.');
                    } else {
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
                    }
                    
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

        // Register event handlers. Admission wrappers remain live for the life of this socket and
        // consult the dynamic shutdown flag, so existing connections cannot race the snapshot.
        const runAdmission = (kind, task) => this._runAdmission(socket, kind, task);
        socket.on('chat message', (msg) => this.chatHandler.handleChatMessage(socket, msg, {
            // Legacy text command has no client contribution, but still consumes the already
            // published one-time server offer with an empty clientSeed.
            handleGameQueue: (commandSocket) => runAdmission('chat_game_queue',
                () => this.handleJoinQueue(commandSocket, {})),
            handleCancelEntry: (socket) => this.queueHandler.handleCancelEntry(socket),
            handleStatsRequest: (socket) => this.handleStatsRequest(socket)
        }));
        // Phase 2: a client-signed global chat event (posts under the player's own Smirk npub).
        socket.on('chat_signed', (payload) => this.chatHandler.handleSignedChatMessage(socket, payload));
    socket.on('player_move', (moveData) => this.movementManager.handleMove(socket.id, moveData));
        socket.on('disconnect', () => this.handleDisconnect(socket));
        socket.on('debug_ping', (data) => this.handleDebugPing(socket, data));
        socket.on('register_client', async (data) => {
            this.connectionHandler.handleRegisterClient(socket, data);
            this._emitFairnessOffer(socket);
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
        socket.on('auto_start', (data) => runAdmission('auto_start',
            () => this.handleAutoStart(socket, (data && typeof data === 'object') ? data : {}))); // New handler for start button
        socket.on('play_free', (data) => runAdmission('play_free',
            () => this.handleAutoStart(socket, { ...((data && typeof data === 'object') ? data : {}), free: true }))); // Explicit free-play choice
        socket.on('join_queue', (data) => runAdmission('join_queue',
            () => this.handleJoinQueue(socket, (data && typeof data === 'object') ? data : {}))); // Queue instead of auto-start ({ free: true } for Pleb-board free play)
        socket.on('early_entry', (data) => runAdmission('early_entry',
            () => this.handleEarlyEntry(socket, (data && typeof data === 'object') ? data : {}))); // Early entry without waiting for block
        socket.on('fairness_offer_request', () => this._emitFairnessOffer(socket));
        socket.on('address:prompt', () => this.handleAddressPrompt(socket));
        
        // Payment system handlers
        socket.on('request_payment', (data) => runAdmission('request_payment',
            () => this.handlePaymentRequest(socket, data)));
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
        // Match mode handlers. Every match listener is wrapped so a match-layer fault can
        // never crash the connection or leak a stack to the client — it logs and emits a
        // benign 'match_error' instead (C5). Identity is always resolved from the CONNECTION,
        // never from the client payload.
        socket.on('match_queue', (data) => runAdmission('match_queue',
            () => this._handleMatchQueue(socket, data)));
        socket.on('match_move', (data) => {
            try {
                this.matchManager.move(socket, data);
            } catch (err) {
                if (this.debugManager?.CONSOLE_LOGGING) console.error('[SocketHandlers] match_move error:', err.message);
                socket.emit('match_error', { message: 'Move could not be processed.' });
            }
        });
        socket.on('match_leave', () => {
            try {
                this.matchManager.leave(socket);
            } catch (err) {
                if (this.debugManager?.CONSOLE_LOGGING) console.error('[SocketHandlers] match_leave error:', err.message);
                socket.emit('match_error', { message: 'Could not leave the match.' });
            }
        });
        socket.on('match_reconnect', (data) => this._handleMatchReconnect(socket, data));
        // Tavern match spectator bridge
        socket.on('tavern_match_list', () => {
            const list = this.tavernMatchBridge ? this.tavernMatchBridge.getActiveMatches() : [];
            socket.emit('tavern_match_list', list);
        });


    }

    async handlePaymentRequest(socket, data = {}) {
        if (this._isShuttingDown === true) {
            this._rejectAdmissionDuringShutdown?.(socket, 'request_payment');
            return;
        }
        const request = (data && typeof data === 'object') ? data : {};
        const rlId = stableId(socket, this.sessionManager);
        const rlIp = clientIp(socket);
        const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'payment:create', rlIp);
        if (!rateLimitResult.allowed) {
            socket.emit('payment_error', {
                error: 'Too many payment requests. Please wait and try again.',
                code: 'RATE_LIMITED',
                retryAfterMs: rateLimitResult.retryAfter
            });
            return;
        }
        // Count every accepted attempt before any wallet/DB work so invalid product ids or
        // fairness payloads cannot be used to bypass the IP + stable-user bucket.
        await this.rateLimiter.recordAttempt(rlId, 'payment:create', rlIp);

        // Check before consuming a one-time fairness offer or touching wallet/DB state.
        if (!requirePaidActionAcknowledgement(
            this,
            socket,
            request.legalAcknowledgement,
            'payment_error'
        )) return;

        const paymentType = request.type || request.gameMode || 'single_game';
        if (typeof this.gameModeManager?.isPaymentIntakeEnabled === 'function'
            && !this.gameModeManager.isPaymentIntakeEnabled(paymentType)) {
            socket.emit('payment_error', {
                error: 'That paid product is not available on this server.',
                code: 'PAYMENT_INTAKE_DISABLED'
            });
            return;
        }
        if (paymentType !== 'single_game') {
            return this.paymentHandlers.handlePaymentRequest(socket, request);
        }
        const fairnessProof = this._consumeFairnessAttempt(socket, request);
        if (!fairnessProof) return;
        return this.paymentHandlers.handlePaymentRequest(socket, { ...request, fairnessProof });
    }

    /**
     * Handle immediate start button (auto_start)
     * Applies payment eligibility + payout address gating (for payout-eligible modes)
     * If eligible, starts game immediately (bypassing block queue) and processes game start (credit deduction / payment linkage)
     */
    async handleAutoStart(socket, opts = {}) {
        if (this._isShuttingDown === true) {
            this._rejectAdmissionDuringShutdown?.(socket, 'solo_start');
            return;
        }
        try {
            const wantsExplicitFree = opts.free === true && this.gameModeManager?.freePlayEnabled;
            if (!wantsExplicitFree
                && !requirePaidActionAcknowledgement(this, socket, opts.legalAcknowledgement)) return;
            const fairnessProof = this._consumeFairnessAttempt(socket, opts);
            if (!fairnessProof) return;
            let gameFairnessProof = fairnessProof;

            // The player explicitly chose FREE play (Pleb board, no payment/payout). Only
            // honoured when the instance allows free play; otherwise fall through to paid.
            const wantsFree = wantsExplicitFree;

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
                        await this.paymentHandlers.createAndShowPaymentRequest(socket, {
                            fairnessProof,
                            legalAcknowledgement: opts.legalAcknowledgement
                        });
                        return;
                    }
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error', canStart.reason || 'Not allowed to start');
                    return;
                }

                // Address-gate the effective entry mode, not the instance's legacy/global mode.
                // This matters on mixed direct+credits servers and when the master payout switch
                // is off (no payout means no address should be required).
                const effectiveMode = canStart.effectiveMode || this.gameModeManager.gameMode;
                if (effectiveMode === 'PAID_SINGLE' && canStart.paymentId) {
                    // A direct invoice is already bound to the offer that was published before
                    // its address was shown. Never replace it with the fresh socket offer chosen
                    // after payment/reconnect.
                    gameFairnessProof = canStart.fairnessProof || null;
                    if (this.gameModeManager._requiresPaidFairnessV2?.() && !gameFairnessProof) {
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                            'This paid entry has no durable fairness binding and requires support review.');
                        return;
                    }
                }
                const needsAddress = typeof this.gameModeManager.requiresPayoutAddressForMode === 'function'
                    ? this.gameModeManager.requiresPayoutAddressForMode(effectiveMode)
                    : ((effectiveMode === 'PAID_SINGLE')
                        || (effectiveMode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled));
                if (needsAddress) {
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
            }

            // Record the game start attempt (same stable id + IP as the check above)
            await this.rateLimiter.recordAttempt(rlId, 'game:start', rlIp);

            // Create game immediately
            const blockHeight = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
            memUser.blockRec = blockHeight; // keep legacy timeout logic consistent
            const game = await this.gameManager.createGameForUser(memUser, 'standard', {
                fairnessProof: gameFairnessProof
            });
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
                    if (game.dbId && this.gameModeManager?.db) {
                        await this.gameModeManager.db.query(`
                            UPDATE games
                            SET status = 'expired', outcome = 'aborted', completed_at = NOW()
                            WHERE id = $1 AND entry_consumed_at IS NULL AND status = 'active'
                        `, [game.dbId]);
                    }
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
    async handleJoinQueue(socket, opts = {}) {
        if (this._isShuttingDown === true) {
            this._rejectAdmissionDuringShutdown?.(socket, 'solo_queue');
            return;
        }
        try {
            const rlId = stableId(socket, this.sessionManager);
            const rlIp = clientIp(socket);
            const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'game:queue', rlIp);
            if (!rateLimitResult.allowed) {
                socket.emit('queue_error', {
                    message: 'Too many queue attempts. Please wait and try again.',
                    code: 'RATE_LIMITED',
                    retryAfterMs: rateLimitResult.retryAfter
                });
                return;
            }
            await this.rateLimiter.recordAttempt(rlId, 'game:queue', rlIp);

            const wantsExplicitFree = opts.free === true && this.gameModeManager?.freePlayEnabled;
            if (!wantsExplicitFree
                && !requirePaidActionAcknowledgement(this, socket, opts.legalAcknowledgement)) return;

            const fairnessProof = this._consumeFairnessAttempt(socket, opts);
            if (!fairnessProof) return;
            await this.queueHandler.handleGameQueue(
                socket,
                this.connectionHandler.getUserBySocket.bind(this.connectionHandler),
                { ...opts, fairnessProof }
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
    async handleEarlyEntry(socket, opts = {}) {
        if (this._isShuttingDown === true) {
            this._rejectAdmissionDuringShutdown?.(socket, 'early_entry');
            return;
        }
        try {
            // Early entry is free only on a free-only instance. Mixed/credits entry may consume a
            // credit, so treat ambiguous mixed-mode requests as paid and fail closed.
            if (this.gameModeManager?.gameMode !== 'FREE'
                && !requirePaidActionAcknowledgement(this, socket, opts.legalAcknowledgement, 'early_entry_error')) return;
            const fairnessProof = this._consumeFairnessAttempt(socket, opts);
            if (!fairnessProof) return;
            const result = await this.queueHandler.handleEarlyEntry(
                socket,
                this.connectionHandler.getUserBySocket.bind(this.connectionHandler),
                { fairnessProof }
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

    /**
     * Resolve the stable match session/identity for a connection. Identity is derived ONLY
     * from the CONNECTION (the session cache, then a DB lookup by socket) — never from any
     * client-supplied payload — so a client can't act on another user's behalf (C5). Mirrors
     * how other handlers resolve identity via sessionManager.
     * @returns {Promise<{userId:number, socketId:string, sessionToken:(string|null), user:Object}|null>}
     */
    async _resolveMatchSession(socket) {
        if (!this.sessionManager || !socket) return null;
        let sessionUser = null;
        try {
            sessionUser = this.sessionManager.sessions?.get(socket.id) || null;
        } catch (_) { sessionUser = null; }
        if (!sessionUser) {
            try { sessionUser = await this.sessionManager.getBySocket(socket.id); } catch (_) { sessionUser = null; }
        }
        if (!sessionUser || sessionUser.id == null) return null;
        return {
            userId: sessionUser.id,
            socketId: socket.id,
            sessionToken: sessionUser.anon_token || null,
            user: sessionUser
        };
    }

    /**
     * Handle a match-mode queue join/leave (C5/S4). The economy comes from the payload but
     * the IDENTITY is resolved from the connection, never from data. Never throws: any fault
     * is logged and reported to the client via 'match_error'. If match mode is disabled /
     * the queue is absent, respond benignly and return.
     * @param {Object} socket
     * @param {{action?:('join'|'leave'), economy?:string}} data
     */
    async _handleMatchQueue(socket, data = {}) {
        try {
            // Match disabled or queue not wired → benign no-op.
            if (!this.matchQueue || (typeof this.matchQueue.isEnabled === 'function' && !this.matchQueue.isEnabled())) {
                return;
            }

            const action = (data && data.action === 'leave') ? 'leave' : 'join';
            if (action === 'join' && this._isShuttingDown === true) {
                this._rejectAdmissionDuringShutdown?.(socket, 'match_queue');
                return;
            }
            if (action === 'join' && this.activeGames?.has(socket.id)) {
                const soloGame = this.activeGames.get(socket.id);
                socket.emit('match_error', {
                    message: soloGame?.settlementPending
                        ? 'Your finished solo game is still being saved. Wait for settlement before joining a match.'
                        : 'Finish your solo game before joining a match.',
                    code: soloGame?.settlementPending ? 'SOLO_SETTLEMENT_PENDING' : 'SOLO_GAME_ACTIVE'
                });
                return;
            }
            // A leave is never throttled: users must always be able to release queued escrow.
            // Joins share the reconnect-proof solo/match queue bucket to bound DB churn.
            if (action === 'join') {
                const rlId = stableId(socket, this.sessionManager);
                const rlIp = clientIp(socket);
                const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'game:queue', rlIp);
                if (!rateLimitResult.allowed) {
                    socket.emit('match_error', {
                        message: 'Too many queue attempts. Please wait and try again.',
                        code: 'RATE_LIMITED',
                        retryAfterMs: rateLimitResult.retryAfter
                    });
                    return;
                }
                await this.rateLimiter.recordAttempt(rlId, 'game:queue', rlIp);
            }

            const session = await this._resolveMatchSession(socket);
            if (!session) {
                socket.emit('match_error', { message: 'Please reconnect before joining a match.' });
                return;
            }

            const economy = (data && typeof data.economy === 'string') ? data.economy : undefined;
            // Carry economy on the session too, so a leave(session) that keys on economy and
            // an enqueue(session,{economy}) that keys on the explicit arg both stay correct.
            const matchSession = { ...session, economy };

            if (action === 'leave') {
                const result = await this.matchQueue.leave(matchSession);
                socket.emit('match_queue_left', { ...(result || { success: false }), economy });
            } else {
                if ((economy === 'credits_prestige' || economy === 'crypto_race')
                    && !requirePaidActionAcknowledgement(this, socket, data.legalAcknowledgement, 'match_error')) return;
                const result = await this.matchQueue.enqueue(matchSession, { economy });
                socket.emit('match_queue_joined', { ...(result || { success: false }), economy });
            }
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) console.error('[SocketHandlers] _handleMatchQueue error:', err.message);
            socket.emit('match_error', { message: 'Could not update the match queue. Please try again.' });
        }
    }

    /**
     * Handle a match-mode reconnect (C5). Resolves identity from the connection and hands the
     * live socket + session to the match manager. Same never-throw discipline as the other
     * match listeners; benign no-op when match mode is disabled.
     */
    async _handleMatchReconnect(socket, data = {}) {
        try {
            if (!this.matchManager || this.matchManager.enabled === false) {
                return;
            }
            const session = await this._resolveMatchSession(socket);
            if (!session) return;
            await this.matchManager.handleReconnect(socket, session);
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) console.error('[SocketHandlers] match_reconnect error:', err.message);
            socket.emit('match_error', { message: 'Could not rejoin the match.' });
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
        if (this.fairnessOffers) this.fairnessOffers.discardSocket(socket.id);
        if (this.paymentHandlers?.clearPendingCommerceAcknowledgement) {
            this.paymentHandlers.clearPendingCommerceAcknowledgement(socket.id);
        }
        if (this.paymentHandlers?.pendingEntryFairness) {
            this.paymentHandlers.pendingEntryFairness.delete(socket.id);
        }
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

            // A retry can commit while the async identity lookup above is in flight. Re-check the
            // retained object immediately before suspension so a completed terminal game cannot
            // be resurrected as a reconnectable/"playable" game.
            if (activeGame?.settlementCommitted) {
                this.activeGames.delete(socketId);
            } else if (activeGame && dbUserId && this.suspendedGameManager) {
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

            // Clean up match presence (starts the AFK grace timer). New signature takes the
            // live socket (C5). Guarded so a match-layer fault can't abort disconnect cleanup.
            if (this.matchManager) {
                try {
                    this.matchManager.handleDisconnect(socket);
                } catch (err) {
                    if (this.debugManager?.CONSOLE_LOGGING) console.error('[SocketHandlers] match handleDisconnect error:', err.message);
                }
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
                SELECT id, subaddress, expected_amount, payment_type, description, expires_at, address_index,
                       fairness_proof_version, fairness_offer_id, fairness_offer_issued_at,
                       fairness_commitment, fairness_server_seed, fairness_client_seed,
                       fairness_bound_at, fairness_consumed_at
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
            const fairnessProof = payment.payment_type === 'single_game'
                && typeof this.gameModeManager._paymentFairnessProofFromRow === 'function'
                ? this.gameModeManager._paymentFairnessProofFromRow(payment)
                : null;
            if (payment.payment_type === 'single_game'
                && typeof this.gameModeManager._requiresPaidFairnessV2 === 'function'
                && this.gameModeManager._requiresPaidFairnessV2()
                && (!fairnessProof || payment.fairness_consumed_at != null)) {
                console.error(`[RestorePayment] Refusing to monitor unbound paid entry ${payment.id}`);
                this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                    'This paid entry has no durable fairness binding and requires support review.');
                return;
            }
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
                restored: true,
                fairness: fairnessProof ? {
                    proofVersion: fairnessProof.proofVersion,
                    offerId: fairnessProof.offerId,
                    offerIssuedAt: fairnessProof.offerIssuedAt,
                    commitment: fairnessProof.commitment,
                    clientSeed: fairnessProof.clientSeed
                } : null
            });

            // Get current user object for queue operations
            const currentUser = this.connectionHandler.getUserBySocket(socket.id) || { serverId: socket.id };

            // Create a mock paymentRequest object for _monitorAddress
            const paymentRequest = {
                id: payment.id,
                address: payment.subaddress,
                amount: payment.expected_amount,
                amountFormatted: formattedAmount,
                package: null,
                fairnessProof
            };

            // Re-register address in wallet service so checkPaymentStatus() can query the wallet RPC.
            // This is essential after server restart or if the entry was lost during disconnect.
            if (this.walletService && payment.subaddress) {
                this.walletService.addressToUser.set(payment.subaddress, {
                    userId: String(dbUserId),
                    socketId: socket.id,
                    amount: money.toSafe(money.toBig(payment.expected_amount)),
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
                    payment.payment_type,
                    fairnessProof
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
        if (this._isShuttingDown) return null;
        return this._runAdmission(null, 'block_queue_start', async () => {
            // Start queued single-player games first and capture the result to return.
            const result = await this.queueHandler.startGamesForWaiting(blockHeight);
            // Keep scheduler work inside the tracked admission boundary. A match-layer fault still
            // cannot fail solo processing, but shutdown now knows when the pre-barrier block tick
            // has reached a stable state.
            if (this.matchScheduler) {
                await this.matchScheduler.onBlock(blockHeight).catch(err => {
                    if (this.debugManager.CONSOLE_LOGGING) console.error('[SocketHandlers] Match scheduler block error:', err);
                });
            }
            return result;
        });
    }

    /**
     * Check for game timeouts based on block height
     */
    async checkGamesTimeout(currentHeight) {
        if (this._isShuttingDown) return;
        return this._runAdmission(null, 'block_game_timeout', async () => {
            // Snapshot the entries first: handleGameOver mutates activeGames (it deletes the
            // entry), so iterating the live Map could skip games. Process sequentially and
            // await each game-over rather than firing them all off concurrently on one tick.
            // Anti-instant-death guard ONLY (default 2s, set 0 to disable). Random block timing
            // is the game's core mechanic and is deliberately preserved — this is not a fairness
            // floor. It only avoids the degenerate case where a block lands in the same instant
            // the game starts and the player dies before the dungeon even renders / before their
            // first move is possible (100ms move cooldown).
            const graceMs = (() => {
                const value = parseInt(process.env.GAME_START_GRACE_MS, 10);
                return Number.isFinite(value) ? value : 2000;
            })();
            const now = Date.now();
            const snapshot = Array.from(this.activeGames.entries());
            for (const [socketId, game] of snapshot) {
                // A pass can have crossed the admission gate before shutdown and then yielded
                // while settling an earlier game. Never let it install a later terminal intent
                // after the shutdown producer drain has begun.
                if (this._isShuttingDown) break;
                // G3: the snapshot can go stale while we await a previous game-over. If this game
                // was concurrently won or otherwise ended (removed from activeGames on another
                // async path), never re-end it here as a loss/timeout.
                if (!this.activeGames.has(socketId)) continue;
                // Terminal games deliberately remain mapped until their DB transaction succeeds.
                // Never race that frozen result with a later block-timeout loss.
                if (game?.settlementPending || game?.settlementCommitted || game?.gameState === 'ended') continue;

                const user = this.connectionHandler.getUserBySocket(socketId);
                if (!user) continue;

                // G1/C3: only end when the entry block is DEFINED and a later block has arrived.
                // If we've never recorded an entry block for this player, record the current
                // height as the first observation instead of treating a missing value as either
                // immortal (never times out) or instant-death (times out on the first tick).
                if (user.blockRec == null) {
                    user.blockRec = currentHeight;
                    continue;
                }

                const elapsedMs = now - (game.startedAt || now);
                if (currentHeight > user.blockRec && elapsedMs >= graceMs) {
                    // Keep this check immediately adjacent to terminal mutation. The synchronous
                    // beginShutdown flag is the authoritative cut between snapshot/restart work.
                    if (this._isShuttingDown) break;
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
            spectators: this.spectatorManager ? this.spectatorManager.getStats() : null,
            tavern: this.tavernManager ? this.tavernManager.getStats() : null
        };
    }

    /**
     * Shutdown method to clean up all resources and prevent memory leaks
     */
    async shutdown() {
        this.beginShutdown();
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('🛑 SocketHandlers shutting down...');
        }

        // Let work that crossed the synchronous admission boundary reach a stable state before
        // freezing the settlement set. This includes a block-timeout pass paused on an earlier
        // game's durable completion.
        await this.drainShutdownProducers();

        // Settle terminal solo runs while the DB pool is still open. This is idempotent if the
        // top-level graceful-shutdown path already drained them.
        if (this.gameManager?.shutdown) {
            const soloDrain = await this.gameManager.shutdown();
            if (soloDrain.pending > 0) {
                console.error(`[SocketHandlers] ${soloDrain.pending} solo settlement(s) remain pending at shutdown.`);
            }
        }

        // Shutdown components in reverse order of initialization
        if (this.tavernManager) {
            this.tavernManager.shutdown();
        }
        if (this.matchScheduler) {
            await this.matchScheduler.shutdown();
        }
        if (this.matchQueue) {
            await this.matchQueue.shutdown().catch(() => {});
        }
        if (this.matchManager) {
            this.matchManager.shutdown();
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
