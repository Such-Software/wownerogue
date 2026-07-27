const fs = require('fs');
const path = require('path');
const Game = require('../src/game/game');
const GameManager = require('../src/game/gameManager');
const SuspendedGameManager = require('../src/network/suspendedGameManager');
const SocketHandlers = require('../src/network/socketHandlers');
const PaymentHandlers = require('../src/network/paymentHandlers');
const { hashSeed } = require('../src/game/provablyFair');
const {
    SNAPSHOT_VERSION,
    captureSoloRestartSnapshot,
    restoreSoloRestartSnapshot
} = require('../src/game/soloRestartSnapshot');

function makeGame(generatorVersion = null) {
    const user = { id: 'socket-old', joinGame: jest.fn(), endGame: jest.fn() };
    const options = {
        cryptoType: 'XMR',
        width: 30,
        height: 15,
        ...(generatorVersion ? {
            fairnessProof: {
                serverSeed: '0'.repeat(64),
                clientSeed: '',
                commitment: hashSeed('0'.repeat(64))
            }
        } : {})
    };
    const game = generatorVersion
        ? Game.createRestoredStandardGame('socket-old', user, options, generatorVersion)
        : Game.createStandardGame('socket-old', user, options);
    game.dbId = 91;
    game.userId = 44;
    game.dbUserId = 44;
    game.db = { query: jest.fn() };
    game.blockRec = 12345;
    game.startBlock = 12345;
    game.moveCount = 7;
    game.startedAt = Date.now() - 5000;
    game.player.hasTreasure = true;
    game.dungeon.treasure = null;
    const passable = new Set([game.gameConfig.primaryFloor, game.gameConfig.secondaryFloor, 0, '>', '$M']);
    if (!passable.has(game.dungeon.map?.[game.monster.y]?.[game.monster.x])
        || (game.monster.x === game.player.x && game.monster.y === game.player.y)) {
        outer: for (let y = 0; y < game.dungeon.map.length; y += 1) {
            for (let x = 0; x < game.dungeon.map[y].length; x += 1) {
                if (passable.has(game.dungeon.map[y][x])
                    && (x !== game.player.x || y !== game.player.y)
                    && (!game.dungeon.exit || x !== game.dungeon.exit[0] || y !== game.dungeon.exit[1])) {
                    game.monster.moveTo(x, y);
                    break outer;
                }
            }
        }
    }
    game.monster.lastKnownPlayerX = game.player.x;
    game.monster.lastKnownPlayerY = game.player.y;
    game.seededRNG();
    game.seededRNG();
    return game;
}

function rowFor(game, snapshot, overrides = {}) {
    return {
        game_id: snapshot.gameId,
        user_id: snapshot.userId,
        dungeon_seed: snapshot.dungeonSeed,
        joined_game_id: snapshot.gameId,
        game_user_id: snapshot.userId,
        game_dungeon_seed: snapshot.dungeonSeed,
        snapshot_version: snapshot.snapshotVersion,
        original_socket_id: snapshot.originalSocketId,
        payment_monitoring_active: snapshot.paymentMonitoringActive,
        state: snapshot.state,
        created_at: new Date(),
        status: 'active',
        completed_at: null,
        game_mode: 'PAID_CREDITS',
        start_block_height: game.startBlock,
        proof_version: game.gameProof.proofVersion,
        fairness_offer_id: game.gameProof.offerId,
        fairness_offer_issued_at: game.gameProof.offerIssuedAt,
        proof_commitment: game.gameProof.commitment,
        server_seed: game.gameProof.serverSeed,
        client_seed: game.gameProof.clientSeed,
        effective_seed: game.gameProof.seed,
        layout_fingerprint: game.gameProof.layoutFingerprint,
        layout_fingerprints: game.gameProof.layoutFingerprints,
        generator_version: game.gameProof.generatorVersion,
        proof_context: game.gameProof.context,
        ...overrides
    };
}

describe('durable solo restart snapshots', () => {
    const savedEnv = {};

    beforeAll(() => {
        for (const key of ['DIFFICULTY_PRESET', 'DUNGEON_LEVELS', 'GAME_MODE', 'PAYMENTS_ENABLED']) {
            savedEnv[key] = process.env[key];
        }
        process.env.DIFFICULTY_PRESET = 'easy';
        process.env.DUNGEON_LEVELS = '1';
        process.env.GAME_MODE = 'FREE';
        process.env.PAYMENTS_ENABLED = 'false';
    });

    afterAll(() => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('round-trips exact runtime progress and the next deterministic RNG draw', () => {
        const original = makeGame();
        const snapshot = captureSoloRestartSnapshot(original, { paymentMonitoringActive: true });
        const db = { query: jest.fn() };
        const restored = restoreSoloRestartSnapshot(rowFor(original, snapshot), { db });

        expect(snapshot.snapshotVersion).toBe(SNAPSHOT_VERSION);
        const serializedState = JSON.stringify(snapshot.state);
        expect(serializedState).not.toContain('serverSeed');
        expect(serializedState).not.toContain('fairnessProof');
        expect(serializedState).not.toContain(original.gameProof.serverSeed);
        expect(serializedState).not.toContain(original.gameProof.seed);
        expect(restored).toMatchObject({
            userId: 44,
            originalSocketId: 'socket-old',
            paymentMonitoringActive: true,
            snapshotVersion: SNAPSHOT_VERSION
        });
        expect(restored.game).toMatchObject({
            id: original.id,
            dbId: 91,
            userId: 44,
            dbUserId: 44,
            moveCount: 7,
            blockRec: 12345,
            gameState: 'active'
        });
        expect(restored.game.player.getState()).toEqual(original.player.getState());
        expect(restored.game.monster.getState()).toEqual(original.monster.getState());
        expect(restored.game.monster.lastKnownPlayerX).toBe(original.monster.lastKnownPlayerX);
        expect(restored.game.monster.lastKnownPlayerY).toBe(original.monster.lastKnownPlayerY);
        expect(restored.game.seededRNG()).toBe(original.seededRNG());
        expect(restored.game.gameProof).toMatchObject({
            gameId: original.id,
            commitment: original.gameProof.commitment,
            seed: original.gameProof.seed
        });
    });

    test.each(['dungeon-generator-v1', 'dungeon-generator-v2'])(
        'restores a durable %s run with its persisted fingerprints and next RNG draw',
        (generatorVersion) => {
            const original = makeGame(generatorVersion);
            const snapshot = captureSoloRestartSnapshot(original);
            const expectedManifest = original.gameProof.layoutFingerprints;
            const expectedFingerprint = original.gameProof.layoutFingerprint;
            const restored = restoreSoloRestartSnapshot(rowFor(original, snapshot), {
                db: { query: jest.fn() }
            });

            expect(restored.game.generatorVersion).toBe(generatorVersion);
            expect(restored.game.gameProof.generatorVersion).toBe(generatorVersion);
            expect(restored.game.gameProof.layoutFingerprints).toEqual(expectedManifest);
            expect(restored.game.gameProof.layoutFingerprint).toBe(expectedFingerprint);
            expect(restored.game.seededRNG()).toBe(original.seededRNG());
        }
    );

    test('never captures or restores terminal/settlement-drifted state', () => {
        const game = makeGame();
        game.settlementPending = true;
        expect(() => captureSoloRestartSnapshot(game)).toThrow(/terminal or settlement-pending/);

        game.settlementPending = false;
        const snapshot = captureSoloRestartSnapshot(game);
        expect(() => restoreSoloRestartSnapshot(rowFor(game, snapshot, { status: 'won' }), {
            db: { query: jest.fn() }
        })).toThrow(/active and nonterminal/);
        expect(() => restoreSoloRestartSnapshot(rowFor(game, snapshot, {
            proof_commitment: '0'.repeat(64)
        }), { db: { query: jest.fn() } })).toThrow(/commitment/);
        expect(() => restoreSoloRestartSnapshot(rowFor(game, snapshot, {
            game_user_id: 45
        }), { db: { query: jest.fn() } })).toThrow(/exactly join/);
    });

    test('normalizes PostgreSQL fairness timestamps back to the numeric proof contract', () => {
        const game = makeGame();
        const snapshot = captureSoloRestartSnapshot(game);
        const issuedAt = new Date('2026-07-22T12:34:56.789Z');
        const restored = restoreSoloRestartSnapshot(rowFor(game, snapshot, {
            fairness_offer_issued_at: issuedAt
        }), { db: { query: jest.fn() } });
        expect(restored.game.gameProof.offerIssuedAt).toBe(issuedAt.getTime());
    });

    test('rejects impossible active geometry and future runtime timestamps', () => {
        const game = makeGame();
        const snapshot = captureSoloRestartSnapshot(game);
        const overlapping = JSON.parse(JSON.stringify(snapshot.state));
        overlapping.monster.x = overlapping.player.x;
        overlapping.monster.y = overlapping.player.y;
        expect(() => restoreSoloRestartSnapshot(rowFor(game, snapshot, { state: overlapping }), {
            db: { query: jest.fn() }
        })).toThrow(/overlap/);

        const future = JSON.parse(JSON.stringify(snapshot.state));
        future.startedAt = Date.now() + 120000;
        expect(() => restoreSoloRestartSnapshot(rowFor(game, snapshot, { state: future }), {
            db: { query: jest.fn() }
        })).toThrow(/startedAt/);
    });

    test('durable claim is atomic, timerless, and only exposes the game after PostgreSQL accepts it', async () => {
        jest.useFakeTimers();
        const activeGames = new Map();
        const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 91 }], rowCount: 1 }) };
        const game = makeGame();
        game.db = db;
        const suspended = new SuspendedGameManager({
            debugManager: { CONSOLE_LOGGING: false },
            activeGames,
            cleanupTimeoutMs: 1
        });
        suspended.suspendGame(44, 'socket-old', game, {
            durableRestartSnapshot: true,
            snapshotVersion: SNAPSHOT_VERSION,
            paymentMonitoringActive: true
        });

        expect(jest.getTimerCount()).toBe(0);
        const newUser = { joinGame: jest.fn() };
        const restored = await suspended.restoreGame(44, 'socket-new', newUser);

        expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM solo_restart_snapshots/),
            [91, 44, game.id, SNAPSHOT_VERSION, 'socket-new']);
        expect(restored.game).toBe(game);
        expect(activeGames.get('socket-new')).toBe(game);
        expect(suspended.hasSuspendedGame(44)).toBe(false);
        expect(newUser.joinGame).toHaveBeenCalledWith(game);
        suspended.cleanup();
        jest.useRealTimers();
    });

    test('failed durable claim leaves the game suspended and never makes it active', async () => {
        const activeGames = new Map();
        const game = makeGame();
        game.db = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
        const suspended = new SuspendedGameManager({
            debugManager: { CONSOLE_LOGGING: false },
            activeGames
        });
        suspended.suspendGame(44, 'socket-old', game, {
            durableRestartSnapshot: true,
            snapshotVersion: SNAPSHOT_VERSION
        });

        await expect(suspended.restoreGame(44, 'socket-new', { joinGame: jest.fn() }))
            .rejects.toMatchObject({ code: 'SOLO_RESTART_SNAPSHOT_CLAIM_FAILED' });
        expect(suspended.hasSuspendedGame(44)).toBe(true);
        expect(activeGames.size).toBe(0);
        expect(game.socketId).toBe('socket-old');
        suspended.cleanup();
    });

    test('shutdown persistence uses one transaction and exact active game/user/seed guards', async () => {
        const game = makeGame();
        const client = { query: jest.fn().mockResolvedValue({ rows: [{ game_id: 91 }], rowCount: 1 }) };
        const db = { withTransaction: jest.fn(async callback => callback(client)) };
        const context = Object.assign(Object.create(SocketHandlers.prototype), {
            _admissionsInFlight: new Set(),
            gameModeManager: { db },
            activeGames: new Map([['socket-old', game]]),
            paymentHandlers: { hasActiveMonitoring: jest.fn().mockReturnValue(true) },
            suspendedGameManager: { suspendedGames: new Map() }
        });

        const result = await SocketHandlers.prototype.persistSoloRestartSnapshots.call(context);

        expect(result).toEqual({ captured: 1 });
        expect(db.withTransaction).toHaveBeenCalledTimes(1);
        const [sql, params] = client.query.mock.calls[0];
        expect(sql).toMatch(/g\.id = \$1 AND g\.user_id = \$2 AND g\.dungeon_seed = \$3/);
        expect(sql).toMatch(/g\.status = 'active' AND g\.completed_at IS NULL/);
        expect(params.slice(0, 6)).toEqual([91, 44, game.id, SNAPSHOT_VERSION, 'socket-old', true]);
        expect(JSON.parse(params[6])).toMatchObject({ version: SNAPSHOT_VERSION, dbId: 91, userId: 44 });
    });

    test('startup rehydration validates every row before placing it in the timerless cache', async () => {
        jest.useFakeTimers();
        const game = makeGame();
        const snapshot = captureSoloRestartSnapshot(game);
        const row = rowFor(game, snapshot);
        const db = { query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
        const suspendedGameManager = new SuspendedGameManager({
            debugManager: { CONSOLE_LOGGING: false },
            activeGames: new Map(),
            cleanupTimeoutMs: 1
        });
        const context = Object.assign(Object.create(SocketHandlers.prototype), {
            gameModeManager: { db },
            suspendedGameManager
        });

        const result = await SocketHandlers.prototype.rehydrateSoloRestartSnapshots.call(context);

        expect(result).toEqual({ restored: 1 });
        expect(suspendedGameManager.hasSuspendedGame(44)).toBe(true);
        expect(suspendedGameManager.getSuspendedState(44)).toMatchObject({
            durableRestartSnapshot: true,
            snapshotVersion: SNAPSHOT_VERSION
        });
        expect(jest.getTimerCount()).toBe(0);
        suspendedGameManager.cleanup();
        jest.useRealTimers();
    });

    test('shutdown closes every admission layer synchronously and drains work already inside', async () => {
        let release;
        const inFlight = new Promise(resolve => { release = resolve; });
        const context = Object.assign(Object.create(SocketHandlers.prototype), {
            _isShuttingDown: false,
            _admissionsInFlight: new Set(),
            gameManager: { beginShutdown: jest.fn() },
            gameModeManager: { beginGameAdmissionShutdown: jest.fn() },
            paymentHandlers: { beginShutdown: jest.fn() },
            movementManager: { shutdown: jest.fn() },
            broadcastManager: { sendStatusUpdate: jest.fn() }
        });
        const socket = { id: 'socket-old', emit: jest.fn() };
        const existing = context._runAdmission(socket, 'solo_start', () => inFlight);

        context.beginShutdown();
        const rejectedTask = jest.fn();
        await context._runAdmission(socket, 'solo_start', rejectedTask);
        let drained = false;
        const drain = context.drainAdmissionHandlers().then(() => { drained = true; });
        await Promise.resolve();

        expect(context._isShuttingDown).toBe(true);
        expect(context.gameManager.beginShutdown).toHaveBeenCalledTimes(1);
        expect(context.gameModeManager.beginGameAdmissionShutdown).toHaveBeenCalledTimes(1);
        expect(context.paymentHandlers.beginShutdown).toHaveBeenCalledTimes(1);
        expect(context.movementManager.shutdown).toHaveBeenCalledTimes(1);
        expect(rejectedTask).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('server_restarting', expect.objectContaining({
            code: 'SERVER_SHUTTING_DOWN'
        }));
        expect(drained).toBe(false);

        release();
        await existing;
        await drain;
        expect(drained).toBe(true);
    });

    test('GameManager is a non-bypassable last-line creation gate', async () => {
        const manager = new GameManager({
            activeGames: new Map(),
            io: { to: () => ({ emit: jest.fn() }) },
            broadcastManager: {},
            debugManager: { CONSOLE_LOGGING: false },
            gameModeManager: null
        });
        manager.beginShutdown();
        await expect(manager.createGameForUser({ id: 'socket', joinGame: jest.fn() }))
            .rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
    });

    test('PaymentHandlers internally refuses indirect invoice creation after the barrier', async () => {
        const emitted = [];
        const paymentHandlers = new PaymentHandlers({
            io: { to: id => ({ emit: (event, payload) => emitted.push({ id, event, payload }) }) },
            gameModeManager: { createPaymentRequest: jest.fn() },
            walletService: {},
            debugManager: { CONSOLE_LOGGING: false },
            queueManager: {},
            broadcastManager: {},
            sessionManager: null
        });
        const socket = { id: 'socket-old' };
        paymentHandlers.beginShutdown();

        await paymentHandlers.createAndShowPaymentRequest(socket, {});
        await paymentHandlers.handlePaymentRequest(socket, {});

        expect(paymentHandlers.gameModeManager.createPaymentRequest).not.toHaveBeenCalled();
        expect(emitted).toEqual([
            expect.objectContaining({ event: 'payment_error', payload: expect.objectContaining({ code: 'SERVER_SHUTTING_DOWN' }) }),
            expect.objectContaining({ event: 'payment_error', payload: expect.objectContaining({ code: 'SERVER_SHUTTING_DOWN' }) })
        ]);
        paymentHandlers.dispose();
    });

    test('block-driven queue starts and timeouts are frozen after beginShutdown', async () => {
        const context = Object.assign(Object.create(SocketHandlers.prototype), {
            _isShuttingDown: true,
            queueHandler: { startGamesForWaiting: jest.fn() },
            activeGames: new Map([['socket', { startedAt: 0 }]])
        });
        await expect(context.startGamesForWaiting(123)).resolves.toBeNull();
        await expect(context.checkGamesTimeout(123)).resolves.toBeUndefined();
        expect(context.queueHandler.startGamesForWaiting).not.toHaveBeenCalled();
    });

    test('shutdown drains a paused timeout pass before settlement drain and snapshots later games', async () => {
        const first = makeGame();
        first.socketId = 'socket-first';
        const second = makeGame();
        second.socketId = 'socket-second';
        second.dbId = 92;
        second.userId = 45;
        second.dbUserId = 45;

        let releaseFirst;
        const firstSettlement = new Promise(resolve => { releaseFirst = resolve; });
        const activeGames = new Map([
            ['socket-first', first],
            ['socket-second', second]
        ]);
        const client = { query: jest.fn().mockResolvedValue({ rows: [{ game_id: 92 }], rowCount: 1 }) };
        const db = { withTransaction: jest.fn(async callback => callback(client)) };
        const handleGameOver = jest.fn(async (socket, game) => {
            game.settlementPending = true;
            await firstSettlement;
            game.settlementPending = false;
            game.settlementCommitted = true;
            activeGames.delete(socket.id);
            return { success: true };
        });
        const context = Object.assign(Object.create(SocketHandlers.prototype), {
            _isShuttingDown: false,
            _admissionsInFlight: new Set(),
            activeGames,
            handleGameOver,
            connectionHandler: {
                getUserBySocket: jest.fn(socketId => ({
                    id: socketId,
                    blockRec: 10
                }))
            },
            debugManager: { CONSOLE_LOGGING: false },
            gameManager: {
                beginShutdown: jest.fn(),
                drainAdmissions: jest.fn().mockResolvedValue({ pending: 0 })
            },
            gameModeManager: {
                db,
                beginGameAdmissionShutdown: jest.fn(),
                drainGameStartAdmissions: jest.fn().mockResolvedValue({ pending: 0 })
            },
            paymentHandlers: {
                beginShutdown: jest.fn(),
                drainShutdownWork: jest.fn().mockResolvedValue({ pending: 0 }),
                hasActiveMonitoring: jest.fn().mockReturnValue(false)
            },
            movementManager: { shutdown: jest.fn() },
            suspendedGameManager: { suspendedGames: new Map() }
        });

        const timeoutPass = context.checkGamesTimeout(11);
        expect(handleGameOver).toHaveBeenCalledTimes(1);
        context.beginShutdown();
        let producersDrained = false;
        const drain = context.drainShutdownProducers().then(() => { producersDrained = true; });
        await Promise.resolve();

        expect(producersDrained).toBe(false);
        expect(second.gameState).toBe('active');
        releaseFirst();
        await timeoutPass;
        await drain;

        expect(handleGameOver).toHaveBeenCalledTimes(1);
        expect(second.gameState).toBe('active');
        const snapshots = await context.persistSoloRestartSnapshots();
        expect(snapshots).toEqual({ captured: 1 });
        expect(client.query.mock.calls[0][1].slice(0, 3)).toEqual([92, 45, second.id]);
    });

    test('migration enforces versioned identities and removes snapshots on terminal transition', () => {
        const migration = fs.readFileSync(path.join(
            __dirname, '../src/migrations/043_durable_solo_restart_snapshots.sql'
        ), 'utf8');
        expect(migration).toMatch(/snapshot_version = 1/);
        expect(migration).toMatch(/UNIQUE \(user_id\)/);
        expect(migration).toMatch(/AFTER UPDATE OF status ON games/);
        expect(migration).toMatch(/DELETE FROM solo_restart_snapshots WHERE game_id = NEW\.id/);
    });
});
