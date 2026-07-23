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

    describe('production payout and free-play policy', () => {
        test('financial recovery gate blocks invoice intake and every paid start but preserves explicit free play', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.financialAdmissionAllowed = () => false;

            expect(gmm.isPaymentIntakeEnabled('single_game')).toBe(false);
            expect(gmm.isPaymentIntakeEnabled('credits_package')).toBe(false);
            expect(gmm.isPaymentIntakeEnabled('cosmetic_pack')).toBe(false);

            const user = { id: 7, credits: 5, payout_address: 'wallet' };
            jest.spyOn(gmm, 'getOrCreateUser').mockResolvedValue(user);
            const paid = await gmm.processGameStart('socket-paid', 'game-paid');
            expect(paid).toMatchObject({
                success: false,
                code: 'FINANCIAL_RECOVERY_PENDING'
            });
            expect(mockDb.query).not.toHaveBeenCalled();
            expect(mockDb.withTransaction).not.toHaveBeenCalled();

            expect(await gmm._processGameStartWithCredits(user, 'socket-paid', 'game-credits'))
                .toMatchObject({ success: false, code: 'FINANCIAL_RECOVERY_PENDING' });
            expect(await gmm._processGameStartWithPayment(user, { id: 9 }, 'game-direct'))
                .toMatchObject({ success: false, code: 'FINANCIAL_RECOVERY_PENDING' });
            expect(mockDb.withTransaction).not.toHaveBeenCalled();

            jest.spyOn(gmm, '_processGameStartFree').mockResolvedValue({
                success: true,
                effectiveMode: 'FREE'
            });
            await expect(gmm.processGameStart('socket-free', 'game-free', { forceFree: true }))
                .resolves.toEqual({ success: true, effectiveMode: 'FREE' });
        });

        test('master payout switch overrides enabled per-mode rules and stops dispatch', async () => {
            gmm.payoutsEnabled = false;
            gmm.directPayoutEnabled = true;
            gmm.creditsPayoutEnabled = true;
            gmm.directRequiresAddress = true;

            expect(gmm.isPayoutEnabledForMode('PAID_SINGLE')).toBe(false);
            expect(gmm.isPayoutEnabledForMode('PAID_CREDITS')).toBe(false);
            expect(gmm.requiresPayoutAddressForMode('PAID_SINGLE')).toBe(false);

            await gmm._processPendingPayouts();
            expect(mockDb.withTransaction).not.toHaveBeenCalled();
            expect(mockWalletService.processPayout).not.toHaveBeenCalled();
        });

        test('shutdown cancels a queued payout debounce and rejects later scheduling', async () => {
            jest.useFakeTimers();
            try {
                const processPending = jest.spyOn(gmm, '_processPendingPayouts').mockResolvedValue();

                gmm._scheduleBatchPayout();
                expect(jest.getTimerCount()).toBe(1);

                gmm.shutdown();
                expect(gmm._batchPayoutTimer).toBeNull();
                expect(jest.getTimerCount()).toBe(0);

                gmm._scheduleBatchPayout();
                jest.advanceTimersByTime(5000);
                await Promise.resolve();
                expect(processPending).not.toHaveBeenCalled();
                expect(jest.getTimerCount()).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });

        test('unified paid config does not accidentally inherit free mode when FREE_PLAY_ENABLED is false', () => {
            const oldGameMode = process.env.GAME_MODE;
            const oldFree = process.env.FREE_PLAY_ENABLED;
            try {
                delete process.env.GAME_MODE;
                process.env.FREE_PLAY_ENABLED = 'false';
                const manager = new GameModeManager(mockDb, mockWalletService, mockDebugManager, mockPaymentConfigManager);
                expect(manager.paymentsEnabled).toBe(true);
                expect(manager.freePlayEnabled).toBe(false);
            } finally {
                if (oldGameMode === undefined) delete process.env.GAME_MODE; else process.env.GAME_MODE = oldGameMode;
                if (oldFree === undefined) delete process.env.FREE_PLAY_ENABLED; else process.env.FREE_PLAY_ENABLED = oldFree;
            }
        });

        test('game mode info advertises the selected safe ruleset catalog', () => {
            const old = process.env.MATCH_RULESET_ID;
            try {
                process.env.MATCH_RULESET_ID = 'last-alive';
                const match = gmm.getGameModeInfo().modes.match;
                expect(match.activeRuleset).toEqual(expect.objectContaining({
                    id: 'last-alive',
                    label: 'Last Alive',
                    winCondition: 'last-alive'
                }));
                expect(match.rulesets.map(r => r.id)).toEqual(expect.arrayContaining(['race', 'last-alive', 'score-attack', 'coop-escape']));
                expect(match.rulesets.map(r => r.id)).not.toContain('solo-classic');
            } finally {
                if (old === undefined) delete process.env.MATCH_RULESET_ID; else process.env.MATCH_RULESET_ID = old;
            }
        });

        test('game mode info publishes only a recognized operated product profile id', () => {
            const old = process.env.OPERATED_PRODUCT_PROFILE;
            try {
                process.env.OPERATED_PRODUCT_PROFILE = 'such-play-wow-prestige';
                expect(gmm.getGameModeInfo().operatedProductProfileId)
                    .toBe('such-play-wow-prestige');
                process.env.OPERATED_PRODUCT_PROFILE = 'unreviewed-profile';
                expect(gmm.getGameModeInfo().operatedProductProfileId).toBeNull();
            } finally {
                if (old === undefined) delete process.env.OPERATED_PRODUCT_PROFILE;
                else process.env.OPERATED_PRODUCT_PROFILE = old;
            }
        });

        test('crypto race economy is hidden when the payout master switch is off', () => {
            const keys = [
                'MATCH_ENABLED', 'MATCH_CRYPTO_RACE_ENABLED', 'MATCH_PAYOUTS_ENABLED',
                'MATCH_PAYOUT_MAX', 'MATCH_ENTRY_FEE_ATOMIC', 'MATCH_HOUSE_FEE_PERCENT',
                'MATCH_MAX_PLAYERS'
            ];
            const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
            try {
                process.env.MATCH_ENABLED = 'true';
                process.env.MATCH_CRYPTO_RACE_ENABLED = 'true';
                process.env.MATCH_PAYOUTS_ENABLED = 'true';
                process.env.MATCH_PAYOUT_MAX = '1000000000000';
                process.env.MATCH_ENTRY_FEE_ATOMIC = '10000';
                process.env.MATCH_HOUSE_FEE_PERCENT = '5';
                process.env.MATCH_MAX_PLAYERS = '4';
                gmm.payoutsEnabled = false;
                expect(gmm._getMatchEconomies().crypto_race).toBeUndefined();
                gmm.payoutsEnabled = true;
                expect(gmm._getMatchEconomies().crypto_race).toBe(true);
            } finally {
                for (const key of keys) {
                    if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
                }
            }
        });
    });

    describe('calculatePayout', () => {
        test('publishes only the double/triple outcomes implemented by payout calculation', () => {
            gmm.directPayoutMultipliers = {
                escape: 2,
                escapeWithTreasure: 3,
                perfectRun: 5,
                experimentalJackpot: 20
            };
            gmm.creditPayoutMultipliers = {
                escape: 2,
                escapeWithTreasure: 3,
                perfectRun: 3
            };

            expect(gmm.getImplementedPayoutMultipliersForMode('PAID_SINGLE')).toStrictEqual({
                escape: 2,
                escapeWithTreasure: 3
            });
            expect(gmm.getImplementedPayoutMultipliersForMode('PAID_CREDITS')).toStrictEqual({
                escape: 2,
                escapeWithTreasure: 3
            });

            const publicInfo = gmm.getGameModeInfo();
            expect(publicInfo.payoutMultipliers).toStrictEqual({
                direct: { escape: 2, escapeWithTreasure: 3 },
                credits: { escape: 2, escapeWithTreasure: 3 }
            });
        });

        test('publishes exact effective outcomes after cap/min policy', () => {
            gmm.payoutsEnabled = true;
            gmm.directPayoutEnabled = true;
            gmm.creditsPayoutEnabled = true;
            gmm.singleGamePrice = 20000;
            gmm.creditsPayoutBaseValue = 1000;
            gmm.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
            gmm.creditPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
            gmm.configSnapshot.payouts.rules.direct.minPayout = 1n;
            gmm.configSnapshot.payouts.rules.direct.maxPayout = 50000n;
            gmm.configSnapshot.payouts.rules.credits.minPayout = 3000n;
            gmm.configSnapshot.payouts.rules.credits.maxPayout = 50000n;

            const outcomes = gmm.getGameModeInfo().payoutOutcomes;
            expect(outcomes.direct.escape).toEqual(expect.objectContaining({
                payable: true,
                amountAtomic: '40000',
                rawAmountAtomic: '40000',
                capApplied: false
            }));
            expect(outcomes.direct.escapeWithTreasure).toEqual(expect.objectContaining({
                payable: true,
                amountAtomic: '50000',
                rawAmountAtomic: '60000',
                capApplied: true
            }));
            expect(outcomes.credits.escape).toEqual(expect.objectContaining({
                payable: false,
                amountAtomic: '0',
                rawAmountAtomic: '2000',
                suppressedReason: 'below_minimum'
            }));

            const snapshot = gmm._computePayoutSnapshot('PAID_SINGLE');
            expect(snapshot.treasureAmount).toBe('50000');
            expect(snapshot.terms.version).toBe(2);
        });

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
            mockClient.query.mockImplementation(async (sql) => {
                if (/UPDATE payments/i.test(sql)) return { rows: [{ id: 123 }], rowCount: 1 };
                if (/SELECT id, premium_level/i.test(sql)) return { rows: [{ id: 1, premium_level: 'free' }], rowCount: 1 };
                if (/UPDATE users/i.test(sql)) return { rows: [{ id: 1, credits: 15, total_credits_purchased: 15, premium_level: 'free' }], rowCount: 1 };
                if (/INSERT INTO payment_entitlement_grants/i.test(sql)) return { rows: [{ payment_id: 123 }], rowCount: 1 };
                if (/SELECT pack_id/i.test(sql)) return { rows: [] };
                return { rows: [], rowCount: 1 };
            });

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, { credits: 10, bonus: 5 });
            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(15); // 10 + 5 bonus
        });

        test('applies bundled pack grants from package info', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: '', status: 'pending', payment_type: 'credits_package' }]
            });

            mockClient.query.mockImplementation(async (sql) => {
                if (/UPDATE payments/i.test(sql)) return { rows: [{ id: 123 }], rowCount: 1 };
                if (/SELECT id, premium_level/i.test(sql)) return { rows: [{ id: 1, premium_level: 'free' }], rowCount: 1 };
                if (/UPDATE users/i.test(sql)) return { rows: [{ id: 1, credits: 15, total_credits_purchased: 15, premium_level: 'supporter' }], rowCount: 1 };
                if (/INSERT INTO user_pack_entitlements/i.test(sql)) return { rows: [{ pack_id: 'kenney-3d-characters' }], rowCount: 1 };
                if (/INSERT INTO payment_entitlement_grants/i.test(sql)) return { rows: [{ payment_id: 123 }], rowCount: 1 };
                if (/SELECT pack_id/i.test(sql)) return { rows: [{ pack_id: 'kenney-3d-characters' }] };
                return { rows: [], rowCount: 1 };
            });

            const result = await gmm.processCreditsPackageConfirmation('socket1', 123, {
                id: 'bundle',
                credits: 10,
                grants: {
                    credits: 15,
                    packs: ['kenney-3d-characters'],
                    premiumLevel: 'supporter'
                }
            });

            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(15);
            expect(result.grantsApplied.packs.map(p => p.id)).toEqual(['kenney-3d-characters']);
            expect(result.entitlements.packs['kenney-3d-characters']).toBe(true);

            const entitlementInsert = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO user_pack_entitlements/i.test(sql));
            expect(entitlementInsert).toBeDefined();
            expect(entitlementInsert[1][1]).toBe('kenney-3d-characters');
        });

        test('applies standalone cosmetic pack product without granting credits', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    user_id: 1,
                    description: '3D pack',
                    status: 'pending',
                    payment_type: 'cosmetic_pack',
                    product_id: 'pack_3d',
                    product_grants: { credits: 0, packs: [{ id: 'kenney-3d-characters' }], premiumLevel: null }
                }]
            });

            mockClient.query.mockImplementation(async (sql) => {
                if (/UPDATE payments/i.test(sql)) return { rows: [{ id: 456 }], rowCount: 1 };
                if (/SELECT id, premium_level/i.test(sql)) return { rows: [{ id: 1, premium_level: 'free' }], rowCount: 1 };
                if (/UPDATE users/i.test(sql)) return { rows: [{ id: 1, credits: 0, total_credits_purchased: 0, premium_level: 'free' }], rowCount: 1 };
                if (/INSERT INTO user_pack_entitlements/i.test(sql)) return { rows: [{ pack_id: 'kenney-3d-characters' }], rowCount: 1 };
                if (/INSERT INTO payment_entitlement_grants/i.test(sql)) return { rows: [{ payment_id: 456 }], rowCount: 1 };
                if (/SELECT pack_id/i.test(sql)) return { rows: [{ pack_id: 'kenney-3d-characters' }] };
                return { rows: [], rowCount: 1 };
            });

            const result = await gmm.processProductPaymentConfirmation('socket1', 456, null, 1000);

            expect(result.success).toBe(true);
            expect(result.creditsAdded).toBe(0);
            expect(result.entitlements.packs['kenney-3d-characters']).toBe(true);
            expect(mockClient.query.mock.calls.some(([sql]) => /INSERT INTO credit_transactions/i.test(sql))).toBe(false);
        });

        test('creates an exact funded lot from the durable confirmed-payment grant snapshot', async () => {
            const keys = ['MATCH_CRYPTO_RACE_ENABLED', 'MATCH_PAYOUTS_ENABLED', 'MATCH_ENTRY_FEE_ATOMIC'];
            const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
            try {
                process.env.MATCH_CRYPTO_RACE_ENABLED = 'true';
                process.env.MATCH_PAYOUTS_ENABLED = 'true';
                process.env.MATCH_ENTRY_FEE_ATOMIC = '10000';
                mockDb.query.mockResolvedValueOnce({
                    rows: [{
                        user_id: 1,
                        description: 'Two race entries',
                        status: 'pending',
                        payment_type: 'cosmetic_pack',
                        product_id: 'race_2',
                        product_grants: {
                            credits: 0,
                            raceEntries: 2,
                            raceEntryValueAtomic: '10000',
                            packs: [],
                            premiumLevel: null
                        },
                        received_amount: '20000',
                        expected_amount: '20000'
                    }]
                });
                mockClient.query.mockImplementation(async (sql) => {
                    if (/UPDATE payments/i.test(sql)) return { rows: [{ id: 700 }], rowCount: 1 };
                    if (/SELECT id, premium_level/i.test(sql)) {
                        return { rows: [{ id: 1, premium_level: 'free' }], rowCount: 1 };
                    }
                    if (/SET credits = credits/i.test(sql)) {
                        return {
                            rows: [{ id: 1, credits: 0, total_credits_purchased: 0, premium_level: 'free' }],
                            rowCount: 1
                        };
                    }
                    if (/SET race_entries = race_entries \+/i.test(sql)) {
                        return { rows: [{ race_entries: 2 }], rowCount: 1 };
                    }
                    if (/INSERT INTO race_entry_lots/i.test(sql)) {
                        return { rows: [{ id: 88 }], rowCount: 1 };
                    }
                    if (/SELECT pack_id/i.test(sql)) return { rows: [], rowCount: 0 };
                    return { rows: [], rowCount: 1 };
                });

                const result = await gmm.processProductPaymentConfirmation('new-socket', 700, {
                    id: 'changed-live-catalog',
                    grants: { race_entries: 99, race_entry_value_atomic: '1' }
                }, '20000');

                expect(result.success).toBe(true);
                const lot = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO race_entry_lots/i.test(sql));
                expect(lot[1]).toEqual([1, 700, '10000', 2, 'race_2']);
                const ticketLedger = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO race_entry_transactions/i.test(sql));
                expect(ticketLedger[1][3]).toBe(700);
            } finally {
                for (const key of keys) {
                    if (previous[key] === undefined) delete process.env[key];
                    else process.env[key] = previous[key];
                }
            }
        });

        test('does not confirm an underfunded race-ticket invoice', async () => {
            const keys = ['MATCH_CRYPTO_RACE_ENABLED', 'MATCH_PAYOUTS_ENABLED', 'MATCH_ENTRY_FEE_ATOMIC'];
            const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
            try {
                process.env.MATCH_CRYPTO_RACE_ENABLED = 'true';
                process.env.MATCH_PAYOUTS_ENABLED = 'true';
                process.env.MATCH_ENTRY_FEE_ATOMIC = '10000';
                mockDb.query.mockResolvedValueOnce({
                    rows: [{
                        user_id: 1,
                        status: 'pending',
                        payment_type: 'cosmetic_pack',
                        product_id: 'race_2',
                        product_grants: {
                            credits: 0,
                            raceEntries: 2,
                            raceEntryValueAtomic: '10000'
                        },
                        received_amount: '19999',
                        expected_amount: '20000'
                    }]
                });

                const result = await gmm.processProductPaymentConfirmation('new-socket', 701, null, '19999');

                expect(result.success).toBe(false);
                expect(mockDb.withTransaction).not.toHaveBeenCalled();
            } finally {
                for (const key of keys) {
                    if (previous[key] === undefined) delete process.env[key];
                    else process.env[key] = previous[key];
                }
            }
        });

        test('falls back to default credits when package info missing and no description', async () => {
            // Step 1: db.query — SELECT payment lookup with no credits in description
            mockDb.query.mockResolvedValueOnce({
                rows: [{ user_id: 1, description: 'Some payment', status: 'pending' }]
            });

            // Step 2: withTransaction — client.query calls
            mockClient.query.mockImplementation(async (sql) => {
                if (/UPDATE payments/i.test(sql)) return { rows: [{ id: 123 }], rowCount: 1 };
                if (/SELECT id, premium_level/i.test(sql)) return { rows: [{ id: 1, premium_level: 'free' }], rowCount: 1 };
                if (/UPDATE users/i.test(sql)) return { rows: [{ id: 1, credits: 10, total_credits_purchased: 10, premium_level: 'free' }], rowCount: 1 };
                if (/INSERT INTO payment_entitlement_grants/i.test(sql)) return { rows: [{ payment_id: 123 }], rowCount: 1 };
                if (/SELECT pack_id/i.test(sql)) return { rows: [] };
                return { rows: [], rowCount: 1 };
            });

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

        test('when direct is preferred, a confirmed direct entry is not replaced by an existing credit', async () => {
            gmm.paymentsEnabled = true;
            gmm.directModeEnabled = true;
            gmm.creditsModeEnabled = true;
            gmm.preferCreditsFirst = false;

            mockDb.query
                .mockResolvedValueOnce({ rows: [{ id: 1, credits: 5 }] })
                .mockResolvedValueOnce({ rows: [] })
                .mockResolvedValueOnce({ rows: [{ id: 999 }] });

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
