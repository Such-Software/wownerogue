const FinancialEventExporter = require('../src/services/financialEventExporter');
const { buildFinancialEvent } = FinancialEventExporter;

const ENV = {
    NODE_ENV: 'production',
    CRYPTO_TYPE: 'WOW',
    MONERO_NETWORK: 'mainnet',
    FINANCIAL_EVENT_SINK_URL: 'https://accounting.example.test/api/events/wowngeon',
    FINANCIAL_EVENT_SINK_TOKEN: 'a'.repeat(64),
    FINANCIAL_EVENT_ACCOUNT_REF: 'wowngeon:receipts'
};

const PAYMENT = {
    id: 22,
    payment_type: 'credits_package',
    expected_amount: '900000000000',
    received_amount: '900000000000',
    confirmed_at: '2026-07-22T14:30:00Z',
    provider_id: 'native-monero',
    product_id: 'small',
    receipts: [{ evidence_type: 'chain_output', evidence_id: `${'a'.repeat(64)}:${'b'.repeat(64)}` }]
};

describe('financial event exporter', () => {
    test('builds a backend-neutral, unpriced WOW receipt without customer data', () => {
        const event = buildFinancialEvent(PAYMENT, ENV);

        expect(event).toEqual(expect.objectContaining({
            schema: 'financial-event/v1',
            id: 'payment-22',
            producer: 'wowngeon',
            product: 'wowngeon',
            activity: 'customer-payment',
            account_refs: ['wowngeon:receipts'],
            amounts: {},
            attributes: expect.objectContaining({
                valuation_required: true,
                atomic_amount: '900000000000',
                atomic_decimals: 11
            })
        }));
        expect(event.legs[0]).toEqual(expect.objectContaining({
            asset: 'WOW', quantity: '9', direction: 'in', usd_value: '0'
        }));
        expect(JSON.stringify(event)).not.toMatch(/user|email|address_index/i);
    });

    test('claims and delivers one durable outbox row', async () => {
        const db = {
            query: jest.fn(async (sql) => {
                if (/RETURNING id, aggregate_id, attempts/i.test(sql)) {
                    return db.claimed ? { rows: [] } : (db.claimed = true, { rows: [{ id: 5, aggregate_id: 22, attempts: 1 }] });
                }
                if (/FROM payments p/i.test(sql)) return { rows: [PAYMENT] };
                return { rows: [] };
            })
        };
        const fetchFn = jest.fn(async () => ({ ok: true, status: 201 }));
        const exporter = new FinancialEventExporter({ db, env: ENV, fetchFn, logger: { warn: jest.fn() } });

        await expect(exporter.runOnce()).resolves.toEqual({ skipped: false, delivered: 1, deferred: 0 });
        expect(fetchFn).toHaveBeenCalledWith(ENV.FINANCIAL_EVENT_SINK_URL, expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ authorization: `Bearer ${ENV.FINANCIAL_EVENT_SINK_TOKEN}` })
        }));
        expect(db.query.mock.calls.some(([sql]) => /SET status = 'delivered'/i.test(sql))).toBe(true);
    });

    test('refuses to export stagenet value into production accounting', () => {
        expect(() => new FinancialEventExporter({
            db: { query: jest.fn() },
            env: { ...ENV, CRYPTO_TYPE: 'XMR', MONERO_NETWORK: 'stagenet' },
            fetchFn: jest.fn()
        })).toThrow(/must not be exported/);
    });
});
