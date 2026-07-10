const { PaymentProvider } = require('./paymentProvider');

/**
 * Native Monero/Wownero provider — wraps the existing walletRPCService (subaddress invoicing +
 * transfer_split payouts) so "our own XMR/WOW stuff" is just another plugin behind the same
 * contract. Behavior-preserving: it delegates to the exact calls the game already makes today.
 * Supports XMR/WOW only; other chains route to BTCPay.
 */
class NativeMoneroProvider extends PaymentProvider {
    constructor({ walletService, chains = ['XMR', 'WOW'] } = {}) {
        super('native-monero');
        this.wallet = walletService;
        this.chains = new Set(chains.map(c => String(c).toUpperCase()));
    }

    supportsChain(chain) { return this.chains.has(String(chain || '').toUpperCase()); }

    _addr(ref) { return typeof ref === 'object' ? (ref.address || ref.invoiceId) : ref; }

    _normalize(st) {
        const complete = !!(st && st.confirmed && st.complete);
        return {
            status: complete ? 'paid' : (st && st.detected ? 'processing' : 'pending'),
            complete,
            paidAtomic: st && st.amount != null ? String(st.amount) : null,
            confirmations: st && st.confirmations != null ? st.confirmations : null,
            raw: st
        };
    }

    async createInvoice({ amountAtomic, description, userId, orderId } = {}) {
        const req = await this.wallet.createPaymentRequest(amountAtomic, description || 'Game entry', userId, orderId);
        const address = req && (req.address || req.subaddress) || null;
        return {
            invoiceId: address, // native invoices are keyed by their subaddress
            address,
            uri: (req && req.uri) || null,
            amountAtomic: String(amountAtomic),
            expiresAt: (req && req.expiresAt) || null,
            raw: req
        };
    }

    async getInvoiceStatus(invoiceRef) {
        return this._normalize(await this.wallet.checkPaymentStatus(this._addr(invoiceRef)));
    }

    startWatch(invoiceRef, onUpdate, intervalMs = 2000) {
        const address = this._addr(invoiceRef);
        if (typeof this.wallet.startPaymentMonitoring === 'function') {
            this.wallet.startPaymentMonitoring(address, (st) => onUpdate(this._normalize(st)), intervalMs);
        }
    }
    stopWatch(invoiceRef) {
        if (typeof this.wallet.stopPaymentMonitoring === 'function') this.wallet.stopPaymentMonitoring(this._addr(invoiceRef));
    }

    async sendPayout({ address, amountAtomic } = {}) {
        const result = await this.wallet.processBatchPayout([{ address, amount: amountAtomic }]);
        const txids = (result && (result.tx_hash_list || (result.txHash ? [result.txHash] : []))) || [];
        return { txids, raw: result };
    }

    async validateAddress(chain, address) {
        try {
            if (typeof this.wallet.rpcCall === 'function') {
                const r = await this.wallet.rpcCall('validate_address', { address });
                return { valid: !!(r && r.valid) };
            }
        } catch (_) { /* fall through */ }
        return { valid: true };
    }
}

module.exports = NativeMoneroProvider;
