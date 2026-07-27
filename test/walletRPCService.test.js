const WalletRPCService = require('../src/payments/walletRPCService');

// Minimal debugManager mock
const debugManagerMock = { CONSOLE_LOGGING: false };

function confirmedTransfer({ txid, amount, height, minor, major = 0, confirmations = 1,
  doubleSpend = false, unlockTime = 0 }) {
  return {
    txid,
    amount,
    height,
    confirmations,
    double_spend_seen: doubleSpend,
    unlock_time: unlockTime,
    subaddr_index: { major, minor }
  };
}

function incomingOutput({ txHash, amount, blockHeight, minor, major = 0, pubkey,
  globalIndex, frozen = false, spent = false, unlocked = false }) {
  return {
    tx_hash: txHash,
    amount,
    block_height: blockHeight,
    frozen,
    global_index: globalIndex,
    pubkey,
    spent,
    subaddr_index: { major, minor },
    unlocked
  };
}

describe('WalletRPCService interface', () => {

  test('exposes expected methods', () => {
    const svc = new WalletRPCService(debugManagerMock);
    expect(typeof svc.initialize).toBe('function');
    expect(typeof svc.rpcCall).toBe('function');
    expect(typeof svc.createPaymentRequest).toBe('function');
    expect(typeof svc.checkPaymentStatus).toBe('function');
    expect(typeof svc.startPaymentMonitoring).toBe('function');
    expect(typeof svc.stopPaymentMonitoring).toBe('function');
    expect(typeof svc.processBatchPayout).toBe('function');
    expect(typeof svc.processPayout).toBe('function');
    expect(typeof svc.normalizeAtomicAmount).toBe('function');
    expect(typeof svc.cleanupUserPayments).toBe('function');
    expect(typeof svc.getHealthStatus).toBe('function');
  });

  test('processBatchPayout validates destinations', async () => {
    const svc = new WalletRPCService(debugManagerMock);
    await expect(svc.processBatchPayout([])).rejects.toThrow(/destinations/i);
  });

  test('the injected payout gate blocks every transfer entrypoint before wallet RPC', async () => {
    const svc = new WalletRPCService(debugManagerMock, { transferAllowed: () => false });
    svc.rpcCall = jest.fn();

    await expect(svc.processPayout({ address: '5'.repeat(95), amount: 1 }))
      .rejects.toMatchObject({ code: 'PAYOUT_DISPATCH_DISABLED', statusCode: 503 });
    await expect(svc.processBatchPayout([{ address: '5'.repeat(95), amount: 1 }]))
      .rejects.toMatchObject({ code: 'PAYOUT_DISPATCH_DISABLED', statusCode: 503 });
    expect(svc.rpcCall).not.toHaveBeenCalled();
  });

  test('rpcCall wraps failures in ExternalServiceError', async () => {
    const svc = new WalletRPCService(debugManagerMock);
    svc.walletEndpoint = 'http://127.0.0.1:65535';

    await expect(svc.rpcCall('get_height')).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
      safeMessage: 'Wallet RPC call failed.'
    });
  });

  test('createPaymentRequest rethrows wrapped errors', async () => {
    const svc = new WalletRPCService(debugManagerMock);
    svc.rpcCall = jest.fn().mockRejectedValue(new Error('rpc unavailable'));

    await expect(
      svc.createPaymentRequest(10, 'test payment', 'user-1', 'socket-1')
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
      safeMessage: 'Unable to create a payment address at this time.'
    });
  });
});

describe('WalletRPCService.normalizeAtomicAmount', () => {
  let svc;

  beforeEach(() => {
    svc = new WalletRPCService(debugManagerMock);
  });

  test('accepts valid positive number', () => {
    expect(svc.normalizeAtomicAmount(100)).toBe(100);
    expect(svc.normalizeAtomicAmount(1)).toBe(1);
    expect(svc.normalizeAtomicAmount(100000000000)).toBe(100000000000);
  });

  test('accepts valid positive bigint', () => {
    expect(svc.normalizeAtomicAmount(100n)).toBe(100);
    expect(svc.normalizeAtomicAmount(1n)).toBe(1);
  });

  test('converts large bigint to string when beyond safe integer', () => {
    const largeValue = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
    const result = svc.normalizeAtomicAmount(largeValue);
    expect(typeof result).toBe('string');
    expect(result).toBe(largeValue.toString());
  });

  test('rejects fractional atomic-unit numbers', () => {
    expect(() => svc.normalizeAtomicAmount(100.9)).toThrow();
    expect(() => svc.normalizeAtomicAmount(100.1)).toThrow();
    expect(() => svc.normalizeAtomicAmount(99.9999)).toThrow();
  });

  test('throws on zero amount', () => {
    expect(() => svc.normalizeAtomicAmount(0)).toThrow();
  });

  test('throws on negative amount', () => {
    expect(() => svc.normalizeAtomicAmount(-100)).toThrow();
    expect(() => svc.normalizeAtomicAmount(-1)).toThrow();
  });

  test('throws on zero bigint', () => {
    expect(() => svc.normalizeAtomicAmount(0n)).toThrow();
  });

  test('throws on negative bigint', () => {
    expect(() => svc.normalizeAtomicAmount(-100n)).toThrow();
  });

  test('throws on null/undefined', () => {
    expect(() => svc.normalizeAtomicAmount(null)).toThrow();
    expect(() => svc.normalizeAtomicAmount(undefined)).toThrow();
  });

  test('throws on NaN', () => {
    expect(() => svc.normalizeAtomicAmount(NaN)).toThrow();
  });

  test('throws on Infinity', () => {
    expect(() => svc.normalizeAtomicAmount(Infinity)).toThrow();
    expect(() => svc.normalizeAtomicAmount(-Infinity)).toThrow();
  });

  test('throws when truncated value is zero', () => {
    expect(() => svc.normalizeAtomicAmount(0.5)).toThrow();
    expect(() => svc.normalizeAtomicAmount(0.001)).toThrow();
  });
});

describe('WalletRPCService.processPayout', () => {
  let svc;

  beforeEach(() => {
    svc = new WalletRPCService(debugManagerMock);
  });

  test('validates address is provided', async () => {
    await expect(svc.processPayout({ amount: 100 }))
      .rejects.toThrow(/address/i);
    
    await expect(svc.processPayout({ address: '', amount: 100 }))
      .rejects.toThrow(/address/i);
    
    await expect(svc.processPayout({ address: 123, amount: 100 }))
      .rejects.toThrow(/address/i);
  });

  test('validates amount is positive', async () => {
    // Mock validateAddress to pass so we can test amount validation
    svc.validateAddress = jest.fn().mockResolvedValue({ valid: true });

    await expect(svc.processPayout({
      address: 'wow1addr',
      amount: 0
    })).rejects.toThrow(/amount/i);

    await expect(svc.processPayout({
      address: 'wow1addr',
      amount: -100
    })).rejects.toThrow(/amount/i);
  });

  test('calls transfer_split RPC with correct parameters', async () => {
    // Mock validateAddress to return valid
    svc.validateAddress = jest.fn().mockResolvedValue({ valid: true });
    svc.rpcCall = jest.fn().mockResolvedValueOnce({
      result: {
        tx_hash_list: ['a'.repeat(64)],
        tx_key_list: ['key789'],
        fee_list: [1000000]
      }
    });

    const result = await svc.processPayout({
      address: 'wow1testaddress123456789',
      amount: 100000000000,
      userId: 'user1',
      gameId: 'game123'
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('a'.repeat(64));
    expect(result.txKey).toBe('key789');
    expect(result.fee).toBe(1000000);
    expect(result.userId).toBe('user1');
    expect(result.gameId).toBe('game123');
    expect(result.amount).toBe(100000000000);

    expect(svc.rpcCall).toHaveBeenCalledWith('transfer_split', {
      destinations: [{
        amount: 100000000000,
        address: 'wow1testaddress123456789'
      }],
      account_index: 0,
      priority: 1,
      get_tx_key: true
    });
  });

  test('includes subaddr_indices when subaddressIndex specified', async () => {
    svc.validateAddress = jest.fn().mockResolvedValue({ valid: true });
    svc.rpcCall = jest.fn().mockResolvedValueOnce({
      result: { tx_hash_list: ['b'.repeat(64)], tx_key_list: ['key'], fee_list: [100] }
    });

    await svc.processPayout({
      address: 'wow1addr',
      amount: 100,
      subaddressIndex: 5
    });

    expect(svc.rpcCall).toHaveBeenCalledWith('transfer_split',
      expect.objectContaining({
        subaddr_indices: [5]
      })
    );
  });

  test('does not include subaddr_indices for invalid index values', async () => {
    svc.validateAddress = jest.fn().mockResolvedValue({ valid: true });
    svc.rpcCall = jest.fn().mockResolvedValueOnce({
      result: { tx_hash_list: ['c'.repeat(64)], tx_key_list: ['key'], fee_list: [100] }
    });

    await svc.processPayout({
      address: 'wow1addr',
      amount: 100,
      subaddressIndex: -1
    });

    expect(svc.rpcCall).toHaveBeenCalledWith('transfer_split',
      expect.not.objectContaining({
        subaddr_indices: expect.anything()
      })
    );
  });

  test('handles RPC failure and wraps error', async () => {
    svc.validateAddress = jest.fn().mockResolvedValue({ valid: true });
    svc.rpcCall = jest.fn().mockRejectedValueOnce(new Error('Insufficient balance'));

    await expect(svc.processPayout({
      address: 'wow1addr',
      amount: 100
    })).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
      safeMessage: 'Unable to send payout at this time.'
    });
  });
});

describe('WalletRPCService.createPaymentRequest', () => {
  let svc;

  beforeEach(() => {
    svc = new WalletRPCService(debugManagerMock);
  });

  test('creates payment request with correct parameters', async () => {
    svc.rpcCall = jest.fn().mockResolvedValueOnce({
      result: {
        address: 'wow1subaddress123',
        address_index: 42
      }
    });

    const result = await svc.createPaymentRequest(
      100000000000,
      'Game entry payment',
      'user123',
      'socket456'
    );

    expect(result.success).toBe(true);
    expect(result.address).toBe('wow1subaddress123');
    expect(result.addressIndex).toBe(42);
    expect(result.amount).toBe(100000000000);
    expect(result.description).toBe('Game entry payment');
    expect(result.id).toBeDefined();
    expect(result.expiresAt).toBeInstanceOf(Date);

    expect(svc.rpcCall).toHaveBeenCalledWith('create_address', {
      account_index: 0,
      label: expect.stringContaining('game_user123_')
    });
  });

  test('stores payment info for monitoring', async () => {
    svc.rpcCall = jest.fn().mockResolvedValueOnce({
      result: {
        address: 'wow1subaddress123',
        address_index: 42
      }
    });

    await svc.createPaymentRequest(
      100000000000,
      'Test payment',
      'user123',
      'socket456'
    );

    expect(svc.addressToUser.has('wow1subaddress123')).toBe(true);
    expect(svc.addressToSocket.has('wow1subaddress123')).toBe(true);

    const userInfo = svc.addressToUser.get('wow1subaddress123');
    expect(userInfo.userId).toBe('user123');
    expect(userInfo.socketId).toBe('socket456');
    expect(userInfo.amount).toBe(100000000000);
    expect(userInfo.addressIndex).toBe(42);
    expect(userInfo.status).toBe('pending');
    expect(userInfo.detected).toBe(false);
    expect(userInfo.confirmed).toBe(false);
  });
});

describe('WalletRPCService Payment Monitoring', () => {
  let svc;

  beforeEach(() => {
    svc = new WalletRPCService(debugManagerMock);
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Cleanup any watchers
    for (const [addr] of svc.paymentWatchers) {
      svc.stopPaymentMonitoring(addr);
    }
    jest.useRealTimers();
  });

  test('starts and stops payment monitoring', () => {
    const callback = jest.fn();
    const address = 'wow1testaddr';
    
    svc.checkPaymentStatus = jest.fn().mockResolvedValue({
      complete: false,
      in_mempool: false,
      confirmed: false
    });

    svc.startPaymentMonitoring(address, callback, 100);
    
    expect(svc.paymentWatchers.has(address)).toBe(true);
    
    svc.stopPaymentMonitoring(address);
    
    expect(svc.paymentWatchers.has(address)).toBe(false);
  });

  test('does not start duplicate monitors for same address', () => {
    const callback = jest.fn();
    const address = 'wow1testaddr';
    
    svc.checkPaymentStatus = jest.fn().mockResolvedValue({
      complete: false
    });

    svc.startPaymentMonitoring(address, callback, 100);
    const firstWatcher = svc.paymentWatchers.get(address);
    
    svc.startPaymentMonitoring(address, callback, 100); // Duplicate
    const secondWatcher = svc.paymentWatchers.get(address);
    
    // Should be the same watcher
    expect(firstWatcher).toBe(secondWatcher);
    expect(svc.paymentWatchers.size).toBe(1);
    
    svc.stopPaymentMonitoring(address);
  });

  test('cleanupUserPayments removes all monitors for user', () => {
    const userId = 'user123';
    const addr1 = 'wow1addr1';
    const addr2 = 'wow1addr2';
    const addr3 = 'wow1addr3'; // Different user
    
    svc.addressToUser.set(addr1, { userId, socketId: 'sock1' });
    svc.addressToUser.set(addr2, { userId, socketId: 'sock2' });
    svc.addressToUser.set(addr3, { userId: 'otherUser', socketId: 'sock3' });
    
    svc.paymentWatchers.set(addr1, setInterval(() => {}, 10000));
    svc.paymentWatchers.set(addr2, setInterval(() => {}, 10000));
    svc.paymentWatchers.set(addr3, setInterval(() => {}, 10000));

    svc.cleanupUserPayments(userId);
    
    expect(svc.paymentWatchers.has(addr1)).toBe(false);
    expect(svc.paymentWatchers.has(addr2)).toBe(false);
    expect(svc.paymentWatchers.has(addr3)).toBe(true); // Different user, not cleaned

    svc.stopPaymentMonitoring(addr3);
  });
});

describe('WalletRPCService.checkPaymentStatus', () => {
  let svc;

  beforeEach(() => {
    svc = new WalletRPCService(debugManagerMock);
  });

  test('returns default status for unknown address', async () => {
    const status = await svc.checkPaymentStatus('unknown_address');
    
    expect(status.complete).toBe(false);
    expect(status.in_mempool).toBe(false);
    expect(status.confirmed).toBe(false);
    expect(status.amount).toBe(0);
    expect(status.confirmations).toBe(0);
  });

  test('checks mempool and confirmed transfers', async () => {
    // Setup: create a payment first
    svc.addressToUser.set('wow1testaddr', {
      userId: 'user1',
      socketId: 'sock1',
      amount: 100000000000,
      addressIndex: 5,
      accountIndex: 0,
      detected: false,
      confirmed: false
    });

    // Contract-shaped wallet RPC calls: get_transfers has transaction metadata but no output
    // identity; incoming_transfers has pubkey/global_index and uses tx_hash/block_height names.
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({
        result: {
          pool: [],
          in: [confirmedTransfer({
            txid: 'd'.repeat(64), amount: 100000000000, height: 1000,
            confirmations: 5, minor: 5
          })]
        }
      })
      .mockResolvedValueOnce({
        result: { transfers: [incomingOutput({
          txHash: 'd'.repeat(64), pubkey: '1'.repeat(64), globalIndex: 12345,
          amount: 100000000000, blockHeight: 1000, minor: 5
        })] }
      });

    const status = await svc.checkPaymentStatus('wow1testaddr');
    
    expect(status.complete).toBe(true);
    expect(status.confirmed).toBe(true);
    expect(status.amount).toBe(100000000000);
    expect(status.confirmations).toBe(5); // 1005 - 1000
    expect(status.txHash).toBe('d'.repeat(64));
    expect(status.receipts).toEqual([expect.objectContaining({
      txHash: 'd'.repeat(64),
      outputId: '1'.repeat(64),
      evidenceId: `${'d'.repeat(64)}:${'1'.repeat(64)}`,
      addressIndex: 5,
      amount: '100000000000',
      confirmed: true
    })]);
    expect(svc.rpcCall).toHaveBeenNthCalledWith(2, 'incoming_transfers', {
      transfer_type: 'all', account_index: 0, subaddr_indices: [5]
    });
  });

  test('does not combine a confirmed dust transfer with an unconfirmed pool top-up', async () => {
    svc.addressToUser.set('wow1mixed', {
      userId: 'user1', socketId: 'sock1', amount: 1000,
      addressIndex: 7, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: {
        pool: [{ txid: 'e'.repeat(64), amount: 999, subaddr_index: { major: 0, minor: 7 } }],
        in: [confirmedTransfer({ txid: 'f'.repeat(64), amount: 1, height: 200,
          confirmations: 1, minor: 7 })]
      } })
      .mockResolvedValueOnce({ result: { transfers: [incomingOutput({
        txHash: 'f'.repeat(64), pubkey: '2'.repeat(64), globalIndex: 200,
        amount: 1, blockHeight: 200, minor: 7
      })] } });

    const status = await svc.checkPaymentStatus('wow1mixed');

    expect(status.confirmed).toBe(true);
    expect(status.in_mempool).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.amount).toBe(1);
    expect(status.pendingAmount).toBe(999);
    expect(status.observedAmount).toBe(1000);
    expect(status.receipts).toHaveLength(1);
    expect(status.receipts[0].txHash).toBe('f'.repeat(64));
  });

  test('returns every confirmed top-up receipt in deterministic order', async () => {
    svc.addressToUser.set('wow1topups', {
      userId: 'user1', socketId: 'sock1', amount: 1000,
      addressIndex: 8, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: { pool: [], in: [
        confirmedTransfer({ txid: 'b'.repeat(64), amount: 400, height: 301,
          confirmations: 3, minor: 8 }),
        confirmedTransfer({ txid: 'a'.repeat(64), amount: 600, height: 302,
          confirmations: 2, minor: 8 })
      ] } })
      .mockResolvedValueOnce({ result: { transfers: [
        incomingOutput({ txHash: 'b'.repeat(64), pubkey: '3'.repeat(64), globalIndex: 301,
          amount: 400, blockHeight: 301, minor: 8 }),
        incomingOutput({ txHash: 'a'.repeat(64), pubkey: '4'.repeat(64), globalIndex: 302,
          amount: 600, blockHeight: 302, minor: 8 })
      ] } });

    const status = await svc.checkPaymentStatus('wow1topups');

    expect(status.complete).toBe(true);
    expect(status.amount).toBe(1000);
    expect(status.receipts.map(receipt => receipt.txHash)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64)
    ]);
    expect(status.confirmations).toBe(2);
  });

  test('counts distinct same-transaction outputs to one subaddress and ignores output replay', async () => {
    const txid = '9'.repeat(64);
    const firstPubkey = '5'.repeat(64);
    const secondPubkey = '6'.repeat(64);
    svc.addressToUser.set('wow1sameoutputscope', {
      userId: 'user1', socketId: 'sock1', amount: 100,
      addressIndex: 13, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: { pool: [], in: [confirmedTransfer({
        txid, amount: 100, height: 400, confirmations: 4, minor: 13
      })] } })
      .mockResolvedValueOnce({ result: { transfers: [
        incomingOutput({ txHash: txid, pubkey: firstPubkey, globalIndex: 401,
          amount: 40, blockHeight: 400, minor: 13 }),
        incomingOutput({ txHash: txid, pubkey: secondPubkey, globalIndex: 402,
          amount: 60, blockHeight: 400, minor: 13 }),
        incomingOutput({ txHash: txid, pubkey: firstPubkey, globalIndex: 401,
          amount: 40, blockHeight: 400, minor: 13 })
      ] } });

    const status = await svc.checkPaymentStatus('wow1sameoutputscope');

    expect(status.complete).toBe(true);
    expect(status.amount).toBe(100);
    expect(status.receipts).toHaveLength(2);
    expect(status.receipts.map(receipt => receipt.outputId)).toEqual([firstPubkey, secondPubkey]);
  });

  test('fails closed when a confirmed transfer has no stable output identifier', async () => {
    svc.addressToUser.set('wow1missingoutputid', {
      userId: 'user1', socketId: 'sock1', amount: 100,
      addressIndex: 14, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: { pool: [], in: [confirmedTransfer({
        txid: '8'.repeat(64), amount: 100, height: 500, confirmations: 1, minor: 14
      })] } })
      .mockResolvedValueOnce({ result: { transfers: [incomingOutput({
        txHash: '8'.repeat(64), amount: 100, blockHeight: 500, minor: 14
      })] } });

    const status = await svc.checkPaymentStatus('wow1missingoutputid');

    expect(status.complete).toBe(false);
    expect(status.confirmed).toBe(false);
    expect(status.amount).toBe(0);
    expect(status.receipts).toEqual([]);
  });

  test('ignores double-spend-marked and explicitly timelocked incoming transfers', async () => {
    svc.addressToUser.set('wow1unsafeoutputs', {
      userId: 'user1', socketId: 'sock1', amount: 100,
      addressIndex: 15, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: { pool: [], in: [
        confirmedTransfer({ txid: '7'.repeat(64), amount: 100, height: 600,
          confirmations: 2, minor: 15, doubleSpend: true }),
        confirmedTransfer({ txid: '6'.repeat(64), amount: 100, height: 601,
          confirmations: 2, minor: 15, unlockTime: 42 }),
        confirmedTransfer({ txid: '5'.repeat(64), amount: 100, height: 602,
          confirmations: 2, minor: 15, unlockTime: Number.MAX_SAFE_INTEGER + 1 })
      ] } })
      .mockResolvedValueOnce({ result: { transfers: [
        incomingOutput({ txHash: '7'.repeat(64), pubkey: 'a'.repeat(64), globalIndex: 600,
          amount: 100, blockHeight: 600, minor: 15 }),
        incomingOutput({ txHash: '6'.repeat(64), pubkey: 'b'.repeat(64), globalIndex: 601,
          amount: 100, blockHeight: 601, minor: 15 }),
        incomingOutput({ txHash: '5'.repeat(64), pubkey: 'c'.repeat(64), globalIndex: 602,
          amount: 100, blockHeight: 602, minor: 15 })
      ] } });

    const status = await svc.checkPaymentStatus('wow1unsafeoutputs');

    expect(status.complete).toBe(false);
    expect(status.confirmed).toBe(false);
    expect(status.amount).toBe(0);
    expect(status.receipts).toEqual([]);
  });

  test('requires the configured minimum confirmations and rejects frozen output evidence', async () => {
    svc = new WalletRPCService(debugManagerMock, { minConfirmations: 2 });
    svc.addressToUser.set('wow1depth', {
      userId: 'user1', socketId: 'sock1', amount: 100,
      addressIndex: 16, accountIndex: 0, detected: false, confirmed: false
    });
    svc.rpcCall = jest.fn()
      .mockResolvedValueOnce({ result: { pool: [], in: [
        confirmedTransfer({ txid: '4'.repeat(64), amount: 50, height: 700,
          confirmations: 1, minor: 16 }),
        confirmedTransfer({ txid: '3'.repeat(64), amount: 50, height: 699,
          confirmations: 2, minor: 16 })
      ] } })
      .mockResolvedValueOnce({ result: { transfers: [
        incomingOutput({ txHash: '4'.repeat(64), pubkey: 'd'.repeat(64), globalIndex: 700,
          amount: 50, blockHeight: 700, minor: 16 }),
        incomingOutput({ txHash: '3'.repeat(64), pubkey: 'e'.repeat(64), globalIndex: 699,
          amount: 50, blockHeight: 699, minor: 16, frozen: true })
      ] } });

    const status = await svc.checkPaymentStatus('wow1depth');

    expect(status).toEqual(expect.objectContaining({
      complete: false, confirmed: false, amount: 0, confirmations: 0
    }));
    expect(status.receipts).toEqual([]);
  });
});

describe('WalletRPCService Health Status', () => {
  test('returns health status object with correct fields', () => {
    const svc = new WalletRPCService(debugManagerMock);
    svc.isHealthy = true;
    svc.paymentWatchers = new Map([['addr1', {}], ['addr2', {}]]);
    svc.addressToUser = new Map([['addr1', {}]]);

    const status = svc.getHealthStatus();
    
    expect(status.healthy).toBe(true);
    expect(status.endpoint).toBe(svc.walletEndpoint);
    expect(status.activeMonitors).toBe(2);
    expect(status.pendingPayments).toBe(1);
  });

  test('reflects unhealthy state', () => {
    const svc = new WalletRPCService(debugManagerMock);
    svc.isHealthy = false;

    const status = svc.getHealthStatus();
    
    expect(status.healthy).toBe(false);
  });
});
