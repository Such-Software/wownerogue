const { buildProviderRegistry, parseRouting } = require('../src/payments/providers');

const fakeWallet = { createPaymentRequest: async () => ({}), checkPaymentStatus: async () => ({}), processBatchPayout: async () => ({}) };

describe('parseRouting', () => {
    test('parses JSON and compact forms, ignores garbage', () => {
        expect(parseRouting('{"btc":"btcpay","xmr":"native-monero"}')).toEqual({ BTC: 'btcpay', XMR: 'native-monero' });
        expect(parseRouting('BTC:btcpay, XMR:native-monero')).toEqual({ BTC: 'btcpay', XMR: 'native-monero' });
        expect(parseRouting('')).toEqual({});
        expect(parseRouting('{not json')).toEqual({});
    });
});

describe('buildProviderRegistry', () => {
    test('native-only (no BTCPay env): every chain routes to native — behavior-preserving', () => {
        const reg = buildProviderRegistry({ env: {}, walletService: fakeWallet });
        expect(reg.getProvider('WOW').id).toBe('native-monero');
        expect(reg.getProvider('XMR').id).toBe('native-monero');
        expect(reg.getProvider('BTC').id).toBe('native-monero'); // default provider, no routing entry
    });

    test('with BTCPay env: BTC/LTC/GRIN -> btcpay, XMR/WOW stay native', () => {
        const reg = buildProviderRegistry({
            env: { BTCPAY_URL: 'https://btcpay.lan', BTCPAY_STORE_ID: 's', BTCPAY_API_KEY: 'k' },
            walletService: fakeWallet
        });
        expect(reg.getProvider('BTC').id).toBe('btcpay');
        expect(reg.getProvider('LTC').id).toBe('btcpay');
        expect(reg.getProvider('GRIN').id).toBe('btcpay');
        expect(reg.getProvider('XMR').id).toBe('native-monero');
        expect(reg.getProvider('WOW').id).toBe('native-monero');
    });

    test('BTCPay-only (no wallet): all five chains route to btcpay', () => {
        const reg = buildProviderRegistry({
            env: { BTCPAY_URL: 'https://btcpay.lan', BTCPAY_STORE_ID: 's', BTCPAY_API_KEY: 'k' },
            walletService: null
        });
        expect(reg.getProvider('XMR').id).toBe('btcpay');
        expect(reg.getProvider('WOW').id).toBe('btcpay');
        expect(reg.getProvider('BTC').id).toBe('btcpay');
    });

    test('PAYMENT_ROUTING override wins', () => {
        const reg = buildProviderRegistry({
            env: { BTCPAY_URL: 'u', BTCPAY_STORE_ID: 's', BTCPAY_API_KEY: 'k', PAYMENT_ROUTING: 'WOW:btcpay' },
            walletService: fakeWallet
        });
        expect(reg.getProvider('WOW').id).toBe('btcpay'); // overrode the native default
        expect(reg.getProvider('XMR').id).toBe('native-monero'); // untouched
    });
});
