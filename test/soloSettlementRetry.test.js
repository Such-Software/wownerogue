const GameManager = require('../src/game/gameManager');
const MovementManager = require('../src/game/movementManager');
const SuspendedGameManager = require('../src/network/suspendedGameManager');

function makeHarness(completions, { retryMs = 1000 } = {}) {
    const targeted = [];
    const io = {
        to: jest.fn(socketId => ({
            emit: (event, payload) => targeted.push({ socketId, event, payload })
        })),
        emit: jest.fn()
    };
    const game = {
        id: 'solo-terminal-seed',
        socketId: 'socket-1',
        dbUserId: 44,
        player: { hasTreasure: true },
        moveCount: 17,
        startedAt: Date.now() - 2400,
        movePlayer: jest.fn(),
        endGame: jest.fn(function endGame() { this.gameState = 'ended'; }),
        getProofReveal: jest.fn(() => ({ commitment: 'proof', seed: 'revealed-after-terminal' }))
    };
    const activeGames = new Map([['socket-1', game]]);
    const gameModeManager = {
        completeGame: jest.fn(),
        db: { query: jest.fn().mockResolvedValue({ rows: [{ name: 'Alice' }] }) }
    };
    for (const result of completions) gameModeManager.completeGame.mockResolvedValueOnce(result);
    const manager = new GameManager({
        activeGames,
        io,
        broadcastManager: {},
        debugManager: { CONSOLE_LOGGING: false },
        gameModeManager,
        settlementRetryBaseMs: retryMs,
        settlementRetryMaxMs: retryMs
    });
    return { manager, game, activeGames, gameModeManager, io, targeted };
}

describe('solo terminal settlement retry', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('retains one frozen result after success:false and publishes it once after retry succeeds', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-21T12:00:00Z'));
        const harness = makeHarness([
            { success: false, error: 'Temporary database error' },
            { success: true, payout: { payoutId: 91, status: 'queued', amount: '300', multiplier: 3 } }
        ]);

        const first = await harness.manager.handleGameOver(
            { id: 'socket-1' },
            harness.game,
            'won',
            'escaped',
            'You escaped!',
            777
        );

        expect(first.success).toBe(false);
        expect(harness.activeGames.get('socket-1')).toBe(harness.game);
        expect(harness.game.settlementPending).toBe(true);
        expect(harness.game.endGame).toHaveBeenCalledTimes(1);
        expect(harness.targeted.filter(event => event.event === 'game_over')).toHaveLength(0);
        expect(harness.targeted.filter(event => event.event === 'game_settlement_pending')).toHaveLength(1);
        expect(harness.io.emit).not.toHaveBeenCalledWith('win_feed', expect.anything());

        // Retaining the game blocks both movement and replacement-game creation while the exact
        // terminal transaction is unresolved.
        const movement = new MovementManager({
            activeGames: harness.activeGames,
            io: harness.io,
            debugManager: {},
            moveCooldown: 0
        });
        movement.handleMove('socket-1', { direction: 'right' });
        expect(harness.game.movePlayer).not.toHaveBeenCalled();
        await expect(harness.manager.createGameForUser({ id: 'socket-1' }))
            .rejects.toThrow('active or settlement-pending game');

        // Even accidental object mutation cannot change the already-frozen DB arguments.
        harness.game.moveCount = 999;
        harness.game.player.hasTreasure = false;

        await jest.advanceTimersByTimeAsync(1000);

        expect(harness.gameModeManager.completeGame).toHaveBeenCalledTimes(2);
        for (const call of harness.gameModeManager.completeGame.mock.calls) {
            expect(call).toEqual([
                'socket-1',
                'solo-terminal-seed',
                true,
                true,
                {
                    moves: 17,
                    durationSeconds: 2,
                    score: 777,
                    reason: 'escaped',
                    outcome: 'escaped'
                }
            ]);
        }
        expect(harness.activeGames.has('socket-1')).toBe(false);
        expect(harness.game.settlementPending).toBe(false);
        expect(harness.game.settlementCommitted).toBe(true);
        expect(harness.targeted.filter(event => event.event === 'game_over')).toHaveLength(1);
        expect(harness.io.emit.mock.calls.filter(([event]) => event === 'leaderboard_update')).toHaveLength(1);
        expect(harness.io.emit.mock.calls.filter(([event]) => event === 'win_feed')).toHaveLength(1);

        // A late duplicate terminal callback is a no-op after commit.
        await harness.manager.handleGameOver(
            { id: 'socket-1' }, harness.game, 'lost', 'timeout', 'Too late', 0
        );
        expect(harness.gameModeManager.completeGame).toHaveBeenCalledTimes(2);
        expect(harness.targeted.filter(event => event.event === 'game_over')).toHaveLength(1);
    });

    test('graceful shutdown cancels timers and drains an unresolved terminal result before DB close', async () => {
        jest.useFakeTimers();
        const harness = makeHarness([
            { success: false, error: 'Temporary database error' },
            { success: true, payout: null }
        ], { retryMs: 60000 });

        await harness.manager.handleGameOver(
            { id: 'socket-1' }, harness.game, 'lost', 'monster', 'Caught', 0
        );
        const result = await harness.manager.shutdown({ timeoutMs: 1000, retryIntervalMs: 1 });

        expect(result).toEqual({ initial: 1, settled: 1, pending: 0 });
        expect(harness.gameModeManager.completeGame).toHaveBeenCalledTimes(2);
        expect(harness.activeGames.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('targets the reconnect socket and removes its re-keyed ownership after settlement', async () => {
        jest.useFakeTimers();
        const harness = makeHarness([
            { success: false, error: 'Temporary database error' },
            { success: true, payout: null }
        ]);

        await harness.manager.handleGameOver(
            { id: 'socket-1' }, harness.game, 'won', 'escaped', 'Escaped', 500
        );

        // Mirrors SuspendedGameManager.restoreGame(): the same object moves to the new socket key.
        harness.activeGames.delete('socket-1');
        harness.game.socketId = 'socket-2';
        harness.activeGames.set('socket-2', harness.game);

        await jest.advanceTimersByTimeAsync(1000);

        expect(harness.gameModeManager.completeGame.mock.calls[1][0]).toBe('socket-2');
        expect(harness.targeted.filter(event => event.event === 'game_over')).toEqual([
            expect.objectContaining({ socketId: 'socket-2' })
        ]);
        expect(harness.activeGames.has('socket-1')).toBe(false);
        expect(harness.activeGames.has('socket-2')).toBe(false);
    });

    test('reconnect restores a pending terminal lock without re-counting it as a playable game', () => {
        jest.useFakeTimers();
        const activeGames = new Map();
        const suspended = new SuspendedGameManager({
            debugManager: { CONSOLE_LOGGING: false },
            activeGames,
            cleanupTimeoutMs: 60000
        });
        const game = {
            id: 'pending-reconnect',
            settlementPending: true,
            player: { x: 1, y: 2, hasTreasure: true },
            moveCount: 9
        };
        const newUser = { joinGame: jest.fn() };

        suspended.suspendGame(44, 'socket-old', game);
        const restored = suspended.restoreGame(44, 'socket-new', newUser);

        expect(restored.game).toBe(game);
        expect(activeGames.get('socket-new')).toBe(game);
        expect(newUser.joinGame).not.toHaveBeenCalled();
        expect(game.user).toBe(newUser);
        suspended.cleanup();
        expect(jest.getTimerCount()).toBe(0);
    });
});
