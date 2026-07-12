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
});
