const { PaymentProvider } = require('./paymentProvider');
const ChainProfile = require('../../chain/chainProfile');
const Atomic = require('../../money/atomic');

// Convert a decimal crypto string (e.g. "1.5") to an integer atomic amount for `decimals` places.
// Truncates any digits beyond `decimals` (the gateway already quantizes to chain precision).
function decimalToAtomic(dec, decimals) {
    const s = String(dec == null ? '' : dec).trim();
    if (!s || s === '-') return 0;
    const neg = s[0] === '-';
    const [ip, fpRaw = ''] = s.replace('-', '').split('.');
    const fp = (fpRaw + '0'.repeat(decimals)).slice(0, decimals);
    const atomic = BigInt(ip || '0') * (10n ** BigInt(decimals)) + BigInt(fp || '0');
    return Number(neg ? -atomic : atomic);
}

/**
 * BTCPay Greenfield provider — the first payment plugin. One client class serves every endpoint
 * that speaks the BTCPay Greenfield API. On the operator's LAN that is THREE endpoints (see the
 * btcpay-infra-topology memo): real BTCPay Server for BTC/LTC, plus the `xmrcheckout` and
 * `wowcheckout` shims which expose Greenfield-compatible `/api/v1/stores/{id}/invoices` routes for
 * XMR and WOW. So the same class is registered up to three times with different `id`/baseUrl/store/
 * key/chains (id defaults to 'btcpay'). Grin is not deployed yet. The invoice is denominated by
 * `currency` — pass the chain ticker (e.g. 'XMR') for a native-crypto amount. Auth is
 * `Authorization: token <apiKey>` on all three.
 *
 * fetchImpl is injectable for tests; defaults to the global fetch (Node >= 18).
 */
class BTCPayProvider extends PaymentProvider {
    constructor({ id = 'btcpay', baseUrl, storeId, apiKey, chains = ['BTC', 'LTC', 'XMR', 'WOW', 'GRIN'], fetchImpl = null } = {}) {
        super(id);
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        this.storeId = storeId;
        this.apiKey = apiKey;
        this.chains = new Set(chains.map(c => String(c).toUpperCase()));
        this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    }

    supportsChain(chain) {
        return this.chains.has(String(chain || '').toUpperCase());
    }

    _headers() {
        return { 'Content-Type': 'application/json', 'Authorization': `token ${this.apiKey}` };
    }

    async _req(method, path, body) {
        if (!this.fetch) throw new Error('btcpay: no fetch available');
        if (!this.baseUrl || !this.storeId || !this.apiKey) throw new Error('btcpay: not configured (BTCPAY_URL/STORE_ID/API_KEY)');
        const res = await this.fetch(`${this.baseUrl}${path}`, {
            method,
            headers: this._headers(),
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
        if (!res.ok) {
            const msg = (json && (json.message || (json[0] && json[0].message))) || `btcpay ${res.status}`;
            throw new Error(msg);
        }
        return json;
    }

    // Normalize the BTCPay invoice status to our contract.
    static _mapStatus(s) {
        switch (String(s || '')) {
            case 'Settled':
            case 'Complete': return { status: 'paid', complete: true };
            case 'Processing': return { status: 'processing', complete: false };
            case 'Expired': return { status: 'expired', complete: false };
            case 'Invalid': return { status: 'invalid', complete: false };
            case 'New':
            default: return { status: 'pending', complete: false };
        }
    }

    async createInvoice({ chain, amountAtomic, description, orderId } = {}) {
        const ch = String(chain || '').toUpperCase();
        const amount = Atomic.format(amountAtomic, ChainProfile.decimalsFor(ch)); // decimal string in the chain's units
        const invoice = await this._req('POST', `/api/v1/stores/${this.storeId}/invoices`, {
            amount,
            currency: ch, // price the invoice in the crypto itself
            metadata: { orderId: orderId || null, itemDesc: description || 'Game entry' }
        });
        // The address for the chosen chain comes from the invoice's payment methods.
        let address = null, uri = null;
        try {
            const methods = await this._req('GET', `/api/v1/stores/${this.storeId}/invoices/${invoice.id}/payment-methods`);
            const list = Array.isArray(methods) ? methods : [];
            const match = list.find(m => String(m.paymentMethod || m.cryptoCode || '').toUpperCase().startsWith(ch)) || list[0];
            if (match) { address = match.destination || match.address || null; uri = match.paymentLink || null; }
        } catch (_) { /* address can be fetched later; invoice still valid */ }
        return {
            invoiceId: invoice.id,
            address,
            uri: uri || invoice.checkoutLink || null,
            amountAtomic: String(amountAtomic),
            expiresAt: invoice.expirationTime || null,
            raw: invoice
        };
    }

    async getInvoiceStatus(invoiceRef) {
        const id = typeof invoiceRef === 'object' ? invoiceRef.invoiceId : invoiceRef;
        const inv = await this._req('GET', `/api/v1/stores/${this.storeId}/invoices/${id}`);
        const mapped = BTCPayProvider._mapStatus(inv.status);
        return {
            status: mapped.status,
            complete: mapped.complete,
            paidAtomic: null, // BTCPay reports fiat/crypto paid via payment-methods; not needed for a paid/settled gate
            confirmations: null,
            raw: inv
        };
    }

    // Read the invoice as a RAW wallet-style status (the shape the confirmation callback consumes),
    // so a gateway payment flows through the exact same paymentHandlers path as a native one.
    // Settled -> confirmed+complete; Processing -> in_mempool. Paid/required amounts (atomic) come
    // from the invoice payment-methods (totalPaid / amount), converted via the chain's decimals.
    async getWalletStatus(invoiceRef) {
        const id = typeof invoiceRef === 'object' ? invoiceRef.invoiceId : invoiceRef;
        const inv = await this._req('GET', `/api/v1/stores/${this.storeId}/invoices/${id}`);
        const mapped = BTCPayProvider._mapStatus(inv.status);
        let amount = 0, required = 0;
        if (mapped.status === 'processing' || mapped.status === 'paid') {
            try {
                const methods = await this._req('GET', `/api/v1/stores/${this.storeId}/invoices/${id}/payment-methods`);
                const list = Array.isArray(methods) ? methods : [];
                const m = list[0] || {};
                const dec = ChainProfile.decimalsFor(m.cryptoCode || m.paymentMethod || '');
                amount = decimalToAtomic(m.totalPaid != null ? m.totalPaid : m.paymentMethodPaid, dec);
                required = decimalToAtomic(m.amount, dec);
            } catch (_) { /* amount stays 0; a Settled invoice still confirms via `complete` */ }
        }
        return {
            in_mempool: mapped.status === 'processing',
            confirmed: mapped.status === 'paid',
            complete: mapped.complete,
            amount,
            required,
            confirmations: null,
            _terminal: mapped.status === 'expired' || mapped.status === 'invalid'
        };
    }

    // Poll-based watch (BTCPay also supports webhooks; a webhook bridge can call onUpdate directly).
    // onUpdate receives the raw wallet-style status from getWalletStatus.
    startWatch(invoiceRef, onUpdate, intervalMs = 4000) {
        const id = typeof invoiceRef === 'object' ? invoiceRef.invoiceId : invoiceRef;
        if (this._watchers && this._watchers.has(id)) return;
        this._watchers = this._watchers || new Map();
        const timer = setInterval(async () => {
            try {
                const st = await this.getWalletStatus(id);
                onUpdate(st);
                if (st.complete || st._terminal) this.stopWatch(id);
            } catch (_) { /* keep polling */ }
        }, intervalMs);
        if (timer.unref) timer.unref();
        this._watchers.set(id, timer);
    }
    stopWatch(invoiceRef) {
        const id = typeof invoiceRef === 'object' ? invoiceRef.invoiceId : invoiceRef;
        if (this._watchers && this._watchers.has(id)) { clearInterval(this._watchers.get(id)); this._watchers.delete(id); }
    }
}

module.exports = BTCPayProvider;
