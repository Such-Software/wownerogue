/**
 * Comprehensive Payment and Payout Tests
 * Deep testing of all payment flows, credits, payouts, and edge cases
 */

const GameModeManager = require('../src/game/gameModeManager');

// Mock dependencies
const createMockDb = () => {
    const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] })
    };
    return {
        query: jest.fn(),
        // Mock withTransaction to execute the callback with a shared mock client
        // so tests can set up client.query expectations
        withTransaction: jest.fn().mockImplementation(async (callback) => {
            return callback(mockClient);
        }),
        _mockClient: mockClient // Expose for test setup
    };
};

const createMockWalletService = () => ({
    createPaymentRequest: jest.fn(),
    processPayout: jest.fn(),
    startPaymentMonitoring: jest.fn(),
    stopPaymentMonitoring: jest.fn()
});

const createMockDebugManager = () => ({
    CONSOLE_LOGGING: false,
    getCurrentBlockHeight: () => 12345
});

const createMockPaymentConfig = (overrides = {}) => ({
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: {
            direct: { enabled: true, price: 100000000000n },
            credits: { enabled: true, creditsPerGame: 1, packages: [
                { id: 'small', credits: 10, price: '500000000000', bonus: 0 },
                { id: 'medium', credits: 25, price: '1000000000000', bonus: 2 }
            ] }
        },
        payouts: {
            rules: {
                direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 } },
                credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 }, baseValue: 50000000000n }
            }
        },
        preferences: { preferCreditsFirst: true },
        earlyEntry: { enabled: true, allowInFreeMode: true, allowInCreditsMode: true },
        ...overrides
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
});

describe('Payment & Payout Comprehensive Tests', () => {
    let gmm;
    let mockDb;
    let mockWalletService;
    let mockDebugManager;
    let mockPaymentConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb = createMockDb();
        mockWalletService = createMockWalletService();
        mockDebugManager = createMockDebugManager();
        mockPaymentConfig = createMockPaymentConfig();
        
        gmm = new GameModeManager(mockDb, mockWalletService, mockDebugManager, mockPaymentConfig);
    });

    describe('Credit Deduction - Negative Balance Prevention', () => {
        test('should fail gracefully when user has insufficient credits', async () => {
            const user = { id: 1, credits: 0 };
            gmm.creditsPerGameCost = 1;

            // The credits update should return 0 rows because WHERE credits >= 1 fails
            // (when user.credits = 0 and we require >= 1)
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // UPDATE users ... WHERE credits >= 1 - returns empty!

            const result = await gmm._processGameStartWithCredits(user, 'socket1', 'game123');
            
            expect(result.success).toBe(false);
            expect(result.reason).toBe('Insufficient credits');
            expect(result.creditsRequired).toBe(1);
        });

        test('should succeed when user has exactly enough credits', async () => {
            const user = { id: 1, credits: 1 };
            gmm.creditsPerGameCost = 1;

            // All queries inside withTransaction go through client.query
            mockDb._mockClient.query
                .mockResolvedValueOnce({ rows: [{ credits: 0 }] }) // UPDATE users ... WHERE credits >= 1
                .mockResolvedValueOnce({ rows: [] }) // UPDATE games
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm._processGameStartWithCredits(user, 'socket1', 'game123');

            expect(result.success).toBe(true);
            expect(result.creditsRemaining).toBe(0);
            expect(result.creditsSpent).toBe(1);
        });

        test('should deduct correct amount for multi-credit games', async () => {
            const user = { id: 1, credits: 5 };
            gmm.creditsPerGameCost = 2;

            // All queries inside withTransaction go through client.query
            mockDb._mockClient.query
                .mockResolvedValueOnce({ rows: [{ credits: 3 }] }) // UPDATE users
                .mockResolvedValueOnce({ rows: [] }) // UPDATE games
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm._processGameStartWithCredits(user, 'socket1', 'game123');

            expect(result.success).toBe(true);
            expect(result.creditsRemaining).toBe(3);
            expect(result.creditsSpent).toBe(2);
        });
    });

    describe('Payout Calculation', () => {
        test('direct mode escape payout calculated correctly', () => {
            gmm.singleGamePrice = 100000000000;
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };

            const result = gmm.calculatePayout('PAID_SINGLE', { treasureFound: false });
            
            expect(result.amount).toBe(200000000000);
            expect(result.multiplier).toBe(2);
            expect(result.base).toBe(100000000000);
        });

        test('direct mode treasure payout calculated correctly', () => {
            gmm.singleGamePrice = 100000000000;
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };

            const result = gmm.calculatePayout('PAID_SINGLE', { treasureFound: true });
            
            expect(result.amount).toBe(300000000000);
            expect(result.multiplier).toBe(3);
        });

        test('credits mode uses base value not single game price', () => {
            gmm.singleGamePrice = 100000000000;
            gmm.creditsPayoutBaseValue = 50000000000;
            gmm.creditPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };

            const result = gmm.calculatePayout('PAID_CREDITS', { treasureFound: false });
            
            expect(result.amount).toBe(100000000000); // 50000000000 * 2
            expect(result.base).toBe(50000000000);
        });

        test('zero multiplier returns zero payout', () => {
            gmm.creditPayoutMultipliers = { escape: 0, escapeWithTreasure: 0 };
            gmm.creditsPayoutBaseValue = 100000000000;

            const result = gmm.calculatePayout('PAID_CREDITS', { treasureFound: false });
            
            expect(result.amount).toBe(0);
        });

        test('fractional multipliers work correctly', () => {
            gmm.singleGamePrice = 100000000000;
            gmm.directPayoutMultipliers = { escape: 1.5, escapeWithTreasure: 2.5 };

            const result = gmm.calculatePayout('PAID_SINGLE', { treasureFound: false });
            
            expect(result.amount).toBe(150000000000);
        });
    });

    describe('Mixed Mode Payment Selection', () => {
        beforeEach(() => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.creditsPerGameCost = 1;
        });

        test('prefers credits when user has credits and preferCreditsFirst is true', async () => {
            gmm.preferCreditsFirst = true;
            const user = { id: 1, credits: 5, payout_address: 'wow1addr' };
            
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active

            const result = await gmm.canUserStartGame('socket1');
            
            expect(result.allowed).toBe(true);
            expect(result.useCredits).toBe(true);
            expect(result.effectiveMode).toBe('PAID_CREDITS');
        });

        test('uses direct payment when user has no credits', async () => {
            gmm.preferCreditsFirst = true;
            const user = { id: 1, credits: 0, payout_address: 'wow1addr' };
            
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            // Has confirmed payment
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 123 }] }); // confirmed payment query

            const result = await gmm.canUserStartGame('socket1');
            
            expect(result.allowed).toBe(true);
            expect(result.paymentId).toBe(123);
            expect(result.effectiveMode).toBe('PAID_SINGLE');
        });

        test('denies when no credits and no confirmed payment', async () => {
            const user = { id: 1, credits: 0, payout_address: 'wow1addr' };
            
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no confirmed payment
            // getPaymentOptionsForUser will be called
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser again
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active

            const result = await gmm.canUserStartGame('socket1');
            
            expect(result.allowed).toBe(false);
            expect(result.action).toBe('choose_payment');
        });
    });

    describe('Credits Package Confirmation', () => {
        test('adds credits from package info correctly', async () => {
            // Step 1: db.query — SELECT payment lookup (has user_id, status='pending')
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: '', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls:
            mockDb._mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // UPDATE payments SET status='confirmed' RETURNING id
                .mockResolvedValueOnce({ rows: [{ credits: 15 }] }) // UPDATE users SET credits = credits + 15
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, { credits: 10, bonus: 5 });

            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(15);
            expect(result.newBalance).toBe(15);
        });

        test('parses credits from payment description as fallback', async () => {
            // Step 1: db.query — SELECT payment lookup with description
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: 'Wowngeon 25 credits package (WOW)', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls:
            mockDb._mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // UPDATE payments SET status='confirmed'
                .mockResolvedValueOnce({ rows: [{ credits: 30 }] }) // UPDATE users
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, null);

            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(25); // Parsed from description
        });

        test('defaults to 10 credits when no info available', async () => {
            // Step 1: db.query — SELECT payment lookup with non-matching description
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: 'Some payment', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls:
            mockDb._mockClient.query
                .mockResolvedValueOnce({ rows: [{ id: 123 }] }) // UPDATE payments SET status='confirmed'
                .mockResolvedValueOnce({ rows: [{ credits: 10 }] }) // UPDATE users
                .mockResolvedValueOnce({ rows: [] }); // INSERT credit_transactions

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, null);

            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(10); // Default fallback
        });
    });

    describe('Game Completion & Payout Flow', () => {
        beforeEach(() => {
            gmm.gameMode = 'PAID_SINGLE';
            gmm.singleGamePrice = 100000000000;
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
        });

        test('processes winning game with payout correctly', async () => {
            // Game record lookup
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }]
            });
            // Game update
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            // Check for existing payout
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            // User lookup
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, payout_address: 'wow1testaddress' }]
            });
            // INSERT payout (pending record) - returns new payout id
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 999 }]
            });

            const result = await gmm.completeGame('socket1', 'game123', true, false, { moves: 50 });

            expect(result.success).toBe(true);
            expect(result.payout).toBeDefined();
            expect(result.payout.status).toBe('queued');
            expect(result.payout.payoutId).toBe(999);
            expect(result.payout.amount).toBe(200000000000);
            expect(result.payout.multiplier).toBe(2);
            // processPayout is NOT called directly — payout is batched via _scheduleBatchPayout
            expect(mockWalletService.processPayout).not.toHaveBeenCalled();
        });

        test('treasure bonus applied correctly to payout', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }]
            });
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payout
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, payout_address: 'wow1testaddress' }]
            });
            // INSERT payout (pending record)
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 999 }]
            });

            const result = await gmm.completeGame('socket1', 'game123', true, true, { moves: 30 });

            expect(result.payout.status).toBe('queued');
            expect(result.payout.amount).toBe(300000000000); // 3x for treasure
            expect(result.payout.multiplier).toBe(3);
            expect(result.payout.treasure).toBe(true);
        });

        test('no payout for losing game', async () => {
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }] 
            });
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // game update

            const result = await gmm.completeGame('socket1', 'game123', false, false, {});
            
            expect(result.success).toBe(true);
            expect(result.payout).toBeNull();
            expect(mockWalletService.processPayout).not.toHaveBeenCalled();
        });

        test('no payout when user has no payout address', async () => {
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }] 
            });
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // game update
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payout
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ id: 1, payout_address: null }] // No address
            });

            const result = await gmm.completeGame('socket1', 'game123', true, false, {});
            
            expect(result.success).toBe(true);
            expect(result.payout).toBeNull();
            expect(result.reason).toBe('No payout address');
            expect(mockWalletService.processPayout).not.toHaveBeenCalled();
        });

        test('prevents duplicate payout for same game', async () => {
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }] 
            });
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // game update
            // Existing payout found
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ id: 999 }] 
            });

            const result = await gmm.completeGame('socket1', 'game123', true, false, {});
            
            expect(result.success).toBe(true);
            expect(result.payout).toBeNull();
            expect(result.reason).toBe('Payout already processed');
            expect(mockWalletService.processPayout).not.toHaveBeenCalled();
        });

        test('uses recorded payment_mode not current gameMode', async () => {
            // Current global mode is PAID_SINGLE
            gmm.gameMode = 'PAID_SINGLE';
            // But the game was started in credits mode
            gmm.creditsPayoutEnabled = true;
            gmm.creditsPayoutBaseValue = 50000000000;
            gmm.creditPayoutMultipliers = { escape: 1.5, escapeWithTreasure: 2 };

            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, user_id: 1, game_mode: 'PAID_CREDITS' }] // Game was started with credits
            });
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // game update
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payout
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1, payout_address: 'wow1testaddress' }]
            });
            // INSERT payout (pending record)
            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 999 }]
            });

            const result = await gmm.completeGame('socket1', 'game123', true, false, {});

            // Should use credits multipliers, not direct
            expect(result.payout.status).toBe('queued');
            expect(result.payout.amount).toBe(75000000000); // 50000000000 * 1.5
            expect(result.payout.multiplier).toBe(1.5);
        });
    });

    describe('Payment Request Creation', () => {
        test('creates single_game payment request correctly', async () => {
            const user = { id: 1, credits: 0 };
            gmm.singleGamePrice = 100000000000;

            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payment
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // expire stale payments

            mockWalletService.createPaymentRequest.mockResolvedValueOnce({
                address: 'wow1paymentaddr',
                expiresAt: new Date()
            });

            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 999, expires_at: new Date() }]
            }); // INSERT payment

            const result = await gmm.createPaymentRequest('socket1', 'single_game');
            
            expect(result.address).toBe('wow1paymentaddr');
            expect(result.amount).toBe(100000000000);
            expect(result.paymentType).toBe('single_game');
            expect(mockWalletService.createPaymentRequest).toHaveBeenCalledWith(
                100000000000,
                expect.stringContaining('single game'),
                1,
                'socket1'
            );
        });

        test('creates credits_package payment request correctly', async () => {
            const user = { id: 1, credits: 0 };
            gmm.creditsPackagePrice = 500000000000;

            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payment
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // expire stale payments

            mockWalletService.createPaymentRequest.mockResolvedValueOnce({
                address: 'wow1creditspayment',
                expiresAt: new Date()
            });

            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1000, expires_at: new Date() }]
            }); // INSERT payment

            const result = await gmm.createPaymentRequest('socket1', 'credits_package');
            
            expect(result.address).toBe('wow1creditspayment');
            expect(result.paymentType).toBe('credits_package');
            expect(result.package).toBeDefined();
        });

        test('creates cosmetic_pack payment request with durable product grants', async () => {
            const user = { id: 1, credits: 0 };
            gmm.configSnapshot.products = {
                cosmetic: [{
                    id: 'pack_3d',
                    label: '3D Character Pack',
                    price: 250000000000n,
                    grants: { packs: ['kenney-3d-characters'] }
                }]
            };

            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payment
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // expire stale payments

            mockWalletService.createPaymentRequest.mockResolvedValueOnce({
                address: 'wow1packpayment',
                expiresAt: new Date()
            });

            mockDb.query.mockResolvedValueOnce({
                rows: [{ id: 1001, expires_at: new Date() }]
            }); // INSERT payment

            const result = await gmm.createPaymentRequest('socket1', 'cosmetic_pack', { productId: 'pack_3d' });

            expect(result.address).toBe('wow1packpayment');
            expect(result.paymentType).toBe('cosmetic_pack');
            expect(result.productId).toBe('pack_3d');
            expect(result.grants.packs).toEqual(['kenney-3d-characters']);
            expect(mockWalletService.createPaymentRequest).toHaveBeenCalledWith(
                250000000000,
                expect.stringContaining('3D Character Pack'),
                1,
                'socket1'
            );

            const insertCall = mockDb.query.mock.calls.find(([sql]) => /INSERT INTO payments/i.test(sql));
            expect(insertCall[1][8]).toBe('pack_3d');
            expect(JSON.parse(insertCall[1][9]).packs[0].id).toBe('kenney-3d-characters');
        });

        test('reuses existing pending payment request', async () => {
            const user = { id: 1, credits: 0 };
            gmm.singleGamePrice = 100000000000;
            
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
            // Existing pending payment
            mockDb.query.mockResolvedValueOnce({ 
                rows: [{ 
                    id: 555, 
                    subaddress: 'wow1existingaddr',
                    expected_amount: '100000000000',
                    payment_type: 'single_game',
                    status: 'pending',
                    expires_at: new Date(Date.now() + 1800000)
                }] 
            });

            const result = await gmm.createPaymentRequest('socket1', 'single_game', { reuseExisting: true });
            
            expect(result.id).toBe(555);
            expect(result.address).toBe('wow1existingaddr');
            expect(result.reused).toBe(true);
            // Should not create a new payment
            expect(mockWalletService.createPaymentRequest).not.toHaveBeenCalled();
        });

        test('throws on invalid payment type', async () => {
            const user = { id: 1, credits: 0 };
            
            mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
            mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active

            await expect(gmm.createPaymentRequest('socket1', 'invalid_type'))
                .rejects.toThrow(/Invalid payment type/);
        });
    });

    describe('Game Mode Info', () => {
        test('returns complete game mode info', () => {
            gmm.gameMode = 'PAID_SINGLE';
            gmm.cryptoType = 'WOW';
            gmm.singleGamePrice = 100000000000;
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = false;

            const info = gmm.getGameModeInfo();
            
            expect(info.mode).toBe('PAID_SINGLE');
            expect(info.cryptoType).toBe('WOW');
            expect(info.singleGamePrice).toBe(100000000000);
            expect(info.paymentsEnabled).toBe(true);
            expect(info.directModeEnabled).toBe(true);
            expect(info.creditsModeEnabled).toBe(false);
            expect(info.earlyEntry).toBeDefined();
            expect(info.payoutMultipliers).toBeDefined();
        });

        test('includes testnet warning for XMR stagenet', () => {
            gmm.cryptoType = 'XMR';
            gmm.network = 'stagenet';
            gmm.isTestNetwork = true;

            const info = gmm.getGameModeInfo();
            
            expect(info.isTestNetwork).toBe(true);
            expect(info.testnetWarning).toContain('STAGENET');
        });

        test('no testnet warning for WOW (only has mainnet)', () => {
            gmm.cryptoType = 'WOW';
            gmm.network = 'mainnet';
            gmm.isTestNetwork = false;

            const info = gmm.getGameModeInfo();
            
            expect(info.isTestNetwork).toBe(false);
            expect(info.testnetWarning).toBeNull();
        });
    });

    describe('User Stats', () => {
        test('returns user statistics from database function', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    total_games: 100,
                    games_won: 45,
                    win_rate: 0.45,
                    total_paid: 5000000000000,
                    total_won: 6000000000000,
                    net_profit: 1000000000000,
                    credits_remaining: 15
                }]
            });

            const stats = await gmm.getUserStats('socket1');
            
            expect(stats.total_games).toBe(100);
            expect(stats.games_won).toBe(45);
            expect(stats.net_profit).toBe(1000000000000);
        });

        test('returns default stats when none found', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [] });

            const stats = await gmm.getUserStats('socket1');
            
            expect(stats.total_games).toBe(0);
            expect(stats.games_won).toBe(0);
            expect(stats.net_profit).toBe(0);
        });
    });
});

describe('Edge Cases and Error Handling', () => {
    let gmm;
    let mockDb;
    let mockWalletService;

    beforeEach(() => {
        mockDb = createMockDb();
        mockWalletService = createMockWalletService();
        gmm = new GameModeManager(mockDb, mockWalletService, createMockDebugManager(), createMockPaymentConfig());
    });

    test('handles payout insert failure gracefully', async () => {
        gmm.gameMode = 'PAID_SINGLE';

        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, payment_mode: 'direct' }] });
        mockDb.query.mockResolvedValueOnce({ rows: [] }); // game update
        mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payout
        mockDb.query.mockResolvedValueOnce({
            rows: [{ id: 1, payout_address: 'wow1testaddress' }]
        });
        // INSERT payout fails
        mockDb.query.mockRejectedValueOnce(new Error('Database connection lost'));

        const result = await gmm.completeGame('socket1', 'game123', true, false, {});

        expect(result.success).toBe(true);
        expect(result.payout).toBeNull();
        expect(result.payoutError).toBeDefined();
    });

    test('handles database error during credits deduction', async () => {
        const user = { id: 1, credits: 5 };

        // _processGameStartWithCredits uses withTransaction, so error must come from there
        mockDb.withTransaction.mockRejectedValueOnce(new Error('Database connection lost'));

        await expect(gmm._processGameStartWithCredits(user, 'socket1', 'game123'))
            .rejects.toThrow('Database connection lost');
    });

    test('handles payment creation when wallet is unavailable', async () => {
        const user = { id: 1 };
        
        mockDb.query.mockResolvedValueOnce({ rows: [user] }); // getOrCreateUser
        mockDb.query.mockResolvedValueOnce({ rows: [] }); // update last_active
        mockDb.query.mockResolvedValueOnce({ rows: [] }); // no existing payment
        
        mockWalletService.createPaymentRequest.mockRejectedValueOnce(
            new Error('RPC connection refused')
        );

        await expect(gmm.createPaymentRequest('socket1', 'single_game'))
            .rejects.toThrow();
    });
});
