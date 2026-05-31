/**
 * Payout snapshot tests (Phase 1.2).
 *
 * The payout terms are snapshotted onto the game at start. completeGame must pay from
 * that snapshot, so a mid-game config change can't alter an in-flight game's payout.
 */

const GameModeManager = require('../src/game/gameModeManager');

const createMockDb = () => {
  const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withTransaction: jest.fn().mockImplementation(async (cb) => cb(mockClient)),
    _mockClient: mockClient
  };
};

const createMockPaymentConfig = () => ({
  getConfig: () => ({
    paymentsEnabled: true,
    currency: { symbol: 'WOW', decimals: 11 },
    modes: {
      direct: { enabled: true, price: 100000000000n },
      credits: { enabled: true, creditsPerGame: 1, packages: [{ id: 'small', credits: 10, price: '500000000000', bonus: 0 }] }
    },
    payouts: {
      rules: {
        direct: { enabled: true, multipliers: { escape: 2, escapeWithTreasure: 3 } },
        credits: { enabled: false, multipliers: { escape: 1.5, escapeWithTreasure: 2 }, baseValue: 50000000000n }
      }
    },
    preferences: { preferCreditsFirst: true },
    earlyEntry: { enabled: false }
  }),
  getLegacyGameMode: () => 'PAID_SINGLE',
  eventBus: { on: () => {} }
});

function buildGmm() {
  const db = createMockDb();
  const gmm = new GameModeManager(
    db,
    { processPayout: jest.fn(), processBatchPayout: jest.fn() },
    { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 },
    createMockPaymentConfig()
  );
  gmm._scheduleBatchPayout = jest.fn(); // don't actually schedule
  return { gmm, db };
}

describe('Payout uses the snapshot recorded at game start', () => {
  test('pays the snapshot amount, not the live-config amount', async () => {
    const { gmm, db } = buildGmm();

    // Snapshot recorded at start: escape pays 123456 atomic (deliberately unlike the
    // live 2x = 200000000000), treasure pays 999999.
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr',
        payout_escape_amount: '123456', payout_treasure_amount: '999999',
        payout_escape_mult: '2.000', payout_treasure_mult: '3.000'
      }] })                                   // game record lookup
      .mockResolvedValueOnce({ rows: [] })     // game completion UPDATE
      .mockResolvedValueOnce({ rows: [] })     // existing-payout check
      .mockResolvedValueOnce({ rows: [{ id: 1, payout_address: 'wow1addr' }] }) // user lookup
      .mockResolvedValueOnce({ rows: [{ id: 999 }] }); // INSERT payout

    // Even if live config is mutated after start, the snapshot must win.
    gmm.directPayoutMultipliers = { escape: 9, escapeWithTreasure: 9 };

    const result = await gmm.completeGame('socket1', 'game123', true, false, { moves: 10 });

    expect(result.payout).toBeDefined();
    expect(result.payout.amount).toBe('123456');
  });

  test('falls back to live calculation for legacy games without a snapshot', async () => {
    const { gmm, db } = buildGmm();

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr' }] }) // no snapshot cols
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, payout_address: 'wow1addr' }] })
      .mockResolvedValueOnce({ rows: [{ id: 999 }] });

    const result = await gmm.completeGame('socket1', 'game123', true, false, { moves: 10 });

    expect(result.payout.amount).toBe(200000000000); // live 2x
  });
});
