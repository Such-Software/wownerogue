const fs = require('fs');
const path = require('path');
const createAdminRoutes = require('../src/routes/admin');
const AlertService = require('../src/services/alertService');

function makeRouter(db) {
    return createAdminRoutes({
        db,
        gameModeManager: {},
        walletRPCService: {},
        socketHandlers: {},
        io: {},
        alertService: null
    });
}

function handlerFor(router, method, routePath) {
    const layer = router.stack.find(item => item.route?.path === routePath
        && item.route.methods[method]);
    if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, req) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ status: this.statusCode, payload });
                return this;
            }
        };
        handler(req, res, reject);
    });
}

describe('admin financial operations visibility', () => {
    test.each(['processing', 'needs_review'])(
        'payout list accepts the %s filter and reports every operational total',
        async status => {
            const db = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [{
                        id: 7,
                        game_id: 8,
                        user_id: 9,
                        amount: '1200',
                        payout_address: 'address',
                        status,
                        tx_hash: null,
                        fee: null,
                        retry_count: 1,
                        last_error: 'ambiguous result',
                        created_at: new Date('2026-07-21T00:00:00Z'),
                        processed_at: null
                    }] })
                    .mockResolvedValueOnce({ rows: [{
                        pending_count: '1',
                        processing_count: '2',
                        failed_count: '3',
                        review_count: '4',
                        completed_count: '5',
                        permanently_failed_count: '6',
                        batched_count: '7',
                        total_volume: '8000'
                    }] })
            };
            const handler = handlerFor(makeRouter(db), 'get', '/api/admin/stats/payouts');

            const response = await invoke(handler, { query: { status } });

            expect(response.status).toBe(200);
            expect(db.query.mock.calls[0][1]).toEqual([50, 0, status]);
            expect(response.payload.payouts[0]).toMatchObject({ status, lastError: 'ambiguous result' });
            expect(response.payload.totals).toMatchObject({
                pending: 1,
                processing: 2,
                failed: 3,
                needsReview: 4,
                completed: 5,
                permanentlyFailed: 6,
                batched: 7
            });
        }
    );

    test('refund attention filter lists requested, processing, and needs_review rows', async () => {
        const db = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{
                    id: 11,
                    payment_id: 12,
                    user_id: 13,
                    payment_status: 'refunded',
                    status: 'needs_review',
                    amount: '900',
                    payout_address: 'refund-address',
                    credits_deducted: '2',
                    purchase_progress_deducted: '2',
                    race_entries_deducted: 0,
                    tx_hash: null,
                    error_message: 'wallet outcome unknown',
                    reason: 'operator request',
                    created_at: new Date('2026-07-21T00:00:00Z'),
                    updated_at: new Date('2026-07-21T00:01:00Z')
                }] })
                .mockResolvedValueOnce({ rows: [{
                    recorded_count: '1',
                    requested_count: '2',
                    processing_count: '3',
                    completed_count: '4',
                    review_count: '5',
                    completed_volume: '600'
                }] })
        };
        const handler = handlerFor(makeRouter(db), 'get', '/api/admin/stats/refunds');

        const response = await invoke(handler, { query: { status: 'attention' } });

        expect(db.query.mock.calls[0][1]).toEqual([
            50,
            0,
            ['requested', 'processing', 'needs_review']
        ]);
        expect(response.payload.refunds[0]).toMatchObject({
            id: 11,
            status: 'needs_review',
            error: 'wallet outcome unknown'
        });
        expect(response.payload.totals).toMatchObject({
            recorded: 1,
            requested: 2,
            processing: 3,
            completed: 4,
            needsReview: 5
        });
    });

    test('dashboard sends the retry endpoint its required explicit confirmation', () => {
        const html = fs.readFileSync(path.join(__dirname, '../html/admin.html'), 'utf8');
        const retryFunction = html.match(/async function retryPayout[\s\S]*?async function loadRefunds/)[0];

        expect(retryFunction).toContain("'Content-Type': 'application/json'");
        expect(retryFunction).toContain('body: JSON.stringify({ confirm: true })');
        expect(html).toContain('<option value="processing">Processing</option>');
        expect(html).toContain('<option value="needs_review">Needs Review</option>');
        expect(html).toContain('id="refundStatusFilter"');
    });
});

describe('financial review alerts', () => {
    let logSpy;
    let errorSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('alerts for manual-review and stale nonterminal rows without mutating them', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [{
            payout_review_count: '2',
            refund_review_count: '1',
            stale_payout_processing_count: '1',
            stale_refund_nonterminal_count: '2'
        }] }) };
        const service = new AlertService({ db, walletService: null, debugManager: {} });
        service.sendAlert = jest.fn().mockResolvedValue({ sent: true });
        service.resolveAlert = jest.fn().mockResolvedValue({ sent: false });

        await service.checkFinancialReviewRows();

        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][1]).toEqual([service.financialReviewStaleMs]);
        expect(service.sendAlert).toHaveBeenCalledWith(
            'financial_needs_review',
            expect.objectContaining({ level: 'crit' })
        );
        expect(service.sendAlert).toHaveBeenCalledWith(
            'financial_nonterminal_stale',
            expect.objectContaining({ level: 'crit' })
        );
        expect(service.resolveAlert).not.toHaveBeenCalled();
        expect(db.query.mock.calls[0][0]).not.toMatch(/\bUPDATE\b/i);
    });

    test('resolves both aggregate alerts after all review queues clear', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [{
            payout_review_count: '0',
            refund_review_count: '0',
            stale_payout_processing_count: '0',
            stale_refund_nonterminal_count: '0'
        }] }) };
        const service = new AlertService({ db, walletService: null, debugManager: {} });
        service.sendAlert = jest.fn();
        service.resolveAlert = jest.fn().mockResolvedValue({ sent: true });

        await service.checkFinancialReviewRows();

        expect(service.sendAlert).not.toHaveBeenCalled();
        expect(service.resolveAlert).toHaveBeenCalledWith('financial_needs_review');
        expect(service.resolveAlert).toHaveBeenCalledWith('financial_nonterminal_stale');
    });

    test('periodic checks include the financial review query', async () => {
        const service = new AlertService({ db: {}, walletService: null, debugManager: {} });
        service.checkWalletBalance = jest.fn().mockResolvedValue();
        service.checkWalletConnection = jest.fn().mockResolvedValue();
        service.checkPendingPayouts = jest.fn().mockResolvedValue();
        service.checkFinancialReviewRows = jest.fn().mockResolvedValue();

        await service.runChecks();

        expect(service.checkFinancialReviewRows).toHaveBeenCalledTimes(1);
    });
});
