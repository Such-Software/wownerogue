const PaymentHandlers = require('../src/network/paymentHandlers');

function makeMocks() {
  return {
    io: { to: () => ({ emit: () => {} }) },
    gameModeManager: {
      gameMode: 'PAID_SINGLE',
      cryptoType: 'WOW',
      singleGamePrice: 1000,
      createPaymentRequest: async () => ({ id: 'pid123', address: 'addr', amount: 1000, expiresAt: new Date() })
    },
    walletService: {
      startPaymentMonitoring: (addr, cb) => { /* simulate nothing */ },
      stopPaymentMonitoring: () => {}
    },
    debugManager: { getCurrentBlockHeight: () => 123, CONSOLE_LOGGING: false },
    queueManager: {
      getUserBySocket: () => ({ clientId: 'client1' }),
      getPlayerIndex: () => -1,
      addPlayer: () => {},
      markConfirmed: () => {}
    },
    broadcastManager: { sendStatusUpdate: () => {} }
  };
}

describe('PaymentHandlers basic', () => {
  test('createAndShowPaymentRequest emits payment_created', async () => {
    const mocks = makeMocks();
    const emitted = {};
    mocks.io.to = () => ({ emit: (event, data) => { emitted[event] = data; } });
    ph = new PaymentHandlers(mocks);
    await ph.createAndShowPaymentRequest({ id: 'sock1' });
    expect(emitted.payment_created).toBeDefined();
    expect(emitted.payment_created.paymentId).toBe('pid123');
  });
  afterAll(() => {
    if (ph && typeof ph.dispose === 'function') {
      ph.dispose();
    }
  });
});
