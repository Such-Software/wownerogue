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
            variant: 'race',
            tickCount: 5,
            status: 'active',
            rows: 2,
            cols: 3,
            occupants: new Map([['a', { id: 'a', x: 1, y: 2, name: 'A', avatar: 'default', facing: 'down' }]]),
            playerStates: new Map([['a', { alive: true, finished: false, escaped: false, hasTreasure: false, placement: null }]]),
            monster: { x: 3, y: 4 },
            treasure: null,
            dungeon: { map: [["'1", "'1", '#'], ['#', "'1", '>']], entrance: [0, 0], exit: [2, 1] },
            winnerId: null,
            seedHash: 'deadbeef',
            seed: 'never-publish-this'
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

    test('public snapshots include a renderer-safe map but never the unrevealed seed', () => {
        const room = makeRoom('m-render');
        room.toGameState = () => ({
            visibleTiles: room.dungeon.map,
            exploredTiles: room.dungeon.map,
            lighting: {},
            dungeonRows: 2,
            dungeonCols: 3,
            players: [{ id: 'a', x: 1, y: 1, alive: true }],
            monster: { x: 0, y: 1 },
            treasure: { x: 1, y: 0, carrierId: null },
            entrance: [0, 0],
            exit: [2, 1],
            seed: room.seed,
            privateEvents: [{ input: 'left' }]
        });
        const { bridge } = makeBridge({ rooms: [room] });
        const snap = bridge.getActiveMatches()[0];

        expect(snap.visibleTiles).toEqual(room.dungeon.map);
        expect(snap.exploredTiles).toEqual(room.dungeon.map);
        expect(snap).toMatchObject({ dungeonRows: 2, dungeonCols: 3, seedHash: 'deadbeef' });
        expect(snap.seed).toBeUndefined();
        expect(snap.privateEvents).toBeUndefined();
    });
});
