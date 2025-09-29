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
