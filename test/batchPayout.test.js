/**
 * Batch payout dispatch tests (Phase 0.3).
 *
 * transfer_split sends ONE on-chain tx to many destinations, so every payout row in a
 * batch shares that tx_hash. These tests guard:
 *  - the whole batch is marked completed with the shared tx_hash in one transaction
 *    (no row stranded mid-batch by a unique-index collision), and
 *  - an ambiguous batch failure is marked 'needs_review' (NOT 'failed'), so the retry
 *    service won't re-send and double-pay.
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
            credits: { enabled: true, creditsPerGame: 1, packages: [{ id: 'small', credits: 10, price: '500000000000', bonus: 0 }] }
        },
        payouts: {
            rules: {
                direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 } },
                credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 }, baseValue: 50000000000n }
            }
        },
        preferences: { preferCreditsFirst: true },
        earlyEntry: { enabled: false }
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
});

function buildGmm(walletService) {
    const db = createMockDb();
    const debugManager = { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 };
    const gmm = new GameModeManager(db, walletService, debugManager, createMockPaymentConfig());
    return { gmm, db };
}

const TWO_PENDING = [
    { id: 10, user_id: 1, game_id: 'g1', payout_address: 'addrA', amount: '200000000000', multiplier: 2, reason: 'escape' },
    { id: 11, user_id: 2, game_id: 'g2', payout_address: 'addrB', amount: '300000000000', multiplier: 3, reason: 'escape' }
];
const ONE_PENDING = [TWO_PENDING[0]];
const SHARED_TX_HASH = 'e'.repeat(64);

describe('Batch payout dispatch', () => {
    test('shared runtime dispatch predicate stops internal batch paths before DB or wallet work', async () => {
        const walletService = {
            getBalance: jest.fn(),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        gmm.payoutDispatchAllowed = jest.fn(() => false);

        gmm._scheduleBatchPayout();
        await gmm._processPendingPayouts();

        expect(gmm.payoutDispatchAllowed).toHaveBeenCalled();
        expect(gmm._batchPayoutTimer).toBeNull();
        expect(db.withTransaction).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(walletService.processBatchPayout).not.toHaveBeenCalled();
    });

    test('marks the whole batch completed with the shared tx_hash in one transaction', async () => {
        const walletService = {
            processPayout: jest.fn(),
            processBatchPayout: jest.fn().mockResolvedValue({ success: true, tx_hash_list: [SHARED_TX_HASH], totalFee: 200 }),
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' })
        };
        const { gmm, db } = buildGmm(walletService);

        // First withTransaction = gather: SELECT returns 2 pending rows, then UPDATE ... processing.
        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING }) // SELECT ... FOR UPDATE SKIP LOCKED
            .mockResolvedValue({ rows: [] });             // everything else

        await gmm._processPendingPayouts();

        // The batch RPC was called once with both destinations.
        expect(walletService.processBatchPayout).toHaveBeenCalledTimes(1);
        expect(walletService.processBatchPayout.mock.calls[0][0]).toHaveLength(2);

        // The completion UPDATE set the shared tx_hash on the whole batch via id = ANY(...).
        const calls = db._mockClient.query.mock.calls.map(c => c[0]);
        const batchUpdate = calls.find(sql => /UPDATE payouts SET tx_hash/i.test(sql) && /id = ANY/i.test(sql));
        expect(batchUpdate).toBeDefined();
        expect(batchUpdate).toMatch(/status = 'completed'/);

        const batchUpdateCall = db._mockClient.query.mock.calls.find(c => /UPDATE payouts SET tx_hash/i.test(c[0]) && /id = ANY/i.test(c[0]));
        expect(batchUpdateCall[1][0]).toBe(SHARED_TX_HASH); // tx_hash param
        expect(batchUpdateCall[1][3]).toEqual([10, 11]);    // ids array

        // Per-user stats incremented for each winner inside the same transaction (BIGINT, no float).
        const statUpdates = calls.filter(sql => /UPDATE users SET total_amount_won/i.test(sql));
        expect(statUpdates.length).toBe(2);
    });

    test('an ambiguous batch failure is marked needs_review, not failed', async () => {
        const walletService = {
            // Enough unlocked balance so the pre-flight check passes and we reach the transfer.
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn().mockRejectedValue(new Error('RPC timeout'))
        };
        const { gmm, db } = buildGmm(walletService);

        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        // Failure handling uses db.query (outside a transaction) to mark the batch needs_review.
        // Status is passed as a bound param ($1), so check the params array, not the SQL text.
        const failCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'needs_review');
        expect(failCall).toBeDefined();
        expect(failCall[0]).toMatch(/id = ANY/i);
        // Must NOT mark them 'failed' (which the retry service would auto-resend).
        const failedCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'failed');
        expect(failedCall).toBeUndefined();
    });

    test('single payout retains a valid wallet hash when the completion DB write fails', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' }),
            processPayout: jest.fn().mockResolvedValue({ success: true, txHash: SHARED_TX_HASH, fee: 20 }),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: ONE_PENDING })
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(new Error('database write failed after broadcast'));

        await gmm._processPendingPayouts();

        const review = db.query.mock.calls.find(call => call[1]?.[0] === 'needs_review');
        expect(review).toBeDefined();
        expect(review[0]).toMatch(/tx_hash = COALESCE\(\$3, tx_hash\)/i);
        expect(review[1][2]).toBe(SHARED_TX_HASH);
        expect(review[1][3]).toBe(10);
        expect(db.query.mock.calls.some(call => call[1]?.[0] === 'pending')).toBe(false);
        expect(walletService.processPayout).toHaveBeenCalledTimes(1);
    });

    test('batch retains its one valid wallet hash when the completion DB write fails', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn().mockResolvedValue({
                success: true,
                tx_hash_list: [SHARED_TX_HASH],
                totalFee: 200
            })
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(new Error('database write failed after batch broadcast'));

        await gmm._processPendingPayouts();

        const review = db.query.mock.calls.find(call => call[1]?.[0] === 'needs_review');
        expect(review).toBeDefined();
        expect(review[0]).toMatch(/tx_hash = COALESCE\(\$4, tx_hash\)/i);
        expect(review[1][2]).toEqual([10, 11]);
        expect(review[1][3]).toBe(SHARED_TX_HASH);
        expect(db.query.mock.calls.some(call => call[1]?.[0] === 'pending')).toBe(false);
        expect(walletService.processBatchPayout).toHaveBeenCalledTimes(1);
    });

    test('multiple valid wallet hashes are not guessed onto every liability', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn().mockResolvedValue({
                success: true,
                tx_hash_list: ['a'.repeat(64), 'b'.repeat(64)],
                totalFee: 200
            })
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        const review = db.query.mock.calls.find(call => call[1]?.[0] === 'needs_review');
        expect(review).toBeDefined();
        expect(db._mockClient.query.mock.calls.some(call => /status = 'completed'/i.test(call[0]))).toBe(false);
    });

    test('MONERO LOCKING: defers the batch to pending when unlocked balance is insufficient (no transfer attempted)', async () => {
        // TWO_PENDING needs 200000000000 + 300000000000 = 500000000000 atomic.
        // Unlocked balance is far below that (outputs locked ~10 blocks) -> defer, do not send.
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ balance: '500000000000', unlocked_balance: '1000000000' }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);

        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        // No on-chain transfer was attempted.
        expect(walletService.processBatchPayout).not.toHaveBeenCalled();
        expect(walletService.processPayout).not.toHaveBeenCalled();

        // The defer UPDATE sets status = 'pending' literally in SQL and passes ids as $1.
        const deferSql = db.query.mock.calls.find(c => /SET status = 'pending'/i.test(c[0]) && /id = ANY/i.test(c[0]));
        expect(deferSql).toBeDefined();
        expect(deferSql[1][0]).toEqual([10, 11]); // ids array param
    });

    test('defers without transfer when unlocked balance cannot be verified', async () => {
        const walletService = {
            getBalance: jest.fn().mockRejectedValue(new Error('wallet unavailable')),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(walletService.processBatchPayout).not.toHaveBeenCalled();
        const deferred = db.query.mock.calls.find(call => /wallet unlocked balance could not be verified/.test(call[1]?.[1] || ''));
        expect(deferred).toBeDefined();
        expect(deferred[1][0]).toEqual([10, 11]);
    });

    test('rechecks a gate that closes after claim and wallet probe before transfer', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({
                balance: '10000000000000',
                unlocked_balance: '10000000000000'
            }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn()
        };
        const { gmm, db } = buildGmm(walletService);
        let checks = 0;
        gmm.payoutDispatchAllowed = jest.fn(() => ++checks === 1);
        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        expect(walletService.getBalance).toHaveBeenCalledTimes(1);
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(walletService.processBatchPayout).not.toHaveBeenCalled();
        expect(db.query.mock.calls.some(call => call[1]?.[1] === 'Payout dispatch paused before wallet transfer')).toBe(true);
    });

    test('a pre-broadcast insufficient-funds batch error is retried (pending), not needs_review', async () => {
        const walletService = {
            getBalance: jest.fn().mockResolvedValue({ balance: '10000000000000', unlocked_balance: '10000000000000' }),
            processPayout: jest.fn(),
            processBatchPayout: jest.fn().mockRejectedValue(new Error('not enough unlocked money to transfer'))
        };
        const { gmm, db } = buildGmm(walletService);

        db._mockClient.query
            .mockResolvedValueOnce({ rows: TWO_PENDING })
            .mockResolvedValue({ rows: [] });

        await gmm._processPendingPayouts();

        // A funds error means nothing broadcast -> safe to retry: status='pending', NOT needs_review.
        const pendingCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'pending' && /id = ANY/i.test(c[0]));
        expect(pendingCall).toBeDefined();
        const reviewCall = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][0] === 'needs_review');
        expect(reviewCall).toBeUndefined();
    });
});
