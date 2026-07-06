const Room = require('../src/multiplayer/Room');
const Occupant = require('../src/multiplayer/Occupant');

describe('Room — shared real-time engine (Tavern instance)', () => {
    test('builds a rectangular walkable map with at least one spawn', () => {
        const room = new Room({ id: 'test-room', type: 'tavern' });
        expect(room.rows).toBeGreaterThan(0);
        expect(room.cols).toBeGreaterThan(0);
        expect(room.spawns.length).toBeGreaterThan(0);
        // Border is solid; a spawn tile is walkable.
        expect(room.isWalkable(0, 0)).toBe(false);
        const s = room.spawns[0];
        expect(room.isWalkable(s.x, s.y)).toBe(true);
    });

    test('occupants join at a spawn and appear in the snapshot', () => {
        const room = new Room({ id: 'r' });
        const a = room.addOccupant('alice', { name: 'Alice', avatar: 'default' });
        room.addOccupant('bob', { name: 'Bob' });
        expect(a).toBeInstanceOf(Occupant);
        expect(room.size).toBe(2);
        const ids = room.snapshot().occupants.map(o => o.id).sort();
        expect(ids).toEqual(['alice', 'bob']);
    });

    test('full state includes walkability for designed rooms without ASCII layout', () => {
        const room = new Room({
            id: 'designed',
            roomData: {
                cols: 2,
                rows: 2,
                walkable: [[true, false], [false, true]]
            }
        });
        const state = room.fullState();
        expect(state.layout).toBeNull();
        expect(state.walkable).toEqual([[true, false], [false, true]]);
    });

    test('server-authoritative movement: a valid step moves and sets facing', () => {
        const room = new Room({ id: 'r' });
        const occ = room.addOccupant('alice');
        const startX = occ.x;
        const res = room.moveOccupant('alice', 1, 0); // step right (spawn has open floor right)
        expect(res.moved).toBe(true);
        expect(occ.x).toBe(startX + 1);
        expect(occ.facing).toBe('right');
    });

    test('rejects diagonal, multi-tile and no-op requests', () => {
        const room = new Room({ id: 'r' });
        room.addOccupant('alice');
        expect(room.moveOccupant('alice', 1, 1).moved).toBe(false); // diagonal
        expect(room.moveOccupant('alice', 0, 0).moved).toBe(false); // no-op
        expect(room.moveOccupant('ghost', 1, 0).moved).toBe(false); // not in room
    });

    test('cannot walk through walls or off the map', () => {
        const room = new Room({ id: 'r' });
        const occ = room.addOccupant('alice');
        for (let i = 0; i < 40; i++) room.moveOccupant('alice', -1, 0); // slam left
        expect(occ.x).toBeGreaterThanOrEqual(0);
        expect(room.isWalkable(occ.x, occ.y)).toBe(true);       // still on floor
        expect(room.isWalkable(occ.x - 1, occ.y)).toBe(false);  // wall to the left
    });

    test('match rooms (solidOccupants) block stepping onto another occupant', () => {
        const match = new Room({ id: 'm', solidOccupants: true });
        const p = match.addOccupant('p'); // spawn A
        const q = match.addOccupant('q'); // spawn B, adjacent to A
        expect(Math.abs(p.x - q.x) + Math.abs(p.y - q.y)).toBe(1);
        const res = match.moveOccupant('q', Math.sign(p.x - q.x), Math.sign(p.y - q.y));
        expect(res.moved).toBe(false);
        expect(res.reason).toBe('occupied');
    });

    test('tavern rooms let occupants share a tile (open doorways, no blocking griefing)', () => {
        const tavern = new Room({ id: 't', solidOccupants: false });
        const p = tavern.addOccupant('p');
        const q = tavern.addOccupant('q');
        const res = tavern.moveOccupant('q', Math.sign(p.x - q.x), Math.sign(p.y - q.y));
        expect(res.moved).toBe(true);
        expect(tavern.isOccupied(p.x, p.y)).toBe(true); // both share the tile, allowed
    });

    test('tick is a heartbeat that increments and never throws', () => {
        const room = new Room({ id: 'r' });
        for (let i = 0; i < 5; i++) room.tick();
        expect(room.tickCount).toBe(5);
        expect(room.snapshot().tick).toBe(5);
    });

    test('removeOccupant clears them from the snapshot', () => {
        const room = new Room({ id: 'r' });
        room.addOccupant('alice');
        expect(room.removeOccupant('alice')).toBe(true);
        expect(room.size).toBe(0);
        expect(room.snapshot().occupants).toEqual([]);
    });
});
