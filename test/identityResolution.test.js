/**
 * Identity resolution tests (Phase 2.1).
 *
 * getOrCreateUser must resolve through the stable anon_token identity (via SessionManager)
 * rather than the mutable, non-unique socket_id — and must NOT create a duplicate "orphan"
 * user row when a session already exists.
 */

const GameModeManager = require('../src/game/gameModeManager');

const createMockPaymentConfig = () => ({
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
  const calls = { byId: 0, bySocketSelect: 0, insert: 0 };
  const db = {
    query: jest.fn(async (text, params = []) => {
      if (/SELECT \* FROM users WHERE id = \$1/i.test(text)) { calls.byId++; return { rows: [{ id: params[0], credits: 5, socket_id: 'sockNEW' }] }; }
      if (/UPDATE users SET last_active/i.test(text)) return { rows: [] };
      if (/SELECT \* FROM users WHERE socket_id = \$1/i.test(text)) { calls.bySocketSelect++; return { rows: [] }; }
      if (/INSERT INTO users/i.test(text)) { calls.insert++; return { rows: [{ id: 99, socket_id: params[0] }] }; }
      return { rows: [] };
    })
  };
  const gmm = new GameModeManager(db, { processPayout: jest.fn() }, { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 }, createMockPaymentConfig());
  return { gmm, db, calls };
}

describe('getOrCreateUser identity resolution', () => {
  test('resolves through the session stable id and does not create a duplicate', async () => {
    const { gmm, calls } = buildGmm();
    // Session resolves the socket to stable user id 1 (cache populated at connect).
    gmm.sessionManager = { getBySocket: jest.fn().mockResolvedValue({ id: 1 }) };

    const user = await gmm.getOrCreateUser('sockNEW');

    expect(user.id).toBe(1);
    expect(gmm.sessionManager.getBySocket).toHaveBeenCalledWith('sockNEW');
    expect(calls.byId).toBe(1);          // resolved by stable id
    expect(calls.insert).toBe(0);        // NO duplicate orphan row created
    expect(calls.bySocketSelect).toBe(0); // did not fall back to socket_id lookup
  });

  test('falls back to socket_id lookup when no session manager is wired', async () => {
    const { gmm, calls } = buildGmm();
    // No gmm.sessionManager (legacy path).
    const user = await gmm.getOrCreateUser('sockLEGACY');

    expect(calls.bySocketSelect).toBe(1); // used socket_id lookup
    // socket_id lookup returned no rows in this mock -> created as last resort
    expect(calls.insert).toBe(1);
    expect(user.id).toBe(99);
  });
});
