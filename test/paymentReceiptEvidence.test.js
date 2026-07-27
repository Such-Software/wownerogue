const fs = require('fs');
const path = require('path');
const GameModeManager = require('../src/game/gameModeManager');

function chainReceipt(txHash, outputId, addressIndex, amount) {
    return {
        evidenceType: 'chain_output',
        evidenceId: `${txHash}:${outputId}`,
        providerId: 'native-monero',
        txHash,
        outputId,
        addressIndex,
        amount: String(amount),
        confirmed: true
    };
}

function receiptDb(rows) {
    const payments = new Map(rows.map(row => [row.id, { provider_id: 'native-monero', status: 'pending', ...row }]));
    const receipts = [];
    const client = {
        query: jest.fn(async (sql, params = []) => {
            if (/SELECT id, status, expected_amount/i.test(sql)) {
                const payment = payments.get(params[0]);
                return { rows: payment ? [{ ...payment }] : [] };
            }
            if (/INSERT INTO payment_receipts/i.test(sql)) {
                const candidate = {
                    payment_id: params[0], provider_id: params[1], evidence_type: params[2],
                    evidence_id: params[3], tx_hash: params[4], output_id: params[5],
                    address_index: params[6], amount: params[7]
                };
                const occupied = receipts.some(receipt => receipt.provider_id === candidate.provider_id
                    && receipt.evidence_id === candidate.evidence_id);
                if (!occupied) receipts.push(candidate);
                return { rows: [], rowCount: occupied ? 0 : 1 };
            }
            if (/COALESCE\(SUM\(amount\)/i.test(sql)) {
                const owned = receipts.filter(receipt => receipt.payment_id === params[0]
                    && receipt.provider_id === params[1]);
                const total = owned.reduce((sum, receipt) => sum + BigInt(receipt.amount), 0n);
                const hashes = owned.map(receipt => receipt.tx_hash).filter(Boolean).sort();
                return { rows: [{ total: total.toString(), primary_tx_hash: hashes[0] || null }] };
            }
            if (/UPDATE payments/i.test(sql)) {
                const payment = payments.get(params[0]);
                if (!payment || payment.status !== 'pending') return { rows: [] };
                payment.status = 'confirmed';
                payment.received_amount = params[1];
                payment.tx_hash = params[2];
                return { rows: [{ id: payment.id }] };
            }
            return { rows: [], rowCount: 0 };
        })
    };
    return {
        withTransaction: jest.fn(async callback => callback(client)),
        payments,
        receipts
    };
}

describe('durable incoming payment receipts', () => {
    test('one Monero transaction can confirm distinct invoice subaddresses, not the same output twice', async () => {
        const hash = 'a'.repeat(64);
        const outputOne = '1'.repeat(64);
        const outputTwo = '2'.repeat(64);
        const db = receiptDb([
            { id: 1, expected_amount: '100', address_index: 5 },
            { id: 2, expected_amount: '100', address_index: 6 },
            { id: 3, expected_amount: '100', address_index: 5 }
        ]);
        const manager = Object.create(GameModeManager.prototype);
        manager.db = db;

        await expect(manager.confirmSingleGamePayment(1, '100', [chainReceipt(hash, outputOne, 5, 100)]))
            .resolves.toEqual({ updated: true });
        await expect(manager.confirmSingleGamePayment(2, '100', [chainReceipt(hash, outputTwo, 6, 100)]))
            .resolves.toEqual({ updated: true });
        await expect(manager.confirmSingleGamePayment(3, '100', [chainReceipt(hash, outputOne, 5, 100)]))
            .rejects.toThrow(/do not cover/i);

        expect(db.payments.get(1).status).toBe('confirmed');
        expect(db.payments.get(2).status).toBe('confirmed');
        expect(db.payments.get(3).status).toBe('pending');
        expect(db.receipts).toHaveLength(2);
    });

    test('several confirmed top-ups can exactly cover one invoice', async () => {
        const db = receiptDb([{ id: 4, expected_amount: '100', address_index: 9 }]);
        const manager = Object.create(GameModeManager.prototype);
        manager.db = db;
        const result = await manager.confirmSingleGamePayment(4, '100', [
            chainReceipt('b'.repeat(64), '3'.repeat(64), 9, 40),
            chainReceipt('c'.repeat(64), '4'.repeat(64), 9, 60)
        ]);
        expect(result.updated).toBe(true);
        expect(db.receipts).toHaveLength(2);
        expect(db.payments.get(4).received_amount).toBe('100');
    });

    test('distinct outputs in one transaction to one subaddress sum once despite replay', async () => {
        const hash = 'd'.repeat(64);
        const first = chainReceipt(hash, '5'.repeat(64), 12, 40);
        const second = chainReceipt(hash, '6'.repeat(64), 12, 60);
        const db = receiptDb([{ id: 5, expected_amount: '100', address_index: 12 }]);
        const manager = Object.create(GameModeManager.prototype);
        manager.db = db;

        const result = await manager.confirmSingleGamePayment(5, '140', [first, second, { ...first }]);

        expect(result).toEqual({ updated: true });
        expect(db.receipts).toHaveLength(2);
        expect(db.payments.get(5).received_amount).toBe('100');
    });

    test('migration removes txid-only uniqueness and installs the output-scoped forward guard', () => {
        const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/037_payment_receipt_evidence.sql'), 'utf8');
        expect(sql).toMatch(/DROP INDEX IF EXISTS idx_payments_tx_hash_unique/i);
        expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+payments\s*\(\s*tx_hash\s*,\s*address_index\s*\)/i);
        expect(sql).toMatch(/ON\s+payment_receipts\s*\(\s*provider_id\s*,\s*evidence_id\s*\)/i);
        expect(sql).not.toMatch(/ON\s+payment_receipts\s*\(\s*tx_hash\s*,\s*address_index\s*\)/i);
        expect(sql).not.toMatch(/UNIQUE\s*\(subaddress\)/i);
        expect(sql).toMatch(/evidence_id\s*=\s*tx_hash\s*\|\|\s*':'\s*\|\|\s*output_id/i);
        expect(sql).toMatch(/OLD\.status IS DISTINCT FROM 'confirmed'/i);
        expect(sql).toMatch(/receipt_total < NEW\.expected_amount/i);
    });
});
