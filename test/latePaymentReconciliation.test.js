const GameModeManager = require('../src/game/gameModeManager');
const LatePaymentReconciler = require('../src/services/latePaymentReconciler');

describe('late incoming payment reconciliation', () => {
    test('bounded scanner sends an expired native receipt only to manual review', async () => {
        const row = {
            id: 7,
            user_id: 3,
            status: 'expired',
            subaddress: 'late-address',
            address_index: 11,
            expected_amount: '100',
            provider_id: 'native-monero',
            provider_invoice_id: 'late-address'
        };
        const db = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
        const receipt = {
            evidenceType: 'chain_output', providerId: 'native-monero',
            txHash: 'a'.repeat(64), outputId: 'b'.repeat(64),
            evidenceId: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
            addressIndex: 11, amount: '100', confirmed: true
        };
        const walletService = {
            accountIndex: 0,
            addressToUser: new Map(),
            addressToSocket: new Map(),
            checkPaymentStatus: jest.fn(async address => {
                expect(address).toBe('late-address');
                expect(walletService.addressToUser.get(address)).toEqual(expect.objectContaining({
                    amount: 100,
                    addressIndex: 11
                }));
                return { confirmed: true, complete: true, amount: 100, receipts: [receipt] };
            }),
            stopPaymentMonitoring: jest.fn()
        };
        const gameModeManager = {
            paymentProviders: { get: jest.fn(() => null) },
            reconcileLatePaymentForReview: jest.fn().mockResolvedValue({ checked: true, needsReview: true })
        };
        const service = new LatePaymentReconciler({
            db, gameModeManager, walletService, lookbackHours: 24, batchSize: 20,
            logger: { warn: jest.fn(), error: jest.fn() }
        });

        const result = await service.runOnce();

        expect(result).toEqual({ skipped: false, checked: 1, reviews: 1, errors: 0 });
        expect(db.query.mock.calls[0][1]).toEqual([24, 20]);
        expect(gameModeManager.reconcileLatePaymentForReview).toHaveBeenCalledWith(7, [receipt]);
        expect(walletService.addressToUser.has('late-address')).toBe(false);
        expect(walletService.stopPaymentMonitoring).toHaveBeenCalledWith('late-address');
    });

    test.each([
        ['missing status', undefined],
        ['missing receipts', { complete: false }],
        ['non-array receipts', { receipts: null }],
        ['malformed receipts', { receipts: {} }],
        ['nonfinal positive without receipts', { in_mempool: true, confirmed: false, complete: false, receipts: [] }],
        ['confirmed without receipts', { confirmed: true, complete: true, receipts: [] }],
        ['complete without confirmation', { confirmed: false, complete: true, receipts: [] }],
        ['receipts without confirmation', { confirmed: false, complete: false, receipts: [{}] }]
    ])('does not mark the invoice scanned on %s', async (_case, status) => {
        const row = {
            id: 9, user_id: 3, status: 'expired', subaddress: 'late-address',
            address_index: 11, expected_amount: '100', provider_id: 'native-monero'
        };
        const walletService = {
            accountIndex: 0, addressToUser: new Map(), addressToSocket: new Map(),
            checkPaymentStatus: jest.fn().mockResolvedValue(status),
            stopPaymentMonitoring: jest.fn()
        };
        const gameModeManager = {
            reconcileLatePaymentForReview: jest.fn(), paymentProviders: { get: jest.fn() }
        };
        const service = new LatePaymentReconciler({
            db: { query: jest.fn().mockResolvedValue({ rows: [row] }) },
            gameModeManager, walletService,
            logger: { warn: jest.fn(), error: jest.fn() }
        });

        expect(await service.runOnce()).toEqual({ skipped: false, checked: 0, reviews: 0, errors: 1 });
        expect(gameModeManager.reconcileLatePaymentForReview).not.toHaveBeenCalled();
        expect(walletService.stopPaymentMonitoring).not.toHaveBeenCalled();
        expect(walletService.addressToUser.has(row.subaddress)).toBe(false);
    });

    test('gateway status alone cannot establish an empty historical receipt scan', async () => {
        const provider = { getWalletStatus: jest.fn().mockResolvedValue({
            _terminal: true, confirmed: false, complete: false, receipts: []
        }) };
        const gameModeManager = {
            paymentProviders: { get: jest.fn(() => provider) },
            reconcileLatePaymentForReview: jest.fn()
        };
        const service = new LatePaymentReconciler({
            db: { query: jest.fn().mockResolvedValue({ rows: [{
                id: 13, user_id: 3, subaddress: 'gateway-address',
                address_index: 0, expected_amount: '100', provider_id: 'btcpay',
                provider_invoice_id: 'gateway-invoice'
            }] }) },
            gameModeManager,
            logger: { warn: jest.fn(), error: jest.fn() }
        });

        expect(await service.runOnce()).toEqual({ skipped: false, checked: 0, reviews: 0, errors: 1 });
        expect(gameModeManager.reconcileLatePaymentForReview).not.toHaveBeenCalled();
    });

    test('does not log upstream response text from a failed gateway receipt read', async () => {
        const privateMarker = 'untrusted-provider-response-canary';
        const provider = { getWalletStatus: jest.fn().mockRejectedValue(new Error(privateMarker)) };
        const logger = { warn: jest.fn(), error: jest.fn() };
        const service = new LatePaymentReconciler({
            db: { query: jest.fn().mockResolvedValue({ rows: [{
                id: 14, user_id: 3, subaddress: 'gateway-address',
                address_index: 0, expected_amount: '100', provider_id: 'btcpay',
                provider_invoice_id: 'gateway-invoice'
            }] }) },
            gameModeManager: {
                paymentProviders: { get: jest.fn(() => provider) },
                reconcileLatePaymentForReview: jest.fn()
            },
            logger
        });

        expect(await service.runOnce()).toEqual({ skipped: false, checked: 0, reviews: 0, errors: 1 });
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0][0].includes(privateMarker)).toBe(false);
    });

    test('does not advance the marker when the wallet read rejects', async () => {
        const walletService = {
            accountIndex: 0, addressToUser: new Map(), addressToSocket: new Map(),
            checkPaymentStatus: jest.fn().mockRejectedValue(new Error('wallet unavailable')),
            stopPaymentMonitoring: jest.fn()
        };
        const gameModeManager = { reconcileLatePaymentForReview: jest.fn() };
        const service = new LatePaymentReconciler({
            db: { query: jest.fn().mockResolvedValue({ rows: [{
                id: 10, user_id: 3, subaddress: 'late-address',
                address_index: 11, expected_amount: '100', provider_id: 'native-monero'
            }] }) },
            gameModeManager, walletService,
            logger: { warn: jest.fn(), error: jest.fn() }
        });

        expect(await service.runOnce()).toEqual({ skipped: false, checked: 0, reviews: 0, errors: 1 });
        expect(gameModeManager.reconcileLatePaymentForReview).not.toHaveBeenCalled();
        expect(walletService.stopPaymentMonitoring).not.toHaveBeenCalled();
    });

    test('a successful empty receipt list advances the scan without a review', async () => {
        const walletService = {
            accountIndex: 0, addressToUser: new Map(), addressToSocket: new Map(),
            checkPaymentStatus: jest.fn().mockResolvedValue({
                complete: false, confirmed: false, receipts: []
            }),
            stopPaymentMonitoring: jest.fn()
        };
        const gameModeManager = {
            reconcileLatePaymentForReview: jest.fn().mockResolvedValue({ checked: true, needsReview: false })
        };
        const service = new LatePaymentReconciler({
            db: { query: jest.fn().mockResolvedValue({ rows: [{
                id: 11, user_id: 3, subaddress: 'late-address',
                address_index: 11, expected_amount: '100', provider_id: 'native-monero'
            }] }) },
            gameModeManager, walletService,
            logger: { warn: jest.fn(), error: jest.fn() }
        });

        expect(await service.runOnce()).toEqual({ skipped: false, checked: 1, reviews: 0, errors: 0 });
        expect(gameModeManager.reconcileLatePaymentForReview).toHaveBeenCalledWith(11, []);
    });

    test('durable late receipt stays expired and creates review without any entitlement write', async () => {
        const calls = [];
        const client = {
            query: jest.fn(async (sql, params = []) => {
                calls.push({ sql, params });
                if (/SELECT id, status, expected_amount/i.test(sql)) {
                    return { rows: [{
                        id: 8, status: 'expired', expected_amount: '100',
                        provider_id: 'native-monero', address_index: 12
                    }] };
                }
                if (/COALESCE\(SUM\(amount\)/i.test(sql)) {
                    return { rows: [{ total: '100', primary_tx_hash: 'c'.repeat(64), receipt_count: '1' }] };
                }
                if (/INSERT INTO payment_late_reviews/i.test(sql)) {
                    return { rows: [{ status: 'needs_review' }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            })
        };
        const manager = Object.create(GameModeManager.prototype);
        manager.db = { withTransaction: async callback => callback(client) };
        const outputId = 'd'.repeat(64);
        const receipt = {
            evidenceType: 'chain_output', providerId: 'native-monero',
            txHash: 'c'.repeat(64), outputId,
            evidenceId: `${'c'.repeat(64)}:${outputId}`,
            addressIndex: 12, amount: '100', confirmed: true
        };

        const result = await manager.reconcileLatePaymentForReview(8, [receipt]);

        expect(result).toEqual(expect.objectContaining({
            checked: true,
            needsReview: true,
            coverageComplete: true
        }));
        expect(calls.some(call => /INSERT INTO payment_receipts/i.test(call.sql))).toBe(true);
        expect(calls.some(call => /INSERT INTO payment_late_reviews/i.test(call.sql))).toBe(true);
        expect(calls.some(call => /SET status = CASE WHEN status = 'pending' THEN 'expired'/i.test(call.sql))).toBe(true);
        expect(calls.some(call => /UPDATE users|payment_entitlement_grants|credit_transactions/i.test(call.sql))).toBe(false);
    });

    test('the manager refuses missing evidence before starting a transaction', async () => {
        const manager = Object.create(GameModeManager.prototype);
        manager.db = { withTransaction: jest.fn() };
        await expect(manager.reconcileLatePaymentForReview(12)).rejects.toThrow();
        expect(manager.db.withTransaction).not.toHaveBeenCalled();
    });
});
