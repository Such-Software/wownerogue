const money = require('../money/atomic');

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/**
 * Finds recently expired invoices whose transfer may have mined after the browser watcher
 * stopped. It never confirms a payment or applies an entitlement: valid durable receipts are
 * attached to the expired payment and surfaced through payment_late_reviews for manual handling.
 */
class LatePaymentReconciler {
    constructor({ db, gameModeManager, walletService, logger = console,
        lookbackHours = 72, batchSize = 100 } = {}) {
        this.db = db;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.logger = logger;
        this.lookbackHours = boundedInteger(lookbackHours, 72, 1, 168);
        this.batchSize = boundedInteger(batchSize, 100, 1, 500);
        this.running = false;
    }

    async _nativeStatus(payment) {
        if (!this.walletService || typeof this.walletService.checkPaymentStatus !== 'function') {
            throw new Error('Native wallet receipt checker is unavailable');
        }
        const address = payment.subaddress;
        const priorUser = this.walletService.addressToUser?.get(address);
        const priorSocket = this.walletService.addressToSocket?.get(address);
        this.walletService.addressToUser?.set(address, {
            userId: String(payment.user_id),
            socketId: `late-reconcile:${payment.id}`,
            amount: money.toSafe(money.toBig(payment.expected_amount)),
            addressIndex: payment.address_index,
            accountIndex: this.walletService.accountIndex ?? 0,
            detected: false,
            confirmed: false,
            status: 'expired'
        });
        try {
            return await this.walletService.checkPaymentStatus(address);
        } finally {
            if (priorUser) this.walletService.addressToUser?.set(address, priorUser);
            else this.walletService.addressToUser?.delete(address);
            if (priorSocket !== undefined) this.walletService.addressToSocket?.set(address, priorSocket);
            else this.walletService.addressToSocket?.delete(address);
        }
    }

    async _status(payment) {
        const providerId = payment.provider_id || 'native-monero';
        if (providerId === 'native-monero') return this._nativeStatus(payment);
        const provider = this.gameModeManager?.paymentProviders?.get?.(providerId);
        if (!provider || typeof provider.getWalletStatus !== 'function') {
            throw new Error(`Payment provider ${providerId} cannot reconcile invoice status`);
        }
        return provider.getWalletStatus({
            invoiceId: payment.provider_invoice_id,
            address: payment.subaddress
        });
    }

    _stopExpiredWatch(payment) {
        const providerId = payment.provider_id || 'native-monero';
        const provider = this.gameModeManager?.paymentProviders?.get?.(providerId);
        const ref = providerId === 'native-monero'
            ? payment.subaddress
            : (payment.provider_invoice_id || payment.subaddress);
        try { provider?.stopWatch?.(ref); } catch (_) { /* best effort */ }
        try { this.walletService?.stopPaymentMonitoring?.(payment.subaddress); } catch (_) { /* best effort */ }
        this.walletService?.addressToUser?.delete(payment.subaddress);
        this.walletService?.addressToSocket?.delete(payment.subaddress);
    }

    async runOnce() {
        if (this.running) return { skipped: true, checked: 0, reviews: 0, errors: 0 };
        this.running = true;
        try {
            const candidates = await this.db.query(`
                SELECT id, user_id, status, subaddress, address_index, expected_amount,
                       provider_id, provider_invoice_id, expires_at
                FROM payments
                WHERE status IN ('pending', 'expired')
                  AND expires_at <= NOW()
                  AND expires_at >= NOW() - ($1::integer * INTERVAL '1 hour')
                  AND (late_receipt_checked_at IS NULL
                    OR late_receipt_checked_at < NOW() - INTERVAL '5 minutes')
                ORDER BY late_receipt_checked_at ASC NULLS FIRST, expires_at ASC
                LIMIT $2
            `, [this.lookbackHours, this.batchSize]);

            let checked = 0;
            let reviews = 0;
            let errors = 0;
            for (const payment of candidates.rows) {
                try {
                    const status = await this._status(payment);
                    const result = await this.gameModeManager.reconcileLatePaymentForReview(
                        payment.id,
                        Array.isArray(status?.receipts) ? status.receipts : []
                    );
                    if (result?.checked) {
                        checked += 1;
                        this._stopExpiredWatch(payment);
                    }
                    if (result?.needsReview) {
                        reviews += 1;
                        this.logger.warn?.(`[LatePayment] Payment ${payment.id} has durable late receipt evidence and requires review`);
                    }
                } catch (error) {
                    errors += 1;
                    this.logger.error?.(`[LatePayment] Reconciliation failed for payment ${payment.id}: ${error.message}`);
                }
            }
            return { skipped: false, checked, reviews, errors };
        } finally {
            this.running = false;
        }
    }
}

module.exports = LatePaymentReconciler;
