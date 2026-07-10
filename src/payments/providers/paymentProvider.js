/**
 * Modular payment-provider system (Pillar 3, reframed).
 *
 * Instead of the game implementing per-chain wallet/daemon code, it talks to pluggable PAYMENT
 * PROVIDERS. BTCPay Server is the first plugin (it already handles BTC/LTC natively + XMR/WOW via
 * checkout plugins + Grin via our own plugin — all five Smirk chains). The existing native
 * Monero/Wownero wallet-RPC integration is a second plugin, so an operator can route each chain to
 * whichever provider they run (e.g. BTCPay for BTC/LTC/GRIN, native-RPC for XMR/WOW).
 *
 * A provider implements this contract (all amounts are atomic-unit strings/BigInt for the chain):
 *   async createInvoice({ chain, amountAtomic, description, userId, orderId }) ->
 *        { invoiceId, address, uri, amountAtomic, expiresAt, raw }
 *   async getInvoiceStatus(invoiceRef) ->
 *        { status: 'pending'|'processing'|'paid'|'expired'|'invalid', paidAtomic, confirmations, complete, raw }
 *   startWatch(invoiceRef, onUpdate, intervalMs) -> void      (poll or webhook-bridge)
 *   stopWatch(invoiceRef) -> void
 *   async sendPayout({ chain, address, amountAtomic }) -> { txid | txids, raw }   (optional)
 *   async validateAddress(chain, address) -> { valid, reason }                    (optional)
 *   supportsChain(chain) -> boolean
 */

class PaymentProvider {
    /** @param {string} id stable provider id, e.g. 'btcpay' | 'native-monero' */
    constructor(id) {
        this.id = id;
    }
    supportsChain(_chain) { return true; }
    async createInvoice(_req) { throw new Error(`${this.id}: createInvoice not implemented`); }
    async getInvoiceStatus(_ref) { throw new Error(`${this.id}: getInvoiceStatus not implemented`); }
    startWatch(_ref, _onUpdate, _intervalMs) { /* optional */ }
    stopWatch(_ref) { /* optional */ }
    async sendPayout(_req) { throw new Error(`${this.id}: sendPayout not implemented`); }
    async validateAddress(_chain, _address) { return { valid: true }; }
}

/**
 * Routes each chain to a registered provider. Operator-configurable: setRouting({ BTC:'btcpay',
 * XMR:'native-monero', ... }) with a default. Unknown chains fall back to the default provider.
 */
class PaymentProviderRegistry {
    constructor({ defaultProviderId = null } = {}) {
        this.providers = new Map();
        this.routing = {};
        this.defaultProviderId = defaultProviderId;
    }
    register(provider) {
        if (!provider || !provider.id) throw new Error('provider must have an id');
        this.providers.set(provider.id, provider);
        if (!this.defaultProviderId) this.defaultProviderId = provider.id;
        return this;
    }
    setRouting(map = {}) {
        const out = {};
        for (const k of Object.keys(map)) out[String(k).toUpperCase()] = map[k];
        this.routing = out;
        return this;
    }
    setDefault(providerId) { this.defaultProviderId = providerId; return this; }

    providerIdForChain(chain) {
        const c = String(chain || '').toUpperCase();
        return this.routing[c] || this.defaultProviderId;
    }
    getProvider(chain) {
        const id = this.providerIdForChain(chain);
        const p = id ? this.providers.get(id) : null;
        if (p && (typeof p.supportsChain !== 'function' || p.supportsChain(chain))) return p;
        // Fall back to any registered provider that supports the chain.
        for (const prov of this.providers.values()) {
            if (typeof prov.supportsChain === 'function' && prov.supportsChain(chain)) return prov;
        }
        return p || null;
    }
    get(id) { return this.providers.get(id) || null; }
}

module.exports = { PaymentProvider, PaymentProviderRegistry };
