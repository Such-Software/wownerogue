/**
 * Payout snapshot tests (Phase 1.2).
 *
 * The payout terms are snapshotted onto the game at start. completeGame must pay from
 * that snapshot, so a mid-game config change can't alter an in-flight game's payout.
 */

const GameModeManager = require('../src/game/gameModeManager');

const createMockDb = () => {
  const db = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withTransaction: jest.fn()
  };
  db.withTransaction.mockImplementation(async (cb) => cb(db));
  return db;
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
        id: 1, user_id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr',
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
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr' }] }) // no snapshot cols
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, payout_address: 'wow1addr' }] })
      .mockResolvedValueOnce({ rows: [{ id: 999 }] });

    const result = await gmm.completeGame('socket1', 'game123', true, false, { moves: 10 });

    expect(result.payout.amount).toBe(200000000000); // live 2x
  });

  test('no payout for a PAID_SINGLE win when direct payouts are disabled (no-payout instance)', async () => {
    const { gmm, db } = buildGmm();
    gmm.directPayoutEnabled = false; // e.g. mainnet legitimacy: sell entry, never pay out

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr' }] }) // game record
      .mockResolvedValue({ rows: [] }); // completion UPDATE + anything else

    const result = await gmm.completeGame('socket1', 'game123', true, true, { moves: 10 });

    expect(result.success).toBe(true);
    expect(result.payout == null || result.payout === undefined).toBe(true); // no payout queued
    // No payout INSERT happened.
    const insertedPayout = db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]));
    expect(insertedPayout).toBeUndefined();
  });

  test('master payout switch prevents payout creation even when direct payouts are enabled', async () => {
    const { gmm, db } = buildGmm();
    gmm.payoutsEnabled = false;
    gmm.directPayoutEnabled = true;

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 1, game_mode: 'PAID_SINGLE', payout_address: 'wow1addr' }] })
      .mockResolvedValue({ rows: [] });

    const result = await gmm.completeGame('socket1', 'game-master-off', true, true, { moves: 10 });

    expect(result.success).toBe(true);
    expect(db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]))).toBeUndefined();
    expect(gmm._scheduleBatchPayout).not.toHaveBeenCalled();
  });

  test('a start-time eligible liability survives a mid-game master kill switch', async () => {
    const { gmm, db } = buildGmm();
    gmm.payoutsEnabled = false; // dispatch is paused after the game committed its terms
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 1,
        user_id: 1,
        status: 'active',
        game_mode: 'PAID_SINGLE',
        payout_address: 'wow1addr',
        payout_eligible: true,
        payout_terms: {
          version: 1,
          eligible: true,
          escapeAmount: '222',
          treasureAmount: '333',
          escapeMultiplier: 2,
          treasureMultiplier: 3,
          minAmount: '1',
          maxAmount: '1000'
        }
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, payout_address: 'wow1addr' }] })
      .mockResolvedValueOnce({ rows: [{ id: 901 }], rowCount: 1 });

    const result = await gmm.completeGame('socket1', 'committed-game', true, false, {});

    expect(result.payout).toEqual(expect.objectContaining({ payoutId: 901, amount: '222' }));
    expect(db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]))).toBeDefined();
  });

  test('a start-time ineligible game never gains a payout after policy is enabled', async () => {
    const { gmm, db } = buildGmm();
    gmm.payoutsEnabled = true;
    gmm.directPayoutEnabled = true;
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 2,
        user_id: 1,
        status: 'active',
        game_mode: 'PAID_SINGLE',
        payout_eligible: false,
        payout_terms: { version: 1, mode: 'PAID_SINGLE', eligible: false }
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await gmm.completeGame('socket1', 'ineligible-game', true, true, {});

    expect(result.success).toBe(true);
    expect(result.payout).toBeNull();
    expect(db.query.mock.calls.find(c => /INSERT INTO payouts/i.test(c[0]))).toBeUndefined();
  });
});
