const TavernMatchBridge = require('../src/network/tavernMatchBridge');

describe('TavernMatchBridge', () => {
    function makeManager() {
        const rooms = new Map();
        return {
            rooms,
            onTick: jest.fn(),
            onFinish: jest.fn()
        };
    }

    function makeBridge({ rooms = [], io = null } = {}) {
        const manager = makeManager();
        for (const r of rooms) manager.rooms.set(r.id, r);
        const emitted = [];
        const bridge = new TavernMatchBridge({
            matchManager: manager,
            io: io || { to: () => ({ emit: (e, p) => emitted.push({ e, p }) }) },
            debugManager: null
        });
        bridge.enabled = true;
        return { bridge, manager, emitted };
    }

    function makeRoom(id = 'm1') {
        return {
            id,
            economy: 'free',
            tickCount: 5,
            status: 'active',
            occupants: new Map([['a', { id: 'a', x: 1, y: 2, name: 'A', avatar: 'default', facing: 'down' }]]),
            playerStates: new Map([['a', { alive: true, finished: false, escaped: false, hasTreasure: false, placement: null }]]),
            monster: { x: 3, y: 4 },
            treasure: null,
            dungeon: { exit: [10, 10] },
            winnerId: null,
            seedHash: 'deadbeef'
        };
    }

    test('forwards public match tick to tavern room', () => {
        const room = makeRoom('m1');
        const { bridge, manager, emitted } = makeBridge({ rooms: [room] });
        bridge.initialize();
        manager.onTick('m1', { tick: 5, events: [] });
        expect(emitted.some(e => e.e === 'tavern_match_tick' && e.p.matchId === 'm1')).toBe(true);
    });

    test('forwards match end to tavern room', async () => {
        const room = makeRoom('m2');
        room.status = 'finished';
        room.winnerId = 'a';
        const { bridge, manager, emitted } = makeBridge({ rooms: [room] });
        bridge.initialize();
        await manager.onFinish(room);
        expect(emitted.some(e => e.e === 'tavern_match_end' && e.p.matchId === 'm2')).toBe(true);
    });

    test('getActiveMatches returns public snapshots', () => {
        const room = makeRoom('m3');
        const { bridge } = makeBridge({ rooms: [room] });
        const list = bridge.getActiveMatches();
        expect(list.length).toBe(1);
        expect(list[0].matchId).toBe('m3');
        expect(list[0].players.length).toBe(1);
    });
});
