const PaymentHandlers = require('../src/network/paymentHandlers');

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
    await ph.createAndShowPaymentRequest({ id: 'sock1' });
    expect(emitted.payment_created).toBeDefined();
    expect(emitted.payment_created.paymentId).toBe('pid123');
    expect(mocks.walletService.startPaymentMonitoring).toHaveBeenCalled();
  });
});
