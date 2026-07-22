const PaymentConfigManager = require('../src/config/paymentConfig');
const GameModeManager = require('../src/game/gameModeManager');

const ENV_KEYS = [
    'GAME_MODE',
    'PAYMENTS_ENABLED',
    'PAYMENT_MODES',
    'DIRECT_PAYMENT_ENABLED',
    'CREDITS_ENABLED',
    'FREE_PLAY_ENABLED',
    'PAYOUTS_ENABLED',
    'DIRECT_PAYOUTS_ENABLED',
    'CREDITS_PAYOUTS_ENABLED',
    'PAYOUT_MAX_PER_GAME',
    'CREDITS_PAYOUT_MAX'
];

describe('production payment policy wiring', () => {
    let saved;

    beforeEach(() => {
        saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
        for (const key of ENV_KEYS) delete process.env[key];
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    test('PAYOUTS_ENABLED=false remains authoritative with both per-mode flags true', () => {
        process.env.PAYMENTS_ENABLED = 'true';
        process.env.PAYMENT_MODES = 'direct,credits';
        process.env.PAYOUTS_ENABLED = 'false';
        process.env.DIRECT_PAYOUTS_ENABLED = 'true';
        process.env.CREDITS_PAYOUTS_ENABLED = 'true';
        process.env.FREE_PLAY_ENABLED = 'false';

        const configManager = new PaymentConfigManager({ logger: { warn() {}, info() {} } });
        const manager = new GameModeManager(
            { query: jest.fn(), withTransaction: jest.fn() },
            { validateAddress: jest.fn() },
            { CONSOLE_LOGGING: false },
            configManager
        );

        expect(configManager.getConfig().payouts.enabled).toBe(false);
        expect(manager.payoutsEnabled).toBe(false);
        expect(manager.isPayoutEnabledForMode('PAID_SINGLE')).toBe(false);
        expect(manager.isPayoutEnabledForMode('PAID_CREDITS')).toBe(false);
        expect(manager.getGameModeInfo()).toEqual(expect.objectContaining({
            payoutsEnabled: false,
            directPayoutsEnabled: false,
            creditsPayoutsEnabled: false,
            freePlayEnabled: false
        }));
    });

    test('PAYMENTS_ENABLED=false remains authoritative over every per-mode enable', () => {
        process.env.PAYMENTS_ENABLED = 'false';
        process.env.PAYMENT_MODES = 'direct,credits';
        process.env.DIRECT_PAYMENT_ENABLED = 'true';
        process.env.CREDITS_ENABLED = 'true';

        const config = new PaymentConfigManager({ logger: { warn() {}, info() {} } }).getConfig();

        expect(config.paymentsEnabled).toBe(false);
        expect(config.modes.direct.enabled).toBe(false);
        expect(config.modes.credits.enabled).toBe(false);
    });

    test('invoice creation refuses before database or wallet work when the master switch is off', async () => {
        process.env.PAYMENTS_ENABLED = 'false';
        process.env.PAYMENT_MODES = 'direct,credits';
        const configManager = new PaymentConfigManager({ logger: { warn() {}, info() {} } });
        const db = { query: jest.fn(), withTransaction: jest.fn() };
        const wallet = { createPaymentRequest: jest.fn(), validateAddress: jest.fn() };
        const manager = new GameModeManager(db, wallet, { CONSOLE_LOGGING: false }, configManager);

        await expect(manager.createPaymentRequest('socket-disabled', 'single_game'))
            .rejects.toMatchObject({ code: 'PAYMENT_INTAKE_DISABLED' });
        await expect(manager.createPaymentRequest('socket-disabled', 'credits_package'))
            .rejects.toMatchObject({ code: 'PAYMENT_INTAKE_DISABLED' });
        expect(db.query).not.toHaveBeenCalled();
        expect(wallet.createPaymentRequest).not.toHaveBeenCalled();
    });

    test('per-product switches cannot be bypassed through the generic invoice method', async () => {
        process.env.PAYMENTS_ENABLED = 'true';
        process.env.PAYMENT_MODES = 'direct';
        process.env.DIRECT_PAYMENT_ENABLED = 'true';
        process.env.CREDITS_ENABLED = 'false';
        const configManager = new PaymentConfigManager({ logger: { warn() {}, info() {} } });
        const db = { query: jest.fn(), withTransaction: jest.fn() };
        const wallet = { createPaymentRequest: jest.fn(), validateAddress: jest.fn() };
        const manager = new GameModeManager(db, wallet, { CONSOLE_LOGGING: false }, configManager);

        expect(manager.isPaymentIntakeEnabled('single_game')).toBe(true);
        expect(manager.isPaymentIntakeEnabled('credits_package')).toBe(false);
        await expect(manager.createPaymentRequest('socket-disabled', 'credits_package'))
            .rejects.toMatchObject({ code: 'PAYMENT_INTAKE_DISABLED' });
        expect(db.query).not.toHaveBeenCalled();
        expect(wallet.createPaymentRequest).not.toHaveBeenCalled();
    });

    test('global per-game payout cap is an outer bound for direct and credit wins', () => {
        process.env.PAYMENT_MODES = 'direct,credits';
        process.env.PAYOUT_MAX_PER_GAME = '123456';

        const config = new PaymentConfigManager({ logger: { warn() {}, info() {} } }).getConfig();

        expect(config.payouts.rules.direct.maxPayout).toBe(123456n);
        expect(config.payouts.rules.credits.maxPayout).toBe(123456n);
    });
});
