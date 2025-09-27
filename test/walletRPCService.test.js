const WalletRPCService = require('../src/payments/walletRPCService');

// Minimal debugManager mock
const debugManagerMock = { CONSOLE_LOGGING: false };

describe('WalletRPCService interface', () => {
  test('exposes expected methods', () => {
    const svc = new WalletRPCService(debugManagerMock);
    expect(typeof svc.initialize).toBe('function');
    expect(typeof svc.rpcCall).toBe('function');
    expect(typeof svc.createPaymentRequest).toBe('function');
    expect(typeof svc.checkPaymentStatus).toBe('function');
    expect(typeof svc.startPaymentMonitoring).toBe('function');
    expect(typeof svc.stopPaymentMonitoring).toBe('function');
    expect(typeof svc.processBatchPayouts).toBe('function'); // newly added stub
  });

  test('processBatchPayouts stub returns processed:0', async () => {
    const svc = new WalletRPCService(debugManagerMock);
    const res = await svc.processBatchPayouts();
    expect(res).toEqual({ processed: 0 });
  });
});
