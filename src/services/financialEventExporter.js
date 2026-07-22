'use strict';

const { getProfile } = require('../chain/chainProfile');
const money = require('../money/atomic');

const PLACEHOLDER = /(change[_-]?me|replace[_-]?with|example|password|secret)/i;
const ACCOUNT_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DELIVERY_CONTRACT = Object.freeze({
    guarantee: 'at-least-once',
    deduplication: 'Idempotency-Key equals the immutable financial event id',
    acknowledgement: 'delivery is complete only after a 2xx response is durably recorded'
});

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function isoTimestamp(value) {
    if (value == null || (typeof value === 'string' && !value.trim())) {
        throw new Error('Financial event has no valid timestamp');
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Financial event has no valid timestamp');
    return date.toISOString();
}

function safeText(value, maxLength = 300) {
    return String(value ?? '').slice(0, maxLength);
}

function parseJsonObject(value, label) {
    let parsed = value;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (_) { throw new Error(`${label} is not valid JSON`); }
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`${label} is not an object`);
    }
    return parsed;
}

function sourceSnapshotFromPayment(payment) {
    if (!payment || payment.id == null) throw new Error('Payment identity is required');
    return {
        schema: 'financial-event-source/v1',
        event_id: `payment-confirmed-${payment.id}`,
        event_kind: 'payment.confirmed',
        source_type: 'payment',
        source_id: payment.id,
        aggregate_id: payment.id,
        occurred_at: payment.confirmed_at,
        atomic_amount: String(payment.received_amount ?? payment.expected_amount ?? 0),
        payment_type: safeText(payment.payment_type, 40),
        product_id: safeText(payment.product_id, 100),
        provider_id: safeText(payment.provider_id, 100),
        receipt_count: Array.isArray(payment.receipts) ? payment.receipts.length : 0
    };
}

function networkIdentity(profile, env) {
    const network = safeText(env.MONERO_NETWORK || 'mainnet', 30).trim().toLowerCase();
    return profile.id === 'WOW' ? 'wownero:mainnet' : `monero:${network}`;
}

function buildFinancialEvent(sourceOrPayment, env = process.env) {
    const source = sourceOrPayment?.schema === 'financial-event-source/v1'
        ? parseJsonObject(sourceOrPayment, 'Financial event source snapshot')
        : sourceSnapshotFromPayment(sourceOrPayment);
    if (!source.event_id || !source.event_kind || source.source_id == null) {
        throw new Error('Financial event source identity is incomplete');
    }

    const profile = getProfile(env.CRYPTO_TYPE || 'WOW');
    const atomic = money.toBig(source.atomic_amount ?? 0);
    const isRefund = source.event_kind === 'payment.refund';
    if ((!isRefund && atomic <= 0n) || (isRefund && atomic < 0n)) {
        throw new Error('Financial event has an invalid atomic amount');
    }
    if (!isRefund && source.event_kind !== 'payment.confirmed') {
        throw new Error('Unsupported financial event kind');
    }

    const accountRef = String(env.FINANCIAL_EVENT_ACCOUNT_REF || 'wowngeon:receipts').trim();
    if (!ACCOUNT_REF.test(accountRef)) throw new Error('Invalid non-PII financial event account reference');
    const refundStatus = safeText(source.refund_status, 20);
    if (isRefund && !['recorded', 'completed'].includes(refundStatus)) {
        throw new Error('Refund snapshot is not in a final exportable state');
    }

    const sourceRef = isRefund
        ? `payment-refund-${source.source_id}`
        : `payment-${source.aggregate_id}`;
    const event = {
        schema: 'financial-event/v1',
        id: safeText(source.event_id, 120),
        occurred_at: isoTimestamp(source.occurred_at),
        producer: 'wowngeon',
        product: 'wowngeon',
        activity: isRefund
            ? (refundStatus === 'completed' ? 'customer-refund' : 'customer-payment-reversal')
            : 'customer-payment',
        account_refs: [accountRef],
        provenance: [{
            kind: isRefund ? 'wowngeon-refund' : 'wowngeon-payment',
            ref: sourceRef
        }],
        amounts: {},
        legs: [{
            asset: profile.symbol,
            quantity: money.format(atomic, profile.decimals),
            direction: isRefund ? 'out' : 'in',
            network: networkIdentity(profile, env),
            account_ref: accountRef,
            usd_value: '0',
            price_source: '',
            price_confidence: ''
        }],
        memo: isRefund
            ? 'Final customer refund/reversal; USD valuation is required before accounting confirmation.'
            : 'Confirmed customer payment; USD valuation is required before accounting confirmation.',
        attributes: {
            valuation_required: true,
            atomic_amount: atomic.toString(),
            atomic_decimals: profile.decimals,
            source_type: safeText(source.source_type, 32),
            source_id: safeText(source.source_id, 40),
            aggregate_id: safeText(source.aggregate_id, 40)
        }
    };

    if (isRefund) {
        event.attributes.refund_status = refundStatus;
    } else {
        event.attributes.payment_type = safeText(source.payment_type, 40);
        event.attributes.product_id = safeText(source.product_id, 100);
        event.attributes.provider_id = safeText(source.provider_id, 100);
        event.attributes.receipt_count = boundedInteger(source.receipt_count, 0, 0, 1000000);
    }
    return event;
}

function countValue(row, name) {
    const value = Number.parseInt(String(row?.[name] ?? '0'), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
        this.maxAttempts = boundedInteger(env.FINANCIAL_EVENT_MAX_ATTEMPTS, 8, 1, 100);
        this.running = false;
        this.timer = null;
        this.profile = getProfile(env.CRYPTO_TYPE || 'WOW');
        this.network = safeText(env.MONERO_NETWORK || 'mainnet', 30).trim().toLowerCase();
        this.exportAllowed = this.network === 'mainnet';
        this.health = {
            contract: DELIVERY_CONTRACT.guarantee,
            enabled: this.enabled,
            exportAllowed: this.exportAllowed,
            running: false,
            runs: 0,
            attempted: 0,
            delivered: 0,
            deferred: 0,
            deadLettered: 0,
            ignored: 0,
            backlog: 0,
            deadLetters: 0,
            ignoredRows: 0,
            lastRunAt: null,
            lastSuccessAt: null,
            lastError: null
        };

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
        if (parsed.username || parsed.password) {
            throw new Error('Financial event sink URL must not embed credentials');
        }
        if (this.token.length < 32 || PLACEHOLDER.test(this.token)) {
            throw new Error('Financial event sink token must be a strong non-placeholder secret');
        }
    }

    getDeliveryContract() {
        return { ...DELIVERY_CONTRACT };
    }

    getHealth() {
        return { ...this.health, running: this.running };
    }

    // Safe for the unauthenticated liveness payload: no endpoint, token, account reference,
    // row/event identifiers, error text, or timestamps.  These counters are informational and
    // deliberately do not participate in application readiness.
    getPublicHealth() {
        const health = this.getHealth();
        return {
            contract: DELIVERY_CONTRACT.guarantee,
            enabled: health.enabled,
            exportAllowed: health.exportAllowed,
            running: health.running,
            backlog: health.backlog,
            deadLetters: health.deadLetters,
            ignoredRows: health.ignoredRows,
            delivered: health.delivered,
            deferred: health.deferred,
            deadLettered: health.deadLettered,
            ignored: health.ignored
        };
    }

    async _suppressUnsafeNetwork() {
        const result = await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'ignored', lease_until = NULL, delivered_at = NULL,
                ignored_at = NOW(), ignored_reason = 'non_mainnet_network',
                dead_lettered_at = NULL, last_error = NULL, updated_at = NOW()
            WHERE status IN ('pending', 'in_flight', 'dead_letter')
            RETURNING id
        `);
        return result.rowCount ?? result.rows?.length ?? 0;
    }

    async _deadLetterExhausted() {
        const result = await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'dead_letter', lease_until = NULL,
                dead_lettered_at = COALESCE(dead_lettered_at, NOW()),
                last_error = COALESCE(last_error, 'Maximum delivery attempts exhausted'),
                updated_at = NOW()
            WHERE attempts >= $1
              AND (status = 'pending' OR (status = 'in_flight' AND lease_until < NOW()))
            RETURNING id
        `, [this.maxAttempts]);
        return result.rowCount ?? result.rows?.length ?? 0;
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
                  AND attempts < $1
                  AND (status = 'pending' OR (status = 'in_flight' AND lease_until < NOW()))
                ORDER BY created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, event_id, event_kind, source_type, source_id, aggregate_id,
                      payload_snapshot, delivery_payload, attempts
        `, [this.maxAttempts]);
        return result.rows[0] || null;
    }

    async _ensureDeliveryPayload(claim) {
        if (claim.delivery_payload) {
            const existing = parseJsonObject(claim.delivery_payload, 'Stored financial event payload');
            if (existing.id !== claim.event_id) throw new Error('Stored financial event id is inconsistent');
            return existing;
        }

        const snapshot = parseJsonObject(claim.payload_snapshot, 'Financial event source snapshot');
        if (snapshot.event_id !== claim.event_id || snapshot.event_kind !== claim.event_kind) {
            throw new Error('Financial event source identity is inconsistent');
        }
        const payload = buildFinancialEvent(snapshot, this.env);
        const result = await this.db.query(`
            UPDATE financial_event_outbox
            SET delivery_payload = $2::jsonb, updated_at = NOW()
            WHERE id = $1 AND status = 'in_flight' AND delivery_payload IS NULL
            RETURNING delivery_payload
        `, [claim.id, JSON.stringify(payload)]);
        if (!result.rows[0]?.delivery_payload) {
            throw new Error('Financial event payload could not be durably initialized');
        }
        return parseJsonObject(result.rows[0].delivery_payload, 'Stored financial event payload');
    }

    async _deliver(claim) {
        const payload = await this._ensureDeliveryPayload(claim);
        const response = await this.fetchFn(this.endpoint, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json',
                'idempotency-key': claim.event_id
            },
            body: JSON.stringify(payload),
            redirect: 'manual',
            signal: AbortSignal.timeout(10000)
        });
        if (!response || !response.ok) {
            throw new Error(`Financial event sink returned HTTP ${response?.status || 0}`);
        }
        const result = await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'delivered', delivered_at = NOW(), lease_until = NULL,
                last_error = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'in_flight'
            RETURNING id
        `, [claim.id]);
        if ((result.rowCount ?? result.rows?.length ?? 0) !== 1) {
            throw new Error('Financial event delivery acknowledgement was not durably recorded');
        }
    }

    async _retry(claim, error) {
        const message = safeText(error?.message || 'Financial event delivery failed', 500);
        if (Number(claim.attempts || 0) >= this.maxAttempts) {
            const result = await this.db.query(`
                UPDATE financial_event_outbox
                SET status = 'dead_letter', lease_until = NULL,
                    dead_lettered_at = NOW(), last_error = $2, updated_at = NOW()
                WHERE id = $1 AND status = 'in_flight'
                RETURNING id
            `, [claim.id, message]);
            const changed = (result.rowCount ?? result.rows?.length ?? 0) === 1;
            if (changed) this.logger.warn?.(`[FinancialEvent] Delivery ${claim.id} moved to dead letter: ${message}`);
            return { deadLettered: changed };
        }

        const seconds = Math.min(3600, 30 * (2 ** Math.min(Number(claim.attempts || 1) - 1, 7)));
        await this.db.query(`
            UPDATE financial_event_outbox
            SET status = 'pending', lease_until = NULL,
                next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
                last_error = $3, updated_at = NOW()
            WHERE id = $1 AND status = 'in_flight'
        `, [claim.id, seconds, message]);
        this.logger.warn?.(`[FinancialEvent] Delivery ${claim.id} deferred: ${message}`);
        return { deadLettered: false };
    }

    async _refreshHealth() {
        const result = await this.db.query(`
            SELECT
                COUNT(*) FILTER (WHERE status IN ('pending', 'in_flight')) AS backlog,
                COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letters,
                COUNT(*) FILTER (WHERE status = 'ignored') AS ignored_rows
            FROM financial_event_outbox
        `);
        const row = result.rows[0] || {};
        this.health.backlog = countValue(row, 'backlog');
        this.health.deadLetters = countValue(row, 'dead_letters');
        this.health.ignoredRows = countValue(row, 'ignored_rows');
    }

    async runOnce() {
        if (this.running) {
            return { skipped: true, delivered: 0, deferred: 0, deadLettered: 0, ignored: 0 };
        }
        this.running = true;
        this.health.running = true;
        this.health.runs += 1;
        this.health.lastRunAt = new Date().toISOString();
        let delivered = 0;
        let deferred = 0;
        let deadLettered = 0;
        let ignored = 0;
        let succeeded = false;
        let healthRefreshed = true;
        try {
            if (!this.exportAllowed) {
                ignored = await this._suppressUnsafeNetwork();
                this.health.ignored += ignored;
                succeeded = true;
                return { skipped: false, delivered, deferred, deadLettered, ignored };
            }
            if (!this.enabled) {
                succeeded = true;
                return { skipped: true, delivered, deferred, deadLettered, ignored };
            }

            deadLettered += await this._deadLetterExhausted();
            for (let index = 0; index < this.batchSize; index += 1) {
                const claim = await this._claim();
                if (!claim) break;
                this.health.attempted += 1;
                try {
                    await this._deliver(claim);
                    delivered += 1;
                } catch (error) {
                    const retry = await this._retry(claim, error);
                    if (retry.deadLettered) deadLettered += 1;
                    else deferred += 1;
                }
            }
            this.health.delivered += delivered;
            this.health.deferred += deferred;
            this.health.deadLettered += deadLettered;
            succeeded = true;
            return { skipped: false, delivered, deferred, deadLettered, ignored };
        } catch (error) {
            this.health.lastError = safeText(error?.message || error, 500);
            throw error;
        } finally {
            try {
                await this._refreshHealth();
            } catch (healthError) {
                healthRefreshed = false;
                this.health.lastError = safeText(healthError?.message || healthError, 500);
                this.logger.warn?.(`[FinancialEvent] Health counters unavailable: ${this.health.lastError}`);
            }
            if (succeeded && healthRefreshed) {
                this.health.lastSuccessAt = new Date().toISOString();
                this.health.lastError = null;
            }
            this.running = false;
            this.health.running = false;
        }
    }

    start() {
        // Poll even without a sink: public health must show a real backlog, and non-mainnet
        // deployments must continuously suppress newly appended rows.
        if (this.timer) return false;
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
module.exports.sourceSnapshotFromPayment = sourceSnapshotFromPayment;
module.exports.DELIVERY_CONTRACT = DELIVERY_CONTRACT;
