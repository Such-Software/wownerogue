const Game = require('../src/game/game');
const GameManager = require('../src/game/gameManager');

describe('paid game persistence gate', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a failed durable INSERT aborts before the game becomes active', async () => {
        const game = { id: 'durable-seed', gameProof: {} };
        jest.spyOn(Game, 'createStandardGame').mockReturnValue(game);
        const user = { id: 'socket-1', joinGame: jest.fn() };
        const activeGames = new Map();
        const dbError = new Error('database unavailable');
        const manager = new GameManager({
            activeGames,
            io: {},
            broadcastManager: {},
            debugManager: { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 100 },
            gameModeManager: {
                paymentsEnabled: true,
                gameMode: 'PAID_SINGLE',
                db: { query: jest.fn().mockRejectedValue(dbError) }
            }
        });

        await expect(manager.createGameForUser(user)).rejects.toThrow('database unavailable');

        expect(user.joinGame).not.toHaveBeenCalled();
        expect(activeGames.has(user.id)).toBe(false);
        expect(game.dbId).toBeNull();
    });

    test('a paid game also rejects an INSERT that returns no durable id', async () => {
        const game = { id: 'missing-id', gameProof: {} };
        jest.spyOn(Game, 'createStandardGame').mockReturnValue(game);
        const user = { id: 'socket-2', joinGame: jest.fn() };
        const manager = new GameManager({
            activeGames: new Map(),
            io: {},
            broadcastManager: {},
            debugManager: { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 100 },
            gameModeManager: {
                paymentsEnabled: true,
                gameMode: 'PAID_SINGLE',
                db: { query: jest.fn().mockResolvedValue({ rows: [] }) }
            }
        });

        await expect(manager.createGameForUser(user)).rejects.toThrow('Durable game record is required');
        expect(user.joinGame).not.toHaveBeenCalled();
    });
});
