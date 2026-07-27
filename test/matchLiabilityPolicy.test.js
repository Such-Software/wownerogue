const MatchManager = require('../src/network/matchManager');
const MatchPayoutService = require('../src/network/matchPayoutService');
const MatchQueue = require('../src/network/matchQueue');
const MatchRoom = require('../src/multiplayer/MatchRoom');
const MatchScheduler = require('../src/network/matchScheduler');
const {
    buildPaidEntrantFreeze,
    deriveFutureBlockMatchSeed
} = require('../src/network/matchFairness');

const MATCH_ENV_KEYS = [
    'MATCH_ENABLED', 'MATCH_CRYPTO_RACE_ENABLED', 'MATCH_PAYOUTS_ENABLED',
    'MATCH_PAYOUT_MAX', 'MATCH_ENTRY_FEE_ATOMIC', 'MATCH_HOUSE_FEE_PERCENT',
    'MATCH_RULESET_ID', 'MATCH_MAX_PLAYERS', 'PAYOUTS_ENABLED', 'PAYMENTS_ENABLED'
];

describe('match payout liability production invariants', () => {
    let priorEnv;

    beforeEach(() => {
        priorEnv = Object.fromEntries(MATCH_ENV_KEYS.map(key => [key, process.env[key]]));
        Object.assign(process.env, {
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'true',
            MATCH_PAYOUTS_ENABLED: 'true',
            MATCH_PAYOUT_MAX: '1000000',
            MATCH_ENTRY_FEE_ATOMIC: '10000',
            MATCH_HOUSE_FEE_PERCENT: '5',
            MATCH_RULESET_ID: 'race',
            MATCH_MAX_PLAYERS: '4',
            PAYOUTS_ENABLED: 'true',
            PAYMENTS_ENABLED: 'true'
        });
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    const gameModeManager = (overrides = {}) => ({
        payoutsEnabled: true,
        directModeEnabled: true,
        creditsModeEnabled: false,
        _scheduleBatchPayout: jest.fn(),
        ...overrides
    });

    function cryptoRoom(rulesetId = 'race') {
        return new MatchRoom({
            economy: 'crypto_race',
            rulesetId,
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: '0'.repeat(64)
        });
    }

    test('MATCH_PAYOUT_MAX is checked before any ticket commitment transaction', async () => {
        process.env.MATCH_PAYOUT_MAX = '18000'; // two entries owe 19,000 after the 5% fee
        const db = { withTransaction: jest.fn() };
        const service = new MatchPayoutService({ db, gameModeManager: gameModeManager() });

        await expect(service.collectEntryTickets(cryptoRoom(), [
            { userId: 1, queueEntryId: 11 }, { userId: 2, queueEntryId: 12 }
        ]))
            .rejects.toMatchObject({ code: 'PAYOUT_CAP_EXCEEDED' });
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('crypto co-op is rejected before commitment because split semantics do not exist', async () => {
        process.env.MATCH_RULESET_ID = 'coop-escape';
        const db = { withTransaction: jest.fn() };
        const service = new MatchPayoutService({ db, gameModeManager: gameModeManager() });

        await expect(service.collectEntryTickets(cryptoRoom('coop-escape'), [
            { userId: 1, queueEntryId: 11 }, { userId: 2, queueEntryId: 12 }
        ]))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_CRYPTO_RULESET' });
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('scheduler clamps entrants to the selected ruleset player contract', () => {
        const scheduler = new MatchScheduler({
            matchQueue: {},
            matchManager: {},
            rulesetId: 'race',
            maxPlayers: 32
        });

        expect(scheduler.minPlayers).toBe(2);
        expect(scheduler.maxPlayers).toBe(8);
        scheduler.shutdown();
    });

    test('hot-disable refunds queued crypto escrow and removes memory only after commit', async () => {
        let available = true;
        const captured = [];
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('UPDATE match_queue_entries')) return { rows: [{ id: 1 }], rowCount: 1 };
                        if (sql.includes('UPDATE users')) return { rows: [{ race_entries: 2 }], rowCount: 1 };
                        return { rows: [{ id: 1 }], rowCount: 1 };
                    }
                });
            }
        };
        const manager = gameModeManager({
            _getMatchEconomies: () => available ? { free: true, crypto_race: true } : { free: true }
        });
        const queue = new MatchQueue({ db, gameModeManager: manager });
        queue._queues.crypto_race.push({ userId: 1, socketId: 'a', createdAt: 1 });

        available = false;
        await queue.refundUnavailableQueues();

        expect(queue.length('crypto_race')).toBe(0);
        expect(captured.some(q => q.sql.includes('race_entries = race_entries + $1'))).toBe(true);
        expect(captured.some(q => q.sql.includes('INSERT INTO race_entry_transactions'))).toBe(true);
    });

    test('failed hot-disable refund remains queued for the next reconciliation attempt', async () => {
        const db = { async withTransaction() { throw new Error('db down'); } };
        const manager = gameModeManager({ _getMatchEconomies: () => ({ free: true }) });
        const queue = new MatchQueue({ db, gameModeManager: manager });
        queue._queues.crypto_race.push({ userId: 1, socketId: 'a', createdAt: 1 });

        await queue.refundUnavailableQueues();

        expect(queue.length('crypto_race')).toBe(1);
    });

    test('finished liability is reconciled after a transient payout insertion failure', async () => {
        let insertFails = true;
        let payoutInserted = false;
        let successfulInserts = 0;
        const captured = [];
        const db = {
            async query(sql) {
                if (sql.includes('SELECT m.id')) {
                    return payoutInserted
                        ? { rows: [], rowCount: 0 }
                        : { rows: [{ id: 'match-1' }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('FROM matches') && sql.includes('FOR UPDATE')) {
                            return { rows: [{
                                id: 'match-1', economy: 'crypto_race', status: 'finished', winner_user_id: 7,
                                payout_liability_amount_atomic: '19000',
                                payout_liability_cap_atomic: '1000000',
                                payout_liability_accepted_at: new Date().toISOString()
                            }], rowCount: 1 };
                        }
                        if (sql.includes('FROM payouts')) {
                            return payoutInserted
                                ? { rows: [{ id: 88 }], rowCount: 1 }
                                : { rows: [], rowCount: 0 };
                        }
                        if (sql.includes('FROM users')) return { rows: [{ id: 7, payout_address: 'wallet' }], rowCount: 1 };
                        if (sql.includes('INSERT INTO payouts') && insertFails) throw new Error('insert unavailable');
                        if (sql.includes('INSERT INTO payouts')) {
                            payoutInserted = true;
                            successfulInserts += 1;
                        }
                        return { rows: [{ id: 88 }], rowCount: 1 };
                    }
                });
            }
        };
        const manager = gameModeManager();
        const service = new MatchPayoutService({ db, gameModeManager: manager });

        expect(await service.reconcileFinishedLiabilities()).toEqual({
            ok: false,
            scanned: 1,
            created: 0,
            failed: 1,
            unresolved: [{ type: 'match_liability', id: 'match-1' }]
        });
        insertFails = false;
        expect(await service.reconcileFinishedLiabilities()).toEqual({
            ok: true,
            scanned: 1,
            created: 1,
            failed: 0,
            unresolved: []
        });
        expect(await service.reconcileFinishedLiabilities()).toEqual({
            ok: true,
            scanned: 0,
            created: 0,
            failed: 0,
            unresolved: []
        });
        expect(successfulInserts).toBe(1);
        expect(manager._scheduleBatchPayout).toHaveBeenCalledTimes(1);
        expect(captured.filter(q => q.sql.includes('INSERT INTO payouts'))).toHaveLength(2);
    });

    test('manager durably persists completion before attempting liability insertion', async () => {
        const manager = new MatchManager({ io: null, db: {}, debugManager: null });
        manager.enabled = true;
        const order = [];
        manager._persistFinish = async () => { order.push('persist'); };
        manager.matchPayoutService.payoutWinner = async () => { order.push('payout'); };
        manager.matchLeaderboard.postMatch = async () => { order.push('leaderboard'); };
        const room = cryptoRoom();
        room.winnerId = 'a';
        room.status = 'finished';

        await manager._finalize(room);

        expect(order.slice(0, 2)).toEqual(['persist', 'payout']);
        manager.shutdown();
    });

    test('a future-block-frozen match with an ambiguous collect acknowledgement continues only when the accepted snapshot exists', async () => {
        const entries = [
            { userId: 1, socketId: 'a', sessionToken: 'ta', queueEntryId: 11 },
            { userId: 2, socketId: 'b', sessionToken: 'tb', queueEntryId: 12 }
        ];
        const matchQueue = {
            refundEntries: jest.fn()
        };
        const payoutService = {
            collectEntryTickets: jest.fn().mockRejectedValue(new Error('COMMIT acknowledgement lost')),
            getAcceptedLiability: jest.fn().mockResolvedValue({
                entry_fee_atomic: '10000',
                pot_atomic: '20000',
                house_fee_atomic: '1000',
                house_fee_percent: '5',
                payout_liability_amount_atomic: '19000',
                payout_liability_cap_atomic: '1000000',
                payout_liability_terms: { version: 2 }
            })
        };
        const matchManager = {
            db: null,
            gameModeManager: gameModeManager(),
            matchPayoutService: payoutService,
            setEngine: jest.fn(),
            attach: jest.fn(),
            onTick: jest.fn(),
            onFinish: jest.fn()
        };
        const scheduler = new MatchScheduler({
            matchQueue,
            matchManager,
            blockCountProvider: async () => 902,
            blockEntropyProvider: async height => ({
                block_header: { height, hash: 'ab'.repeat(32) }
            })
        });
        const freeze = buildPaidEntrantFreeze({
            freezeBlockHeight: 899,
            targetBlockHeight: 900,
            economy: 'crypto_race',
            rulesetId: 'race',
            queueEntryIds: entries.map(entry => entry.queueEntryId)
        });
        const seedProof = deriveFutureBlockMatchSeed({
            blockHash: 'ab'.repeat(32),
            blockHeight: 900,
            freeze
        });

        await scheduler._startEntries({
            entries,
            economy: 'crypto_race',
            blockHeight: 900,
            seedProof,
            frozen: {
                id: '11111111-1111-4111-8111-111111111111',
                freeze,
                freezeCommitment: freeze.freezeCommitment,
                entries
            }
        });

        expect(payoutService.collectEntryTickets).toHaveBeenCalledTimes(1);
        expect(payoutService.getAcceptedLiability).toHaveBeenCalledTimes(1);
        expect(matchQueue.refundEntries).not.toHaveBeenCalled();
        expect(matchManager.attach).toHaveBeenCalledTimes(1);
        const room = matchManager.attach.mock.calls[0][0];
        expect(room.payoutLiabilityAmountAtomic).toBe('19000');
        scheduler.shutdown();
    });
});
