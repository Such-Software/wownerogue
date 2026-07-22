/**
 * Pillar 4 — Ruleset engine + PvP modes on the match engine.
 */
const { defineRuleset, WIN, getRuleset, listRulesets, rulesetFromMatchOpts } = require('../src/game/rulesets');
const MatchRoom = require('../src/multiplayer/MatchRoom');

const SEED = 'ruleset-test-seed';

describe('defineRuleset normalization', () => {
    test('empty spec yields safe classic defaults', () => {
        const r = defineRuleset({});
        expect(r.winCondition.type).toBe(WIN.FIRST_TO_EXIT);
        expect(r.entities.monster).toBe(true);
        expect(r.entities.pvpCombat).toBe(false);
        expect(r.timing.tickMs).toBe(250);
        expect(r.economy.model).toBe('free');
        expect(Object.isFrozen(r)).toBe(true);
    });

    test('clamps out-of-range values and unknown win type', () => {
        const r = defineRuleset({ players: { min: 99, max: 2 }, timing: { tickMs: 1 }, winCondition: { type: 'nonsense' } });
        expect(r.players.max).toBe(2);
        expect(r.players.min).toBeLessThanOrEqual(r.players.max);
        expect(r.timing.tickMs).toBe(50); // clamped up to the floor
        expect(r.winCondition.type).toBe(WIN.FIRST_TO_EXIT); // invalid -> default
    });

    test('monster:false forces monsterCount 0', () => {
        expect(defineRuleset({ entities: { monster: false } }).entities.monsterCount).toBe(0);
    });
});

describe('registry', () => {
    test('built-ins include the new PvP + score modes', () => {
        const ids = listRulesets().map(r => r.id);
        expect(ids).toEqual(expect.arrayContaining(['solo-classic', 'race', 'last-alive', 'score-attack']));
        expect(getRuleset('last-alive').entities.pvpCombat).toBe(true);
        expect(getRuleset('score-attack').winCondition.type).toBe(WIN.HIGH_SCORE);
    });

    test('unknown id falls back to race', () => {
        expect(getRuleset('does-not-exist').id).toBe('race');
    });

    test('rulesetFromMatchOpts preserves race semantics (first-to-exit)', () => {
        const r = rulesetFromMatchOpts({ economy: 'crypto_race', variant: 'pvp', difficultyPreset: 'race', maxPlayers: 6 });
        expect(r.winCondition.type).toBe(WIN.FIRST_TO_EXIT); // variant never silently changes the win rule
        expect(r.economy.model).toBe('crypto_race');
        expect(r.players.max).toBe(6);
    });
});

function findAdjacentWalkable(room) {
    for (let y = 0; y < room.rows; y++) {
        for (let x = 0; x < room.cols - 1; x++) {
            if (room.isWalkable(x, y) && room.isWalkable(x + 1, y)) return { x, y };
        }
    }
    return null;
}

function stageSequentialExit(room) {
    room.dungeon.exit = [2, 2];
    room.walkable[2][1] = true;
    room.walkable[2][2] = true;
    room.walkable[3][2] = true;
    room.occupants.get('a').moveTo(1, 2);
    room.occupants.get('b').moveTo(2, 3);
}

describe('MatchRoom drives new rulesets', () => {
    test('last-alive PvP: stepping onto a rival kills them and ends the match with the survivor as winner', () => {
        const room = new MatchRoom({
            ruleset: { id: 'test-pvp', winCondition: { type: WIN.LAST_ALIVE }, entities: { monster: false, pvpCombat: true }, players: { min: 2, max: 4 } },
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: SEED
        });
        expect(room.monster).toBeNull(); // monster:false honored
        room.start();

        const cell = findAdjacentWalkable(room);
        room.occupants.get('a').moveTo(cell.x, cell.y);
        room.occupants.get('b').moveTo(cell.x + 1, cell.y);

        room.queueMove('a', 1, 0); // a strikes east into b
        const res = room.resolveTick();

        expect(res.events.some(e => e.type === 'player_death' && e.id === 'b' && e.killedBy === 'a')).toBe(true);
        expect(room.playerStates.get('b').alive).toBe(false);
        expect(room.status).toBe('finished');
        expect(room.endReason).toBe('last_alive');

        room.finalize();
        expect(room.winnerId).toBe('a');
        expect(room.playerStates.get('a').placement).toBe(1);
        expect(room.playerStates.get('b').placement).toBe(2);
    });

    test('same-tick PvP is independent of packet order and eliminated actors never retaliate', () => {
        const run = (submissionOrder) => {
            const room = new MatchRoom({
                ruleset: { id: 'ordered-pvp', winCondition: { type: WIN.LAST_ALIVE }, entities: { monster: false, pvpCombat: true }, players: { min: 2, max: 4 } },
                entrants: { a: { userId: 1 }, b: { userId: 2 }, c: { userId: 3 } },
                seed: SEED
            });
            room.start();

            const ids = ['a', 'b', 'c'].sort((left, right) =>
                room._tickActionPriority(left, room.tickCount + 1)
                    .localeCompare(room._tickActionPriority(right, room.tickCount + 1))
            );
            const [attacker, victim, downstream] = ids;
            room.occupants.get(attacker).moveTo(2, 2);
            room.occupants.get(victim).moveTo(3, 2);
            room.occupants.get(downstream).moveTo(4, 2);
            room.walkable[2][2] = true;
            room.walkable[2][3] = true;
            room.walkable[2][4] = true;

            const moves = new Map([
                [attacker, [1, 0]],       // kills victim first by committed tick priority
                [victim, [1, 0]]          // would kill downstream if post-mortem actions ran
            ]);
            for (const id of submissionOrder(ids)) room.queueMove(id, ...moves.get(id));
            const result = room.resolveTick();
            return {
                attacker,
                victim,
                downstream,
                events: result.events,
                status: room.status,
                winnerId: room.winnerId,
                players: Array.from(room.playerStates.entries()).map(([id, state]) => [id, {
                    alive: state.alive,
                    killedBy: state.killedBy,
                    moves: state.moves,
                    placement: state.placement
                }])
            };
        };

        const forward = run(ids => [ids[0], ids[1]]);
        const reverse = run(ids => [ids[1], ids[0]]);
        expect(reverse).toEqual(forward);
        expect(forward.players.find(([id]) => id === forward.victim)[1].alive).toBe(false);
        expect(forward.players.find(([id]) => id === forward.downstream)[1].alive).toBe(true);
        expect(forward.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'move_failed', id: forward.victim, reason: 'eliminated_before_action'
            })
        ]));
    });

    test('last-alive corpses remain visible but do not trap surviving players', () => {
        const room = new MatchRoom({
            ruleset: {
                id: 'corpse-pass-through', winCondition: { type: WIN.LAST_ALIVE },
                entities: { monster: false, pvpCombat: true }, players: { min: 2, max: 4 }
            },
            entrants: { a: { userId: 1 }, b: { userId: 2 }, c: { userId: 3 } },
            seed: SEED
        });
        room.start();
        room.walkable[2][1] = true;
        room.walkable[2][2] = true;
        room.walkable[2][3] = true;
        room.occupants.get('a').moveTo(1, 2);
        room.occupants.get('b').moveTo(2, 2);
        room.occupants.get('c').moveTo(3, 2);
        room._killPlayer('b', 'monster');

        room.queueMove('a', 1, 0);
        const result = room.resolveTick();

        expect(room.occupants.get('b')).toBeDefined();
        expect(room.occupants.get('a')).toEqual(expect.objectContaining({ x: 2, y: 2 }));
        expect(result.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'move', id: 'a' })
        ]));
    });

    test('high-score: reaching the exit does NOT instantly win — the match keeps going', () => {
        const room = new MatchRoom({
            ruleset: { id: 'test-score', winCondition: { type: WIN.HIGH_SCORE }, entities: { monster: false }, players: { min: 1, max: 4 } },
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: SEED
        });
        room.start();
        stageSequentialExit(room);
        room.queueMove('a', 1, 0);
        const res = room.resolveTick();

        expect(room.playerStates.get('a').escaped).toBe(true);
        expect(room.status).toBe('active');   // b is still in play — no instant win
        expect(room.winnerId).toBeNull();
        expect(res.finished).toBe(false);

        room.queueMove('b', 0, -1);
        const second = room.resolveTick();
        expect(room.playerStates.get('b').escaped).toBe(true);
        expect(room.occupants.get('b')).toEqual(expect.objectContaining({ x: 2, y: 2 }));
        expect(second.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'player_exit', id: 'b' })
        ]));
    });

    test('co-op success is collective and never invents an individual winner', () => {
        const room = new MatchRoom({
            ruleset: {
                id: 'test-coop', mode: 'coop',
                winCondition: { type: WIN.ALL_ESCAPE },
                entities: { monster: false }, players: { min: 2, max: 2 }
            },
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: SEED
        });
        room.start();
        stageSequentialExit(room);
        room.queueMove('a', 1, 0);
        room.resolveTick();
        expect(room.status).toBe('active');

        room.queueMove('b', 0, -1);
        const second = room.resolveTick();
        expect(room.endReason).toBe('all_escaped');
        expect(second.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'player_exit', id: 'b' })
        ]));

        room.finalize();
        expect(room.winnerId).toBeNull();
        expect([...room.playerStates.values()].map(s => s.placement).sort()).toEqual([1, 2]);
    });

    test('race (default) still ends the moment someone escapes', () => {
        const room = new MatchRoom({ economy: 'crypto_race', entrants: { a: { userId: 1 }, b: { userId: 2 } }, seed: SEED });
        room.start();
        const exit = room.dungeon.exit;
        room.occupants.get('a').moveTo(exit[0], exit[1]);
        room.resolveTick();
        expect(room.status).toBe('finished');
        expect(room.endReason).toBe('escaped');
        room.finalize();
        expect(room.winnerId).toBe('a');
    });
});
