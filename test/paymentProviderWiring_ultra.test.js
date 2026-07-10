/**
 * Proves GameModeManager.createPaymentRequest routes invoice creation through the payment-provider
 * registry: a configured gateway is used, and with the default registry it delegates to the native
 * walletService (byte-for-byte legacy path).
 */
const GameModeManager = require('../src/game/gameModeManager');

function mockDb() {
    return {
        query: jest.fn(async (sql) => {
            const s = String(sql);
            if (/FROM users WHERE id/i.test(s)) return { rows: [{ id: 7, credits: 0, total_credits_purchased: 0 }] };
            if (/INSERT INTO payments/i.test(s)) return { rows: [{ id: 101, expires_at: null }] };
            return { rows: [] }; // reuse lookup, expire-stale, everything else
        }),
        withTransaction: jest.fn(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }))
    };
}

const mockDebug = { CONSOLE_LOGGING: false };
const mockConfig = {
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: { direct: { enabled: true, price: 100000000000n }, credits: { enabled: false, packages: [] } },
        payouts: { rules: { direct: { multipliers: {} }, credits: { enabled: false, multipliers: {} } } },
        preferences: {}
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
};

describe('createPaymentRequest routes through the provider registry', () => {
    test('a configured gateway provider is used for invoice creation', async () => {
        const gateway = {
            id: 'xmrcheckout',
            createInvoice: jest.fn(async () => ({ invoiceId: 'inv-uuid', address: 'GATEWAYADDR', addressIndex: null, expiresAt: null })),
            getProvider() { return this; }
        };
        const registry = { getProvider: jest.fn(() => gateway) };
        const walletService = { createPaymentRequest: jest.fn() };
        const gmm = new GameModeManager(mockDb(), walletService, mockDebug, mockConfig, registry);

        const res = await gmm.createPaymentRequest('sock1', 'single_game', { userId: 7 });

        expect(registry.getProvider).toHaveBeenCalledWith(gmm.cryptoType);
        expect(gateway.createInvoice).toHaveBeenCalledWith(
            expect.objectContaining({ chain: gmm.cryptoType, userId: 7, orderId: 'sock1' })
        );
        expect(res.address).toBe('GATEWAYADDR');
        expect(res.invoiceId).toBe('inv-uuid');
        expect(walletService.createPaymentRequest).not.toHaveBeenCalled(); // routed away from native
    });

    test('the default registry delegates to the native walletService (legacy path preserved)', async () => {
        const walletService = {
            createPaymentRequest: jest.fn(async () => ({ address: 'NATIVEADDR', addressIndex: 3, expiresAt: null }))
        };
        // No injected registry -> constructor builds one whose only provider wraps this walletService.
        const gmm = new GameModeManager(mockDb(), walletService, mockDebug, mockConfig);

        const res = await gmm.createPaymentRequest('sock2', 'single_game', { userId: 7 });

        expect(walletService.createPaymentRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 7, 'sock2');
        expect(res.address).toBe('NATIVEADDR');
        expect(res.invoiceId).toBe('NATIVEADDR'); // native invoices keyed by subaddress
    });
});
