const MatchLeaderboard = require('../src/network/matchLeaderboard');
const MatchRoom = require('../src/multiplayer/MatchRoom');

describe('MatchLeaderboard', () => {
    function makeDb() {
        const captured = [];
        return {
            captured,
            async withTransaction(fn) {
                const client = {
                    async query(sql, params) {
                        captured.push({ sql, params });
                        return { rowCount: 1, rows: [] };
                    }
                };
                return await fn(client);
            }
        };
    }

    function makeFinishedRoom(economy) {
        const room = new MatchRoom({
            entrants: {
                a: { userId: 1, name: 'A' },
                b: { userId: 2, name: 'B' }
            },
            economy,
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        room.start();
        room.expire('hard_ceiling');
        room.finalize();
        return room;
    }

    test('free race inserts synthetic FREE records', async () => {
        const db = makeDb();
        const lb = new MatchLeaderboard({ db });
        const room = makeFinishedRoom('free');
        await lb.postMatch(room);
        const gamesInserts = db.captured.filter(q => q.sql.includes('INSERT INTO games')) || [];
        expect(gamesInserts.length).toBe(2);
        expect(gamesInserts[0].params[2]).toBe('FREE');
    });

    test('prestige race broadcasts without inserting games', async () => {
        const emitted = [];
        const io = { emit: (e, p) => emitted.push({ e, p }) };
        const db = makeDb();
        const lb = new MatchLeaderboard({ db, io });
        const room = makeFinishedRoom('credits_prestige');
        await lb.postMatch(room);
        const gamesInserts = db.captured.filter(q => q.sql.includes('INSERT INTO games')) || [];
        expect(gamesInserts.length).toBe(0);
        expect(emitted.some(e => e.e === 'leaderboard_update' && e.p.board === 'prestige')).toBe(true);
    });

    test('crypto race inserts PAID_CREDITS records', async () => {
        const db = makeDb();
        const lb = new MatchLeaderboard({ db });
        const room = makeFinishedRoom('crypto_race');
        await lb.postMatch(room);
        const gamesInserts = db.captured.filter(q => q.sql.includes('INSERT INTO games')) || [];
        expect(gamesInserts.length).toBe(2);
        expect(gamesInserts[0].params[2]).toBe('PAID_CREDITS');
    });
});
