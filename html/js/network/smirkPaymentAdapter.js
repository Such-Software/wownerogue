/** Exact WOW invoices and conservative, once-only wallet submission. Backend receipts grant credits. */
(function(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SmirkPayments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const ATTEMPT_STORAGE = 'wowngeon_smirk_attempts_v1';
    const MAX_ATTEMPTS = 128;
    const STATES = new Set(['unknown', 'submitted', 'failed', 'cancelled', 'unavailable']);

    function paymentRequest(invoice, now = Date.now()) {
        if (!invoice || invoice.asset !== 'wow' || invoice.network !== 'mainnet') {
            throw new Error('Smirk requires an explicitly identified WOW mainnet invoice.');
        }
        if (!/^[1-9]\d*$/.test(String(invoice.paymentId || '')) ||
            !/^[1-9]\d*$/.test(String(invoice.ownerUserId || ''))) {
            throw new Error('Payment identity or account ownership is missing.');
        }
        const expiry = new Date(invoice.expiresAt).getTime();
        if (!invoice.expiresAt || !Number.isFinite(expiry) || expiry <= now) {
            throw new Error('This payment request is expired or has no valid expiry.');
        }
        // Wallet RPC owns checksum/nettype validation. Standard WOW addresses and RPC
        // subaddresses are both 97-character Cryptonote base58, including the WW family.
        if (typeof invoice.address !== 'string' || !/^W[1-9A-HJ-NP-Za-km-z]{96}$/.test(invoice.address)) {
            throw new Error('This invoice has no valid WOW recipient.');
        }
        // Never interpret an atomic-unit amount or rounded display label as whole WOW.
        const amount = invoice.humanAmount;
        if (typeof amount !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,11})?$/.test(amount)) {
            throw new Error('This invoice has no exact WOW decimal amount.');
        }
        const [whole, fraction = ''] = amount.split('.');
        const atomic = BigInt(whole) * 100000000000n + BigInt(fraction.padEnd(11, '0'));
        if (atomic <= 0n || !/^\d+$/.test(String(invoice.amount)) ||
            (typeof invoice.amount === 'number' && !Number.isSafeInteger(invoice.amount)) ||
            atomic !== BigInt(invoice.amount)) {
            throw new Error('The invoice decimal amount does not match its accounting amount.');
        }
        const memo = invoice.memo;
        if (typeof memo !== 'string' || !memo.trim() || memo.length > 256) {
            throw new Error('The invoice product description is missing or invalid.');
        }
        return { asset: 'wow', amount, address: invoice.address, memo };
    }

    function createAdapter(options = {}) {
        const now = options.now || (() => Date.now());
        const storage = options.storage;
        const withLock = options.withLock;
        const crypto = options.crypto || globalThis.crypto;
        function read() {
            if (!storage) throw new Error('Browser payment history is unavailable. Use manual payment before any wallet submission.');
            const raw = storage.getItem(ATTEMPT_STORAGE);
            const entries = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(entries) || entries.some(entry => !entry ||
                !STATES.has(entry.state) || !Number.isFinite(entry.expiresAt) ||
                typeof entry.fingerprint !== 'string' || !/^[1-9]\d*$/.test(entry.paymentId))) {
                throw new Error('Payment history cannot be read safely. Check invoice status before paying.');
            }
            return entries.filter(entry => entry.expiresAt > now());
        }
        function save(entries) {
            const serialized = JSON.stringify(entries);
            storage.setItem(ATTEMPT_STORAGE, serialized);
            if (storage.getItem(ATTEMPT_STORAGE) !== serialized) {
                throw new Error('Payment history could not be retained. No wallet payment was requested.');
            }
        }
        function status(invoice) {
            return read().find(entry => entry.paymentId === String(invoice.paymentId)) || null;
        }
        async function pay(invoice, wallet, admit = () => {}) {
            const request = paymentRequest(invoice, now());
            if (typeof wallet?.requestPayment !== 'function') throw new Error('This wallet does not support payment requests.');
            if (typeof withLock !== 'function' || !crypto?.subtle) {
                throw new Error('This browser cannot safely coordinate wallet payments across tabs. Use manual payment before any wallet submission.');
            }
            // Retain a digest, never an address, session token, signature or wallet key.
            const contract = JSON.stringify([String(invoice.ownerUserId), invoice.asset, invoice.network,
                request.amount, request.address, request.memo, invoice.expiresAt]);
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contract));
            const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            return withLock(ATTEMPT_STORAGE, async () => {
                // Recheck expiry after waiting for another tab or wallet approval.
                paymentRequest(invoice, now());
                admit();
                const entries = read();
                const previous = entries.find(entry => entry.paymentId === String(invoice.paymentId));
                if (previous) {
                    if (previous.fingerprint !== fingerprint) throw new Error('This invoice changed. Check its status before paying.');
                    return { state: previous.state, repeated: true };
                }
                if (entries.length >= MAX_ATTEMPTS) throw new Error('Too many active payment attempts. Check their status before paying again.');
                const entry = { paymentId: String(invoice.paymentId), expiresAt: new Date(invoice.expiresAt).getTime(),
                    fingerprint, state: 'unknown' };
                entries.push(entry);
                // Intent is durable before the call. A closed tab cannot turn ambiguity into retry.
                save(entries);
                try {
                    const result = await wallet.requestPayment(request);
                    if (result && typeof result === 'object' && result.success === true &&
                        typeof result.txid === 'string' && /^[0-9a-f]{64}$/i.test(result.txid)) {
                        entry.state = 'submitted';
                    } else if (result && typeof result === 'object' && result.success === false && !result.txid) {
                        entry.state = 'failed';
                    }
                } catch (error) {
                    if (error?.code === 'USER_REJECTED') entry.state = 'cancelled';
                    else if (['NOT_AUTHORIZED', 'UNSUPPORTED_ASSET', 'LOCKED'].includes(error?.code)) entry.state = 'unavailable';
                    // Transport errors can occur after submission. Never offer an automatic retry.
                }
                try { save(entries); } catch (_) { return { state: 'unknown' }; }
                return { state: entry.state };
            });
        }
        return { pay, status };
    }
    return { createAdapter, paymentRequest };
});
