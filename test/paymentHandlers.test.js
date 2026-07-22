const PaymentHandlers = require('../src/network/paymentHandlers');
const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');

function legalAcknowledgement(gameModeManager) {
  const disclosure = buildCommerceDisclosure(gameModeManager, process.env);
  return {
    policyVersion: disclosure.policyVersion,
    ageEligible: true,
    termsRead: true,
    riskAccepted: true,
    testnetUnderstood: disclosure.service.isTestNetwork === true
  };
}

function makeMocks() {
  const user = { id: 'user-1', clientId: 'client1', payout_address: 'wow1address' };
  return {
    io: { to: () => ({ emit: () => {} }) },
    gameModeManager: {
      gameMode: 'PAID_SINGLE',
      cryptoType: 'WOW',
      currencyDecimals: 11,
      singleGamePrice: 1000,
      creditsPayoutEnabled: false,
      formatAtomicHuman: jest.fn(() => '0.001'),
      getOrCreateUser: jest.fn(async () => user),
      createPaymentRequest: async () => ({
        id: 'pid123',
        address: 'addr',
        amount: 1000,
        amountFormatted: '0.001',
        expiresAt: new Date()
      })
    },
    walletService: {
      startPaymentMonitoring: jest.fn(),
      stopPaymentMonitoring: jest.fn()
    },
    debugManager: { getCurrentBlockHeight: () => 123, CONSOLE_LOGGING: false },
    queueManager: {
      getUserBySocket: () => user,
      getPlayerIndex: () => -1,
      getQueueLength: () => 0,
      addPlayer: jest.fn(),
      markConfirmed: jest.fn(),
      startGameImmediately: jest.fn(() => false)
    },
    broadcastManager: { sendStatusUpdate: jest.fn() }
  };
}

describe('PaymentHandlers basic', () => {
  let ph;

  afterEach(() => {
    if (ph && typeof ph.dispose === 'function') {
      ph.dispose();
    }
    ph = null;
  });

  test('createAndShowPaymentRequest emits payment_created', async () => {
    const mocks = makeMocks();
    const emitted = {};
    mocks.io.to = () => ({ emit: (event, data) => { emitted[event] = data; } });
    ph = new PaymentHandlers(mocks);
    await ph.createAndShowPaymentRequest({ id: 'sock1' }, {
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });
    expect(emitted.payment_created).toBeDefined();
    expect(emitted.payment_created.paymentId).toBe('pid123');
    // No paymentProviders registry on the mock -> legacy fallback to direct wallet monitoring.
    expect(mocks.walletService.startPaymentMonitoring).toHaveBeenCalled();
  });

  test('monitoring routes through a routed gateway provider instead of the wallet', async () => {
    const mocks = makeMocks();
    const gateway = { id: 'wowcheckout', startWatch: jest.fn(), stopWatch: jest.fn() };
    mocks.gameModeManager.paymentProviders = { getProvider: jest.fn(() => gateway) };
    mocks.io.to = () => ({ emit: () => {} });
    ph = new PaymentHandlers(mocks);
    await ph.createAndShowPaymentRequest({ id: 'sock2' }, {
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });
    expect(mocks.gameModeManager.paymentProviders.getProvider).toHaveBeenCalledWith('WOW');
    expect(gateway.startWatch).toHaveBeenCalled();
    expect(mocks.walletService.startPaymentMonitoring).not.toHaveBeenCalled(); // routed away from native
  });

  test('direct payout invoice is not created before a required payout address exists', async () => {
    const mocks = makeMocks();
    const emitted = {};
    mocks.io.to = () => ({ emit: (event, data) => { emitted[event] = data; } });
    mocks.gameModeManager.getOrCreateUser.mockResolvedValue({ id: 'user-1', payout_address: null });
    mocks.gameModeManager.requiresPayoutAddressForMode = jest.fn(() => true);
    mocks.gameModeManager.createPaymentRequest = jest.fn();
    ph = new PaymentHandlers(mocks);

    await ph.handlePaymentRequest({ id: 'sock3' }, {
      type: 'single_game',
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });

    expect(mocks.gameModeManager.createPaymentRequest).not.toHaveBeenCalled();
    expect(emitted.payment_error).toEqual(expect.objectContaining({ code: 'PAYOUT_ADDRESS_REQUIRED' }));
  });

  test.each(['single_game', 'credits_package'])(
    'payout-disabled %s invoice intake is not halted by an unknown/low wallet reserve',
    async (paymentType) => {
      const mocks = makeMocks();
      mocks.gameModeManager.isPayoutEnabledForMode = jest.fn(() => false);
      mocks.gameModeManager.alertService = {
        checkBalanceForGameStart: jest.fn().mockResolvedValue({ halted: true, reason: 'low' })
      };
      mocks.gameModeManager.createPaymentRequest = jest.fn(mocks.gameModeManager.createPaymentRequest);
      ph = new PaymentHandlers(mocks);

      await ph.handlePaymentRequest({ id: `no-payout-${paymentType}` }, {
        type: paymentType,
        legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
      });

      expect(mocks.gameModeManager.alertService.checkBalanceForGameStart).not.toHaveBeenCalled();
      expect(mocks.gameModeManager.createPaymentRequest).toHaveBeenCalledTimes(1);
    }
  );

  test('payout-bearing direct invoice remains fail closed under a critical reserve', async () => {
    const mocks = makeMocks();
    const emitted = {};
    mocks.io.to = () => ({ emit: (event, data) => { emitted[event] = data; } });
    mocks.gameModeManager.isPayoutEnabledForMode = jest.fn(mode => mode === 'PAID_SINGLE');
    mocks.gameModeManager.alertService = {
      checkBalanceForGameStart: jest.fn().mockResolvedValue({ halted: true, reason: 'critical' })
    };
    mocks.gameModeManager.createPaymentRequest = jest.fn();
    ph = new PaymentHandlers(mocks);

    await ph.handlePaymentRequest({ id: 'payout-stagenet' }, {
      type: 'single_game',
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });

    expect(mocks.gameModeManager.createPaymentRequest).not.toHaveBeenCalled();
    expect(emitted.balance_critical).toEqual(expect.objectContaining({ message: 'critical' }));
  });

  test('product grant transaction failure emits review-required and never confirmation success', async () => {
    const mocks = makeMocks();
    const emitted = {};
    const socket = { id: 'product-failure', emit: (event, data) => { emitted[event] = data; } };
    mocks.gameModeManager.processProductPaymentConfirmation = jest.fn()
      .mockRejectedValue(new Error('receipt insert failed'));
    mocks.queueManager.removePlayer = jest.fn();
    ph = new PaymentHandlers(mocks);
    ph.socketPaymentMap.set(socket.id, {
      address: 'addr', paymentId: 'pid123', amount: 1000,
      paymentType: 'credits_package', package: { credits: 10 }
    });

    await ph._handlePaymentStatus(socket, { id: 'pid123', address: 'addr', amount: 1000 }, null, {
      confirmed: true,
      complete: true,
      amount: 1000,
      confirmations: 2,
      receipts: []
    });

    expect(emitted.payment_review_required).toEqual(expect.objectContaining({
      code: 'PAYMENT_RECEIPT_REJECTED'
    }));
    expect(emitted.payment_confirmed).toBeUndefined();
    expect(mocks.queueManager.removePlayer).toHaveBeenCalledWith(socket.id);
  });

  test('single-game payment queue preserves the consumed two-phase fairness proof', async () => {
    const mocks = makeMocks();
    let statusCallback;
    mocks.walletService.startPaymentMonitoring.mockImplementation((_address, callback) => {
      statusCallback = callback;
    });
    const fairnessProof = {
      proofVersion: 2,
      offerId: 'offer-paid',
      serverSeed: 'a'.repeat(64),
      commitment: 'b'.repeat(64),
      clientSeed: 'c'.repeat(64)
    };
    const durableProof = {
      ...fairnessProof,
      offerId: 'offer-persisted-on-invoice',
      offerIssuedAt: 1700000000000
    };
    mocks.gameModeManager.createPaymentRequest = jest.fn(async () => ({
      id: 'pid123',
      address: 'addr',
      amount: 1000,
      amountFormatted: '0.001',
      expiresAt: new Date(),
      fairnessProof: durableProof
    }));
    ph = new PaymentHandlers(mocks);

    await ph.createAndShowPaymentRequest({ id: 'sock4', emit: jest.fn() }, {
      fairnessProof,
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });
    await statusCallback({ in_mempool: true, confirmed: false, amount: 1000 });

    expect(mocks.queueManager.addPlayer).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pid123',
      fairnessProof: durableProof
    }));
  });

  test('production refuses to queue an unbound paid invoice', async () => {
    const mocks = makeMocks();
    let statusCallback;
    const emitted = {};
    mocks.gameModeManager._requiresPaidFairnessV2 = jest.fn(() => true);
    mocks.walletService.startPaymentMonitoring.mockImplementation((_address, callback) => {
      statusCallback = callback;
    });
    const socket = {
      id: 'sock-unbound',
      emit: (event, data) => { emitted[event] = data; }
    };
    ph = new PaymentHandlers(mocks);

    await ph.createAndShowPaymentRequest(socket, {
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });
    await statusCallback({ in_mempool: true, confirmed: false, amount: 1000 });

    expect(mocks.queueManager.addPlayer).not.toHaveBeenCalled();
    expect(emitted.payment_review_required).toEqual(expect.objectContaining({
      code: 'PAYMENT_FAIRNESS_UNBOUND'
    }));
  });

  test('fairness proof survives a payout-address prompt before monitoring starts', async () => {
    const mocks = makeMocks();
    let hasAddress = false;
    let statusCallback;
    mocks.gameModeManager.requiresPayoutAddressForMode = jest.fn(() => true);
    mocks.gameModeManager.getOrCreateUser.mockImplementation(async () => ({
      id: 'user-1',
      payout_address: hasAddress ? 'wow1address' : null
    }));
    mocks.walletService.startPaymentMonitoring.mockImplementation((_address, callback) => {
      statusCallback = callback;
    });
    const fairnessProof = { proofVersion: 2, offerId: 'address-offer', clientSeed: 'd'.repeat(64) };
    ph = new PaymentHandlers(mocks);

    await ph.createAndShowPaymentRequest({ id: 'sock5', emit: jest.fn() }, {
      fairnessProof,
      legalAcknowledgement: legalAcknowledgement(mocks.gameModeManager)
    });
    expect(statusCallback).toBeUndefined();
    hasAddress = true;
    await ph.createAndShowPaymentRequest({ id: 'sock5', emit: jest.fn() });
    await statusCallback({ in_mempool: true, confirmed: false, amount: 1000 });

    expect(mocks.queueManager.addPlayer).toHaveBeenCalledWith(expect.objectContaining({ fairnessProof }));
  });
});
