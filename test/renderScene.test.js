const scene = require('../html/js/render/sceneModel');

describe('sceneFromTavern (render kit adapter)', () => {
    test('maps layout chars to tile kinds and occupants to entities', () => {
        const appearance = {
            avatar: 'char-ranger',
            tint: 'teal',
            equipment: { body: 'mail', head: 'hood', shield: 'round', weapon: 'bow' }
        };
        const state = {
            cols: 3, rows: 2,
            layout: ['#=@', 'T..'],
            occupants: [{ id: 'a', x: 2, y: 0, avatar: 'green', appearance, facing: 'left', name: 'Al' }]
        };
        const s = scene.sceneFromTavern(state, 'a');
        expect(s.cols).toBe(3);
        expect(s.rows).toBe(2);
        expect(s.grid[0]).toEqual(['wall', 'bar', 'floor']);   // '@' is walkable floor
        expect(s.grid[1]).toEqual(['table', 'floor', 'floor']);
        expect(s.entities).toHaveLength(1);
        expect(s.entities[0]).toMatchObject({ id: 'a', x: 2, y: 0, kind: 'avatar', avatar: 'char-ranger', appearance, facing: 'left', label: 'Al', you: true });
        expect(s.entities[0].color).toBe(scene.AVATAR_COLORS.default);
    });

    test('you-flag is false for other occupants and unknown avatars fall back to default', () => {
        const s = scene.sceneFromTavern(
            { cols: 1, rows: 1, layout: ['.'], occupants: [{ id: 'b', x: 0, y: 0, avatar: 'zzz' }] },
            'a'
        );
        expect(s.entities[0].you).toBe(false);
        expect(s.entities[0].color).toBe(scene.AVATAR_COLORS.default);
    });

    test('unknown / out-of-legend characters are treated as walls (solid)', () => {
        const s = scene.sceneFromTavern({ cols: 2, rows: 1, layout: ['?~'], occupants: [] });
        expect(s.grid[0]).toEqual(['wall', 'wall']);
    });

    test('uses walkability when a designed room has no ASCII layout', () => {
        const s = scene.sceneFromTavern({
            cols: 3,
            rows: 2,
            layout: null,
            walkable: [
                [true, false, true],
                [false, true, true]
            ],
            occupants: []
        });
        expect(s.grid).toEqual([
            ['floor', 'wall', 'floor'],
            ['wall', 'floor', 'floor']
        ]);
    });
});

describe('sceneFromGameState (dungeon adapter)', () => {
  const api = require('../html/js/render/sceneModel.js');

  test('converts visible tiles, entities, and lighting into a dungeon Scene', () => {
    const scene = api.sceneFromGameState({
      visibleTiles: [['#', "'1", '>'], ["'1", "'1", "'1"]],
      exploredTiles: [['#', "'1", '>'], ["'1", "'1", "'1"]],
      lighting: [[0, 0.5, 0], [0, 0, 0]],
      entrance: [0, 1],
      exit: [2, 0],
      treasure: null,
      player: { x: 1, y: 1, facing: 'down' },
      monster: { x: 2, y: 1 },
      items: {},
      isSpectating: true
    });

    expect(scene.isDungeon).toBe(true);
    expect(scene.cols).toBe(3);
    expect(scene.rows).toBe(2);
    expect(scene.grid[0]).toEqual(['wall', 'floor', 'exit']);
    expect(scene.grid[1]).toEqual(['floor', 'floor', 'floor']);
    expect(scene.lightGrid[0][1]).toBeCloseTo(0.5, 1);
    // Entities: entrance, exit, monster, player (no treasure)
    const kinds = scene.entities.map(e => e.kind);
    expect(kinds).toContain('feature');
    expect(kinds).toContain('monster');
    expect(kinds).toContain('player');
    // Player entity should be marked as not-you for spectators
    const player = scene.entities.find(e => e.kind === 'player');
    expect(player.you).toBe(false);
  });

  test('treasure entity appears when treasure position is set', () => {
    const scene = api.sceneFromGameState({
      visibleTiles: [["'1", '$']],
      entrance: [0, 0],
      exit: [1, 0],
      treasure: [1, 0],
      player: { x: 0, y: 0 },
      monster: null,
      items: {},
      isSpectating: false
    });
    const treasure = scene.entities.find(e => e.id === 'treasure');
    expect(treasure).toBeTruthy();
    expect(treasure.char).toContain('$');
  });

  test('unexplored tiles become dark', () => {
    const scene = api.sceneFromGameState({
      visibleTiles: [["'1", undefined]],
      exploredTiles: [["'1", undefined]],
      lighting: [[0, 0]],
      player: { x: 0, y: 0 },
      monster: null,
      items: {},
      isSpectating: true
    });
    expect(scene.grid[0][1]).toBe('dark');
    expect(scene.lightGrid[0][1]).toBe(0);
  });
});
