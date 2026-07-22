const MatchLeaderboard = require('../src/network/matchLeaderboard');
const MatchRoom = require('../src/multiplayer/MatchRoom');
const { WIN } = require('../src/game/rulesets');

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

    test('last-alive win/loss follows winnerId + placement, never the escaped flag', async () => {
        const db = makeDb();
        const lb = new MatchLeaderboard({ db });
        const room = new MatchRoom({
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            economy: 'free',
            ruleset: {
                id: 'test-last-alive', mode: 'pvp',
                entities: { monster: false, pvpCombat: true },
                players: { min: 2, max: 2 },
                winCondition: { type: WIN.LAST_ALIVE }
            },
            seed: '0'.repeat(64)
        });
        room.start();
        room._finishPlayer('a', true);
        room.winCondition.onExit(room, 'a');
        room.finalize();

        expect(room.playerStates.get('a').escaped).toBe(true);
        expect(room.winnerId).toBe('b');
        expect(room.playerStates.get('b').placement).toBe(1);

        await lb.postMatch(room);
        const inserts = db.captured.filter(q => q.sql.includes('INSERT INTO games'));
        const bySocket = new Map(inserts.map(q => [q.params[1], q.params]));
        expect(bySocket.get('a').slice(3, 5)).toEqual(['lost', 'match_loss']);
        expect(bySocket.get('b').slice(3, 5)).toEqual(['won', 'match_winner']);
    });

    test('score-attack awards the authoritative score winner even when another entrant escaped', async () => {
        const db = makeDb();
        const lb = new MatchLeaderboard({ db });
        const room = new MatchRoom({
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            economy: 'free',
            ruleset: {
                id: 'test-score', mode: 'race', entities: { monster: false },
                players: { min: 2, max: 2 }, winCondition: { type: WIN.HIGH_SCORE }
            },
            seed: '0'.repeat(64)
        });
        room.start();
        room.playerStates.get('a').escaped = true;
        room.playerStates.get('a').finished = true;
        room.playerStates.get('a').moves = 200;
        room.playerStates.get('b').hasTreasure = true;
        room.playerStates.get('b').moves = 1;
        room.expire('hard_ceiling');
        room.finalize();

        expect(room.winnerId).toBe('b');
        await lb.postMatch(room);
        const inserts = db.captured.filter(q => q.sql.includes('INSERT INTO games'));
        const bySocket = new Map(inserts.map(q => [q.params[1], q.params]));
        expect(bySocket.get('a')[3]).toBe('lost');
        expect(bySocket.get('b')[3]).toBe('won');
    });

    test('co-op results stay in match history and never enter individual boards', async () => {
        const emitted = [];
        const db = makeDb();
        const lb = new MatchLeaderboard({ db, io: { emit: (e, p) => emitted.push({ e, p }) } });
        const room = new MatchRoom({
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            economy: 'free',
            ruleset: {
                id: 'coop-escape', mode: 'coop',
                entities: { monster: false }, players: { min: 2, max: 2 },
                winCondition: { type: WIN.ALL_ESCAPE }
            },
            seed: '0'.repeat(64)
        });
        room.start();
        room.expire('hard_ceiling');
        room.finalize();

        expect(room.winnerId).toBeNull();
        await lb.postMatch(room);
        expect(db.captured).toHaveLength(0);
        expect(emitted).toHaveLength(0);
    });
});
