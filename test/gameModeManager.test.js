/**
 * GameModeManager Tests
 * Tests for mixed mode, credits, and payment logic
 */

// Mock the database
const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [] })
};
const mockDb = {
    query: jest.fn(),
    withTransaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockClient);
    })
};

// Mock wallet service
const mockWalletService = {
    createPaymentRequest: jest.fn(),
    processPayout: jest.fn()
};

// Mock debug manager
const mockDebugManager = {
    CONSOLE_LOGGING: false
};

// Mock payment config manager
const mockPaymentConfigManager = {
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: {
            direct: { enabled: true, price: 100000000000n },
            credits: { enabled: true, creditsPerGame: 1, packages: [{ id: 'small', credits: 10, price: '500000000000', bonus: 0 }] }
        },
        payouts: {
            rules: {
                direct: { multipliers: { escape: 2, escapeWithTreasure: 3 } },
                credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 } }
            }
        },
        preferences: { preferCreditsFirst: true }
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
};

const GameModeManager = require('../src/game/gameModeManager');

describe('GameModeManager', () => {
    let gmm;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.query.mockReset();
        mockClient.query.mockReset().mockResolvedValue({ rows: [] });
        gmm = new GameModeManager(mockDb, mockWalletService, mockDebugManager, mockPaymentConfigManager);
    });

    describe('getEffectiveModeForUser', () => {
        test('returns FREE mode when payments disabled', () => {
            gmm.paymentsEnabled = false;
            const result = gmm.getEffectiveModeForUser({ credits: 5 });
            expect(result.mode).toBe('FREE');
        });

        test('returns PAID_CREDITS when user has credits and preferCreditsFirst', () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.preferCreditsFirst = true;
            gmm.creditsPerGameCost = 1;

            const result = gmm.getEffectiveModeForUser({ credits: 5 });
            expect(result.mode).toBe('PAID_CREDITS');
            expect(result.hasCredits).toBe(true);
            expect(result.bothModesEnabled).toBe(true);
        });

        test('returns PAID_SINGLE when user has no credits in mixed mode', () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.preferCreditsFirst = true;
            gmm.creditsPerGameCost = 1;

            const result = gmm.getEffectiveModeForUser({ credits: 0 });
            expect(result.mode).toBe('PAID_SINGLE');
            expect(result.hasCredits).toBe(false);
        });

        test('returns correct mode when only direct is enabled', () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = false;

            const result = gmm.getEffectiveModeForUser({ credits: 10 });
            expect(result.mode).toBe('PAID_SINGLE');
            expect(result.bothModesEnabled).toBe(false);
        });

        test('returns correct mode when only credits is enabled', () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = false;
            gmm.creditsModeEnabled = true;

            const result = gmm.getEffectiveModeForUser({ credits: 5 });
            expect(result.mode).toBe('PAID_CREDITS');
        });
    });

    describe('calculatePayout', () => {
        test('calculates direct mode payout correctly', () => {
            gmm.singleGamePrice = 100000000000; // 1 WOW
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };

            const result = gmm.calculatePayout('PAID_SINGLE', { treasureFound: false });
            expect(result.amount).toBe(200000000000); // 2x
            expect(result.multiplier).toBe(2);
        });

        test('calculates treasure bonus correctly', () => {
            gmm.singleGamePrice = 100000000000;
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };

            const result = gmm.calculatePayout('PAID_SINGLE', { treasureFound: true });
            expect(result.amount).toBe(300000000000); // 3x
            expect(result.multiplier).toBe(3);
        });

        test('returns zero payout for credits mode when disabled', () => {
            gmm.creditsPayoutBaseValue = 100000000000;
            gmm.creditPayoutMultipliers = { escape: 0, escapeWithTreasure: 0 };

            const result = gmm.calculatePayout('PAID_CREDITS', { treasureFound: false });
            expect(result.amount).toBe(0);
        });

        test('calculates credits mode payout when enabled', () => {
            gmm.creditsPayoutBaseValue = 50000000000; // 0.5 WOW base
            gmm.creditPayoutMultipliers = { escape: 1.5, escapeWithTreasure: 2 };

            const result = gmm.calculatePayout('PAID_CREDITS', { treasureFound: false });
            expect(result.amount).toBe(75000000000); // 0.5 * 1.5
        });
    });

    describe('getPaymentOptionsForUser', () => {
        beforeEach(() => {
            mockDb.query.mockResolvedValue({ rows: [{ id: 1, credits: 5, payout_address: 'wow1addr' }] });
        });

        test('returns use_credit option when user has credits', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.creditsPerGameCost = 1;

            const result = await gmm.getPaymentOptionsForUser('socket1');
            const useCreditOption = result.options.find(o => o.type === 'use_credit');
            expect(useCreditOption).toBeDefined();
            expect(useCreditOption.mode).toBe('PAID_CREDITS');
        });

        test('returns pay_direct option', async () => {
            gmm.directModeEnabled = true;

            const result = await gmm.getPaymentOptionsForUser('socket1');
            const directOption = result.options.find(o => o.type === 'pay_direct');
            expect(directOption).toBeDefined();
            expect(directOption.mode).toBe('PAID_SINGLE');
        });

        test('returns buy_credits option when credits mode enabled', async () => {
            gmm.creditsModeEnabled = true;

            const result = await gmm.getPaymentOptionsForUser('socket1');
            const buyOption = result.options.find(o => o.type === 'buy_credits');
            expect(buyOption).toBeDefined();
        });
    });

    describe('processCreditsPackageConfirmation', () => {
        test('adds correct credits from package info', async () => {
            // Step 1: db.query — SELECT payment lookup
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: '', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // UPDATE payments SET status='confirmed'
                .mockResolvedValueOnce({ rows: [{ credits: 15 }] }) // UPDATE users SET credits = credits + 15
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, { credits: 10, bonus: 5 });
            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(15); // 10 + 5 bonus
        });

        test('falls back to default credits when package info missing and no description', async () => {
            // Step 1: db.query — SELECT payment lookup with no credits in description
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: 'Some payment', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls
            mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // UPDATE payments SET status='confirmed'
                .mockResolvedValueOnce({ rows: [{ credits: 10 }] }) // UPDATE users
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, null);
            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(10); // Default fallback
        });
    });

    describe('canUserStartGame - mixed mode', () => {
        test('allows game with credits in mixed mode', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.creditsPerGameCost = 1;

            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 1, credits: 5 }] }) // getOrCreateUser lookup
                .mockResolvedValueOnce({ rows: [] }); // update last_active

            const result = await gmm.canUserStartGame('socket1');
            expect(result.allowed).toBe(true);
            expect(result.useCredits).toBe(true);
            expect(result.effectiveMode).toBe('PAID_CREDITS');
        });

        test('allows game with confirmed payment when user has no credits', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.creditsPerGameCost = 1;

            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 1, credits: 0 }] }) // getOrCreateUser lookup
                .mockResolvedValueOnce({ rows: [] }) // update last_active
                .mockResolvedValueOnce({ rows: [{ id: 999 }] }); // confirmed payment query

            const result = await gmm.canUserStartGame('socket1');
            expect(result.allowed).toBe(true);
            expect(result.paymentId).toBe(999);
            expect(result.effectiveMode).toBe('PAID_SINGLE');
        });

        test('denies game when no credits and no payment in mixed mode', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.creditsPerGameCost = 1;

            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 1, credits: 0 }] }) // getOrCreateUser lookup
                .mockResolvedValueOnce({ rows: [] }) // update last_active
                .mockResolvedValueOnce({ rows: [] }) // no confirmed payment
                .mockResolvedValueOnce({ rows: [{ id: 1, credits: 0 }] }) // getOrCreateUser for getPaymentOptions
                .mockResolvedValueOnce({ rows: [] }); // update last_active

            const result = await gmm.canUserStartGame('socket1');
            expect(result.allowed).toBe(false);
            expect(result.action).toBe('choose_payment');
        });
    });
});
