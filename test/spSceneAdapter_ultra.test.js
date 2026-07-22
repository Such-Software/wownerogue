// The single-player render-kit migration hinges on sceneFromGameState consuming the CLIENT state
// shape — sparse {y:{x:v}} tile maps (vs the server's arrays). Guards that adapter + the RK alias.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSceneKit() {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/sceneModel.js'), 'utf8'), ctx);
  return ctx.RK;
}

const F = "'1"; // primary-floor char

describe('SP client-state → Scene adapter', () => {
  const RK = loadSceneKit();

  test('RK.sceneFromGameState is exposed directly (not only under RK.scene)', () => {
    expect(typeof RK.sceneFromGameState).toBe('function');
    expect(RK.sceneFromGameState).toBe(RK.scene.sceneFromGameState);
  });

  test('sparse {y:{x:v}} maps yield correct dims, kinds, and entities', () => {
    const state = {
      visibleTiles:  { 0: { 0: '#', 1: F, 2: '>' }, 1: { 0: F, 1: F, 2: '#' } },
      exploredTiles: { 0: { 0: '#', 1: F, 2: '>' }, 1: { 0: F, 1: F, 2: '#' } },
      player: { x: 1, y: 1, facing: 'down' }, monster: { x: 0, y: 0 },
      exit: [2, 0], treasure: [1, 1], items: {}, lighting: {}
    };
    const scene = RK.sceneFromGameState(state, { cryptoType: 'WOW' });

    expect(scene.cols).toBe(3);
    expect(scene.rows).toBe(2);
    expect(scene.isDungeon).toBe(true);
    expect(scene.grid[0]).toEqual(['wall', 'floor', 'exit']);
    expect(scene.grid[1]).toEqual(['floor', 'floor', 'wall']);

    const kinds = scene.entities.map(e => e.kind);
    expect(kinds).toContain('player');
    expect(kinds).toContain('monster');
    expect(kinds).toContain('feature'); // exit + treasure
    const player = scene.entities.find(e => e.kind === 'player');
    expect(player).toMatchObject({ x: 1, y: 1 });
  });

  test('unexplored cells render as dark, not floor', () => {
    const state = {
      visibleTiles:  { 0: { 0: F } },          // only (0,0) seen
      exploredTiles: { 0: { 0: F } },
      player: { x: 0, y: 0 }, items: {}, lighting: {}
    };
    const scene = RK.sceneFromGameState(state, {});
    expect(scene.grid[0][0]).toBe('floor');
  });

  test('multiplayer players[] become racers and an explicit socket id owns the camera', () => {
    const state = {
      visibleTiles: [[F, F, F], [F, F, F]],
      exploredTiles: [[F, F, F], [F, F, F]],
      players: [
        { id: 'rival', x: 0, y: 0, name: 'Rival', alive: true },
        { id: 'mine', x: 2, y: 1, name: 'Me', avatar: 'char-ranger', alive: true, placement: 2 }
      ],
      entrance: [0, 0], exit: [2, 1], monster: null, lighting: {}
    };

    // String second args were used by the original match client; keep them backward compatible.
    const scene = RK.sceneFromGameState(state, 'mine');
    const racers = scene.entities.filter(e => e.kind === 'player');
    expect(racers).toHaveLength(2);
    expect(racers.find(e => e.id === 'mine')).toMatchObject({
      x: 2, y: 1, label: 'Me', avatar: 'char-ranger', you: true, cameraTarget: true, placement: 2
    });
    expect(racers.find(e => e.id === 'rival')).toMatchObject({ you: false, cameraTarget: false });
  });

  test('server you flag is honored and spectator camera falls back to a live racer', () => {
    const base = {
      visibleTiles: [[F, F, F]], exploredTiles: [[F, F, F]],
      entrance: [0, 0], exit: [2, 0], monster: null, lighting: {}
    };
    const marked = RK.sceneFromGameState({
      ...base,
      players: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0, you: true }]
    }, {});
    expect(marked.entities.find(e => e.id === 'b')).toMatchObject({ you: true, cameraTarget: true });

    const spectator = RK.sceneFromGameState({
      ...base,
      players: [
        { id: 'dead', x: 0, y: 0, alive: false },
        { id: 'live', x: 1, y: 0, alive: true },
        { id: 'done', x: 2, y: 0, alive: true, finished: true }
      ]
    }, { viewerId: 'spectator' });
    expect(spectator.entities.find(e => e.cameraTarget).id).toBe('live');
    expect(spectator.entities.some(e => e.you)).toBe(false);
  });

  test('match treasure object shape renders until it has a carrier', () => {
    const base = {
      visibleTiles: [[F, F]], exploredTiles: [[F, F]],
      players: [{ id: 'a', x: 0, y: 0 }], monster: null, lighting: {}
    };
    const loose = RK.sceneFromGameState({ ...base, treasure: { x: 1, y: 0, carrierId: null } }, {});
    expect(loose.entities.some(e => e.id === 'treasure')).toBe(true);
    const carried = RK.sceneFromGameState({ ...base, treasure: { x: 1, y: 0, carrierId: 'a' } }, {});
    expect(carried.entities.some(e => e.id === 'treasure')).toBe(false);
  });
});
