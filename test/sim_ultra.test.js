// Guards the balance-sim harness: it must keep driving the REAL engine to terminal outcomes and
// producing well-formed, in-range statistics. Not a balance assertion (those numbers are meant to
// move) — a structural regression guard so the instrument can't silently rot.
const { runOneGame, simulatePreset } = require('../src/sim/simulate');
const { BOTS } = require('../src/sim/simBots');
const { bfsField, stepDownField } = require('../src/sim/pathfind');

describe('balance sim harness', () => {
  test('BFS field + downhill step navigate a trivial grid', () => {
    const passable = () => true;
    const dist = bfsField(3, 3, passable, [[2, 2]]);
    expect(dist[2][2]).toBe(0);
    expect(dist[0][0]).toBe(4); // Manhattan distance, 4-connected
    const step = stepDownField(dist, 0, 0, 3, 3);
    expect(step).toEqual(expect.objectContaining({ dx: expect.any(Number), dy: expect.any(Number) }));
    // Step must reduce distance to the target.
    expect(dist[0 + step.dy][0 + step.dx]).toBeLessThan(dist[0][0]);
  });

  test('every bot policy drives a game to a real terminal outcome', () => {
    for (const id of Object.keys(BOTS)) {
      const r = runOneGame(BOTS[id], { vision: 8, moveCap: 6000 });
      expect(['escaped', 'caught', 'stuck']).toContain(r.outcome);
      expect(r.moves).toBeGreaterThanOrEqual(0);
      expect(typeof r.treasure).toBe('boolean');
    }
  });

  test('simulatePreset returns in-range rates and per-network house-win', () => {
    const args = { runs: 15, bot: 'explorer-greedy', nets: ['WOW', 'BTC', 'GRIN'], cadence: 320, moveCap: 6000 };
    const r = simulatePreset('normal', args);
    expect(r.n).toBe(15);
    for (const k of ['escapeRate', 'treasureRate', 'caughtRate', 'stuckRate']) {
      expect(r[k]).toBeGreaterThanOrEqual(0);
      expect(r[k]).toBeLessThanOrEqual(1);
    }
    // Outcomes partition the runs.
    expect(r.escapeRate + r.caughtRate + r.stuckRate).toBeCloseTo(1, 5);
    for (const net of args.nets) {
      expect(r.houseWin[net]).toBeGreaterThanOrEqual(0);
      expect(r.houseWin[net]).toBeLessThanOrEqual(1);
    }
    // Slower blocks (BTC 10min) give players more time → house wins no MORE than on fast GRIN.
    expect(r.houseWin.BTC).toBeLessThanOrEqual(r.houseWin.GRIN + 1e-9);
  });
});
