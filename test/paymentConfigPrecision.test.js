const PaymentConfigManager = require('../src/config/paymentConfig');
const GameModeManager = require('../src/game/gameModeManager');

describe('PaymentConfigManager atomic-unit precision', () => {
    const originalPrice = process.env.DIRECT_GAME_PRICE;

    afterEach(() => {
        if (originalPrice === undefined) delete process.env.DIRECT_GAME_PRICE;
        else process.env.DIRECT_GAME_PRICE = originalPrice;
    });

    test('parses integer environment values above Number.MAX_SAFE_INTEGER exactly', () => {
        process.env.DIRECT_GAME_PRICE = '100000000000000001';

        const config = new PaymentConfigManager({
            logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
        }).getConfig();

        expect(config.modes.direct.price).toBe(100000000000000001n);
    });

    test('game mode snapshot and public transport preserve large atomic prices exactly', () => {
        process.env.DIRECT_GAME_PRICE = '100000000000000001';
        const manager = new PaymentConfigManager({
            logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
        });
        const gmm = new GameModeManager(
            { query: jest.fn() },
            {},
            { CONSOLE_LOGGING: false },
            manager
        );

        expect(gmm.singleGamePrice).toBe('100000000000000001');
        expect(gmm.getGameModeInfo().singleGamePrice).toBe('100000000000000001');
        expect(gmm.calculatePayout('PAID_SINGLE').amount).toBe('200000000000000002');
    });
});
