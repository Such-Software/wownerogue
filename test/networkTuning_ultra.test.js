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
  test('XMR is the reference (sizeScale 1.0) — casino dims unchanged; WOW (5-min) scales up', () => {
    const xmr = applyNetworkTuning(casino(), 'XMR');
    expect(xmr.dungeon.width).toBe(DIFFICULTY_PRESETS.casino.dungeon.width);
    expect(xmr.dungeon.height).toBe(DIFFICULTY_PRESETS.casino.dungeon.height);
    // WOW is a slow chain now (5 min) → bigger map than XMR.
    expect(applyNetworkTuning(casino(), 'WOW').dungeon.width).toBeGreaterThan(xmr.dungeon.width);
  });

  test('dungeon size scales with block time: GRIN < XMR < WOW', () => {
    const g = applyNetworkTuning(casino(), 'GRIN').dungeon.width;
    const x = applyNetworkTuning(casino(), 'XMR').dungeon.width;
    const w = applyNetworkTuning(casino(), 'WOW').dungeon.width;
    expect(g).toBeLessThan(x);
    expect(x).toBeLessThan(w);
  });

  test('tuning scales SIZE only — the monster stays at its fair preset speed', () => {
    // No cheating-fast monster: every preset keeps its own movesPerPlayerMove.
    expect(applyNetworkTuning(casino(), 'BTC').monster.movesPerPlayerMove)
      .toBe(DIFFICULTY_PRESETS.casino.monster.movesPerPlayerMove);
    expect(applyNetworkTuning(normal(), 'BTC').monster.movesPerPlayerMove)
      .toBe(DIFFICULTY_PRESETS.normal.monster.movesPerPlayerMove);
    // ...but both get the pacing size scale.
    expect(applyNetworkTuning(normal(), 'BTC').dungeon.width).toBeGreaterThan(DIFFICULTY_PRESETS.normal.dungeon.width);
    expect(NETWORK_TUNING.BTC.monsterSpeed).toBeUndefined();
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
