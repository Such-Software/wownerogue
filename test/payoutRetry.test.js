/**
 * Payout retry service tests (Phase 1.4).
 *
 * Guards two previously-broken behaviours:
 *  - the "already on-chain" path counts user stats exactly once (the old NOT EXISTS guard
 *    checked the same row it had just marked completed, so it never counted), and
 *  - a successful retry stores tx_hash + marks completed + counts stats in ONE transaction
 *    (no non-atomic tx_hash write that could strand a tx_hash on a non-completed row).
 */

const PayoutRetryService = require('../src/payments/payoutRetryService');

function makeHarness() {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const db = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withTransaction: jest.fn().mockImplementation(async (cb) => cb(client))
  };
  return { client, db };
}

function svcWith(db, wallet) {
  return new PayoutRetryService({
    db, walletService: wallet, debugManager: { CONSOLE_LOGGING: false }, maxRetries: 3
  });
}

const findCall = (mockFn, re) => mockFn.mock.calls.find(c => re.test(c[0]));

describe('PayoutRetryService.retryPayout', () => {
  test('already-on-chain: marks completed and counts stats exactly once', async () => {
    const { client, db } = makeHarness();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // payouts transition (did transition)
      .mockResolvedValue({ rows: [] });             // users stat update
    const wallet = {
      checkTransactionStatus: jest.fn().mockResolvedValue({ exists: true, confirmations: 3 }),
      processPayout: jest.fn()
    };

    await svcWith(db, wallet).retryPayout({ id: 5, user_id: 1, amount: '100', tx_hash: 'tx5', status: 'failed', retry_count: 0 });

    // Transition guarded by `status <> 'completed'` (so it counts once).
    expect(findCall(client.query, /UPDATE payouts[\s\S]*status <> 'completed'/i)).toBeDefined();
    // Stats were counted.
    expect(findCall(client.query, /UPDATE users[\s\S]*total_amount_won/i)).toBeDefined();
    // Did NOT re-send funds (already on chain).
    expect(wallet.processPayout).not.toHaveBeenCalled();
  });

  test('already-on-chain but already completed: does NOT double-count stats', async () => {
    const { client, db } = makeHarness();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // payouts transition affected 0 rows (already completed)
      .mockResolvedValue({ rows: [] });
    const wallet = {
      checkTransactionStatus: jest.fn().mockResolvedValue({ exists: true, confirmations: 9 }),
      processPayout: jest.fn()
    };

    await svcWith(db, wallet).retryPayout({ id: 5, user_id: 1, amount: '100', tx_hash: 'tx5', status: 'failed', retry_count: 0 });

    expect(findCall(client.query, /UPDATE users[\s\S]*total_amount_won/i)).toBeUndefined();
  });

  test('successful retry: stores tx_hash, completes, counts stats in one transaction', async () => {
    const { client, db } = makeHarness();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // completion transition
      .mockResolvedValue({ rows: [] });
    const wallet = {
      checkTransactionStatus: jest.fn(),
      processPayout: jest.fn().mockResolvedValue({ success: true, txHash: 'txNEW', fee: 10 })
    };

    await svcWith(db, wallet).retryPayout({ id: 7, user_id: 1, amount: '100', payout_address: 'wow1addr', status: 'failed', retry_count: 0 });

    // tx_hash + completion happen in the SAME statement (atomic).
    const completion = findCall(client.query, /UPDATE payouts[\s\S]*tx_hash[\s\S]*status = 'completed'/i);
    expect(completion).toBeDefined();
    expect(completion[1]).toContain('txNEW');
    // No standalone pre-transaction tx_hash write on db.query.
    expect(findCall(db.query, /UPDATE payouts SET tx_hash = \$1, fee = \$2 WHERE id/i)).toBeUndefined();
    // Stats counted once.
    expect(findCall(client.query, /UPDATE users[\s\S]*total_amount_won/i)).toBeDefined();
  });
});
