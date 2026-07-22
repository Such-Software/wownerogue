/**
 * matchRework_ultra — regression coverage for the match-mode production hardening pass.
 *
 * Exercises the confirmed defects the rework fixes: the move() crash (MP-C2), the real
 * countdown (MP-H6), reconnect re-keying + ownership (MP-H1/H2), winner consistency across
 * end paths, BigInt/capped/no-address payouts (MP-C4/H5), refund-on-every-cancellation
 * (MP-H3/H4), and payout-first isolated finalize (MP-C5). All timers created here are cleared
 * in afterEach so the suite leaves no open handles.
 */

const MatchManager = require('../src/network/matchManager');
const MatchPayoutService = require('../src/network/matchPayoutService');
const MatchQueue = require('../src/network/matchQueue');
const MatchRoom = require('../src/multiplayer/MatchRoom');
const MatchEngine = require('../src/multiplayer/MatchEngine');

const SEED = '0'.repeat(64);
const NEVER = 10 ** 9; // effectively-never timer duration for countdown/floor/ceiling

function makeIo() {
    const broadcasts = [];
    const sockets = new Map();
    return {
        broadcasts,
        sockets: { sockets },
        to(channel) {
            return { emit: (event, payload) => broadcasts.push({ channel, event, payload }) };
        }
    };
}

function makeSocket(id) {
    return { id, joined: [], emitted: [], join(ch) { this.joined.push(ch); }, emit(ev, p) { this.emitted.push({ ev, p }); } };
}

function makeCryptoFinishedRoom({ winner = 'a' } = {}) {
    const room = new MatchRoom({ economy: 'crypto_race', entrants: { a: { userId: 1 }, b: { userId: 2 } }, seed: SEED });
    room.start();
    room.playerStates.get(winner).escaped = true;
    room.winnerId = winner;
    room.status = 'finished';
    room.finalize();
    return room;
}

describe('match rework — crash + countdown (MatchManager)', () => {
    const managers = [];
    function mgr(opts = {}) {
        const m = new MatchManager({ io: makeIo(), db: null, debugManager: null, ...opts });
        m.enabled = true;
        managers.push(m);
        return m;
    }
    afterEach(() => {
        while (managers.length) managers.pop().shutdown();
        jest.useRealTimers();
        delete process.env.MATCH_ENABLED;
    });

    test('MP-C2: move() no longer references undefined db/gameModeManager and never throws', () => {
        const m = mgr();
        // No match for this socket -> benign no-op (previously threw ReferenceError: db).
        expect(() => m.move({ id: 'ghost' }, { dx: 1, dy: 0 })).not.toThrow();
        // Garbage / missing payload is null-safe.
        expect(() => m.move({ id: 'ghost' }, null)).not.toThrow();
        expect(() => m.move({ id: 'ghost' }, { dx: 'x' })).not.toThrow();
        // Disabled manager returns benignly.
        m.enabled = false;
        expect(() => m.move({ id: 'ghost' }, { dx: 1, dy: 0 })).not.toThrow();
    });

    test('MP-H6: moves are rejected until the countdown elapses, then accepted', () => {
        const m = mgr();
        m.moveCooldownMs = 0; // isolate the status gate from flood control
        const room = new MatchRoom({ economy: 'free', entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED });
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: NEVER, minDurationMs: NEVER, hardCeilingMs: NEVER });

        expect(room.status).toBe('starting');
        m.move({ id: 's1' }, { dx: 1, dy: 0 });
        expect(room.moveQueue.size).toBe(0); // rejected during 'starting'

        room.start(); // simulate the countdown elapsing
        m.move({ id: 's1' }, { dx: 1, dy: 0 });
        expect(room.moveQueue.size).toBe(1); // accepted once 'active'
    });

    test('MP-H6: the countdown (not the scheduler) starts the engine + activates the room', () => {
        jest.useFakeTimers();
        const m = mgr();
        const room = new MatchRoom({ economy: 'free', entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED });
        const engine = new MatchEngine({ room, tickMs: NEVER, onFinish: (r) => m.onFinish(r) });
        m.setEngine(room.id, engine);
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: 3000, minDurationMs: NEVER, hardCeilingMs: NEVER, tickMs: NEVER });

        expect(room.status).toBe('starting');
        jest.advanceTimersByTime(3000);
        expect(room.status).toBe('active');
        expect(engine.running).toBe(true);
    });

    test('leaked-timer safety: expire() is idempotent and clears the hard-ceiling watchdog', () => {
        const m = mgr();
        const room = new MatchRoom({ economy: 'free', entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED });
        const engine = new MatchEngine({ room, tickMs: NEVER, onFinish: (r) => m.onFinish(r) });
        m.setEngine(room.id, engine);
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: NEVER, minDurationMs: NEVER, hardCeilingMs: NEVER });
        room.start();

        m.expire(room.id, 'admin');
        expect(room._finalized).toBe(true);
        expect(room._watchdogs).toBeNull(); // ceiling/floor/countdown timers cleared
        expect(engine.running).toBe(false); // engine stopped
        // Second call must be a benign no-op (no double finalize, no throw).
        expect(() => m.expire(room.id, 'admin')).not.toThrow();
    });

    test('block deadline expires on the first later header after the active-play floor', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
        const m = mgr();
        const room = new MatchRoom({
            economy: 'free', startBlockHeight: 100,
            entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED
        });
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: NEVER, minDurationMs: 20000, hardCeilingMs: NEVER });
        room.start();

        expect(m.expireBlockDeadlines(100)).toBe(0); // same header can never end its room
        jest.advanceTimersByTime(19999);
        expect(m.expireBlockDeadlines(101)).toBe(0); // later header, but floor not met
        jest.advanceTimersByTime(1);
        expect(m.expireBlockDeadlines(101)).toBe(1);
        expect(room.status).toBe('finished');
        expect(room.endReason).toBe('block_deadline');
        expect(room.endBlockHeight).toBe(101);
        expect(m.expireBlockDeadlines(102)).toBe(0); // terminal transition is idempotent
    });

    test('a ruleset can explicitly disable the block deadline', () => {
        const m = mgr();
        const room = new MatchRoom({
            economy: 'free', startBlockHeight: 100,
            entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED,
            ruleset: {
                id: 'no-block-clock', mode: 'race', players: { min: 2, max: 2 },
                entities: { monster: false }, winCondition: { type: 'high-score' },
                timing: { blockDeadline: false, minDurationMs: 0 }
            }
        });
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: NEVER, minDurationMs: 0, hardCeilingMs: NEVER });
        room.start();

        expect(m.expireBlockDeadlines(101)).toBe(0);
        expect(room.status).toBe('active');
    });
});

describe('match rework — reconnect re-keying + ownership (MP-H1/H2)', () => {
    const managers = [];
    afterEach(() => { while (managers.length) managers.pop().shutdown(); delete process.env.MATCH_ENABLED; });

    function activeMatch() {
        const m = new MatchManager({ io: makeIo(), db: null, debugManager: null });
        m.enabled = true;
        managers.push(m);
        const room = new MatchRoom({ economy: 'free', entrants: { s1: { userId: 1 }, s2: { userId: 2 } }, seed: SEED });
        m.attach(room, [{ userId: 1, socketId: 's1' }, { userId: 2, socketId: 's2' }],
            { countdownMs: NEVER, minDurationMs: NEVER, hardCeilingMs: NEVER });
        room.start();
        return { m, room };
    }

    test('reconnect re-maps old socket id to new across occupants, playerStates + manager maps', () => {
        const { m, room } = activeMatch();
        // Disconnect s1 -> arms the AFK grace timer keyed by the OLD id.
        m.handleDisconnect({ id: 's1' });
        expect(m.disconnectTimeouts.has(`${room.id}:s1`)).toBe(true);

        const sock = makeSocket('s1new');
        const ok = m.handleReconnect(sock, { userId: 1 });
        expect(ok).toBe(true);

        // Occupant + state re-keyed to the new socket id, old key gone.
        expect(room.occupants.has('s1new')).toBe(true);
        expect(room.occupants.has('s1')).toBe(false);
        expect(room.occupants.get('s1new').id).toBe('s1new'); // occupant.id updated too
        expect(room.playerStates.has('s1new')).toBe(true);
        expect(room.playerStates.get('s1new').userId).toBe(1);
        expect(room.playerStates.has('s1')).toBe(false);

        // Manager maps re-keyed; AFK timer for the OLD id cleared (never AFK-kill a reconnect).
        expect(m.socketToMatch.get('s1new')).toBe(room.id);
        expect(m.socketToMatch.has('s1')).toBe(false);
        expect(m.disconnectTimeouts.has(`${room.id}:s1`)).toBe(false);
        expect(sock.emitted.some(e => e.ev === 'match_rejoined')).toBe(true);
    });

    test('a session that does not own a racer cannot attach to the match', () => {
        const { m, room } = activeMatch();
        const evil = makeSocket('evil');
        const ok = m.handleReconnect(evil, { userId: 999 }); // no racer with userId 999
        expect(ok).toBe(false);
        expect(room.occupants.has('evil')).toBe(false);
        expect(m.socketToMatch.has('evil')).toBe(false);
    });

    test('a finished-room reconnect receives the terminal result immediately and once', () => {
        const { m, room } = activeMatch();
        room.expire('hard_ceiling');
        room.finalize();
        room._finalized = true; // durable finish retained during the normal cleanup grace

        const sock = makeSocket('s1new');
        expect(m.handleReconnect(sock, { userId: 1 })).toBe(true);
        expect(m.handleReconnect(sock, { userId: 1 })).toBe(true);

        const terminal = sock.emitted.filter(e => e.ev === 'match_end');
        expect(terminal).toHaveLength(1);
        expect(terminal[0].p).toEqual(expect.objectContaining({
            matchId: room.id,
            reason: 'hard_ceiling',
            winnerId: room.winnerId
        }));
        expect(terminal[0].p.players.find(p => p.id === 's1new')).toEqual(expect.objectContaining({
            placement: expect.any(Number),
            score: expect.any(Number)
        }));
        expect(terminal[0].p.fairness.seed).toBe(SEED);
    });

    test('a reconnect during nondurable finish gets pending, never a premature winner', () => {
        const { m, room } = activeMatch();
        room.expire('hard_ceiling');
        room.finalize();
        room._finalized = false;

        const sock = makeSocket('s1new');
        expect(m.handleReconnect(sock, { userId: 1 })).toBe(true);
        expect(sock.emitted.some(e => e.ev === 'match_settlement_pending')).toBe(true);
        expect(sock.emitted.some(e => e.ev === 'match_end')).toBe(false);
    });
});

describe('match rework — winner consistency across end paths', () => {
    test('all-dead: winnerId equals the placement #1 player (never a stranded null)', () => {
        const room = new MatchRoom({ economy: 'crypto_race', entrants: { a: { userId: 1 }, b: { userId: 2 } }, seed: SEED });
        room.start();
        room._killPlayer('a', 'monster');
        room._killPlayer('b', 'monster');
        expect(room.status).toBe('finished');
        expect(room.endReason).toBe('all_dead');
        room.finalize();

        const placeOne = [...room.playerStates.entries()].find(([, s]) => s.placement === 1);
        expect(placeOne).toBeTruthy();
        expect(room.winnerId).toBe(placeOne[0]); // payout target == leaderboard #1
        expect(room.winnerId).not.toBeNull();
    });

    test('escape: the first player out stays the winner and is placement #1', () => {
        const room = makeCryptoFinishedRoom({ winner: 'a' });
        expect(room.winnerId).toBe('a');
        expect(room.playerStates.get('a').placement).toBe(1);
    });
});

describe('match rework — payout economics (MP-C4/H5)', () => {
    function capturingDb({ address = 'WALLET', pot = '20000', fee = '1000' } = {}) {
        const captured = [];
        const amount = (BigInt(pot) - BigInt(fee)).toString();
        return {
            captured,
            async query() { return { rows: [], rowCount: 0 }; },
            async withTransaction(fn) {
                const client = {
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('FROM matches') && sql.includes('FOR UPDATE')) {
                            return { rows: [{
                                id: params[0], economy: 'crypto_race', status: 'finished', winner_user_id: 1,
                                payout_liability_amount_atomic: amount,
                                payout_liability_cap_atomic: amount,
                                payout_liability_accepted_at: new Date().toISOString()
                            }], rowCount: 1 };
                        }
                        if (sql.includes('FROM payouts')) return { rows: [], rowCount: 0 };
                        if (sql.includes('FROM users')) return { rows: [{ id: 1, payout_address: address }], rowCount: 1 };
                        return { rows: [{ id: 1 }], rowCount: 1 };
                    }
                };
                return fn(client);
            }
        };
    }

    test('winner with an address gets a pending payout capped at pot minus house fee', async () => {
        const db = capturingDb({ address: 'WALLET', pot: '20000', fee: '1000' });
        const svc = new MatchPayoutService({ db });
        await svc.payoutWinner(makeCryptoFinishedRoom());
        const ins = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(ins.params[3]).toBe('19000');       // amount = 20000 - 1000
        expect(ins.params[5]).toBe('match_winner');
        expect(ins.params[6]).toBe('pending');
    });

    test('MP-H5: a winner with NO address still records a claimable payout (never forfeited)', async () => {
        const db = capturingDb({ address: null, pot: '20000', fee: '1000' });
        const svc = new MatchPayoutService({ db });
        await svc.payoutWinner(makeCryptoFinishedRoom());
        const ins = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(ins).toBeTruthy();
        expect(ins.params[3]).toBe('19000');                 // full owed amount recorded
        expect(ins.params[6]).toBe('needs_review');          // deferred, batcher won't send it
        expect(ins.params[5]).toBe('match_winner_no_address');
        expect(ins.params[2]).toBe('PENDING_NO_ADDRESS');    // sentinel, non-null, claimable
    });

    test('BigInt exactness: a pot beyond 2^53 loses no precision', async () => {
        const db = capturingDb({ address: 'WALLET', pot: '900719925474099201', fee: '1' });
        const svc = new MatchPayoutService({ db });
        await svc.payoutWinner(makeCryptoFinishedRoom());
        const ins = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(ins.params[3]).toBe('900719925474099200'); // exact; a float would round this
    });

    test('collectEntryTickets uses integer basis-point math for a fractional house fee', async () => {
        process.env.MATCH_ENABLED = 'true';
        process.env.MATCH_CRYPTO_RACE_ENABLED = 'true';
        process.env.MATCH_PAYOUTS_ENABLED = 'true';
        process.env.MATCH_PAYOUT_MAX = '1000000000000';
        process.env.MATCH_MAX_PLAYERS = '4';
        process.env.PAYOUTS_ENABLED = 'true';
        process.env.PAYMENTS_ENABLED = 'true';
        process.env.MATCH_ENTRY_FEE_ATOMIC = '10000000000';
        process.env.MATCH_HOUSE_FEE_PERCENT = '5.5';
        const captured = [];
        const db = { async withTransaction(fn) { return fn({ async query(sql, params) {
            captured.push({ sql, params });
            if (sql.includes('FROM match_queue_entries') && sql.includes('FOR UPDATE')) {
                return {
                    rows: params[0].map((id, index) => ({
                        id,
                        user_id: index + 1,
                        race_entry_lot_id: 100 + index,
                        escrow_amount: '1',
                        escrow_value_atomic: '10000000000'
                    })),
                    rowCount: params[0].length
                };
            }
            return { rows: [{ race_entries: 1, id: 1 }], rowCount: 1 };
        } }); } };
        const svc = new MatchPayoutService({ db });
        const room = new MatchRoom({ economy: 'crypto_race', entrants: { a: { userId: 1 }, b: { userId: 2 } }, seed: SEED });
        await svc.collectEntryTickets(room, [
            { userId: 1, queueEntryId: 11 },
            { userId: 2, queueEntryId: 12 }
        ]);
        const upd = captured.find(q => q.sql.includes('UPDATE matches'));
        expect(upd.params[0]).toBe('10000000000'); // entry fee
        expect(upd.params[1]).toBe('20000000000'); // pot = fee * 2
        expect(upd.params[2]).toBe('1100000000');  // house fee = pot * 550bp / 10000 (floor)
        expect(room.potAtomic).toBe('20000000000');
        delete process.env.MATCH_ENTRY_FEE_ATOMIC;
        delete process.env.MATCH_HOUSE_FEE_PERCENT;
        delete process.env.MATCH_CRYPTO_RACE_ENABLED;
        delete process.env.MATCH_PAYOUTS_ENABLED;
        delete process.env.MATCH_PAYOUT_MAX;
        delete process.env.MATCH_MAX_PLAYERS;
        delete process.env.PAYOUTS_ENABLED;
        delete process.env.PAYMENTS_ENABLED;
        delete process.env.MATCH_ENABLED;
    });
});

describe('match rework — refunds on every cancellation path (MP-H3/H4)', () => {
    afterEach(() => { delete process.env.MATCH_ENABLED; delete process.env.MATCH_CREDITS_COST; });

    test('refundEntries cancels the queue row AND writes a ticket refund ledger row', async () => {
        process.env.MATCH_ENABLED = 'true';
        const captured = [];
        const db = {
            async query() { return { rows: [], rowCount: 0 }; },
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('UPDATE match_queue_entries')) return { rows: [{ id: 1 }], rowCount: 1 };
                        return { rows: [{ race_entries: 5 }], rowCount: 1 };
                    }
                });
            }
        };
        const q = new MatchQueue({ db });
        await q.refundEntries([{ userId: 1 }], 'crypto_race', 'match_cancel');
        expect(captured.some(c => c.sql.includes("status = 'cancelled'"))).toBe(true);
        expect(captured.some(c => c.sql.includes('race_entries = race_entries + $1'))).toBe(true);
        expect(captured.some(c => c.sql.includes('INSERT INTO race_entry_transactions'))).toBe(true);
    });

    test('MP-H4: a credits leave after restart refunds the DB-derived amount, not memory', async () => {
        process.env.MATCH_ENABLED = 'true';
        // No MATCH_CREDITS_COST set -> configured default is 1; the ledger says 7 was deducted.
        const captured = [];
        const db = {
            async query() { return { rows: [], rowCount: 0 }; },
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('DELETE FROM match_queue_entries')) return { rows: [{ id: 1 }], rowCount: 1 };
                        if (sql.includes("reason = 'match_queue_join'")) return { rows: [{ amount: '-7' }], rowCount: 1 };
                        if (sql.includes('UPDATE users SET credits')) return { rows: [{ credits: 107 }], rowCount: 1 };
                        return { rows: [{}], rowCount: 1 };
                    }
                });
            }
        };
        const q = new MatchQueue({ db }); // in-memory queue is EMPTY (simulates a restart)
        const res = await q.leave(1, 'credits_prestige');
        expect(res.success).toBe(true);
        const upd = captured.find(c => c.sql.includes('UPDATE users SET credits'));
        expect(upd.params[0]).toBe(7); // exact deducted amount from the ledger, not config (1)
    });

    test('leave accepts a resolved session object (socketHandlers form)', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = {
            async query() { return { rows: [], rowCount: 0 }; },
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('DELETE FROM match_queue_entries')) return { rows: [{ id: 1 }], rowCount: 1 };
                        return { rows: [{ race_entries: 3 }], rowCount: 1 };
                    }
                });
            }
        };
        const q = new MatchQueue({ db });
        const res = await q.leave({ userId: 1, economy: 'crypto_race' });
        expect(res.success).toBe(true);
    });
});

describe('match rework — durable-finish isolated finalize (MP-C5)', () => {
    afterEach(() => { delete process.env.MATCH_ENABLED; });

    test('a nondurable winner creates no payout, leaderboard row, or final announcement', async () => {
        const io = makeIo();
        const throwingDb = { async withTransaction() { throw new Error('persist boom'); } };
        const m = new MatchManager({ io, db: throwingDb, debugManager: null });
        m.enabled = true;

        const order = [];
        m.matchPayoutService.payoutWinner = async () => { order.push('payout'); };
        m.matchLeaderboard.postMatch = async () => { order.push('leaderboard'); };

        const room = makeCryptoFinishedRoom();
        m.rooms.set(room.id, room);
        await m._finalize(room);

        expect(order).not.toContain('payout'); // no DB winner means no reconstructable payout target
        expect(order).not.toContain('leaderboard'); // no synthetic result without a durable match
        expect(room._finalized).not.toBe(true); // remains retryable in memory
        expect(io.broadcasts.some(b => b.event === 'match_end')).toBe(false);
        expect(io.broadcasts.some(b => b.event === 'match_settlement_pending')).toBe(true);
        m.shutdown();
    });

    test('a transient finish failure retries and announces only after durability succeeds', async () => {
        jest.useFakeTimers();
        const io = makeIo();
        const m = new MatchManager({ io, db: {}, debugManager: null });
        m.enabled = true;
        m._persistFinish = jest.fn()
            .mockRejectedValueOnce(new Error('temporary database outage'))
            .mockResolvedValueOnce();
        m.matchPayoutService.payoutWinner = jest.fn().mockResolvedValue();
        m.matchLeaderboard.postMatch = jest.fn().mockResolvedValue();

        const room = makeCryptoFinishedRoom();
        m.rooms.set(room.id, room);
        await m._finalize(room);
        expect(room._finalized).not.toBe(true);
        expect(io.broadcasts.some(b => b.event === 'match_end')).toBe(false);

        await jest.advanceTimersByTimeAsync(5000);
        expect(room._finalized).toBe(true);
        expect(m._persistFinish).toHaveBeenCalledTimes(2);
        expect(m.matchPayoutService.payoutWinner).toHaveBeenCalledTimes(1);
        expect(m.matchLeaderboard.postMatch).toHaveBeenCalledTimes(1);
        expect(io.broadcasts.filter(b => b.event === 'match_end')).toHaveLength(1);
        m.shutdown();
        jest.useRealTimers();
    });
});
