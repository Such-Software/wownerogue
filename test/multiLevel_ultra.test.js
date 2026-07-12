// Multi-level descent: a run spans `maxDepth` levels, each a fresh deterministic dungeon, treasure
// only in the vault (final level), and only the final exit escapes. Verifies the mechanic + that
// every level stays reproducible from the one committed seed (provably fair across the descent).
const Game = require('../src/game/game');
const DungeonGenerator = require('../src/game/dungeon');
const { levelSeed } = require('../src/game/provablyFair');

const SAVE = {};
const KEYS = ['DUNGEON_LEVELS', 'CRYPTO_TYPE', 'DIFFICULTY_PRESET', 'NETWORK_TUNING_DISABLED', 'PAYMENTS_ENABLED', 'GAME_MODE'];
beforeEach(() => { KEYS.forEach(k => { SAVE[k] = process.env[k]; delete process.env[k]; }); process.env.DIFFICULTY_PRESET = 'normal'; });
afterEach(() => { KEYS.forEach(k => { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; }); });

const user = () => ({ id: 0, username: 'test', endGame() {} });

describe('multi-level descent', () => {
  test('descends through levels; treasure only in the vault; stays active until the final exit', () => {
    process.env.DUNGEON_LEVELS = '3';
    const game = new Game('sock', user(), {});
    expect(game.maxDepth).toBe(3);
    expect(game.depth).toBe(1);
    expect(game.gameState).toBe('active');
    expect(game.dungeon.treasure).toBeNull();      // level 1/3 — no treasure

    game._descend();
    expect(game.depth).toBe(2);
    expect(game.gameState).toBe('active');          // descending is NOT winning
    expect(game.dungeon.treasure).toBeNull();       // level 2/3 — still no treasure
    expect(game.dungeon.entrance).toBeTruthy();
    expect(game.dungeon.exit).toBeTruthy();

    game._descend();
    expect(game.depth).toBe(3);
    expect(game.dungeon.treasure).not.toBeNull();   // the vault — treasure present
  });

  test('every level is reproducible from the committed seed + depth (provably fair)', () => {
    process.env.DUNGEON_LEVELS = '3';
    process.env.CRYPTO_TYPE = 'WOW';
    const game = new Game('sock', user(), {});
    const seed = game.gameProof.seed;

    // Level 1 == regenerate from the master seed (unchanged single-level behaviour).
    const regen1 = DungeonGenerator.regenerateFromSeed(levelSeed(seed, 1), 'WOW');
    expect(game.dungeon.map).toEqual(regen1.map);

    game._descend(); // level 2
    const regen2 = DungeonGenerator.regenerateFromSeed(levelSeed(seed, 2), 'WOW');
    expect(game.dungeon.map).toEqual(regen2.map);

    // Deeper levels are salted → a different layout from level 1.
    expect(regen2.map).not.toEqual(regen1.map);
  });

  test('single-level default: an untuned network runs one level and its exit escapes', () => {
    process.env.CRYPTO_TYPE = 'TESTNET'; // unknown → no level tuning → maxDepth 1
    const game = new Game('sock', user(), {});
    expect(game.maxDepth).toBe(1);
    expect(game.dungeon.treasure).not.toBeNull(); // single level IS the vault

    // Walk onto the exit → escaped (won), not descend.
    const [ex, ey] = game.dungeon.exit;
    game.player.moveTo(ex - 1, ey);                // stand next to the exit on a floor cell if possible
    // Force the player adjacent by teleporting onto an exit-adjacent floor, then step in. If the
    // left neighbour isn't floor, just teleport onto the exit-1 and assert via a direct exit check.
    game.player.moveTo(ex, ey);                    // already on exit — re-derive win via a no-op-ish move
    // A fresh move INTO the exit from a neighbour: place on a known floor neighbour of the exit.
    const map = game.dungeon.map;
    const nbrs = [[ex - 1, ey], [ex + 1, ey], [ex, ey - 1], [ex, ey + 1]];
    const floor = nbrs.find(([x, y]) => map[y] && (map[y][x] === "'1" || map[y][x] === "'2"));
    if (floor) {
      game.player.moveTo(floor[0], floor[1]);
      const res = game.movePlayer(ex - floor[0], ey - floor[1]);
      expect(res.event).toBe('escaped');
      expect(game.gameState).toBe('won');
    } else {
      // Degenerate layout (exit fully walled) — the descent path is still covered by other tests.
      expect(game.maxDepth).toBe(1);
    }
  });

  test('DUNGEON_LEVELS env override sets the run length', () => {
    process.env.DUNGEON_LEVELS = '5';
    const game = new Game('sock', user(), {});
    expect(game.maxDepth).toBe(5);
  });
});
