/**
 * Free-play entry tests (Feature 1).
 *
 * When a player explicitly chooses free play (even on an instance that also sells
 * credits/entry), the game must be recorded as game_mode='FREE' (so it lands on the Pleb
 * leaderboard, not the Hall of Champions) with no payment and no payout.
 */

const GameModeManager = require('../src/game/gameModeManager');

const createMockDb = () => {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withTransaction: jest.fn().mockImplementation(async (cb) => cb(client)),
    _client: client
  };
};

const cfg = () => ({
  getConfig: () => ({
    paymentsEnabled: true,
    currency: { symbol: 'WOW', decimals: 11 },
    modes: {
      direct: { enabled: true, price: 100000000000n },
      credits: { enabled: true, creditsPerGame: 1, packages: [{ id: 'small', credits: 10, price: '500000000000', bonus: 0 }] }
    },
    payouts: { rules: { direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 } }, credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 }, baseValue: 50000000000n } } },
    preferences: { preferCreditsFirst: true },
    earlyEntry: { enabled: false }
  }),
  getLegacyGameMode: () => 'PAID_SINGLE',
  eventBus: { on: () => {} }
});

function buildGmm() {
  const db = createMockDb();
  const gmm = new GameModeManager(db, { processPayout: jest.fn() }, { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 }, cfg());
  // Resolve identity straight to a stable user row.
  gmm.sessionManager = { getBySocket: jest.fn().mockResolvedValue({ id: 1 }) };
  db.query.mockImplementation(async (text) => {
    if (/SELECT \* FROM users WHERE id = \$1/i.test(text)) return { rows: [{ id: 1, credits: 0 }] };
    return { rows: [] };
  });
  return { gmm, db };
}

describe('free-play game start (forceFree)', () => {
  test('records game_mode=FREE and counts the game, no payment', async () => {
    const { gmm, db } = buildGmm();

    const res = await gmm.processGameStart('sock1', 'seed-123', { forceFree: true });

    expect(res.success).toBe(true);
    expect(res.effectiveMode).toBe('FREE');
    const calls = db._client.query.mock.calls.map(c => c[0]);
    expect(calls.find(s => /UPDATE games SET game_mode = 'FREE'/i.test(s))).toBeDefined();
    expect(calls.find(s => /UPDATE users SET total_games_played/i.test(s))).toBeDefined();
  });

  test('offers a play_free option when free play is enabled alongside payments', async () => {
    const { gmm } = buildGmm();
    gmm.freePlayEnabled = true;
    const opts = await gmm.getPaymentOptionsForUser('sock1');
    expect(opts.options.some(o => o.type === 'play_free' && o.mode === 'FREE')).toBe(true);
  });

  test('does NOT offer free play when disabled', async () => {
    const { gmm } = buildGmm();
    gmm.freePlayEnabled = false;
    const opts = await gmm.getPaymentOptionsForUser('sock1');
    expect(opts.options.some(o => o.type === 'play_free')).toBe(false);
  });
});
