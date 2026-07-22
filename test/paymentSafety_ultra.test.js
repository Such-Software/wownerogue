/**
 * Payment-safety fixes (M1, M3, M4, M5, C1).
 *
 * Covers the gameModeManager hardening:
 *  - M1: an ambiguous SINGLE payout failure is marked 'needs_review' (not 'failed') + alerts.
 *  - M3: a concurrent single_game payment claim aborts cleanly (no duplicate game / throw).
 *  - M4: completeGame refuses to insert a payout it can't attach to a resolved game + user.
 *  - M5: the payout amount is clamped to the configured max (cap+alert) / skipped below min.
 *  - C1: getOrCreateUser(socketId, { create: false }) returns null without inserting a user.
 */

const GameModeManager = require('../src/game/gameModeManager');

const createMockDb = () => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    return {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        withTransaction: jest.fn().mockImplementation(async (cb) => cb(mockClient)),
        _mockClient: mockClient
    };
};

const createMockPaymentConfig = () => ({
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: {
            direct: { enabled: true, price: 100000000000n },
            credits: { enabled: false, creditsPerGame: 1, packages: [{ id: 'small', credits: 10, price: '500000000000', bonus: 0 }] }
        },
        payouts: {
            rules: {
                direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 }, minPayout: 1000000000n, maxPayout: 10000000000000n },
                credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 }, baseValue: 50000000000n, minPayout: 1000000000n, maxPayout: 5000000000000n }
            }
        },
        preferences: { preferCreditsFirst: true },
        earlyEntry: { enabled: false }
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
});

function buildGmm(walletService = { processPayout: jest.fn(), processBatchPayout: jest.fn() }) {
    const db = createMockDb();
    const gmm = new GameModeManager(db, walletService, { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 }, createMockPaymentConfig());
    gmm._scheduleBatchPayout = jest.fn();           // never actually schedule
    gmm.alertService = { sendAlert: jest.fn().mockResolvedValue() };
    return { gmm, db };
}

const ONE_PENDING = [
    { id: 42, user_id: 1, game_id: 7, payout_address: 'addrA', amount: '100000000000', multiplier: 2, reason: 'escape' }
];

describe('M1 — single payout ambiguous failure', () => {
    test('is marked needs_review (never failed) and alerts', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ unlocked_balance: '10000000000000' }),
            processPayout: jest.fn().mockRejectedValue(new Error('RPC timeout after broadcast?')),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: ONE_PENDING }) // SELECT ... FOR UPDATE SKIP LOCKED
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        const reviewCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'needs_review');
        expect(reviewCall).toBeDefined();
        expect(reviewCall[1][2]).toBeNull(); // no valid transaction hash was observed
        expect(reviewCall[1][3]).toBe(42); // payout id
        const failedCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'failed');
        expect(failedCall).toBeUndefined();
        expect(gmm.alertService.sendAlert).toHaveBeenCalledWith('single_payout_failed', expect.any(Object));
    });

    test('a pre-broadcast insufficient-funds error stays pending (safe retry), no alert', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ unlocked_balance: '10000000000000' }),
            processPayout: jest.fn().mockRejectedValue(new Error('not enough unlocked money to transfer')),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: ONE_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        const pendingCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'pending' && /id = \$4/i.test(c[0]));
        expect(pendingCall).toBeDefined();
        expect(gmm.alertService.sendAlert).not.toHaveBeenCalled();
    });
});

describe('M3 — atomic single_game payment claim', () => {
    test('aborts cleanly when the payment was already consumed (claim returns no row)', async () => {
        const { gmm } = buildGmm();
        // withTransaction runs cb with a client whose claim SELECT returns no rows.
        gmm.db.withTransaction = jest.fn(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }));

        const res = await gmm._processGameStartWithPayment({ id: 1, payout_address: 'addr' }, { id: 55 }, 'seed-1');

        expect(res.success).toBe(false);
        expect(res.alreadyConsumed).toBe(true);
    });

    test('treats a games.payment_id unique violation (23505) as already consumed, not a throw', async () => {
        const { gmm } = buildGmm();
        gmm.db.withTransaction = jest.fn(async (cb) => {
            const client = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{ id: 55 }] }) // claim SELECT ... FOR UPDATE finds the payment
                    .mockImplementationOnce(() => { const e = new Error('duplicate key'); e.code = '23505'; throw e; })
            };
            return cb(client); // the throw propagates like the real withTransaction (rollback + rethrow)
        });

        const res = await gmm._processGameStartWithPayment({ id: 1, payout_address: 'addr' }, { id: 55 }, 'seed-1');

        expect(res.success).toBe(false);
        expect(res.alreadyConsumed).toBe(true);
    });
});

describe('M4 — completeGame durably records every committed liability', () => {
    test('quarantines a liability when the paying identity cannot be resolved', async () => {
        const { gmm, db } = buildGmm();
        db.withTransaction.mockImplementation(async (cb) => cb(db));
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, /* no user_id */ game_mode: 'PAID_SINGLE', payout_address: 'addr' }] }) // game record
            .mockResolvedValueOnce({ rows: [] }) // completion UPDATE
            .mockResolvedValueOnce({ rows: [] }) // existing-payout check
            .mockResolvedValueOnce({ rows: [{ id: 88 }], rowCount: 1 }); // needs_review liability

        const result = await gmm.completeGame('sockX', 'game-xyz', true, false, {});

        expect(result.payout).toEqual(expect.objectContaining({ payoutId: 88, status: 'needs_review' }));
        const inserted = db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]));
        expect(inserted).toBeDefined();
        expect(inserted[1]).toContain('solo_winner_identity_review');
        expect(gmm.alertService.sendAlert).toHaveBeenCalledWith('payout_liability_needs_review', expect.any(Object));
    });
});

describe('M5 — payout amount is clamped to configured bounds', () => {
    test('caps an over-max payout and alerts', async () => {
        const { gmm, db } = buildGmm();
        db.withTransaction.mockImplementation(async (cb) => cb(db));
        db.query
            .mockResolvedValueOnce({ rows: [{
                id: 1, user_id: 1, game_mode: 'PAID_SINGLE', payout_address: 'addr',
                payout_escape_amount: '99999999999999', payout_treasure_amount: '99999999999999',
                payout_escape_mult: '2', payout_treasure_mult: '3'
            }] })                                        // game record
            .mockResolvedValueOnce({ rows: [] })          // completion UPDATE
            .mockResolvedValueOnce({ rows: [] })          // existing-payout check
            .mockResolvedValueOnce({ rows: [{ id: 1, payout_address: 'addr' }] }) // user lookup by id
            .mockResolvedValueOnce({ rows: [{ id: 999 }] });                       // INSERT payout

        const result = await gmm.completeGame('sockX', 'game-xyz', true, false, {});

        expect(result.payout.amount).toBe('10000000000000'); // capped to maxPayout
        expect(gmm.alertService.sendAlert).toHaveBeenCalledWith('payout_over_max', expect.any(Object));
        const inserted = db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]));
        expect(inserted[1][3]).toBe('10000000000000'); // amount param is the capped value
    });

    test('skips a below-min payout entirely (no insert)', async () => {
        const { gmm, db } = buildGmm();
        db.withTransaction.mockImplementation(async (cb) => cb(db));
        db.query
            .mockResolvedValueOnce({ rows: [{
                id: 1, user_id: 1, game_mode: 'PAID_SINGLE', payout_address: 'addr',
                payout_escape_amount: '1', payout_treasure_amount: '1',
                payout_escape_mult: '2', payout_treasure_mult: '3'
            }] })
            .mockResolvedValue({ rows: [] });

        const result = await gmm.completeGame('sockX', 'game-xyz', true, false, {});

        expect(result.reason).toBe('Below minimum payout');
        expect(result.payout).toBeNull();
        const inserted = db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]));
        expect(inserted).toBeUndefined();
    });
});

describe('C1 — getOrCreateUser create:false', () => {
    test('returns null and never inserts when no user row exists', async () => {
        const { gmm, db } = buildGmm();
        db.query.mockResolvedValue({ rows: [] }); // socket lookup finds nothing

        const user = await gmm.getOrCreateUser('ghost-socket', { create: false });

        expect(user).toBeNull();
        const insert = db.query.mock.calls.find(c => /INSERT INTO users/i.test(c[0]));
        expect(insert).toBeUndefined();
    });

    test('still creates by default for existing callers', async () => {
        const { gmm, db } = buildGmm();
        db.query
            .mockResolvedValueOnce({ rows: [] })                       // socket lookup: none
            .mockResolvedValueOnce({ rows: [{ id: 7, socket_id: 's' }] }); // INSERT ... RETURNING *

        const user = await gmm.getOrCreateUser('s');

        expect(user).toEqual({ id: 7, socket_id: 's' });
        const insert = db.query.mock.calls.find(c => /INSERT INTO users/i.test(c[0]));
        expect(insert).toBeDefined();
    });
});
