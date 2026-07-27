const PaymentRefundService = require('../src/services/paymentRefundService');

function clone(value) {
    return value == null ? value : { ...value };
}

class Mutex {
    constructor() {
        this.locked = false;
        this.waiters = [];
    }

    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return () => this.release();
        }
        return new Promise(resolve => this.waiters.push(resolve));
    }

    release() {
        const next = this.waiters.shift();
        if (next) {
            next(() => this.release());
        } else {
            this.locked = false;
        }
    }
}

/** Minimal transactional DB double implementing only the refund service's SQL. */
class FakeRefundDb {
    constructor({ payment, user, grant = null, raceLot = null, packEntitlements = [], refund = null }) {
        this.payment = clone(payment);
        this.user = clone(user);
        this.grant = clone(grant);
        this.raceLot = clone(raceLot);
        this.packEntitlements = packEntitlements.map(clone);
        this.raceTransactions = [];
        this.refund = clone(refund);
        this.creditTransactions = [];
        this.paymentUpdateCount = 0;
        this.nextRefundId = refund?.id ? Number(refund.id) + 1 : 1;
        this.paymentLock = new Mutex();
    }

    async getClient() {
        const db = this;
        let unlock = null;
        return {
            async query(text, params = []) {
                const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
                if (sql === 'begin') return { rows: [] };
                if (sql === 'commit' || sql === 'rollback') {
                    unlock?.();
                    unlock = null;
                    return { rows: [] };
                }
                if (sql.includes('select p.*') && sql.includes('from payments p')) {
                    unlock = await db.paymentLock.acquire();
                    return { rows: db.payment && Number(db.payment.id) === Number(params[0]) ? [clone(db.payment)] : [] };
                }
                if (sql.includes('from payment_refunds') && sql.includes('for update')) {
                    return { rows: db.refund ? [clone(db.refund)] : [] };
                }
                if (sql.includes('select id, credits, race_entries') && sql.includes('from users')) {
                    return { rows: db.user && Number(db.user.id) === Number(params[0]) ? [clone(db.user)] : [] };
                }
                if (sql.includes('from payment_entitlement_grants') && sql.includes('for update')) {
                    return { rows: db.grant ? [clone(db.grant)] : [] };
                }
                if (sql.startsWith('select id from games')) return { rows: [] };
                if (sql.startsWith('update users') && sql.includes('credits = credits -')) {
                    db.user.credits = (BigInt(db.user.credits) - BigInt(params[0])).toString();
                    db.user.total_credits_purchased = (BigInt(db.user.total_credits_purchased) - BigInt(params[1])).toString();
                    db.user.race_entries -= Number(params[2]);
                    db.user.premium_level = params[3];
                    return { rows: [clone(db.user)] };
                }
                if (sql.startsWith('insert into credit_transactions')) {
                    db.creditTransactions.push({
                        user_id: params[0],
                        amount: params[1],
                        reason: params[2],
                        balance_after: params[3],
                        transaction_type: 'refund'
                    });
                    return { rows: [] };
                }
                if (sql.startsWith('insert into race_entry_transactions')) {
                    db.raceTransactions.push({ delta: params[1], payment_id: params[3] });
                    return { rows: [] };
                }
                if (sql.startsWith('update payment_entitlement_grants')) {
                    if (sql.includes("status = 'needs_review'")) {
                        db.grant.status = 'needs_review';
                        db.grant.needs_review_at = new Date();
                    } else {
                        db.grant.status = 'reversed';
                        db.grant.credits_reversed = params[1];
                        db.grant.purchase_progress_reversed = params[2];
                        db.grant.race_entries_reversed = params[3];
                        db.grant.reversed_at = new Date();
                    }
                    return { rows: [clone(db.grant)], rowCount: 1 };
                }
                if (sql.includes('from race_entry_lots')) return { rows: db.raceLot ? [clone(db.raceLot)] : [] };
                if (sql.startsWith('update race_entry_lots')) {
                    if (!db.raceLot || db.raceLot.refunded_at != null
                        || db.raceLot.remaining_entries !== db.raceLot.original_entries) return { rows: [], rowCount: 0 };
                    db.raceLot.remaining_entries = 0;
                    db.raceLot.refunded_at = new Date();
                    return { rows: [{ id: db.raceLot.id }], rowCount: 1 };
                }
                if (sql.includes('from user_pack_entitlements') && sql.includes('for update')) {
                    return { rows: db.packEntitlements.map(clone) };
                }
                if (sql.startsWith('delete from user_pack_entitlements')) {
                    const wanted = new Set(params[1]);
                    const removed = db.packEntitlements.filter(row => wanted.has(row.pack_id)
                        && String(row.metadata?.paymentId) === String(params[2]));
                    db.packEntitlements = db.packEntitlements.filter(row => !removed.includes(row));
                    return { rows: removed.map(row => ({ pack_id: row.pack_id })), rowCount: removed.length };
                }
                if (sql.startsWith('update payments')) {
                    db.payment.status = 'refunded';
                    db.paymentUpdateCount += 1;
                    return { rows: [] };
                }
                if (sql.startsWith('insert into payment_refunds')) {
                    const needsReview = sql.includes("'needs_review'");
                    db.refund = {
                        id: db.nextRefundId++,
                        payment_id: params[0],
                        user_id: params[1],
                        status: needsReview ? 'needs_review' : params[2],
                        amount: needsReview ? params[2] : params[3],
                        payout_address: needsReview ? params[3] : params[4],
                        credits_deducted: needsReview ? '0' : params[5],
                        purchase_progress_deducted: needsReview ? '0' : params[6],
                        race_entries_deducted: needsReview ? 0 : params[7],
                        packs_revoked: needsReview ? [] : JSON.parse(params[8]),
                        premium_level_restored: needsReview ? null : params[9],
                        reason: needsReview ? params[4] : params[10],
                        tx_hash: null,
                        error_message: needsReview ? params[5] : null,
                        requested_at: needsReview || params[2] === 'requested' ? new Date() : null,
                        processing_started_at: null,
                        completed_at: null,
                        needs_review_at: needsReview ? new Date() : null
                    };
                    return { rows: [clone(db.refund)] };
                }
                throw new Error(`Unexpected transaction SQL: ${sql}`);
            },
            release() {
                unlock?.();
                unlock = null;
            }
        };
    }

    async query(text, params = []) {
        const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (sql.startsWith('update payment_refunds') && sql.includes("set status = 'processing'")) {
            if (!this.refund || Number(this.refund.payment_id) !== Number(params[0]) || this.refund.status !== 'requested') {
                return { rows: [] };
            }
            this.refund.status = 'processing';
            this.refund.processing_started_at = new Date();
            this.refund.error_message = null;
            return { rows: [clone(this.refund)] };
        }
        if (sql.startsWith('update payment_refunds') && sql.includes("set status = 'completed'")) {
            if (!this.refund || Number(this.refund.id) !== Number(params[0]) || this.refund.status !== 'processing') {
                return { rows: [] };
            }
            this.refund.status = 'completed';
            this.refund.tx_hash = params[1];
            this.refund.completed_at = new Date();
            this.refund.error_message = null;
            return { rows: [clone(this.refund)] };
        }
        if (sql.startsWith('update payment_refunds') && sql.includes("set status = 'needs_review'")) {
            if (!this.refund || Number(this.refund.id) !== Number(params[0]) || this.refund.status !== 'processing') {
                return { rows: [] };
            }
            this.refund.status = 'needs_review';
            this.refund.tx_hash = params[1] || this.refund.tx_hash;
            this.refund.error_message = params[2];
            this.refund.needs_review_at = new Date();
            return { rows: [clone(this.refund)] };
        }
        if (sql.startsWith('select *') && sql.includes('from payment_refunds')) {
            return { rows: this.refund && Number(this.refund.payment_id) === Number(params[0]) ? [clone(this.refund)] : [] };
        }
        throw new Error(`Unexpected pool SQL: ${sql}`);
    }
}

function fixture(overrides = {}) {
    return new FakeRefundDb({
        payment: {
            id: 42,
            user_id: 7,
            expected_amount: '1000',
            received_amount: '900',
            credits_purchased: '6',
            status: 'confirmed',
            description: 'Credits purchase',
            ...overrides.payment
        },
        user: {
            id: 7,
            credits: '6',
            race_entries: 0,
            total_credits_purchased: '6',
            premium_level: 'free',
            payout_address: '5'.repeat(95),
            ...overrides.user
        },
        grant: overrides.grant === undefined ? {
            payment_id: 42,
            user_id: 7,
            source: 'product_confirmation',
            credits_granted: '6',
            purchase_progress_granted: '6',
            race_entries_granted: 0,
            packs_granted: [],
            premium_level_granted: null,
            premium_level_previous: null,
            status: 'active'
        } : overrides.grant,
        raceLot: overrides.raceLot || null,
        packEntitlements: overrides.packEntitlements || [],
        refund: overrides.refund || null
    });
}

describe('PaymentRefundService', () => {
    test('the global payout gate refuses an automatic refund before any durable or wallet side effect', async () => {
        const db = fixture();
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({
            db,
            walletService,
            logger,
            isSendEnabled: () => false
        });

        await expect(service.refundPayment({ paymentId: 42, sendFunds: true }))
            .rejects.toMatchObject({ code: 'PAYOUT_DISPATCH_DISABLED', statusCode: 503 });
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.refund).toBeNull();
        expect(db.paymentUpdateCount).toBe(0);
    });

    test('a kill switch raised after the refund claim prevents the wallet call and strands safely for review', async () => {
        const db = fixture();
        const walletService = { processPayout: jest.fn() };
        const isSendEnabled = jest.fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const service = new PaymentRefundService({
            db,
            walletService,
            logger,
            isSendEnabled
        });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(isSendEnabled).toHaveBeenCalledTimes(2);
    });

    const txHash = 'a'.repeat(64);
    const logger = { error: jest.fn() };

    beforeEach(() => logger.error.mockClear());

    test('concurrent transfer requests deduct and broadcast exactly once', async () => {
        const db = fixture();
        const walletService = {
            processPayout: jest.fn().mockResolvedValue({ success: true, txHash })
        };
        const service = new PaymentRefundService({ db, walletService, logger });

        const results = await Promise.all([
            service.refundPayment({ paymentId: 42, reason: 'duplicate request', sendFunds: true }),
            service.refundPayment({ paymentId: 42, reason: 'duplicate request', sendFunds: true })
        ]);

        expect(walletService.processPayout).toHaveBeenCalledTimes(1);
        expect(db.paymentUpdateCount).toBe(1);
        expect(db.payment.description).toBe('Credits purchase');
        expect(db.user.credits).toBe('0');
        expect(db.user.total_credits_purchased).toBe('0');
        expect(db.creditTransactions).toHaveLength(1);
        expect(db.creditTransactions[0].amount).toBe('-6');
        expect(db.refund.status).toBe('completed');
        expect(db.refund.amount).toBe('900');
        expect(db.refund.tx_hash).toBe(txHash);
        expect(results.filter(result => result.existing)).toHaveLength(1);
    });

    test('reverses exact purchase progress and a premium tier granted solely by the payment', async () => {
        const Entitlements = require('../src/multiplayer/entitlements');
        const db = fixture({
            user: {
                credits: '6',
                total_credits_purchased: '6',
                premium_level: 'supporter'
            },
            grant: {
                payment_id: 42,
                user_id: 7,
                source: 'product_confirmation',
                credits_granted: '6',
                purchase_progress_granted: '6',
                race_entries_granted: 0,
                packs_granted: [],
                premium_level_granted: 'supporter',
                premium_level_previous: 'free',
                status: 'active'
            }
        });
        const before = Entitlements.snapshotForUser(db.user);
        expect(before.packs['generated-skins']).toBe(true);
        const service = new PaymentRefundService({ db, walletService: null, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: false });
        const after = Entitlements.snapshotForUser(db.user);

        expect(result.refund.status).toBe('recorded');
        expect(db.user.credits).toBe('0');
        expect(db.user.total_credits_purchased).toBe('0');
        expect(db.user.premium_level).toBe('free');
        expect(after.packs['generated-skins']).toBe(false);
        expect(db.grant).toEqual(expect.objectContaining({
            status: 'reversed',
            credits_reversed: '6',
            purchase_progress_reversed: '6'
        }));
        expect(db.refund).toEqual(expect.objectContaining({
            credits_deducted: '6',
            purchase_progress_deducted: '6',
            premium_level_restored: 'free'
        }));
    });

    test('changed purchase progress routes the whole refund to review without revoking benefits', async () => {
        const db = fixture({ user: { credits: '6', total_credits_purchased: '5' } });
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.error_message).toContain('progression cannot be reversed safely');
        expect(db.user.credits).toBe('6');
        expect(db.user.total_credits_purchased).toBe('5');
        expect(db.payment.status).toBe('confirmed');
        expect(walletService.processPayout).not.toHaveBeenCalled();
    });

    test('an unconsumed direct entry with unscoped purchase progress cannot auto-refund', async () => {
        const db = fixture({
            payment: { payment_type: 'single_game', credits_purchased: '0' },
            user: { credits: '0', total_credits_purchased: '1' },
            grant: null
        });
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.error_message).toContain('purchase progression requires manual reconciliation');
        expect(db.user.total_credits_purchased).toBe('1');
        expect(db.payment.status).toBe('confirmed');
        expect(walletService.processPayout).not.toHaveBeenCalled();
    });

    test('record-only requests are durable, terminal, and idempotent', async () => {
        const db = fixture();
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const first = await service.refundPayment({ paymentId: 42, sendFunds: false });
        const second = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(first.refund.status).toBe('recorded');
        expect(second.refund.status).toBe('recorded');
        expect(second.existing).toBe(true);
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.paymentUpdateCount).toBe(1);
        expect(db.creditTransactions).toHaveLength(1);
    });

    test('ambiguous wallet failure moves to needs_review and is never retried', async () => {
        const db = fixture();
        const walletService = {
            processPayout: jest.fn().mockRejectedValue(new Error('timeout after transfer submission'))
        };
        const service = new PaymentRefundService({ db, walletService, logger });

        const first = await service.refundPayment({ paymentId: 42, sendFunds: true });
        const second = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(first.refund.status).toBe('needs_review');
        expect(first.refund.error_message).toContain('timeout');
        expect(second.refund.status).toBe('needs_review');
        expect(walletService.processPayout).toHaveBeenCalledTimes(1);
        expect(db.paymentUpdateCount).toBe(1);
        expect(db.creditTransactions).toHaveLength(1);
    });

    test('success without a valid transaction hash is treated as ambiguous', async () => {
        const db = fixture();
        const walletService = {
            processPayout: jest.fn().mockResolvedValue({ success: true })
        };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.error_message).toContain('valid transaction hash');
        expect(walletService.processPayout).toHaveBeenCalledTimes(1);
    });

    test('consumed purchased credits require review and no wallet transfer', async () => {
        const db = fixture({ user: { credits: '5' } });
        const walletService = {
            processPayout: jest.fn().mockResolvedValue({ success: true, txHash })
        };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.error_message).toContain('already been consumed');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.user.credits).toBe('5');
        expect(db.payment.status).toBe('confirmed');
        expect(db.creditTransactions).toHaveLength(0);
    });

    test('unused race tickets and payment-owned packs reverse exactly once', async () => {
        const db = fixture({
            user: { credits: '0', total_credits_purchased: '0', race_entries: 2 },
            payment: { credits_purchased: '0', payment_type: 'cosmetic_pack' },
            grant: {
                payment_id: 42,
                user_id: 7,
                source: 'product_confirmation',
                credits_granted: '0',
                purchase_progress_granted: '0',
                race_entries_granted: 2,
                packs_granted: [{ id: 'kenney-3d-characters' }],
                premium_level_granted: null,
                premium_level_previous: null,
                status: 'active'
            },
            raceLot: { id: 8, original_entries: 2, remaining_entries: 2, refunded_at: null },
            packEntitlements: [{
                pack_id: 'kenney-3d-characters',
                source: 'product_purchase',
                metadata: { paymentId: 42 }
            }]
        });
        const service = new PaymentRefundService({ db, walletService: null, logger });

        const first = await service.refundPayment({ paymentId: 42, sendFunds: false });
        const second = await service.refundPayment({ paymentId: 42, sendFunds: false });

        expect(first.refund.status).toBe('recorded');
        expect(second.existing).toBe(true);
        expect(db.user.race_entries).toBe(0);
        expect(db.raceLot.remaining_entries).toBe(0);
        expect(db.raceLot.refunded_at).toBeTruthy();
        expect(db.packEntitlements).toHaveLength(0);
        expect(db.raceTransactions).toHaveLength(1);
        expect(db.grant.status).toBe('reversed');
    });

    test('an escrowed race ticket makes the whole refund needs_review', async () => {
        const db = fixture({
            user: { credits: '0', total_credits_purchased: '0', race_entries: 2 },
            payment: { credits_purchased: '0', payment_type: 'cosmetic_pack' },
            grant: {
                payment_id: 42,
                user_id: 7,
                source: 'product_confirmation',
                credits_granted: '0',
                purchase_progress_granted: '0',
                race_entries_granted: 2,
                packs_granted: [],
                premium_level_granted: null,
                premium_level_previous: null,
                status: 'active'
            },
            raceLot: { id: 8, original_entries: 2, remaining_entries: 1, refunded_at: null }
        });
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.error_message).toContain('consumed or escrowed');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.user.race_entries).toBe(2);
        expect(db.raceLot.remaining_entries).toBe(1);
    });

    test('a pending unpaid invoice cannot deduct credits or send its expected amount', async () => {
        const db = fixture({
            payment: { status: 'pending', received_amount: '0' }
        });
        const walletService = {
            processPayout: jest.fn().mockResolvedValue({ success: true, txHash })
        };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('needs_review');
        expect(result.refund.amount).toBe('0');
        expect(result.refund.error_message).toContain('confirmed payment');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.user.credits).toBe('6');
        expect(db.creditTransactions).toHaveLength(0);
    });

    test('a stranded processing row requires review and is never resent', async () => {
        const db = fixture({
            payment: { status: 'refunded' },
            refund: {
                id: 11,
                payment_id: 42,
                user_id: 7,
                status: 'processing',
                amount: '900',
                payout_address: '5'.repeat(95),
                credits_deducted: '4',
                reason: 'Admin refund',
                tx_hash: null,
                error_message: null,
                requested_at: new Date(),
                processing_started_at: new Date()
            }
        });
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.refund.status).toBe('processing');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.paymentUpdateCount).toBe(0);
        expect(db.creditTransactions).toHaveLength(0);
    });

    test('a legacy refunded payment is imported without repeating unknown side effects', async () => {
        const db = fixture({
            payment: { status: 'refunded', received_amount: '900' }
        });
        const walletService = { processPayout: jest.fn() };
        const service = new PaymentRefundService({ db, walletService, logger });

        const result = await service.refundPayment({ paymentId: 42, sendFunds: true });

        expect(result.legacyImported).toBe(true);
        expect(result.existing).toBe(true);
        expect(result.refund.status).toBe('recorded');
        expect(result.refund.amount).toBe('900');
        expect(walletService.processPayout).not.toHaveBeenCalled();
        expect(db.paymentUpdateCount).toBe(0);
        expect(db.user.credits).toBe('6');
        expect(db.creditTransactions).toHaveLength(0);
    });
});
