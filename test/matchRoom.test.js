const MatchRoom = require('../src/multiplayer/MatchRoom');
const MatchEngine = require('../src/multiplayer/MatchEngine');
const MatchState = require('../src/multiplayer/MatchState');

describe('MatchRoom', () => {
    function makeRoom(opts = {}) {
        return new MatchRoom({
            entrants: {
                a: { userId: 1, name: 'A' },
                b: { userId: 2, name: 'B' }
            },
            difficultyPreset: 'race',
            seed: '0000000000000000000000000000000000000000000000000000000000000000',
            ...opts
        });
    }

    describe('construction', () => {
        test('generates a provably-fair seed hash', () => {
            const room = makeRoom();
            expect(room.seed).toHaveLength(64);
            expect(room.seedHash).toHaveLength(64);
            expect(room.seedHash).not.toEqual(room.seed);
        });

        test('places all entrants at the entrance', () => {
            const room = makeRoom();
            expect(room.occupants.size).toBe(2);
            const [e1, e2] = Array.from(room.occupants.values());
            expect(e1.x).toBe(room.dungeon.entrance[0]);
            expect(e1.y).toBe(room.dungeon.entrance[1]);
        });

        test('creates one shared monster', () => {
            const room = makeRoom();
            expect(room.monster).toBeTruthy();
            expect(typeof room.monster.x).toBe('number');
        });

        test('starts in starting status', () => {
            const room = makeRoom();
            expect(room.status).toBe('starting');
        });
    });

    describe('movement', () => {
        test('single player moves one tile', () => {
            const room = makeRoom();
            room.start();
            const occ = room.occupants.get('a');
            const { x, y } = occ;
            room.queueMove('a', 1, 0);
            const result = room.resolveTick();
            expect(result.events.some(e => e.type === 'move' && e.id === 'a')).toBe(true);
            expect(occ.x).toBe(x + 1);
            expect(occ.y).toBe(y);
        });

        test('wall blocks movement', () => {
            const room = makeRoom();
            room.start();
            const occ = room.occupants.get('a');

            // Find any wall tile and an adjacent walkable tile, then move toward the wall.
            let wallX = -1, wallY = -1, fromX = -1, fromY = -1;
            for (let y = 0; y < room.rows && wallX < 0; y++) {
                for (let x = 0; x < room.cols && wallX < 0; x++) {
                    if (!room.isWalkable(x, y)) {
                        const neighbors = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                        for (const [dx, dy] of neighbors) {
                            const nx = x + dx, ny = y + dy;
                            if (room.isWalkable(nx, ny)) {
                                wallX = x; wallY = y;
                                fromX = nx; fromY = ny;
                                break;
                            }
                        }
                    }
                }
            }
            expect(wallX).toBeGreaterThanOrEqual(0);

            occ.moveTo(fromX, fromY);
            const dx = Math.sign(wallX - fromX);
            const dy = Math.sign(wallY - fromY);
            room.queueMove('a', dx, dy);
            const result = room.resolveTick();
            expect(result.events.some(e => e.type === 'move_failed' && e.id === 'a' && e.reason === 'blocked')).toBe(true);
            expect(occ.x).toBe(fromX);
            expect(occ.y).toBe(fromY);
        });

        test('players moving into the same tile bounce', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            const b = room.occupants.get('b');
            // Force a simple setup: A at (2,2), B at (2,4), both walk to (2,3).
            a.moveTo(2, 2);
            b.moveTo(2, 4);
            room.walkable[2][3] = true;
            room.walkable[2][2] = true;
            room.walkable[2][4] = true;

            room.queueMove('a', 0, 1);
            room.queueMove('b', 0, -1);
            const result = room.resolveTick();
            expect(result.events.filter(e => e.type === 'move_failed' && (e.id === 'a' || e.id === 'b')).length).toBeGreaterThanOrEqual(2);
            expect(a.y).toBe(2);
            expect(b.y).toBe(4);
        });

        test('players swapping tiles bounce (no ghosting through)', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            const b = room.occupants.get('b');
            a.moveTo(2, 2);
            b.moveTo(2, 3);
            room.walkable[2][2] = true;
            room.walkable[2][3] = true;

            room.queueMove('a', 0, 1);
            room.queueMove('b', 0, -1);
            room.resolveTick();
            expect(a.y).toBe(2);
            expect(b.y).toBe(3);
        });
    });

    describe('treasure and exits', () => {
        test('player picking treasure marks them as carrier', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            room.treasure = { x: a.x + 1, y: a.y, carrierId: null };
            room.walkable[a.y][a.x + 1] = true;
            room.queueMove('a', 1, 0);
            const result = room.resolveTick();
            expect(result.events.some(e => e.type === 'treasure_pickup' && e.id === 'a')).toBe(true);
            expect(room.playerStates.get('a').hasTreasure).toBe(true);
        });

        test('reaching exit finishes the match', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            const [ex, ey] = room.dungeon.exit;
            a.moveTo(ex - 1, ey);
            room.walkable[ey][ex] = true;
            room.walkable[ey][ex - 1] = true;

            room.queueMove('a', 1, 0);
            const result = room.resolveTick();
            expect(result.finished).toBe(true);
            expect(room.status).toBe('finished');
            expect(room.winnerId).toBe('a');
            expect(result.events.some(e => e.type === 'player_exit' && e.id === 'a')).toBe(true);
        });

        test('treasure drops at corpse when carrier dies', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            room.treasure = { x: a.x + 1, y: a.y, carrierId: null };
            room.walkable[a.y][a.x + 1] = true;
            room.queueMove('a', 1, 0);
            room.resolveTick();
            expect(room.playerStates.get('a').hasTreasure).toBe(true);

            // Kill the player by moving monster onto them.
            room.monster.moveTo(a.x, a.y);
            const result = room.resolveTick();
            expect(room.playerStates.get('a').alive).toBe(false);
            expect(room.treasure.carrierId).toBeNull();
            expect(room.treasure.x).toBe(a.x);
            expect(room.treasure.y).toBe(a.y);
        });
    });

    describe('monster', () => {
        test('monster kills player who moves onto it', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            // Put monster adjacent and player walks onto it.
            const mx = a.x + 1;
            const my = a.y;
            room.monster.moveTo(mx, my);
            room.walkable[my][mx] = true;

            room.queueMove('a', 1, 0);
            const result = room.resolveTick();
            expect(room.playerStates.get('a').alive).toBe(false);
            expect(result.events.some(e => e.type === 'player_death')).toBe(true);
        });

        test('fractional monster speed accumulates across ticks and zero stays stationary', () => {
            const room = makeRoom();
            room.start();
            room.monster.hasLineOfSight = jest.fn(() => true);
            room.monster.moveTowardPlayer = jest.fn(() => true);

            room.difficultyConfig.monster.movesPerPlayerMove = 0.5;
            expect(room._moveMonster().filter(e => e.type === 'monster_move')).toHaveLength(0);
            expect(room._moveMonster().filter(e => e.type === 'monster_move')).toHaveLength(1);
            expect(room.monster.moveTowardPlayer).toHaveBeenCalledTimes(1);

            room.difficultyConfig.monster.movesPerPlayerMove = 0;
            room._moveMonster();
            room._moveMonster();
            expect(room.monster.moveTowardPlayer).toHaveBeenCalledTimes(1);
        });
    });

    describe('expiration / rankings', () => {
        test('expired match ranks living players by proximity to exit', () => {
            const room = makeRoom();
            room.start();
            const a = room.occupants.get('a');
            const b = room.occupants.get('b');
            const [ex, ey] = room.dungeon.exit;
            a.moveTo(ex - 1, ey); // closer
            b.moveTo(ex - 5, ey); // farther
            room.walkable[ey][ex - 1] = true;
            room.walkable[ey][ex - 5] = true;

            room.expire('hard_ceiling');
            room.finalize();
            expect(room.winnerId).toBe('a');
            expect(room.playerStates.get('a').placement).toBe(1);
            expect(room.playerStates.get('b').placement).toBe(2);
        });

        test('all dead without escape ends match', () => {
            const room = makeRoom();
            room.start();
            for (const id of room.playerStates.keys()) {
                room._killPlayer(id, 'monster');
            }
            expect(room.status).toBe('finished');
            expect(room.endReason).toBe('all_dead');
        });
    });

    describe('serialization', () => {
        test('toGameState includes players, monster, treasure, exit', () => {
            const room = makeRoom();
            room.start();
            const state = room.toGameState('a');
            expect(state.players.length).toBe(2);
            expect(state.players.find(p => p.id === 'a').you).toBe(true);
            expect(state.monster).toBeTruthy();
            expect(state.exit).toEqual(room.dungeon.exit);
        });

        test('MatchState serializes entrants for persistence', () => {
            const room = makeRoom();
            room.start();
            room.queueMove('a', 1, 0);
            room.resolveTick();
            room.expire('hard_ceiling');
            room.finalize();
            const rows = MatchState.toEntrantRows(room);
            expect(rows.length).toBe(2);
            expect(rows[0]).toHaveProperty('match_id', room.id);
            expect(rows[0]).toHaveProperty('placement');
            expect(rows[0]).toHaveProperty('score');
        });
    });

    describe('determinism', () => {
        test('same seed produces identical dungeon and initial state', () => {
            const r1 = makeRoom();
            const r2 = makeRoom();
            expect(r1.dungeon.entrance).toEqual(r2.dungeon.entrance);
            expect(r1.dungeon.exit).toEqual(r2.dungeon.exit);
            expect(r1.seedHash).toEqual(r2.seedHash);
            expect(r1.monster.x).toBe(r2.monster.x);
            expect(r1.monster.y).toBe(r2.monster.y);
        });
    });
});

describe('MatchEngine', () => {
    test('starts the room and ticks', () => {
        const room = new MatchRoom({
            entrants: { a: { userId: 1, name: 'A' } },
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        const engine = new MatchEngine({ room, tickMs: 1000 });
        expect(engine.start()).toBe(true);
        expect(room.status).toBe('active');
        engine.stop();
    });

    test('onFinish fires when room finishes', () => {
        const room = new MatchRoom({
            entrants: { a: { userId: 1, name: 'A' } },
            seed: '0000000000000000000000000000000000000000000000000000000000000000'
        });
        const finish = jest.fn();
        const engine = new MatchEngine({ room, onFinish: finish });
        engine.start();

        // Walk to exit.
        const a = room.occupants.get('a');
        const [ex, ey] = room.dungeon.exit;
        a.moveTo(ex - 1, ey);
        room.walkable[ey][ex] = true;
        room.walkable[ey][ex - 1] = true;
        room.queueMove('a', 1, 0);
        engine.tick();

        expect(finish).toHaveBeenCalledWith(room);
        engine.stop();
    });
});
