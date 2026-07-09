const MatchPayoutService = require('../src/network/matchPayoutService');
const MatchRoom = require('../src/multiplayer/MatchRoom');

describe('MatchPayoutService', () => {
    function makeDb() {
        const captured = [];
        return {
            captured,
            async query(sql, params) {
                if (sql.includes('SELECT pot_atomic')) return { rows: [{ pot_atomic: '20000', house_fee_atomic: '1000' }] };
                if (sql.includes('SELECT id, payout_address')) return { rows: [{ id: 1, payout_address: 'WALLET_ADDRESS' }] };
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                const client = {
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('SELECT id FROM payouts')) return { rows: [] };
                        return { rows: [{ id: 99 }], rowCount: 1 };
                    }
                };
                return await fn(client);
            }
        };
    }

    function makeRoom() {
        const room = new MatchRoom({
            economy: 'crypto_race',
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        room.start();
        room.playerStates.get('a').escaped = true;
        room.winnerId = 'a';
        room.status = 'finished';
        room.finalize();
        return room;
    }

    test('collectEntryTickets locks pot on match row', async () => {
        const db = makeDb();
        const service = new MatchPayoutService({ db });
        const room = makeRoom();
        await service.collectEntryTickets(room, [
            { userId: 1, socketId: 'a' },
            { userId: 2, socketId: 'b' }
        ]);
        const updateMatch = db.captured.find(q => q.sql.includes('UPDATE matches'));
        expect(updateMatch).toBeTruthy();
        expect(room.potAtomic).toBeGreaterThan(0);
    });

    test('payoutWinner inserts one pending payout for winner', async () => {
        const db = makeDb();
        const service = new MatchPayoutService({ db });
        const room = makeRoom();
        room.entryFeeAtomic = 10000;
        room.potAtomic = 20000;
        room.houseFeeAtomic = 1000;
        await service.payoutWinner(room);
        const insert = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(insert).toBeTruthy();
        expect(insert.params[3]).toBe('19000'); // winner amount
        expect(insert.params[5]).toBe('match_winner');
    });
});
