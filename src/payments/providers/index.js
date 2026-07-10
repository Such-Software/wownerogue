const { PaymentProvider, PaymentProviderRegistry } = require('./paymentProvider');
const BTCPayProvider = require('./btcpayProvider');
const NativeMoneroProvider = require('./nativeMoneroProvider');

/**
 * Parse an operator routing override. Accepts JSON ({"BTC":"btcpay","XMR":"native-monero"})
 * or a compact "CHAIN:provider,CHAIN:provider" string. Returns {} on empty/garbage.
 */
function parseRouting(raw) {
    if (!raw) return {};
    const s = String(raw).trim();
    if (!s) return {};
    if (s[0] === '{') {
        try {
            const obj = JSON.parse(s);
            const out = {};
            for (const k of Object.keys(obj)) out[String(k).toUpperCase()] = String(obj[k]);
            return out;
        } catch (_) { return {}; }
    }
    const out = {};
    for (const pair of s.split(',')) {
        const [chain, prov] = pair.split(':').map(x => (x || '').trim());
        if (chain && prov) out[chain.toUpperCase()] = prov;
    }
    return out;
}

/**
 * Assemble the payment-provider registry from environment/config. Single wiring seam for Pillar 3.
 *
 * Behavior-preserving: with no BTCPAY_* env set (prod today), only the native Monero/Wownero
 * provider is registered and every chain routes to it — identical to the current flow. Set
 * BTCPAY_URL/BTCPAY_STORE_ID/BTCPAY_API_KEY and BTC/LTC/GRIN route to BTCPay automatically, while
 * XMR/WOW stay on the native wallet-RPC. PAYMENT_ROUTING overrides any chain->provider mapping.
 */
function buildProviderRegistry({ env = process.env, walletService = null } = {}) {
    const registry = new PaymentProviderRegistry();
    let hasNative = false, hasBtcpay = false;

    if (walletService) {
        registry.register(new NativeMoneroProvider({ walletService }));
        hasNative = true;
    }

    const baseUrl = env.BTCPAY_URL, storeId = env.BTCPAY_STORE_ID, apiKey = env.BTCPAY_API_KEY;
    if (baseUrl && storeId && apiKey) {
        registry.register(new BTCPayProvider({ baseUrl, storeId, apiKey }));
        hasBtcpay = true;
    }

    // Sensible defaults, only for providers that are actually present.
    const routing = {};
    if (hasBtcpay) { routing.BTC = 'btcpay'; routing.LTC = 'btcpay'; routing.GRIN = 'btcpay'; }
    if (hasNative) { routing.XMR = 'native-monero'; routing.WOW = 'native-monero'; }
    else if (hasBtcpay) { routing.XMR = 'btcpay'; routing.WOW = 'btcpay'; }

    Object.assign(routing, parseRouting(env.PAYMENT_ROUTING)); // operator override wins
    registry.setRouting(routing);
    registry.setDefault(hasNative ? 'native-monero' : (hasBtcpay ? 'btcpay' : null));

    return registry;
}

module.exports = {
    PaymentProvider,
    PaymentProviderRegistry,
    BTCPayProvider,
    NativeMoneroProvider,
    buildProviderRegistry,
    parseRouting
};
