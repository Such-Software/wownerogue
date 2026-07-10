const { buildProviderRegistry, parseRouting } = require('../src/payments/providers');

const fakeWallet = { createPaymentRequest: async () => ({}), checkPaymentStatus: async () => ({}), processBatchPayout: async () => ({}) };
const CHECKOUT = { // full LAN infra: real BTCPay (BTC/LTC) + xmrcheckout + wowcheckout
    BTCPAY_URL: 'http://10.42.1.33', BTCPAY_STORE_ID: 'b', BTCPAY_API_KEY: 'k',
    XMRCHECKOUT_URL: 'http://10.42.1.33:8080', XMRCHECKOUT_STORE_ID: 'x', XMRCHECKOUT_API_KEY: 'k',
    WOWCHECKOUT_URL: 'http://10.42.1.33:8180', WOWCHECKOUT_STORE_ID: 'w', WOWCHECKOUT_API_KEY: 'k'
};

describe('parseRouting', () => {
    test('parses JSON and compact forms, ignores garbage', () => {
        expect(parseRouting('{"btc":"btcpay","xmr":"xmrcheckout"}')).toEqual({ BTC: 'btcpay', XMR: 'xmrcheckout' });
        expect(parseRouting('BTC:btcpay, XMR:xmrcheckout')).toEqual({ BTC: 'btcpay', XMR: 'xmrcheckout' });
        expect(parseRouting('')).toEqual({});
        expect(parseRouting('{not json')).toEqual({});
    });
});

describe('buildProviderRegistry', () => {
    test('native-only (no gateway env): every chain routes to native — behavior-preserving', () => {
        const reg = buildProviderRegistry({ env: {}, walletService: fakeWallet });
        expect(reg.getProvider('WOW').id).toBe('native-monero');
        expect(reg.getProvider('XMR').id).toBe('native-monero');
        expect(reg.getProvider('BTC').id).toBe('native-monero'); // default provider, no routing entry
    });

    test('real BTCPay + native wallet: BTC/LTC -> btcpay, XMR/WOW stay native', () => {
        const reg = buildProviderRegistry({
            env: { BTCPAY_URL: 'u', BTCPAY_STORE_ID: 's', BTCPAY_API_KEY: 'k' },
            walletService: fakeWallet
        });
        expect(reg.getProvider('BTC').id).toBe('btcpay');
        expect(reg.getProvider('LTC').id).toBe('btcpay');
        expect(reg.getProvider('XMR').id).toBe('native-monero');
        expect(reg.getProvider('WOW').id).toBe('native-monero');
    });

    test('full LAN infra: BTC/LTC -> btcpay, XMR -> xmrcheckout, WOW -> wowcheckout', () => {
        const reg = buildProviderRegistry({ env: CHECKOUT, walletService: fakeWallet });
        expect(reg.getProvider('BTC').id).toBe('btcpay');
        expect(reg.getProvider('LTC').id).toBe('btcpay');
        expect(reg.getProvider('XMR').id).toBe('xmrcheckout'); // dedicated gateway wins over native
        expect(reg.getProvider('WOW').id).toBe('wowcheckout');
    });

    test('a checkout gateway wins over the native wallet for its chain', () => {
        const reg = buildProviderRegistry({
            env: { XMRCHECKOUT_URL: 'http://10.42.1.33:8080', XMRCHECKOUT_STORE_ID: 'x', XMRCHECKOUT_API_KEY: 'k' },
            walletService: fakeWallet
        });
        expect(reg.getProvider('XMR').id).toBe('xmrcheckout');
        expect(reg.getProvider('WOW').id).toBe('native-monero'); // no wowcheckout -> native
    });

    test('BTCPAY_CHAINS widens the real BTCPay gateway', () => {
        const reg = buildProviderRegistry({
            env: { BTCPAY_URL: 'u', BTCPAY_STORE_ID: 's', BTCPAY_API_KEY: 'k', BTCPAY_CHAINS: 'btc,ltc,xmr' },
            walletService: null
        });
        expect(reg.getProvider('XMR').id).toBe('btcpay');
    });

    test('PAYMENT_ROUTING override wins over defaults', () => {
        const reg = buildProviderRegistry({
            env: { ...CHECKOUT, PAYMENT_ROUTING: 'XMR:native-monero' },
            walletService: fakeWallet
        });
        expect(reg.getProvider('XMR').id).toBe('native-monero'); // overrode the xmrcheckout default
        expect(reg.getProvider('WOW').id).toBe('wowcheckout'); // untouched
    });
});
