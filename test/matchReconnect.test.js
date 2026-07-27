const MatchRoom = require('../src/multiplayer/MatchRoom');

describe('MatchRoom reconnect safety', () => {
    test('disconnect grace does not remove player state', () => {
        const room = new MatchRoom({
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        room.start();
        expect(room.playerStates.get('a').alive).toBe(true);
        // Simulate a forfeit / AFK kill.
        room._killPlayer('a', 'afk');
        expect(room.playerStates.get('a').alive).toBe(false);
        expect(room.activePlayerCount).toBe(1);
    });

    test('all players dying ends match', () => {
        const room = new MatchRoom({
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        room.start();
        room._killPlayer('a', 'monster');
        room._killPlayer('b', 'monster');
        expect(room.status).toBe('finished');
        expect(room.endReason).toBe('all_dead');
    });
});
