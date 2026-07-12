// Guards the per-network difficulty tuning: cryptoType must shape size (all presets) and monster
// (casino only), block-time ordering must hold, and operator env overrides must still win.
const {
  DIFFICULTY_PRESETS, NETWORK_TUNING, applyNetworkTuning, getDifficultyConfig
} = require('../src/game/difficultyConfig');

const casino = () => ({ ...DIFFICULTY_PRESETS.casino, presetName: 'casino' });
const normal = () => ({ ...DIFFICULTY_PRESETS.normal, presetName: 'normal' });

// Isolate env mutations per test.
const SAVE = {};
const KEYS = ['NETWORK_TUNING_DISABLED', 'DUNGEON_WIDTH', 'MONSTER_SPEED', 'DIFFICULTY_PRESET', 'CRYPTO_TYPE', 'PAYMENTS_ENABLED', 'GAME_MODE'];
beforeEach(() => { KEYS.forEach(k => { SAVE[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { KEYS.forEach(k => { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; }); });

describe('per-network difficulty tuning', () => {
  test('WOW is the reference (sizeScale 1.0) — casino dims unchanged', () => {
    const t = applyNetworkTuning(casino(), 'WOW');
    expect(t.dungeon.width).toBe(DIFFICULTY_PRESETS.casino.dungeon.width);
    expect(t.dungeon.height).toBe(DIFFICULTY_PRESETS.casino.dungeon.height);
  });

  test('dungeon size scales with block time: GRIN < WOW < BTC', () => {
    const g = applyNetworkTuning(casino(), 'GRIN').dungeon.width;
    const w = applyNetworkTuning(casino(), 'WOW').dungeon.width;
    const b = applyNetworkTuning(casino(), 'BTC').dungeon.width;
    expect(g).toBeLessThan(w);
    expect(w).toBeLessThan(b);
  });

  test('monster speed is tuned for casino but NOT for other presets', () => {
    expect(applyNetworkTuning(casino(), 'BTC').monster.movesPerPlayerMove).toBe(NETWORK_TUNING.BTC.monsterSpeed);
    // normal keeps its own monster speed (tuning was calibrated for casino only)
    expect(applyNetworkTuning(normal(), 'BTC').monster.movesPerPlayerMove)
      .toBe(DIFFICULTY_PRESETS.normal.monster.movesPerPlayerMove);
    // ...but normal STILL gets the pacing size scale
    expect(applyNetworkTuning(normal(), 'BTC').dungeon.width).toBeGreaterThan(DIFFICULTY_PRESETS.normal.dungeon.width);
  });

  test('unknown network is left untouched', () => {
    const t = applyNetworkTuning(casino(), 'DOGE');
    expect(t.dungeon.width).toBe(DIFFICULTY_PRESETS.casino.dungeon.width);
  });

  test('operator env overrides win over tuning', () => {
    process.env.DIFFICULTY_PRESET = 'casino';
    process.env.DUNGEON_WIDTH = '99';
    process.env.MONSTER_SPEED = '1.0';
    const cfg = getDifficultyConfig('BTC');
    expect(cfg.dungeon.width).toBe(99);              // env beats the 1.6× scale
    expect(cfg.monster.movesPerPlayerMove).toBe(1.0); // env beats the 2.2 tuned speed
  });

  test('NETWORK_TUNING_DISABLED=true reverts to the raw preset', () => {
    process.env.NETWORK_TUNING_DISABLED = 'true';
    process.env.DIFFICULTY_PRESET = 'casino';
    const cfg = getDifficultyConfig('BTC');
    expect(cfg.dungeon.width).toBe(DIFFICULTY_PRESETS.casino.dungeon.width);
    expect(cfg.monster.movesPerPlayerMove).toBe(DIFFICULTY_PRESETS.casino.monster.movesPerPlayerMove);
  });
});
