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
});
