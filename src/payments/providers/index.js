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

// Chains parsed from a "btc,ltc" style env list, uppercased.
function parseChains(raw, fallback) {
    if (!raw) return fallback;
    const list = String(raw).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return list.length ? list : fallback;
}

/**
 * Assemble the payment-provider registry from environment/config. Single wiring seam for Pillar 3,
 * shaped to the operator's real infra (see btcpay-infra-topology memo): three Greenfield endpoints
 * — real BTCPay (BTC/LTC), xmrcheckout (XMR), wowcheckout (WOW) — plus the native wallet-RPC.
 *
 * Behavior-preserving: with NO gateway env set (prod today) only the native Monero/Wownero provider
 * is registered and every chain routes to it — identical to the current flow. Each endpoint
 * activates independently when its *_URL/_STORE_ID/_API_KEY trio is present:
 *   BTCPAY_URL/BTCPAY_STORE_ID/BTCPAY_API_KEY            -> id 'btcpay'      (BTCPAY_CHAINS, default BTC,LTC)
 *   XMRCHECKOUT_URL/XMRCHECKOUT_STORE_ID/..._API_KEY     -> id 'xmrcheckout' (XMR)
 *   WOWCHECKOUT_URL/WOWCHECKOUT_STORE_ID/..._API_KEY     -> id 'wowcheckout' (WOW)
 * Default routing sends each chain to its gateway when present, else native for XMR/WOW.
 * PAYMENT_ROUTING (JSON or "CHAIN:provider,...") overrides any chain->provider mapping.
 */
function buildProviderRegistry({ env = process.env, walletService = null } = {}) {
    const registry = new PaymentProviderRegistry();
    const routing = {};
    let hasNative = false;

    if (walletService) {
        registry.register(new NativeMoneroProvider({ walletService }));
        hasNative = true;
        routing.XMR = 'native-monero';
        routing.WOW = 'native-monero';
    }

    // Real BTCPay (BTC/LTC by default; operator may widen via BTCPAY_CHAINS).
    if (env.BTCPAY_URL && env.BTCPAY_STORE_ID && env.BTCPAY_API_KEY) {
        const chains = parseChains(env.BTCPAY_CHAINS, ['BTC', 'LTC']);
        registry.register(new BTCPayProvider({ id: 'btcpay', baseUrl: env.BTCPAY_URL, storeId: env.BTCPAY_STORE_ID, apiKey: env.BTCPAY_API_KEY, chains }));
        for (const c of chains) routing[c] = 'btcpay';
    }

    // xmrcheckout / wowcheckout — Greenfield-compatible shims, same provider class, different id.
    const shims = [
        { prefix: 'XMRCHECKOUT', id: 'xmrcheckout', chain: 'XMR' },
        { prefix: 'WOWCHECKOUT', id: 'wowcheckout', chain: 'WOW' }
    ];
    for (const s of shims) {
        const url = env[`${s.prefix}_URL`], storeId = env[`${s.prefix}_STORE_ID`], apiKey = env[`${s.prefix}_API_KEY`];
        if (url && storeId && apiKey) {
            registry.register(new BTCPayProvider({ id: s.id, baseUrl: url, storeId, apiKey, chains: [s.chain] }));
            routing[s.chain] = s.id; // a dedicated checkout gateway wins over native for its chain
        }
    }

    Object.assign(routing, parseRouting(env.PAYMENT_ROUTING)); // explicit operator override wins over all
    registry.setRouting(routing);

    // Default provider (for chains with no explicit route): native if present, else the first registered gateway.
    const firstId = registry.providers.keys().next().value || null;
    registry.setDefault(hasNative ? 'native-monero' : firstId);

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
