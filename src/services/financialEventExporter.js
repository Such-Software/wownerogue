const { getProfile } = require('../chain/chainProfile');
const money = require('../money/atomic');

const PLACEHOLDER = /(change[_-]?me|replace[_-]?with|example|password|secret)/i;

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function isoTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Confirmed payment has no valid timestamp');
    return date.toISOString();
}

function receiptProvenance(receipts, paymentId) {
    const rows = Array.isArray(receipts) ? receipts : [];
    const normalized = rows.map((receipt) => ({
        kind: receipt.evidence_type === 'chain_output' ? 'monero-output' : 'provider-invoice',
        ref: String(receipt.evidence_id || '').slice(0, 500)
    })).filter((item) => item.ref);
    return normalized.length > 0
        ? normalized
        : [{ kind: 'wowngeon-payment', ref: String(paymentId) }];
}

function buildFinancialEvent(payment, env = process.env) {
    if (!payment || payment.id == null) throw new Error('Payment identity is required');
    const profile = getProfile(env.CRYPTO_TYPE || 'WOW');
    const atomic = money.toBig(payment.received_amount || payment.expected_amount || 0);
    if (atomic <= 0n) throw new Error('Confirmed payment has no positive received amount');
    const networkName = profile.id === 'WOW'
        ? 'wownero:mainnet'
        : `monero:${String(env.MONERO_NETWORK || 'mainnet').toLowerCase()}`;
    const accountRef = String(env.FINANCIAL_EVENT_ACCOUNT_REF || 'wowngeon:receipts').trim();
    if (!accountRef || accountRef.length > 300) throw new Error('Invalid financial event account reference');

    return {
        schema: 'financial-event/v1',
        id: `payment-${payment.id}`,
        occurred_at: isoTimestamp(payment.confirmed_at),
        producer: 'wowngeon',
        product: 'wowngeon',
        activity: 'customer-payment',
        account_refs: [accountRef],
        provenance: receiptProvenance(payment.receipts, payment.id),
        amounts: {},
        legs: [{
            asset: profile.symbol,
            quantity: money.format(atomic, profile.decimals),
            direction: 'in',
            network: networkName,
            account_ref: accountRef,
            usd_value: '0',
            price_source: '',
            price_confidence: ''
        }],
        memo: 'Confirmed customer payment; USD valuation is required before accounting confirmation.',
        attributes: {
            valuation_required: true,
            atomic_amount: atomic.toString(),
            atomic_decimals: profile.decimals,
            payment_type: String(payment.payment_type || ''),
            product_id: String(payment.product_id || ''),
            provider_id: String(payment.provider_id || ''),
            receipt_count: Array.isArray(payment.receipts) ? payment.receipts.length : 0
        }
    };
}

class FinancialEventExporter {
    constructor({ db, env = process.env, fetchFn = global.fetch, logger = console } = {}) {
        if (!db) throw new Error('FinancialEventExporter requires db');
        this.db = db;
        this.env = env;
        this.fetchFn = fetchFn;
        this.logger = logger;
        this.endpoint = String(env.FINANCIAL_EVENT_SINK_URL || '').trim();
        this.token = String(env.FINANCIAL_EVENT_SINK_TOKEN || '').trim();
        this.enabled = Boolean(this.endpoint || this.token);
        this.intervalMs = boundedInteger(env.FINANCIAL_EVENT_POLL_MS, 60000, 5000, 3600000);
        this.batchSize = boundedInteger(env.FINANCIAL_EVENT_BATCH_SIZE, 20, 1, 100);
        this.running = false;
        this.timer = null;

        if (Boolean(this.endpoint) !== Boolean(this.token)) {
            throw new Error('Financial event sink URL and token must be configured together');
        }
        if (!this.enabled) return;
        if (typeof this.fetchFn !== 'function') throw new Error('Financial event HTTP transport is unavailable');
        let parsed;
        try { parsed = new URL(this.endpoint); } catch (_) { throw new Error('Financial event sink URL is invalid'); }
        if (!['http:', 'https:'].includes(parsed.protocol)
            || (String(env.NODE_ENV).toLowerCase() === 'production' && parsed.protocol !== 'https:')) {
            throw new Error('Financial event sink must use HTTPS in production');
        }
        if (this.token.length < 32 || PLACEHOLDER.test(this.token)) {
            throw new Error('Financial event sink token must be a strong non-placeholder secret');
        }
        const profile = getProfile(env.CRYPTO_TYPE || 'WOW');
        const network = String(env.MONERO_NETWORK || 'mainnet').toLowerCase();
        if ((profile.id === 'XMR' && network !== 'mainnet') || profile.id === 'WOW' && network !== 'mainnet') {
            throw new Error('Testnet and stagenet payments must not be exported as financial events');
        }
    }

    async _claim() {
        const result = await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'in_flight', attempts = attempts + 1,
                lease_until = NOW() + INTERVAL '5 minutes', updated_at = NOW()
            WHERE id = (
                SELECT id FROM financial_event_outbox
                WHERE delivered_at IS NULL
                  AND next_attempt_at <= NOW()
                  AND (status = 'pending' OR (status = 'in_flight' AND lease_until < NOW()))
                ORDER BY created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, aggregate_id, attempts
        `);
        return result.rows[0] || null;
    }

    async _loadPayment(paymentId) {
        const result = await this.db.query(`
            SELECT p.id, p.payment_type, p.expected_amount, p.received_amount,
                   p.confirmed_at, p.provider_id, p.product_id,
                   COALESCE(json_agg(json_build_object(
                       'evidence_type', r.evidence_type,
                       'evidence_id', r.evidence_id
                   ) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS receipts
            FROM payments p
            LEFT JOIN payment_receipts r ON r.payment_id = p.id AND r.confirmed = TRUE
            WHERE p.id = $1 AND p.status = 'confirmed'
            GROUP BY p.id
        `, [paymentId]);
        if (!result.rows[0]) throw new Error('Outbox payment is missing or no longer confirmed');
        return result.rows[0];
    }

    async _deliver(claim) {
        const payment = await this._loadPayment(claim.aggregate_id);
        const payload = buildFinancialEvent(payment, this.env);
        const response = await this.fetchFn(this.endpoint, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify(payload),
            redirect: 'manual',
            signal: AbortSignal.timeout(10000)
        });
        if (!response || !response.ok) {
            throw new Error(`Financial event sink returned HTTP ${response?.status || 0}`);
        }
        await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'delivered', delivered_at = NOW(), lease_until = NULL,
                last_error = NULL, updated_at = NOW()
            WHERE id = $1
        `, [claim.id]);
    }

    async _retry(claim, error) {
        const seconds = Math.min(3600, 30 * (2 ** Math.min(Number(claim.attempts || 1) - 1, 7)));
        const message = String(error?.message || 'Financial event delivery failed').slice(0, 500);
        await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'pending', lease_until = NULL,
                next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
                last_error = $3, updated_at = NOW()
            WHERE id = $1
        `, [claim.id, seconds, message]);
        this.logger.warn?.(`[FinancialEvent] Delivery ${claim.id} deferred: ${message}`);
    }

    async runOnce() {
        if (!this.enabled || this.running) return { skipped: true, delivered: 0, deferred: 0 };
        this.running = true;
        let delivered = 0;
        let deferred = 0;
        try {
            for (let index = 0; index < this.batchSize; index += 1) {
                const claim = await this._claim();
                if (!claim) break;
                try {
                    await this._deliver(claim);
                    delivered += 1;
                } catch (error) {
                    await this._retry(claim, error);
                    deferred += 1;
                }
            }
            return { skipped: false, delivered, deferred };
        } finally {
            this.running = false;
        }
    }

    start() {
        if (!this.enabled || this.timer) return false;
        this.runOnce().catch((error) => this.logger.warn?.(`[FinancialEvent] Export tick failed: ${error.message}`));
        this.timer = setInterval(() => {
            this.runOnce().catch((error) => this.logger.warn?.(`[FinancialEvent] Export tick failed: ${error.message}`));
        }, this.intervalMs);
        this.timer.unref?.();
        return true;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = FinancialEventExporter;
module.exports.buildFinancialEvent = buildFinancialEvent;
