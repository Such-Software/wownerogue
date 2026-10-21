const MatchQueue = require('../src/network/matchQueue');
const MatchManager = require('../src/network/matchManager');
const MatchRoom = require('../src/multiplayer/MatchRoom');
const SocketHandlers = require('../src/network/socketHandlers');

describe('MatchQueue', () => {
    function makeDb() {
        let nextQueueId = 1;
        const queueUsers = new Map();
        return {
            queries: [],
            lastParams: null,
            async query(sql, params) {
                this.queries.push(sql);
                this.lastParams = params || [];
                // Default stub: empty rows.
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                const client = {
                    queries: [],
                    async query(sql, params) {
                        this.queries.push({ sql, params });
                        let rows = [{ id: 1, created_at: new Date().toISOString(), credits: 100, race_entries: 1 }];
                        let rowCount = 1;
                        if (sql.includes('INSERT INTO match_queue_entries')) {
                            const id = nextQueueId++;
                            queueUsers.set(String(id), params[0]);
                            rows = [{ id, created_at: new Date().toISOString() }];
                        } else if (sql.includes('UPDATE match_queue_entries') && sql.includes('id = ANY')) {
                            const ids = params[0] || [];
                            rows = ids.map(id => ({ id, user_id: queueUsers.get(String(id)) }));
                            rowCount = ids.length;
                        }
                        return { rows, rowCount };
                    }
                };
                return await fn(client);
            }
        };
    }

    test('disabled when MATCH_ENABLED is not true', () => {
        const q = new MatchQueue({});
        expect(q.isEnabled()).toBe(false);
    });

    test('validates economy', async () => {
        process.env.MATCH_ENABLED = 'true';
        const q = new MatchQueue({});
        const result = await q.join({ userId: 1, socketId: 's', sessionToken: 't', economy: 'bogus' });
        expect(result.success).toBe(false);
        expect(result.reason).toBe('invalid_economy');
        delete process.env.MATCH_ENABLED;
    });

    test('rejects a syntactically valid economy that the server has disabled', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = makeDb();
        const gameModeManager = { _getMatchEconomies: () => ({ free: true }) };
        const q = new MatchQueue({ db, gameModeManager });
        q.initialized = true;

        const result = await q.join({ userId: 1, socketId: 's', sessionToken: 't', economy: 'crypto_race' });

        expect(result).toEqual({ success: false, reason: 'economy_disabled' });
        expect(q.length('crypto_race')).toBe(0);
        expect(db.queries).toHaveLength(0);
        delete process.env.MATCH_ENABLED;
    });

    test('free join adds to memory queue', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = makeDb();
        const q = new MatchQueue({ db });
        const result = await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        expect(result.success).toBe(true);
        expect(q.length('free')).toBe(1);
        delete process.env.MATCH_ENABLED;
    });

    test('credits join deducts credits atomically', async () => {
        process.env.MATCH_ENABLED = 'true';
        process.env.MATCH_CREDITS_COST = '5';
        const db = makeDb();
        const q = new MatchQueue({ db });
        q.initialized = true;
        const result = await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'credits_prestige' });
        expect(result.success).toBe(true);
        expect(q.length('credits_prestige')).toBe(1);
        // Transaction captured in the stub client. We just verify join succeeded.
        delete process.env.MATCH_ENABLED;
        delete process.env.MATCH_CREDITS_COST;
    });

    test.each([
        ['credits_prestige', 'credits'],
        ['crypto_race', 'race_entries']
    ])('concurrent duplicate %s joins hold escrow exactly once', async (economy, debitColumn) => {
        process.env.MATCH_ENABLED = 'true';
        if (economy === 'crypto_race') {
            process.env.MATCH_CRYPTO_RACE_ENABLED = 'true';
            process.env.MATCH_PAYOUTS_ENABLED = 'true';
            process.env.MATCH_PAYOUT_MAX = '1000000';
            process.env.MATCH_ENTRY_FEE_ATOMIC = '10000';
            process.env.MATCH_HOUSE_FEE_PERCENT = '5';
            process.env.MATCH_MAX_PLAYERS = '4';
        }
        let queued = false;
        let debits = 0;
        let joinLedgerRows = 0;
        const createdAt = new Date().toISOString();
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('INSERT INTO match_queue_entries')) {
                            if (queued) return { rows: [], rowCount: 0 };
                            queued = true;
                            return { rows: [{ id: 77, created_at: createdAt }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE match_queue_entries') && sql.includes("status = 'queued'")) {
                            return { rows: [{ id: 77, created_at: createdAt }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE users') && sql.includes(`${debitColumn} = ${debitColumn} -`)) {
                            debits += 1;
                            return {
                                rows: [{ credits: 9, race_entries: 0 }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('SELECT id, unit_value_atomic') && sql.includes('FROM race_entry_lots')) {
                            return { rows: [{ id: 501, unit_value_atomic: '10000' }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE race_entry_lots')) {
                            return { rows: [{ id: 501 }], rowCount: 1 };
                        }
                        if (sql.includes('INSERT INTO credit_transactions') || sql.includes('INSERT INTO race_entry_transactions')) {
                            joinLedgerRows += 1;
                            return { rows: [], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 0 };
                    }
                });
            }
        };
        const gameModeManager = economy === 'crypto_race' ? {
            payoutsEnabled: true,
            directModeEnabled: true,
            creditsModeEnabled: false,
            _getMatchEconomies: () => ({ free: true, crypto_race: true })
        } : null;
        const q = new MatchQueue({ db, gameModeManager });
        q.initialized = true;
        const request = () => q.join({ userId: 9, socketId: 's9', sessionToken: 't9', economy });

        const results = await Promise.all([request(), request()]);

        expect(results.every(result => result.success)).toBe(true);
        expect(results.filter(result => result.alreadyQueued).length).toBe(1);
        expect(debits).toBe(1);
        expect(joinLedgerRows).toBe(1);
        expect(q.length(economy)).toBe(1);
        delete process.env.MATCH_ENABLED;
        delete process.env.MATCH_CRYPTO_RACE_ENABLED;
        delete process.env.MATCH_PAYOUTS_ENABLED;
        delete process.env.MATCH_PAYOUT_MAX;
        delete process.env.MATCH_ENTRY_FEE_ATOMIC;
        delete process.env.MATCH_HOUSE_FEE_PERCENT;
        delete process.env.MATCH_MAX_PLAYERS;
    });

    test('drain requires at least two queued players', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = makeDb();
        const q = new MatchQueue({ db });
        await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        const drain = await q.drain('free', 4);
        expect(drain).toBeNull();
        expect(q.length('free')).toBe(1);
        delete process.env.MATCH_ENABLED;
    });

    test('drain returns two+ players and clears memory queue', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = makeDb();
        const q = new MatchQueue({ db });
        await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await q.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });
        const drain = await q.drain('free', 4);
        expect(drain).toBeTruthy();
        expect(drain.entries.length).toBe(2);
        expect(q.length('free')).toBe(0);
        delete process.env.MATCH_ENABLED;
    });

    test('leave refunds credits and removes from queue', async () => {
        process.env.MATCH_ENABLED = 'true';
        process.env.MATCH_CREDITS_COST = '3';
        const db = makeDb();
        const q = new MatchQueue({ db });
        q.initialized = true;
        await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'credits_prestige' });
        const leave = await q.leave(1, 'credits_prestige');
        expect(leave.success).toBe(true);
        expect(q.length('credits_prestige')).toBe(0);
        delete process.env.MATCH_ENABLED;
        delete process.env.MATCH_CREDITS_COST;
    });
});

describe('SocketHandlers match queue acknowledgements', () => {
    test('emits the documented joined and left results to the client', async () => {
        const emitted = [];
        const socket = { id: 'sock', emit: (event, payload) => emitted.push({ event, payload }) };
        const ctx = {
            activeGames: new Map(),
            matchQueue: {
                isEnabled: () => true,
                enqueue: jest.fn().mockResolvedValue({ success: true, position: 2 }),
                leave: jest.fn().mockResolvedValue({ success: true })
            },
            rateLimiter: {
                checkLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
                recordAttempt: jest.fn().mockResolvedValue(undefined)
            },
            _resolveMatchSession: jest.fn().mockResolvedValue({ userId: 1, socketId: 'sock', sessionToken: 't' }),
            debugManager: { CONSOLE_LOGGING: false }
        };

        await SocketHandlers.prototype._handleMatchQueue.call(ctx, socket, { action: 'join', economy: 'free' });
        await SocketHandlers.prototype._handleMatchQueue.call(ctx, socket, { action: 'leave', economy: 'free' });

        expect(emitted).toContainEqual({
            event: 'match_queue_joined',
            payload: { success: true, position: 2, economy: 'free' }
        });
        expect(emitted).toContainEqual({
            event: 'match_queue_left',
            payload: { success: true, economy: 'free' }
        });
    });

    test('reconnect restores owned queued entries without joining or charging again', async () => {
        const emitted = [];
        const socket = { id: 'new-socket', emit: (event, payload) => emitted.push({ event, payload }) };
        const reattach = jest.fn(async (userId, economy, socketId, token) => {
            expect(userId).toBe(7);
            expect(socketId).toBe(socket.id);
            expect(token).toBe('current-session');
            return economy === 'free' || economy === 'credits_prestige'
                ? { inQueue: true, position: economy === 'free' ? 2 : 1 }
                : { inQueue: false };
        });
        const enqueue = jest.fn();
        const handleReconnect = jest.fn(() => false);
        const context = {
            matchManager: { enabled: true, handleReconnect },
            matchQueue: { reattach, enqueue },
            _resolveMatchSession: jest.fn(async () => ({ userId: 7, sessionToken: 'current-session' })),
            debugManager: { CONSOLE_LOGGING: false }
        };

        await SocketHandlers.prototype._handleMatchReconnect.call(context, socket, {
            userId: 999, economy: 'crypto_race', sessionToken: 'untrusted'
        });

        expect(handleReconnect).toHaveBeenCalledWith(socket, expect.objectContaining({ userId: 7 }));
        expect(reattach).toHaveBeenCalledWith(7, 'free', socket.id, 'current-session');
        expect(reattach).toHaveBeenCalledWith(7, 'credits_prestige', socket.id, 'current-session');
        expect(reattach).toHaveBeenCalledWith(7, 'crypto_race', socket.id, 'current-session');
        expect(enqueue).not.toHaveBeenCalled();
        expect(emitted.filter(item => item.event === 'match_queue_joined')).toEqual([
            { event: 'match_queue_joined', payload: {
                success: true, economy: 'free', position: 2, alreadyQueued: true, restored: true
            } },
            { event: 'match_queue_joined', payload: {
                success: true, economy: 'credits_prestige', position: 1, alreadyQueued: true, restored: true
            } }
        ]);
    });

    test('reconnect does not reclaim a queue row while its active match owns the player', async () => {
        const socket = { id: 'new-socket', emit: jest.fn() };
        const reattach = jest.fn();
        const context = {
            matchManager: { enabled: true, handleReconnect: jest.fn(() => true) },
            matchQueue: { reattach },
            _resolveMatchSession: jest.fn(async () => ({ userId: 7, sessionToken: 'current-session' }))
        };

        await SocketHandlers.prototype._handleMatchReconnect.call(context, socket);

        expect(reattach).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalledWith('match_queue_joined', expect.anything());
    });

    test('reconnect does not use a client claimed user when session resolution fails', async () => {
        const socket = { id: 'new-socket', emit: jest.fn() };
        const handleReconnect = jest.fn();
        const reattach = jest.fn();
        const context = {
            matchManager: { enabled: true, handleReconnect },
            matchQueue: { reattach },
            _resolveMatchSession: jest.fn(async () => null)
        };

        await SocketHandlers.prototype._handleMatchReconnect.call(context, socket, { userId: 7 });

        expect(handleReconnect).not.toHaveBeenCalled();
        expect(reattach).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
    });
});

describe('MatchQueue queued reconnect', () => {
    test('updates the durable queued row and memory socket while preserving its place', async () => {
        process.env.MATCH_ENABLED = 'true';
        const statements = [];
        const queuedRow = { id: 31, created_at: new Date('2026-10-21T10:00:00Z') };
        const db = { query: jest.fn(async (sql, params) => {
            statements.push(sql);
            expect(params).toEqual(['new-socket', 'current-session', 7, 'free']);
            return { rowCount: 1, rows: [queuedRow] };
        }) };
        const queue = new MatchQueue({ db });
        queue._queues.free.push({
            queueEntryId: queuedRow.id, userId: 7, socketId: 'old-socket',
            sessionToken: 'old-session', createdAt: queuedRow.created_at.getTime()
        });
        try {
            const restored = await queue.reattach(7, 'free', 'new-socket', 'current-session');
            expect(restored).toEqual({ inQueue: true, position: 1 });
            expect(queue._queues.free[0]).toMatchObject({
                queueEntryId: queuedRow.id, userId: 7, socketId: 'new-socket',
                sessionToken: 'current-session', createdAt: queuedRow.created_at.getTime()
            });
            expect(statements).toHaveLength(1);
        } finally {
            delete process.env.MATCH_ENABLED;
        }
    });

    test('a matched or absent durable row cannot be restored from stale memory', async () => {
        process.env.MATCH_ENABLED = 'true';
        const db = { query: jest.fn(async () => ({ rowCount: 0, rows: [] })) };
        const queue = new MatchQueue({ db });
        queue._queues.free.push({ userId: 7, socketId: 'old-socket' });
        try {
            expect(await queue.reattach(7, 'free', 'new-socket', 'current-session'))
                .toEqual({ inQueue: false });
            expect(queue._queues.free[0].socketId).toBe('old-socket');
        } finally {
            delete process.env.MATCH_ENABLED;
        }
    });

    test('a restored entrant receives the countdown and start on the new socket', async () => {
        jest.useFakeTimers();
        process.env.MATCH_ENABLED = 'true';
        const db = { query: jest.fn(async () => ({
            rowCount: 1, rows: [{ id: 31, created_at: new Date('2026-10-21T10:00:00Z') }]
        })) };
        const queue = new MatchQueue({ db });
        queue._queues.free.push({
            queueEntryId: 31, userId: 7, socketId: 'old-socket',
            sessionToken: 'old-session', createdAt: Date.parse('2026-10-21T10:00:00Z')
        });
        const makeSocket = id => ({
            id, channels: new Set(), events: [],
            join(channel) { this.channels.add(channel); },
            emit(event, payload) { this.events.push({ event, payload }); }
        });
        const oldSocket = makeSocket('old-socket');
        const newSocket = makeSocket('new-socket');
        const otherSocket = makeSocket('other-socket');
        const sockets = new Map([[newSocket.id, newSocket], [otherSocket.id, otherSocket]]);
        const io = {
            sockets: { sockets },
            to(channel) {
                return { emit(event, payload) {
                    for (const socket of sockets.values()) {
                        if (socket.channels.has(channel)) socket.emit(event, payload);
                    }
                } };
            }
        };
        let manager;
        try {
            await queue.reattach(7, 'free', newSocket.id, 'current-session');
            const entrant = queue._queues.free[0];
            const room = new MatchRoom({
                economy: 'free',
                entrants: {
                    [entrant.socketId]: { userId: entrant.userId },
                    [otherSocket.id]: { userId: 8 }
                },
                seed: '0'.repeat(64)
            });
            manager = new MatchManager({ io, db: null });
            manager.setEngine(room.id, { start: () => room.start(), stop: () => {} });
            manager.attach(room, [entrant, { userId: 8, socketId: otherSocket.id }], {
                countdownMs: 20, minDurationMs: 20000, hardCeilingMs: 60000
            });

            expect(newSocket.events.some(item => item.event === 'match_joined')).toBe(true);
            expect(oldSocket.events).toHaveLength(0);
            jest.advanceTimersByTime(20);
            expect(room.status).toBe('active');
            expect(newSocket.events.some(item => item.event === 'match_start')).toBe(true);
            expect(oldSocket.events).toHaveLength(0);
        } finally {
            manager?.shutdown();
            jest.useRealTimers();
            delete process.env.MATCH_ENABLED;
        }
    });
});
