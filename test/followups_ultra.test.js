/**
 * Post-review follow-ups.
 *
 *  1. No-address match winner reconciliation: setUserPayoutAddress converts a claimable
 *     'needs_review' match payout (reason 'match_winner_no_address') into a sendable 'pending'
 *     payout once a real address is set — and NEVER touches other 'needs_review' rows (e.g. the
 *     ambiguous single-payout rows, which would double-pay if reset).
 *  2. Match boot-recovery age guard: _recoverAbandonedMatches reclaims all in-flight matches
 *     immediately in single-instance mode, but only aged-out ones when MATCH_SINGLE_INSTANCE=false.
 */

const GameModeManager = require('../src/game/gameModeManager');
const MatchQueue = require('../src/network/matchQueue');

const createMockPaymentConfig = () => ({
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: { direct: { enabled: true, price: 100000000000n }, credits: { enabled: false, creditsPerGame: 1, packages: [] } },
        payouts: { rules: { direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 }, minPayout: 1000000000n, maxPayout: 10000000000000n } } },
        preferences: { preferCreditsFirst: true },
        earlyEntry: { enabled: false }
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
});

function buildGmm() {
    const calls = [];
    const db = {
        query: jest.fn().mockImplementation(async (sql) => {
            calls.push(sql);
            if (/UPDATE\s+payouts/i.test(sql)) return { rowCount: 1, rows: [{ id: 99 }] };
            return { rowCount: 0, rows: [] };
        }),
        withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }))
    };
    const gmm = new GameModeManager(db, { processPayout: jest.fn(), processBatchPayout: jest.fn() },
        { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 }, createMockPaymentConfig());
    gmm._scheduleBatchPayout = jest.fn();
    gmm.alertService = { sendAlert: jest.fn().mockResolvedValue() };
    gmm.getOrCreateUser = jest.fn().mockResolvedValue({ id: 7 });
    return { gmm, db, calls };
}

describe('Follow-up 1 — no-address match winner reconciliation', () => {
    test('converts claimable rows and kicks the batcher when an address is set', async () => {
        const { gmm, db } = buildGmm();
        const ok = await gmm.setUserPayoutAddress('sock', 'Wo3pRealAddress');
        expect(ok).toBe(true);
        const payoutUpdate = db.query.mock.calls.find(c => /UPDATE\s+payouts/i.test(c[0]));
        expect(payoutUpdate).toBeTruthy();
        // Narrow, safe filter — only the no-address match liability, never generic needs_review.
        expect(payoutUpdate[0]).toMatch(/reason\s*=\s*'match_winner_no_address'/);
        expect(payoutUpdate[0]).toMatch(/status\s*=\s*'needs_review'/);
        expect(payoutUpdate[0]).toMatch(/PENDING_NO_ADDRESS/);
        expect(payoutUpdate[0]).toMatch(/SET payout_address = \$1, status = 'pending'/);
        expect(payoutUpdate[1]).toEqual(['Wo3pRealAddress', 7]);
        expect(gmm._scheduleBatchPayout).toHaveBeenCalledTimes(1); // rowCount > 0
    });

    test('does not run reconciliation for an empty/cleared address', async () => {
        const { gmm, db } = buildGmm();
        await gmm.setUserPayoutAddress('sock', '   ');
        expect(db.query.mock.calls.some(c => /UPDATE\s+payouts/i.test(c[0]))).toBe(false);
        expect(gmm._scheduleBatchPayout).not.toHaveBeenCalled();
    });

    test('does not schedule a batch when there is nothing to reconcile', async () => {
        const { gmm, db } = buildGmm();
        db.query.mockImplementation(async () => ({ rowCount: 0, rows: [] })); // no claimable rows
        await gmm.setUserPayoutAddress('sock', 'Wo3pRealAddress');
        expect(gmm._scheduleBatchPayout).not.toHaveBeenCalled();
    });
});

describe('Follow-up 2 — match boot-recovery age guard', () => {
    function queueWithCapturingDb() {
        const params = [];
        const db = {
            query: jest.fn().mockImplementation(async (sql, p) => { params.push({ sql, p }); return { rows: [] }; }),
            withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }))
        };
        return { q: new MatchQueue({ db }), db, params };
    }

    const ENV = process.env.MATCH_SINGLE_INSTANCE;
    const CEIL = process.env.MATCH_HARD_CEILING_MS;
    afterEach(() => {
        if (ENV === undefined) delete process.env.MATCH_SINGLE_INSTANCE; else process.env.MATCH_SINGLE_INSTANCE = ENV;
        if (CEIL === undefined) delete process.env.MATCH_HARD_CEILING_MS; else process.env.MATCH_HARD_CEILING_MS = CEIL;
    });

    test('single-instance (default): reclaims all in-flight matches (age threshold 0)', async () => {
        delete process.env.MATCH_SINGLE_INSTANCE;
        const { q, params } = queueWithCapturingDb();
        await q._recoverAbandonedMatches();
        const scan = params.find(x => /FROM matches/i.test(x.sql));
        expect(scan).toBeTruthy();
        expect(scan.sql).toMatch(/COALESCE\(started_at, created_at\)/);
        expect(scan.p).toEqual([0]);
    });

    test('multi-instance: only reclaims matches older than hard ceiling + buffer', async () => {
        process.env.MATCH_SINGLE_INSTANCE = 'false';
        process.env.MATCH_HARD_CEILING_MS = '240000';
        const { q, params } = queueWithCapturingDb();
        await q._recoverAbandonedMatches();
        const scan = params.find(x => /FROM matches/i.test(x.sql));
        expect(scan.p).toEqual([300]); // (240000 + 60000) / 1000
    });
});
