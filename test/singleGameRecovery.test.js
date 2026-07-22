/**
 * Single-game disconnect recovery tests (Phase 0.5).
 *
 * If a user pays for a single game and disconnects before a game starts (no games row
 * references the payment), the money was taken with nothing given. recoverPendingPayments
 * must grant the equivalent credits — exactly once (idempotent), and never for a payment
 * that was actually consumed by a game.
 */

const SessionManager = require('../src/network/sessionManager');

function makeDb({ singleGamePayments = [], gamesForPayment = new Set(), recoveredReasons = new Set(), entitlementPaymentIds = new Set() }) {
  let credits = 0;
  const handler = async (text, params = []) => {
    // credits_package recovery queries (unprocessed + orphaned) — none in these tests
    if (/FROM payments[\s\S]*credits_package/i.test(text)) return { rows: [] };
    if (/FROM payments\s+WHERE id = \$1[\s\S]*FOR UPDATE/i.test(text)) {
      const p = singleGamePayments.find(row => row.id === params[0]);
      return { rows: p ? [{ id: p.id, user_id: 7, status: 'confirmed', payment_type: 'single_game' }] : [] };
    }
    // outer "unconsumed single_game" discovery query
    if (/payment_type = 'single_game'/i.test(text)) {
      return {
        rows: singleGamePayments
          .filter(p => !gamesForPayment.has(p.id)
            && !entitlementPaymentIds.has(p.id)
            && !recoveredReasons.has(`single_game_recovered:${p.id}`))
          .map(p => ({ id: p.id, confirmed_at: p.confirmed_at }))
      };
    }
    if (/SELECT 1 FROM games WHERE payment_id/i.test(text)) return { rows: gamesForPayment.has(params[0]) ? [{}] : [] };
    if (/SELECT payment_id FROM payment_entitlement_grants/i.test(text)) {
      return { rows: entitlementPaymentIds.has(params[0]) ? [{ payment_id: params[0] }] : [] };
    }
    if (/INSERT INTO payment_entitlement_grants/i.test(text)) {
      if (entitlementPaymentIds.has(params[0])) return { rows: [], rowCount: 0 };
      entitlementPaymentIds.add(params[0]);
      return { rows: [{ payment_id: params[0] }], rowCount: 1 };
    }
    if (/FROM credit_transactions WHERE user_id = \$1 AND reason = \$2/i.test(text)) {
      return { rows: recoveredReasons.has(params[1]) ? [{}] : [] };
    }
    if (/UPDATE users SET credits = credits \+/i.test(text)) { credits += Number(params[0]); return { rows: [{ credits }] }; }
    if (/INSERT INTO credit_transactions/i.test(text)) { recoveredReasons.add(params[2]); return { rows: [] }; }
    return { rows: [] };
  };
  return {
    _getCredits: () => credits,
    query: jest.fn(handler),
    withTransaction: jest.fn(async (cb) => cb({ query: jest.fn(handler) }))
  };
}

function makeSession(db) {
  return new SessionManager({
    db,
    debugManager: { CONSOLE_LOGGING: false },
    gameModeManager: { creditsPerGameCost: 1 }
  });
}

describe('Single-game disconnect recovery', () => {
  test('grants a credit for a confirmed-but-unconsumed single_game payment', async () => {
    const db = makeDb({ singleGamePayments: [{ id: 42, confirmed_at: new Date() }] });
    const sm = makeSession(db);

    const result = await sm.recoverPendingPayments(7, 'sock-1');

    expect(result.creditsRecovered).toBe(1);
    expect(result.paymentsProcessed).toBe(1);
    expect(db._getCredits()).toBe(1);
  });

  test('does NOT grant when a game already consumed the payment', async () => {
    const db = makeDb({
      singleGamePayments: [{ id: 42, confirmed_at: new Date() }],
      gamesForPayment: new Set([42])
    });
    const sm = makeSession(db);

    const result = await sm.recoverPendingPayments(7, 'sock-1');

    expect(result.creditsRecovered).toBe(0);
    expect(db._getCredits()).toBe(0);
  });

  test('is idempotent — a second recovery does not double-credit', async () => {
    const db = makeDb({ singleGamePayments: [{ id: 42, confirmed_at: new Date() }] });
    const sm = makeSession(db);

    const first = await sm.recoverPendingPayments(7, 'sock-1');
    const second = await sm.recoverPendingPayments(7, 'sock-2');

    expect(first.creditsRecovered).toBe(1);
    expect(second.creditsRecovered).toBe(0);
    expect(db._getCredits()).toBe(1);
  });
});
