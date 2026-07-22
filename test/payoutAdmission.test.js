const GameModeManager = require('../src/game/gameModeManager');
const {
    PAYOUT_ADMISSION_LOCK_KEY,
    reservePayoutCapacity
} = require('../src/services/payoutAdmissionService');

describe('serialized payout-liability admission', () => {
    const oldCritical = process.env.BALANCE_CRITICAL;
    beforeEach(() => { process.env.BALANCE_CRITICAL = '50'; });
    afterAll(() => {
        if (oldCritical === undefined) delete process.env.BALANCE_CRITICAL;
        else process.env.BALANCE_CRITICAL = oldCritical;
    });

    function capacityClient() {
        const calls = [];
        return {
            calls,
            query: jest.fn(async (sql, params) => {
                calls.push({ sql, params });
                if (/AS payout_rows/i.test(sql)) {
                    return { rows: [{ payout_rows: '100', solo_commitments: '200', match_commitments: '300' }] };
                }
                return { rows: [] };
            })
        };
    }

    test('requires unlocked balance for outstanding + new liability + reserve under one advisory lock', async () => {
        const client = capacityClient();
        const walletService = { isHealthy: true, getBalance: jest.fn().mockResolvedValue({ unlocked_balance: '1050' }) };

        const result = await reservePayoutCapacity({
            client,
            walletService,
            newLiability: '400',
            gameModeManager: null
        });

        expect(result.required).toBe(1050n);
        expect(result.outstanding).toBe(600n);
        expect(client.calls[0]).toEqual(expect.objectContaining({
            params: [PAYOUT_ADMISSION_LOCK_KEY]
        }));
        expect(client.calls[0].sql).toMatch(/pg_advisory_xact_lock/i);
    });

    test('fails closed one atomic unit below exact committed coverage', async () => {
        const client = capacityClient();
        await expect(reservePayoutCapacity({
            client,
            walletService: { isHealthy: true, getBalance: async () => ({ unlocked_balance: '1049' }) },
            newLiability: '400'
        })).rejects.toMatchObject({ code: 'PAYOUT_RESERVE_INSUFFICIENT' });
    });

    test('counts only match liabilities that can still owe a payout', async () => {
        const client = capacityClient();

        await reservePayoutCapacity({
            client,
            walletService: { isHealthy: true, getBalance: async () => ({ unlocked_balance: '1050' }) },
            newLiability: '400'
        });

        const liabilityQuery = client.calls.find(({ sql }) => /AS payout_rows/i.test(sql)).sql;
        expect(liabilityQuery).toMatch(
            /FROM matches m[\s\S]*m\.status IN \('starting', 'active', 'finished'\)[\s\S]*NOT EXISTS/i
        );
        expect(liabilityQuery).not.toMatch(/m\.status IN \([^)]*'cancelled'/i);
    });

    function creditManager({ payoutEligible, getBalance }) {
        const calls = [];
        const client = {
            query: jest.fn(async (sql) => {
                calls.push(sql);
                if (/AS payout_rows/i.test(sql)) {
                    return { rows: [{ payout_rows: '0', solo_commitments: '0', match_commitments: '0' }] };
                }
                if (/UPDATE users[\s\S]*credits = credits -/i.test(sql)) {
                    return { rows: [{ credits: 1, total_credits_purchased: 2, payout_address: 'addr' }], rowCount: 1 };
                }
                if (/UPDATE games SET game_mode = 'PAID_CREDITS'/i.test(sql)) {
                    return { rows: [{ id: 9 }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            })
        };
        const manager = Object.create(GameModeManager.prototype);
        manager.db = { withTransaction: async callback => callback(client) };
        manager.walletService = { isHealthy: true, getBalance };
        manager.creditsPerGameCost = 1;
        manager.requiresPayoutAddressForMode = () => payoutEligible;
        manager._computePayoutSnapshot = () => ({
            eligible: payoutEligible,
            escapeAmount: '200',
            treasureAmount: '300',
            escapeMult: 2,
            treasureMult: 3,
            terms: { version: 1, eligible: payoutEligible }
        });
        return { manager, calls };
    }

    test('existing-credit payout game is denied before debit when balance is unknown', async () => {
        const { manager, calls } = creditManager({
            payoutEligible: true,
            getBalance: jest.fn().mockRejectedValue(new Error('wallet offline'))
        });

        await expect(manager._processGameStartWithCredits(
            { id: 1, credits: 2, payout_address: 'addr' }, 'sock', 'seed'
        )).rejects.toMatchObject({ code: 'PAYOUT_RESERVE_UNVERIFIED' });
        expect(calls.some(sql => /credits = credits -/i.test(sql))).toBe(false);
    });

    test('payout-disabled prestige start stays open and never reads wallet balance', async () => {
        const getBalance = jest.fn().mockRejectedValue(new Error('wallet offline'));
        const { manager } = creditManager({ payoutEligible: false, getBalance });

        const result = await manager._processGameStartWithCredits(
            { id: 1, credits: 2, payout_address: null }, 'sock', 'seed'
        );

        expect(result.success).toBe(true);
        expect(getBalance).not.toHaveBeenCalled();
    });

    test('authoritative credit start rejects a missing required payout address before debit', async () => {
        const { manager, calls } = creditManager({ payoutEligible: true, getBalance: async () => ({ unlocked_balance: '1000' }) });

        const result = await manager._processGameStartWithCredits(
            { id: 1, credits: 2, payout_address: null }, 'sock', 'seed'
        );

        expect(result).toEqual(expect.objectContaining({ success: false }));
        expect(calls).toEqual([]);
    });

    test('authoritative direct-payment claim rechecks the locked user payout address', async () => {
        const calls = [];
        const client = {
            query: jest.fn(async (sql) => {
                calls.push(sql);
                if (/SELECT \* FROM payments/i.test(sql)) {
                    return { rows: [{ id: 4, user_id: 1, status: 'confirmed' }], rowCount: 1 };
                }
                if (/SELECT id, payout_address[\s\S]*FROM users/i.test(sql)) {
                    return { rows: [{ id: 1, payout_address: null }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            })
        };
        const manager = Object.create(GameModeManager.prototype);
        manager.db = { withTransaction: async callback => callback(client) };
        manager._computePayoutSnapshot = () => ({
            eligible: false, escapeAmount: '0', treasureAmount: '0', terms: {}
        });
        manager._requiresPaidFairnessV2 = () => false;
        manager.requiresPayoutAddressForMode = () => true;

        const result = await manager._processGameStartWithPayment(
            { id: 1, payout_address: 'stale-client-cache' }, { id: 4 }, 'seed'
        );

        expect(result).toEqual(expect.objectContaining({ success: false }));
        expect(calls.some(sql => /UPDATE games/i.test(sql))).toBe(false);
        expect(calls.some(sql => /UPDATE payments/i.test(sql))).toBe(false);
    });
});
