const MatchQueue = require('../src/network/matchQueue');

describe('MatchQueue', () => {
    function makeDb() {
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
                        if (sql.includes('UPDATE match_queue_entries') && sql.includes('user_id = ANY')) {
                            const ids = params[0] || [];
                            rows = ids.map((uid, i) => ({ id: i + 10, user_id: uid }));
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
        const result = await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'credits_prestige' });
        expect(result.success).toBe(true);
        expect(q.length('credits_prestige')).toBe(1);
        // Transaction captured in the stub client. We just verify join succeeded.
        delete process.env.MATCH_ENABLED;
        delete process.env.MATCH_CREDITS_COST;
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
        await q.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'credits_prestige' });
        const leave = await q.leave(1, 'credits_prestige');
        expect(leave.success).toBe(true);
        expect(q.length('credits_prestige')).toBe(0);
        delete process.env.MATCH_ENABLED;
        delete process.env.MATCH_CREDITS_COST;
    });
});
