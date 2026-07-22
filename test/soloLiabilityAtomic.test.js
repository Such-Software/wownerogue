const fs = require('fs');
const path = require('path');
const GameModeManager = require('../src/game/gameModeManager');

function paymentConfig() {
    return {
        getConfig: () => ({
            paymentsEnabled: true,
            currency: { symbol: 'WOW', decimals: 11 },
            modes: {
                direct: { enabled: true, price: 100n, requiresAddress: true },
                credits: { enabled: true, creditsPerGame: 1, requiresAddress: true, packages: [{ id: 'p', credits: 1, price: 100n }] }
            },
            payouts: {
                enabled: true,
                rules: {
                    direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 }, minPayout: 1n, maxPayout: 1000n },
                    credits: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 }, baseValue: 100n, minPayout: 1n, maxPayout: 1000n }
                }
            },
            preferences: { preferCreditsFirst: true },
            earlyEntry: { enabled: false }
        }),
        getLegacyGameMode: () => 'PAID_SINGLE',
        eventBus: { on() {} }
    };
}

function managerWith(db) {
    const manager = new GameModeManager(
        db,
        { processPayout: jest.fn(), processBatchPayout: jest.fn() },
        { CONSOLE_LOGGING: false },
        paymentConfig()
    );
    manager._scheduleBatchPayout = jest.fn();
    return manager;
}

describe('solo liability commitment', () => {
    test('credit debit and immutable payout terms are written in the same transaction', async () => {
        const calls = [];
        const client = {
            async query(sql, params) {
                calls.push({ sql, params });
                if (/UPDATE users[\s\S]*credits = credits -/i.test(sql)) {
                    return { rows: [{ credits: 4, total_credits_purchased: 5 }], rowCount: 1 };
                }
                if (/UPDATE games SET game_mode = 'PAID_CREDITS'/i.test(sql)) {
                    return { rows: [{ id: 10 }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            }
        };
        const db = {
            query: jest.fn(),
            withTransaction: jest.fn(async callback => callback(client))
        };
        const manager = managerWith(db);

        const result = await manager._processGameStartWithCredits({ id: 1, credits: 5, payout_address: 'addr' }, 'sock', 'seed');

        expect(result.success).toBe(true);
        expect(db.withTransaction).toHaveBeenCalledTimes(1);
        const commitment = calls.find(call => /payout_committed_at = NOW\(\)/i.test(call.sql));
        expect(commitment).toBeDefined();
        expect(commitment.params[6]).toBe(true);
        expect(JSON.parse(commitment.params[7])).toEqual(expect.objectContaining({
            version: 2,
            mode: 'PAID_CREDITS',
            eligible: true,
            escapeAmount: '200',
            treasureAmount: '300',
            minAmount: '1',
            maxAmount: '1000'
        }));
    });

    test('a missing game row aborts before a credit ledger entry can be committed', async () => {
        const calls = [];
        const client = {
            async query(sql) {
                calls.push(sql);
                if (/UPDATE users[\s\S]*credits = credits -/i.test(sql)) {
                    return { rows: [{ credits: 4 }], rowCount: 1 };
                }
                if (/UPDATE games SET game_mode = 'PAID_CREDITS'/i.test(sql)) {
                    return { rows: [], rowCount: 0 };
                }
                return { rows: [], rowCount: 1 };
            }
        };
        const manager = managerWith({ query: jest.fn(), withTransaction: async callback => callback(client) });

        await expect(manager._processGameStartWithCredits({ id: 1, credits: 5, payout_address: 'addr' }, 'sock', 'missing'))
            .rejects.toMatchObject({ code: 'GAME_ROW_REQUIRED' });
        expect(calls.some(sql => /INSERT INTO credit_transactions/i.test(sql))).toBe(false);
    });

    test('completion rolls back if its payout obligation cannot be inserted', async () => {
        const durable = { status: 'active', payout: false };
        const gameRow = {
            id: 5,
            user_id: 1,
            game_mode: 'PAID_SINGLE',
            status: 'active',
            payout_address: 'addr',
            payout_eligible: true,
            payout_terms: {
                version: 1,
                eligible: true,
                escapeAmount: '200',
                treasureAmount: '300',
                escapeMultiplier: 2,
                treasureMultiplier: 3,
                minAmount: '1',
                maxAmount: '1000'
            }
        };
        const db = {
            query: jest.fn(),
            async withTransaction(callback) {
                const tx = { status: durable.status, payout: durable.payout };
                const client = {
                    async query(sql) {
                        if (/FROM games[\s\S]*FOR UPDATE/i.test(sql)) return { rows: [gameRow], rowCount: 1 };
                        if (/UPDATE games[\s\S]*completed_at = NOW/i.test(sql)) {
                            tx.status = 'won';
                            return { rows: [], rowCount: 1 };
                        }
                        if (/SELECT id, status FROM payouts/i.test(sql)) return { rows: [], rowCount: 0 };
                        if (/SELECT id, payout_address FROM users/i.test(sql)) return { rows: [{ id: 1, payout_address: 'addr' }], rowCount: 1 };
                        if (/INSERT INTO payouts/i.test(sql)) throw new Error('payout insert failed');
                        return { rows: [], rowCount: 1 };
                    }
                };
                const value = await callback(client);
                durable.status = tx.status;
                durable.payout = tx.payout;
                return value;
            }
        };
        const manager = managerWith(db);

        const result = await manager.completeGame('sock', 'seed', true, false, {});

        expect(result.success).toBe(false);
        expect(durable).toEqual({ status: 'active', payout: false });
    });

    test('database identity guards cover every payout status and commitments are immutable', () => {
        const migration = fs.readFileSync(
            path.join(__dirname, '../src/migrations/032_solo_liability_invariants.sql'),
            'utf8'
        );
        expect(migration).toMatch(/CREATE UNIQUE INDEX idx_payouts_one_per_game[\s\S]*WHERE game_id IS NOT NULL;/i);
        expect(migration).toMatch(/CREATE UNIQUE INDEX idx_payouts_one_per_match[\s\S]*WHERE match_id IS NOT NULL;/i);
        expect(migration).not.toMatch(/CREATE UNIQUE INDEX idx_payouts_one_per_(?:game|match)[\s\S]{0,160}status IN/i);
        expect(migration).toMatch(/reject_game_payout_commitment_mutation/i);
    });
});
