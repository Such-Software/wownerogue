'use strict';

const fs = require('fs');
const path = require('path');
const FinancialEventExporter = require('../src/services/financialEventExporter');
const {
    buildFinancialEvent,
    sourceSnapshotFromPayment,
    DELIVERY_CONTRACT
} = FinancialEventExporter;

const ENV = {
    NODE_ENV: 'production',
    CRYPTO_TYPE: 'WOW',
    MONERO_NETWORK: 'mainnet',
    FINANCIAL_EVENT_SINK_URL: 'https://accounting.example.test/api/events/wowngeon',
    FINANCIAL_EVENT_SINK_TOKEN: 'a'.repeat(64),
    FINANCIAL_EVENT_ACCOUNT_REF: 'wowngeon:receipts',
    FINANCIAL_EVENT_BATCH_SIZE: '2'
};

const PAYMENT = {
    id: 22,
    payment_type: 'credits_package',
    expected_amount: '900000000000',
    received_amount: '900000000000',
    confirmed_at: '2026-07-22T14:30:00Z',
    provider_id: 'native-monero',
    product_id: 'small',
    receipts: [{
        evidence_type: 'chain_output',
        evidence_id: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
        payout_address: 'wallet-address-must-not-escape'
    }]
};

function paymentClaim(overrides = {}) {
    return {
        id: 5,
        event_id: 'payment-confirmed-22',
        event_kind: 'payment.confirmed',
        source_type: 'payment',
        source_id: 22,
        aggregate_id: 22,
        payload_snapshot: sourceSnapshotFromPayment(PAYMENT),
        delivery_payload: null,
        attempts: 1,
        ...overrides
    };
}

function healthRows(overrides = {}) {
    return { rows: [{ backlog: '0', dead_letters: '0', ignored_rows: '0', ...overrides }] };
}

function standardDb({ claims = [paymentClaim()], onQuery } = {}) {
    const queue = [...claims];
    const db = {
        query: jest.fn(async (sql, params = []) => {
            if (onQuery) {
                const custom = await onQuery(sql, params);
                if (custom) return custom;
            }
            if (/attempts >= \$1/i.test(sql)) return { rows: [], rowCount: 0 };
            if (/RETURNING id, event_id, event_kind/i.test(sql)) {
                const next = queue.shift();
                return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
            }
            if (/SET delivery_payload = \$2::jsonb/i.test(sql)) {
                return { rows: [{ delivery_payload: JSON.parse(params[1]) }], rowCount: 1 };
            }
            if (/SET status = 'delivered'/i.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 };
            if (/COUNT\(\*\) FILTER/i.test(sql)) return healthRows();
            return { rows: [], rowCount: 0 };
        })
    };
    return db;
}

describe('financial event payload snapshots', () => {
    test('builds a backend-neutral, unpriced WOW receipt without customer or wallet data', () => {
        const source = sourceSnapshotFromPayment(PAYMENT);
        const event = buildFinancialEvent(source, ENV);

        expect(event).toEqual(expect.objectContaining({
            schema: 'financial-event/v1',
            id: 'payment-confirmed-22',
            producer: 'wowngeon',
            product: 'wowngeon',
            activity: 'customer-payment',
            account_refs: ['wowngeon:receipts'],
            amounts: {},
            attributes: expect.objectContaining({
                valuation_required: true,
                atomic_amount: '900000000000',
                atomic_decimals: 11,
                receipt_count: 1
            })
        }));
        expect(event.legs[0]).toEqual(expect.objectContaining({
            asset: 'WOW', quantity: '9', direction: 'in', usd_value: '0'
        }));
        expect(JSON.stringify(source)).not.toContain(PAYMENT.receipts[0].evidence_id);
        expect(JSON.stringify({ source, event })).not.toMatch(
            /user_id|socket_id|ip_address|subaddress|payout_address|provider_invoice_id|wallet-address-must-not-escape/i
        );
    });

    test('exports only the immutable snapshot after the payment becomes mutable/refunded', async () => {
        const snapshot = sourceSnapshotFromPayment(PAYMENT);
        const mutatedPayment = { ...PAYMENT, status: 'refunded', received_amount: '1' };
        const db = standardDb({ claims: [paymentClaim({ payload_snapshot: snapshot })] });
        const fetchFn = jest.fn(async () => ({ ok: true, status: 201 }));
        const exporter = new FinancialEventExporter({ db, env: ENV, fetchFn, logger: { warn: jest.fn() } });

        await expect(exporter.runOnce()).resolves.toEqual({
            skipped: false, delivered: 1, deferred: 0, deadLettered: 0, ignored: 0
        });
        const delivered = JSON.parse(fetchFn.mock.calls[0][1].body);
        expect(delivered.attributes.atomic_amount).toBe('900000000000');
        expect(mutatedPayment.received_amount).toBe('1');
        expect(db.query.mock.calls.some(([sql]) => /FROM payments\b/i.test(sql))).toBe(false);
    });

    test.each([
        ['recorded', 'customer-payment-reversal'],
        ['completed', 'customer-refund']
    ])('exports final %s refund as an outgoing leg', (refundStatus, activity) => {
        const event = buildFinancialEvent({
            schema: 'financial-event-source/v1',
            event_id: 'payment-refund-91',
            event_kind: 'payment.refund',
            source_type: 'payment_refund',
            source_id: 91,
            aggregate_id: 22,
            occurred_at: '2026-07-22T15:00:00Z',
            atomic_amount: '450000000000',
            refund_status: refundStatus
        }, ENV);

        expect(event).toEqual(expect.objectContaining({
            id: 'payment-refund-91',
            activity,
            attributes: expect.objectContaining({ refund_status: refundStatus })
        }));
        expect(event.legs).toEqual([expect.objectContaining({
            quantity: '4.5', direction: 'out', asset: 'WOW'
        })]);
    });

    test.each(['requested', 'processing', 'needs_review'])('refuses non-final %s refund snapshots', status => {
        expect(() => buildFinancialEvent({
            schema: 'financial-event-source/v1',
            event_id: 'payment-refund-91',
            event_kind: 'payment.refund',
            source_type: 'payment_refund',
            source_id: 91,
            aggregate_id: 22,
            occurred_at: '2026-07-22T15:00:00Z',
            atomic_amount: '1',
            refund_status: status
        }, ENV)).toThrow(/final exportable state/);
    });

    test('rejects PII-shaped account references and credential-bearing sink URLs', () => {
        expect(() => buildFinancialEvent(sourceSnapshotFromPayment(PAYMENT), {
            ...ENV,
            FINANCIAL_EVENT_ACCOUNT_REF: 'customer@example.invalid'
        })).toThrow(/non-PII/);
        expect(() => new FinancialEventExporter({
            db: { query: jest.fn() },
            env: { ...ENV, FINANCIAL_EVENT_SINK_URL: 'https://user:pass@accounting.example.test/events' },
            fetchFn: jest.fn()
        })).toThrow(/must not embed credentials/);
    });
});

describe('at-least-once financial event delivery', () => {
    test('uses one stable idempotency key and stored body when the durable acknowledgement is retried', async () => {
        const claim1 = paymentClaim({ attempts: 1 });
        let storedPayload = null;
        let claimNumber = 0;
        let acknowledgementNumber = 0;
        const db = standardDb({
            claims: [],
            onQuery: async (sql, params) => {
                if (/RETURNING id, event_id, event_kind/i.test(sql)) {
                    claimNumber += 1;
                    if (claimNumber === 1) return { rows: [claim1], rowCount: 1 };
                    if (claimNumber === 2) return { rows: [], rowCount: 0 };
                    if (claimNumber === 3) {
                        return { rows: [{ ...claim1, attempts: 2, delivery_payload: storedPayload }], rowCount: 1 };
                    }
                    return { rows: [], rowCount: 0 };
                }
                if (/SET delivery_payload = \$2::jsonb/i.test(sql)) {
                    storedPayload = JSON.parse(params[1]);
                    return { rows: [{ delivery_payload: storedPayload }], rowCount: 1 };
                }
                if (/SET status = 'delivered'/i.test(sql)) {
                    acknowledgementNumber += 1;
                    if (acknowledgementNumber === 1) throw new Error('database acknowledgement unavailable');
                    return { rows: [{ id: params[0] }], rowCount: 1 };
                }
                return null;
            }
        });
        const fetchFn = jest.fn(async () => ({ ok: true, status: 202 }));
        const exporter = new FinancialEventExporter({ db, env: ENV, fetchFn, logger: { warn: jest.fn() } });

        await expect(exporter.runOnce()).resolves.toEqual(expect.objectContaining({ deferred: 1 }));
        await expect(exporter.runOnce()).resolves.toEqual(expect.objectContaining({ delivered: 1 }));

        expect(fetchFn).toHaveBeenCalledTimes(2);
        const first = fetchFn.mock.calls[0][1];
        const second = fetchFn.mock.calls[1][1];
        expect(first.headers['idempotency-key']).toBe('payment-confirmed-22');
        expect(second.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
        expect(second.body).toBe(first.body);
        expect(DELIVERY_CONTRACT).toEqual(expect.objectContaining({ guarantee: 'at-least-once' }));
        expect(exporter.getDeliveryContract().deduplication).toMatch(/Idempotency-Key/);
    });

    test('bounds repeated failures and moves the last attempt to dead letter', async () => {
        const db = standardDb({
            claims: [paymentClaim({ attempts: 2 })],
            onQuery: async (sql, params) => {
                if (/SET status = 'dead_letter'/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
                    return { rows: [{ id: params[0] }], rowCount: 1 };
                }
                if (/COUNT\(\*\) FILTER/i.test(sql)) return healthRows({ backlog: '0', dead_letters: '1' });
                return null;
            }
        });
        const fetchFn = jest.fn(async () => ({ ok: false, status: 503 }));
        const exporter = new FinancialEventExporter({
            db,
            env: { ...ENV, FINANCIAL_EVENT_MAX_ATTEMPTS: '2' },
            fetchFn,
            logger: { warn: jest.fn() }
        });

        await expect(exporter.runOnce()).resolves.toEqual({
            skipped: false, delivered: 0, deferred: 0, deadLettered: 1, ignored: 0
        });
        expect(exporter.getHealth()).toEqual(expect.objectContaining({
            attempted: 1, deadLettered: 1, deadLetters: 1, backlog: 0
        }));
        expect(exporter.getPublicHealth()).toEqual(expect.objectContaining({
            contract: 'at-least-once', deadLettered: 1, deadLetters: 1, backlog: 0
        }));
        expect(JSON.stringify(exporter.getPublicHealth())).not.toMatch(
            /accounting\.example|authorization|token|lastError|event_id|payment-confirmed/i
        );
    });

    test('malformed stored snapshots fail closed and dead-letter without an HTTP attempt', async () => {
        const malformed = paymentClaim({
            attempts: 1,
            payload_snapshot: { ...paymentClaim().payload_snapshot, occurred_at: null }
        });
        const db = standardDb({
            claims: [malformed],
            onQuery: async (sql, params) => {
                if (/SET status = 'dead_letter'/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
                    return { rows: [{ id: params[0] }], rowCount: 1 };
                }
                return null;
            }
        });
        const fetchFn = jest.fn();
        const exporter = new FinancialEventExporter({
            db,
            env: { ...ENV, FINANCIAL_EVENT_MAX_ATTEMPTS: '1' },
            fetchFn,
            logger: { warn: jest.fn() }
        });

        await expect(exporter.runOnce()).resolves.toEqual(expect.objectContaining({ deadLettered: 1 }));
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe('non-mainnet suppression and migration safety', () => {
    test('keeps backlog counters current when the optional mainnet sink is disabled', async () => {
        const db = {
            query: jest.fn(async sql => {
                if (/COUNT\(\*\) FILTER/i.test(sql)) {
                    return healthRows({ backlog: '7', dead_letters: '2', ignored_rows: '1' });
                }
                throw new Error(`unexpected SQL: ${sql}`);
            })
        };
        const exporter = new FinancialEventExporter({
            db,
            env: { NODE_ENV: 'production', CRYPTO_TYPE: 'WOW', MONERO_NETWORK: 'mainnet' },
            fetchFn: jest.fn(),
            logger: { warn: jest.fn() }
        });

        await expect(exporter.runOnce()).resolves.toEqual({
            skipped: true, delivered: 0, deferred: 0, deadLettered: 0, ignored: 0
        });
        expect(exporter.getPublicHealth()).toEqual(expect.objectContaining({
            enabled: false, backlog: 7, deadLetters: 2, ignoredRows: 1
        }));
        expect(exporter.start()).toBe(true);
        exporter.stop();
    });

    test.each(['stagenet', 'testnet'])('continuously suppresses XMR %s rows without a configured sink', async network => {
        const db = {
            query: jest.fn(async sql => {
                if (/ignored_reason = 'non_mainnet_network'/i.test(sql)) {
                    return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
                }
                if (/COUNT\(\*\) FILTER/i.test(sql)) return healthRows({ ignored_rows: '2' });
                throw new Error(`unexpected SQL: ${sql}`);
            })
        };
        const fetchFn = jest.fn();
        const exporter = new FinancialEventExporter({
            db,
            env: { NODE_ENV: 'production', CRYPTO_TYPE: 'XMR', MONERO_NETWORK: network },
            fetchFn,
            logger: { warn: jest.fn() }
        });

        await expect(exporter.runOnce()).resolves.toEqual({
            skipped: false, delivered: 0, deferred: 0, deadLettered: 0, ignored: 2
        });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(exporter.getHealth()).toEqual(expect.objectContaining({
            exportAllowed: false, ignored: 2, ignoredRows: 2
        }));
        const suppressionSql = db.query.mock.calls.find(([sql]) =>
            /ignored_reason = 'non_mainnet_network'/i.test(sql)
        )[0];
        expect(suppressionSql).toMatch(/lease_until = NULL/i);
        expect(suppressionSql).toMatch(/dead_lettered_at = NULL/i);
        expect(suppressionSql).toMatch(/status IN \('pending', 'in_flight', 'dead_letter'\)/i);
    });

    test('does not dead-letter an actively leased attempt from another worker', () => {
        const source = fs.readFileSync(path.join(
            __dirname, '../src/services/financialEventExporter.js'
        ), 'utf8');
        expect(source).toMatch(
            /status = 'in_flight' AND lease_until < NOW\(\)[\s\S]*RETURNING id/
        );
    });

    test('wires sanitized exporter counters into public health without a readiness dependency', () => {
        const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
        expect(indexSource).toMatch(
            /health\.financialEvents = financialEventExporter\.getPublicHealth\(\)/
        );
        expect(indexSource).not.toMatch(
            /ready\s*=\s*[^;\n]*financialEventExporter|getPublicHealth\(\)[^;\n]*ready/i
        );
    });

    test('042 corrects 041 without rereading at delivery or exporting unsettled refunds', () => {
        const migration = fs.readFileSync(path.join(
            __dirname, '../src/migrations/042_immutable_financial_event_snapshots.sql'
        ), 'utf8');

        expect(migration).toMatch(/payload_snapshot JSONB/i);
        expect(migration).toMatch(/delivery_payload JSONB/i);
        expect(migration).toMatch(/COALESCE\(p\.confirmed_at, p\.created_at, o\.created_at, NOW\(\)\)/i);
        expect(migration).toMatch(/malformed_legacy_snapshot/i);
        expect(migration).toMatch(/NEW\.status IN \('recorded', 'completed'\)/i);
        expect(migration).toMatch(/WHERE r\.status IN \('recorded', 'completed'\)/i);
        expect(migration).not.toMatch(/WHERE r\.status IN \([^)]*needs_review/i);
        expect(migration).toMatch(/reject_financial_event_identity_mutation/i);
        expect(migration).toMatch(
            /payload_snapshot->>'event_id'\) IS NOT DISTINCT FROM event_id/i
        );
        expect(migration).toMatch(
            /delivery_payload->>'id'\) IS NOT DISTINCT FROM event_id/i
        );
        expect(migration).toMatch(/OLD\.delivery_payload IS NOT NULL[\s\S]*NEW\.delivery_payload IS DISTINCT/i);
        expect(migration).toMatch(
            /OLD\.delivery_payload IS NULL AND NEW\.delivery_payload IS NOT NULL[\s\S]*OLD\.status IS DISTINCT FROM 'in_flight'/i
        );
        expect(migration).not.toMatch(/payout_address|subaddress|provider_invoice_id|evidence_id|tx_hash/i);
    });
});
