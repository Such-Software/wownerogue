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
      processPayout: jest.fn().mockResolvedValue({ success: true, txHash: 'd'.repeat(64), fee: 10 })
    };

    await svcWith(db, wallet).retryPayout({
      id: 7,
      user_id: 1,
      amount: '100',
      payout_address: 'wow1addr',
      status: 'processing',
      retry_count: 0,
      last_error: 'not enough unlocked money to transfer'
    });

    // tx_hash + completion happen in the SAME statement (atomic).
    const completion = findCall(client.query, /UPDATE payouts[\s\S]*tx_hash[\s\S]*status = 'completed'/i);
    expect(completion).toBeDefined();
    expect(completion[1]).toContain('d'.repeat(64));
    // No standalone pre-transaction tx_hash write on db.query.
    expect(findCall(db.query, /UPDATE payouts SET tx_hash = \$1, fee = \$2 WHERE id/i)).toBeUndefined();
    // Stats counted once.
    expect(findCall(client.query, /UPDATE users[\s\S]*total_amount_won/i)).toBeDefined();
  });

  test('ambiguous failure without a tx hash is never sent again automatically', async () => {
    const { db } = makeHarness();
    const wallet = { checkTransactionStatus: jest.fn(), processPayout: jest.fn() };

    await svcWith(db, wallet).retryPayout({
      id: 8,
      user_id: 1,
      amount: '100',
      payout_address: 'wow1addr',
      status: 'processing',
      retry_count: 1,
      last_error: 'RPC timeout after broadcast'
    });

    expect(wallet.processPayout).not.toHaveBeenCalled();
    const review = findCall(db.query, /SET status = 'needs_review'/i);
    expect(review).toBeDefined();
  });

  test('a recorded transaction hash that is temporarily not found is never resent', async () => {
    const { db } = makeHarness();
    const wallet = {
      checkTransactionStatus: jest.fn().mockResolvedValue({ exists: false }),
      processPayout: jest.fn()
    };

    await svcWith(db, wallet).retryPayout({
      id: 11,
      user_id: 1,
      amount: '100',
      payout_address: 'wow1addr',
      tx_hash: 'possibly-broadcast-tx',
      status: 'processing',
      retry_count: 1
    });

    expect(wallet.processPayout).not.toHaveBeenCalled();
    expect(findCall(db.query, /SET status = 'needs_review'/i)).toBeDefined();
  });
});

describe('PayoutRetryService.processRetries', () => {
  test('stale processing claims are quarantined and never selected for resend', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 44 }], rowCount: 1 }),
      withTransaction: jest.fn(async (fn) => fn({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      }))
    };
    const wallet = { processPayout: jest.fn() };
    const service = new PayoutRetryService({
      db,
      walletService: wallet,
      staleProcessingMs: 60000,
      debugManager: { CONSOLE_LOGGING: false }
    });
    service.retryPayout = jest.fn();

    await service.processRetries();

    const recovery = findCall(db.query, /status = 'needs_review'[\s\S]*status = 'processing'/i);
    expect(recovery).toBeDefined();
    expect(service.retryPayout).not.toHaveBeenCalled();
    expect(wallet.processPayout).not.toHaveBeenCalled();
  });

  test('claims failed rows as processing in the same transaction before dispatch', async () => {
    const candidate = {
      id: 9,
      user_id: 1,
      payout_address: 'wow1addr',
      amount: '100',
      status: 'processing',
      retry_count: 0,
      last_error: 'insufficient unlocked balance'
    };
    const client = { query: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [{ ...candidate, status: 'failed' }] })
      .mockResolvedValueOnce({ rows: [candidate] });
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      withTransaction: jest.fn(async (fn) => fn(client))
    };
    const service = svcWith(db, { processPayout: jest.fn() });
    service.retryPayout = jest.fn().mockResolvedValue();

    await service.processRetries();

    expect(findCall(client.query, /SET status = 'processing'/i)).toBeDefined();
    expect(service.retryPayout).toHaveBeenCalledWith(expect.objectContaining({ id: 9, status: 'processing' }));
  });

  test('master predicate prevents both scan and dispatch', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }), withTransaction: jest.fn() };
    const wallet = { processPayout: jest.fn() };
    const service = new PayoutRetryService({ db, walletService: wallet, isEnabled: () => false });

    await service.processRetries();
    await service.retryPayout({ id: 10 });

    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(wallet.processPayout).not.toHaveBeenCalled();
  });
});
