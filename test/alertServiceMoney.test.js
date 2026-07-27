const AlertService = require('../src/services/alertService');

describe('AlertService exact reserve gate', () => {
    const keys = ['BALANCE_CRITICAL', 'BALANCE_WARN', 'LOW_BALANCE_THRESHOLD'];
    let previous;
    let logSpy;
    let errorSpy;

    beforeEach(() => {
        previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        process.env.BALANCE_CRITICAL = '10000000000000001';
        process.env.BALANCE_WARN = '10000000000000002';
        delete process.env.LOW_BALANCE_THRESHOLD;
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });

    test('compares balances above Number.MAX_SAFE_INTEGER without rounding', async () => {
        const service = new AlertService({
            walletService: {
                isHealthy: true,
                getBalance: jest.fn(async () => ({ unlocked_balance: '10000000000000000' }))
            },
            db: null,
            debugManager: { CONSOLE_LOGGING: false }
        });

        expect(service.balanceCriticalThreshold).toBe(10000000000000001n);
        await expect(service.checkBalanceForGameStart()).resolves.toEqual(expect.objectContaining({ halted: true }));
    });

    test('wallet balance read errors fail closed for new paid games', async () => {
        const service = new AlertService({
            walletService: {
                isHealthy: true,
                getBalance: jest.fn(async () => { throw new Error('rpc unavailable'); })
            },
            db: null,
            debugManager: { CONSOLE_LOGGING: false }
        });

        await expect(service.checkBalanceForGameStart()).resolves.toEqual(expect.objectContaining({
            halted: true,
            reason: expect.stringContaining('could not be verified')
        }));
        expect(service.isBalanceCritical).toBe(true);
    });
});
