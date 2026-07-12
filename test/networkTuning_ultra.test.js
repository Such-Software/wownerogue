// Guards the per-network difficulty tuning: cryptoType must set LEVELS (multi-level depth ∝ block
// time), size + monster must stay at the fair preset, block-time ordering must hold, and operator
// env overrides must still win.
const {
  DIFFICULTY_PRESETS, NETWORK_TUNING, applyNetworkTuning, getDifficultyConfig
} = require('../src/game/difficultyConfig');

const casino = () => ({ ...DIFFICULTY_PRESETS.casino, presetName: 'casino' });
const normal = () => ({ ...DIFFICULTY_PRESETS.normal, presetName: 'normal' });

// Isolate env mutations per test.
const SAVE = {};
const KEYS = ['NETWORK_TUNING_DISABLED', 'DUNGEON_WIDTH', 'DUNGEON_LEVELS', 'MONSTER_SPEED', 'DIFFICULTY_PRESET', 'CRYPTO_TYPE', 'PAYMENTS_ENABLED', 'GAME_MODE'];
beforeEach(() => { KEYS.forEach(k => { SAVE[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { KEYS.forEach(k => { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; }); });

describe('per-network difficulty tuning (multi-level)', () => {
  test('tuning sets LEVELS ∝ block time, leaving size + monster at the preset', () => {
    const w = applyNetworkTuning(casino(), 'WOW');
    expect(w.levels).toBe(NETWORK_TUNING.WOW.levels);
    // Size and monster are untouched — depth is the pacing lever, not size/monster-speed.
    expect(w.dungeon.width).toBe(DIFFICULTY_PRESETS.casino.dungeon.width);
    expect(w.monster.movesPerPlayerMove).toBe(DIFFICULTY_PRESETS.casino.monster.movesPerPlayerMove);
  });

  test('levels are non-decreasing with block time, BTC the deepest', () => {
    const lv = (n) => applyNetworkTuning(casino(), n).levels;
    expect(lv('GRIN')).toBeLessThanOrEqual(lv('XMR'));
    expect(lv('XMR')).toBeLessThanOrEqual(lv('LTC'));
    expect(lv('LTC')).toBeLessThanOrEqual(lv('WOW'));
    expect(lv('WOW')).toBeLessThan(lv('BTC'));
    expect(lv('GRIN')).toBe(1);          // fast chain = single level
    expect(lv('BTC')).toBeGreaterThan(1); // slow chain descends
  });

  test('applies to every preset (levels is preset-agnostic pacing)', () => {
    expect(applyNetworkTuning(normal(), 'WOW').levels).toBe(NETWORK_TUNING.WOW.levels);
  });

  test('getDifficultyConfig surfaces levels; defaults to 1 for an unknown/untuned network', () => {
    process.env.DIFFICULTY_PRESET = 'casino';
    expect(getDifficultyConfig('BTC').levels).toBe(NETWORK_TUNING.BTC.levels);
    expect(getDifficultyConfig('DOGE').levels).toBe(1);
  });

  test('operator env overrides win: DUNGEON_LEVELS + DUNGEON_WIDTH beat the tuning', () => {
    process.env.DIFFICULTY_PRESET = 'casino';
    process.env.DUNGEON_LEVELS = '3';
    process.env.DUNGEON_WIDTH = '99';
    const cfg = getDifficultyConfig('BTC');
    expect(cfg.levels).toBe(3);          // env beats BTC's 8
    expect(cfg.dungeon.width).toBe(99);
  });

  test('NETWORK_TUNING_DISABLED=true → no levels tuning (single level)', () => {
    process.env.NETWORK_TUNING_DISABLED = 'true';
    process.env.DIFFICULTY_PRESET = 'casino';
    expect(getDifficultyConfig('BTC').levels).toBe(1);
  });
});
