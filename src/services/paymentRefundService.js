const { AppError, NotFoundError } = require('../utils/errors');

const MAX_ERROR_LENGTH = 2000;
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function parseAtomic(value, fieldName) {
    try {
        const parsed = BigInt(value == null ? 0 : value);
        if (parsed < 0n) {
            throw new Error('negative value');
        }
        return parsed;
    } catch (error) {
        throw new AppError(`Invalid ${fieldName} stored for payment refund`, {
            code: 'INVALID_REFUND_DATA',
            safeMessage: 'The payment record cannot be refunded automatically.'
        });
    }
}

function jsonInteger(value) {
    const parsed = typeof value === 'bigint' ? value : BigInt(value || 0);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

function errorMessage(error) {
    const message = error && typeof error.message === 'string'
        ? error.message
        : 'Wallet returned an ambiguous refund result.';
    return message.slice(0, MAX_ERROR_LENGTH) || 'Wallet returned an ambiguous refund result.';
}

function jsonObject(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function packIds(value) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(item => {
        if (typeof item === 'string') return item.trim();
        return String(item?.id || item?.packId || item?.pack_id || '').trim();
    }).filter(Boolean))];
}

/**
 * Durable payment-refund state machine.
 *
 * Safety invariant: a wallet transfer is attempted only by the request that atomically
 * changes `requested` to `processing`. No code path changes `processing` back to
 * `requested`, so a crash or timeout can never cause an automatic second transfer.
 */
class PaymentRefundService {
    constructor({ db, walletService, logger = console, isSendEnabled = null } = {}) {
        if (!db) throw new Error('PaymentRefundService requires db');
        this.db = db;
        this.walletService = walletService;
        this.logger = logger;
        // The application injects its single payout master/readiness predicate. Keep the
        // service independently testable, but never let an admin refund become a second wallet
        // transfer path that bypasses PAYOUTS_ENABLED, startup recovery, or wallet health.
        this.isSendEnabled = typeof isSendEnabled === 'function' ? isSendEnabled : () => true;
    }

    _assertSendEnabled() {
        if (!this.isSendEnabled()) {
            throw new AppError('Automatic refund transfer is disabled by the payout safety gate.', {
                statusCode: 503,
                code: 'PAYOUT_DISPATCH_DISABLED',
                safeMessage: 'Automatic refund sending is disabled. Record the refund without sending funds, or restore the payout safety gate first.'
            });
        }
    }

    async refundPayment({ paymentId, reason = 'Admin refund', sendFunds = false }) {
        if (sendFunds === true) this._assertSendEnabled();
        const normalizedReason = typeof reason === 'string' && reason.trim()
            ? reason.trim()
            : 'Admin refund';

        const recorded = await this._recordOnce({
            paymentId,
            reason: normalizedReason,
            sendFunds: sendFunds === true
        });

        let refund = recorded.refund;
        let walletClaimed = false;

        // A recorded-only refund is terminal. An existing requested row may be safely
        // claimed after a crash that happened before any wallet call was started.
        if (sendFunds === true && refund.status === 'requested') {
            const attempt = await this._claimAndSend(paymentId);
            refund = attempt.refund;
            walletClaimed = attempt.claimed;
        }

        return {
            payment: recorded.payment,
            refund,
            existing: recorded.existing,
            legacyImported: recorded.legacyImported,
            walletClaimed
        };
    }

    async _recordOnce({ paymentId, reason, sendFunds }) {
        const client = await this.db.getClient();
        try {
            await client.query('BEGIN');

            // This is the serialization point for all refund requests for one payment.
            const paymentResult = await client.query(`
                SELECT p.*
                FROM payments p
                WHERE p.id = $1
                FOR UPDATE
            `, [paymentId]);

            if (paymentResult.rows.length === 0) {
                throw new NotFoundError('Payment not found', {
                    safeMessage: `Payment ${paymentId} not found.`
                });
            }

            const payment = paymentResult.rows[0];
            const existingResult = await client.query(`
                SELECT *
                FROM payment_refunds
                WHERE payment_id = $1
                FOR UPDATE
            `, [paymentId]);

            if (existingResult.rows.length > 0) {
                await client.query('COMMIT');
                return {
                    payment,
                    refund: existingResult.rows[0],
                    existing: true,
                    legacyImported: false
                };
            }

            const receivedAmount = parseAtomic(payment.received_amount, 'received amount');
            const expectedAmount = parseAtomic(payment.expected_amount, 'expected amount');
            // Never pay an unconfirmed invoice merely because it has an expected amount.
            // Confirmed legacy rows may lack received_amount, hence the narrow fallback.
            const refundAmount = receivedAmount > 0n
                ? receivedAmount
                : (payment.status === 'confirmed' ? expectedAmount : 0n);

            let user = null;
            if (payment.user_id != null) {
                const userResult = await client.query(`
                    SELECT id, credits, race_entries, total_credits_purchased,
                           premium_level, payout_address
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                `, [payment.user_id]);
                user = userResult.rows[0] || null;
            }

            const payoutAddress = typeof user?.payout_address === 'string' && user.payout_address.trim()
                ? user.payout_address.trim()
                : null;

            // Historic refunded rows predate the outbox. Snapshot them as recorded, but
            // never deduct grants or send funds because their prior side effects cannot be
            // proven from the old schema.
            const legacyImported = payment.status === 'refunded';
            let grant = null;
            let creditsDeducted = 0n;
            let raceEntriesDeducted = 0;
            let packsRevoked = [];
            let premiumLevelRestored = null;
            let reviewReason = null;
            let lot = null;

            if (!legacyImported && payment.status === 'confirmed') {
                const grantResult = await client.query(`
                    SELECT *
                    FROM payment_entitlement_grants
                    WHERE payment_id = $1
                    FOR UPDATE
                `, [paymentId]);
                grant = grantResult.rows[0] || null;

                // Upgrade fallback for a confirmed product that predates migration 035. The
                // marker is still created under the payment lock before any reversal.
                if (!grant && ['credits_package', 'cosmetic_pack'].includes(payment.payment_type)) {
                    const durable = jsonObject(payment.product_grants);
                    const legacyCredits = parseAtomic(
                        durable.credits ?? payment.credits_purchased ?? 0,
                        'legacy credits grant'
                    );
                    const legacyRace = Number(durable.raceEntries ?? durable.race_entries ?? 0);
                    const legacyPacks = Array.isArray(durable.packs) ? durable.packs : [];
                    const legacyPremium = durable.premiumLevel || durable.premium_level || null;
                    const inserted = await client.query(`
                        INSERT INTO payment_entitlement_grants (
                            payment_id, user_id, source, credits_granted,
                            purchase_progress_granted, race_entries_granted, packs_granted,
                            premium_level_granted, metadata
                        ) VALUES (
                            $1, $2, 'legacy_product_backfill', $3::bigint, $3::bigint,
                            $4, $5::jsonb, $6, $7::jsonb
                        )
                        ON CONFLICT (payment_id) DO NOTHING
                        RETURNING *
                    `, [
                        paymentId,
                        payment.user_id,
                        legacyCredits.toString(),
                        Number.isSafeInteger(legacyRace) && legacyRace > 0 ? legacyRace : 0,
                        JSON.stringify(legacyPacks),
                        legacyPremium,
                        JSON.stringify({ runtimeLegacyBackfill: true })
                    ]);
                    grant = inserted.rows[0] || null;
                }

                // A linked game proves that a direct entry was consumed. Never send its coins
                // automatically; gameplay value and any payout liability require reconciliation.
                const consumedGame = await client.query(
                    `SELECT id FROM games WHERE payment_id = $1 LIMIT 1`,
                    [paymentId]
                );
                if (consumedGame.rows.length > 0) {
                    reviewReason = 'Payment was consumed by a game; automatic refund is unsafe.';
                }
            }

            const creditsGranted = grant ? parseAtomic(grant.credits_granted, 'credits grant') : 0n;
            const progressGranted = grant ? parseAtomic(grant.purchase_progress_granted, 'purchase progress grant') : 0n;
            const raceGranted = grant ? Number(grant.race_entries_granted || 0) : 0;
            const grantedPackIds = grant ? packIds(jsonObject({ value: grant.packs_granted }).value || grant.packs_granted) : [];
            // PostgreSQL returns JSONB arrays directly; string-backed test/adapter rows need parsing.
            const parsedPacks = typeof grant?.packs_granted === 'string'
                ? (() => { try { return JSON.parse(grant.packs_granted); } catch (_) { return []; } })()
                : grant?.packs_granted;
            const actualPackIds = grant ? packIds(parsedPacks) : grantedPackIds;

            if (!legacyImported && !reviewReason && payment.status !== 'confirmed') {
                reviewReason = 'Only a confirmed payment can be refunded automatically.';
            }
            // Direct-entry confirmation historically advanced lifetime purchase progression
            // outside the payment grant snapshot. Until that benefit has payment-scoped
            // provenance, neither a bare direct payment nor its recovery-credit marker can be
            // reversed exactly. Keep the coins in manual review instead of refunding while
            // leaving a tier/cosmetic unlock behind.
            if (!legacyImported && !reviewReason && payment.payment_type === 'single_game'
                && (!grant || grant.source === 'single_game_recovery')) {
                reviewReason = 'Direct-entry purchase progression requires manual reconciliation.';
            }
            if (!legacyImported && !reviewReason && grant && grant.status !== 'active') {
                reviewReason = `Entitlement grant is ${grant.status}; manual reconciliation is required.`;
            }
            if (!legacyImported && !reviewReason
                && (creditsGranted > 0n || progressGranted > 0n || raceGranted > 0
                    || actualPackIds.length > 0 || grant?.premium_level_granted)
                && !user) {
                reviewReason = 'The entitlement owner no longer exists.';
            }
            if (!legacyImported && !reviewReason && sendFunds && refundAmount <= 0n) {
                reviewReason = 'No received payment amount is available for an automatic refund.';
            }
            if (!legacyImported && !reviewReason && sendFunds && !payoutAddress) {
                reviewReason = 'No payout address is available for an automatic refund.';
            }
            if (!legacyImported && !reviewReason && creditsGranted > parseAtomic(user?.credits, 'user credits')) {
                reviewReason = 'Purchased credits have already been consumed.';
            }
            if (!legacyImported && !reviewReason
                && progressGranted > parseAtomic(user?.total_credits_purchased, 'purchase progress')) {
                reviewReason = 'Purchase progression cannot be reversed safely.';
            }
            if (!legacyImported && !reviewReason
                && (!Number.isSafeInteger(raceGranted) || raceGranted < 0
                    || raceGranted > Number(user?.race_entries || 0))) {
                reviewReason = 'Purchased race entries have already been consumed or escrowed.';
            }

            if (!legacyImported && !reviewReason && raceGranted > 0) {
                const lotResult = await client.query(`
                    SELECT id, original_entries, remaining_entries, refunded_at
                    FROM race_entry_lots
                    WHERE payment_id = $1
                    FOR UPDATE
                `, [paymentId]);
                lot = lotResult.rows[0] || null;
                if (lot && (lot.refunded_at != null
                    || Number(lot.original_entries) !== raceGranted
                    || Number(lot.remaining_entries) !== raceGranted)) {
                    reviewReason = 'Purchased race entries have already been consumed or escrowed.';
                }
            }

            let lockedPacks = [];
            if (!legacyImported && !reviewReason && actualPackIds.length > 0) {
                if (grant.source !== 'product_confirmation') {
                    reviewReason = 'Legacy pack provenance is ambiguous.';
                } else {
                    const packResult = await client.query(`
                        SELECT pack_id, source, metadata
                        FROM user_pack_entitlements
                        WHERE user_id = $1 AND pack_id = ANY($2::text[])
                        ORDER BY pack_id
                        FOR UPDATE
                    `, [payment.user_id, actualPackIds]);
                    lockedPacks = packResult.rows || [];
                    const ownedByPayment = new Set(lockedPacks
                        .filter(row => String(jsonObject(row.metadata).paymentId) === String(paymentId))
                        .map(row => row.pack_id));
                    if (actualPackIds.some(id => !ownedByPayment.has(id))) {
                        reviewReason = 'A purchased pack is missing or has different ownership provenance.';
                    }
                }
            }

            if (!legacyImported && !reviewReason && grant?.premium_level_granted) {
                if (!grant.premium_level_previous
                    || user?.premium_level !== grant.premium_level_granted) {
                    reviewReason = 'The purchased premium level changed after purchase.';
                }
            }

            if (!legacyImported && reviewReason) {
                if (grant) {
                    await client.query(`
                        UPDATE payment_entitlement_grants
                        SET status = 'needs_review', needs_review_at = NOW(), reversal_reason = $2
                        WHERE payment_id = $1 AND status = 'active'
                    `, [paymentId, reviewReason]);
                }
                const reviewInsert = await client.query(`
                    INSERT INTO payment_refunds (
                        payment_id, user_id, status, amount, payout_address,
                        credits_deducted, race_entries_deducted, packs_revoked,
                        reason, requested_at, error_message,
                        entitlement_grant_payment_id
                    ) VALUES (
                        $1, $2, 'needs_review', $3::bigint, $4,
                        0, 0, '[]'::jsonb, $5, NOW(), $6, $7
                    )
                    RETURNING *
                `, [paymentId, payment.user_id, refundAmount.toString(), payoutAddress,
                    reason, reviewReason, grant ? paymentId : null]);
                await client.query('COMMIT');
                return {
                    payment,
                    refund: reviewInsert.rows[0],
                    existing: false,
                    legacyImported: false
                };
            }

            if (!legacyImported && grant && user) {
                const premiumPrevious = grant.premium_level_granted
                    ? grant.premium_level_previous
                    : user.premium_level;
                const updatedUser = await client.query(`
                    UPDATE users
                    SET credits = credits - $1::bigint,
                        total_credits_purchased = total_credits_purchased - $2::bigint,
                        race_entries = race_entries - $3,
                        premium_level = $4
                    WHERE id = $5
                    RETURNING credits, race_entries, total_credits_purchased, premium_level
                `, [creditsGranted.toString(), progressGranted.toString(), raceGranted,
                    premiumPrevious, payment.user_id]);
                if (updatedUser.rows.length !== 1) {
                    throw new AppError('Locked refund user disappeared during entitlement reversal');
                }

                creditsDeducted = creditsGranted;
                raceEntriesDeducted = raceGranted;
                premiumLevelRestored = grant.premium_level_granted ? premiumPrevious : null;
                if (creditsDeducted > 0n) {
                    await client.query(`
                        INSERT INTO credit_transactions (
                            user_id, amount, reason, balance_after, transaction_type, payment_id
                        ) VALUES ($1, $2::bigint, $3, $4::bigint, 'refund', $5)
                    `, [payment.user_id, (-creditsDeducted).toString(),
                        `payment_refund:${paymentId}`, String(updatedUser.rows[0].credits), paymentId]);
                }
                if (raceEntriesDeducted > 0) {
                    await client.query(`
                        INSERT INTO race_entry_transactions (
                            user_id, delta, balance_after, reason, payment_id, metadata
                        ) VALUES ($1, $2, $3, 'refund', $4, $5::jsonb)
                    `, [payment.user_id, -raceEntriesDeducted,
                        updatedUser.rows[0].race_entries, paymentId,
                        JSON.stringify({ refundPaymentId: paymentId })]);
                }
                if (lot) {
                    const reversedLot = await client.query(`
                        UPDATE race_entry_lots
                        SET remaining_entries = 0, refunded_at = NOW()
                        WHERE id = $1 AND refunded_at IS NULL
                          AND remaining_entries = original_entries
                        RETURNING id
                    `, [lot.id]);
                    if (reversedLot.rowCount !== 1) {
                        throw new AppError('Race-entry lot changed during refund reversal');
                    }
                }
                if (actualPackIds.length > 0) {
                    const removed = await client.query(`
                        DELETE FROM user_pack_entitlements
                        WHERE user_id = $1
                          AND pack_id = ANY($2::text[])
                          AND metadata->>'paymentId' = $3
                        RETURNING pack_id
                    `, [payment.user_id, actualPackIds, String(paymentId)]);
                    packsRevoked = (removed.rows || []).map(row => row.pack_id);
                    if (packsRevoked.length !== actualPackIds.length) {
                        throw new AppError('Pack entitlement changed during refund reversal');
                    }
                }
                await client.query(`
                    UPDATE payment_entitlement_grants
                    SET status = 'reversed', credits_reversed = $2::bigint,
                        purchase_progress_reversed = $3::bigint,
                        race_entries_reversed = $4, packs_reversed = $5::jsonb,
                        reversal_reason = $6, reversed_at = NOW()
                    WHERE payment_id = $1 AND status = 'active'
                `, [paymentId, creditsDeducted.toString(), progressGranted.toString(),
                    raceEntriesDeducted, JSON.stringify(packsRevoked), reason]);
            }

            if (!legacyImported) {
                await client.query(`
                    UPDATE payments
                    SET status = 'refunded'
                    WHERE id = $1
                `, [paymentId]);
                payment.status = 'refunded';
            }

            const initialStatus = sendFunds && !legacyImported ? 'requested' : 'recorded';
            const insertResult = await client.query(`
                INSERT INTO payment_refunds (
                    payment_id, user_id, status, amount, payout_address,
                    credits_deducted, purchase_progress_deducted,
                    race_entries_deducted, packs_revoked,
                    premium_level_restored, reason, requested_at,
                    entitlement_grant_payment_id
                ) VALUES (
                    $1, $2, $3, $4::bigint, $5, $6::bigint, $7::bigint,
                    $8, $9::jsonb, $10, $11,
                    CASE WHEN $3 = 'requested' THEN NOW() ELSE NULL END, $12
                )
                RETURNING *
            `, [
                paymentId,
                payment.user_id,
                initialStatus,
                refundAmount.toString(),
                payoutAddress,
                creditsDeducted.toString(),
                progressGranted.toString(),
                raceEntriesDeducted,
                JSON.stringify(packsRevoked),
                premiumLevelRestored,
                reason,
                grant ? paymentId : null
            ]);

            await client.query('COMMIT');
            return {
                payment,
                refund: insertResult.rows[0],
                existing: legacyImported,
                legacyImported
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async _claimAndSend(paymentId) {
        const claimResult = await this.db.query(`
            UPDATE payment_refunds
            SET status = 'processing',
                processing_started_at = NOW(),
                updated_at = NOW(),
                error_message = NULL
            WHERE payment_id = $1
              AND status = 'requested'
            RETURNING *
        `, [paymentId]);

        if (claimResult.rows.length === 0) {
            return { claimed: false, refund: await this._getRefund(paymentId) };
        }

        const claimed = claimResult.rows[0];
        let observedTxHash = null;

        try {
            if (!this.walletService || typeof this.walletService.processPayout !== 'function') {
                throw new Error('Wallet service is unavailable; manual refund review is required.');
            }
            if (BigInt(claimed.amount) <= 0n) {
                throw new Error('No received payment amount is available for an automatic refund.');
            }
            if (typeof claimed.payout_address !== 'string' || !claimed.payout_address.trim()) {
                throw new Error('No payout address is available for an automatic refund.');
            }

            // Recheck after the durable processing claim and immediately before the wallet call.
            // A concurrent kill-switch change therefore cannot be missed by a long DB reversal.
            this._assertSendEnabled();
            const result = await this.walletService.processPayout({
                address: claimed.payout_address,
                amount: BigInt(claimed.amount),
                userId: claimed.user_id,
                description: `Refund for payment ${paymentId}`
            });

            observedTxHash = typeof result?.txHash === 'string' ? result.txHash.trim() : null;
            if (result?.success !== true || !observedTxHash || !TX_HASH_PATTERN.test(observedTxHash)) {
                throw new Error('Wallet did not return explicit success with a valid transaction hash.');
            }

            const completedResult = await this.db.query(`
                UPDATE payment_refunds
                SET status = 'completed',
                    tx_hash = $2,
                    error_message = NULL,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                  AND status = 'processing'
                RETURNING *
            `, [claimed.id, observedTxHash]);

            if (completedResult.rows.length === 0) {
                // The transfer may have happened, so no state transition here may ever
                // make this row eligible for another automatic attempt.
                return { claimed: true, refund: await this._getRefund(paymentId) };
            }

            return { claimed: true, refund: completedResult.rows[0] };
        } catch (error) {
            const reviewResult = await this.db.query(`
                UPDATE payment_refunds
                SET status = 'needs_review',
                    tx_hash = COALESCE($2, tx_hash),
                    error_message = $3,
                    needs_review_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                  AND status = 'processing'
                RETURNING *
            `, [claimed.id, observedTxHash, errorMessage(error)]);

            const finalRefund = reviewResult.rows[0] || await this._getRefund(paymentId);
            if (finalRefund.status !== 'completed') {
                this.logger?.error?.('Payment refund requires manual review', {
                    paymentId,
                    refundId: claimed.id,
                    error: errorMessage(error)
                });
            }

            return {
                claimed: true,
                refund: finalRefund
            };
        }
    }

    async _getRefund(paymentId) {
        const result = await this.db.query(`
            SELECT *
            FROM payment_refunds
            WHERE payment_id = $1
        `, [paymentId]);

        if (result.rows.length === 0) {
            throw new AppError('Payment refund state disappeared', {
                code: 'REFUND_STATE_MISSING',
                safeMessage: 'The refund state could not be loaded.'
            });
        }
        return result.rows[0];
    }

    static toApiResult(result, gameModeManager) {
        const { payment, refund } = result;
        const requiresReview = refund.status === 'needs_review' || refund.status === 'processing';
        let message = 'Payment refunded successfully.';
        if (refund.status === 'processing') {
            message = 'Refund transfer is processing. Do not retry it; reconcile the wallet if it remains processing.';
        } else if (refund.status === 'needs_review') {
            message = 'Payment refund recorded; the transfer requires manual review.';
        } else if (result.existing) {
            message = 'Payment refund already recorded.';
        }
        return {
            success: !result.existing,
            message,
            refund: {
                paymentId: payment.id,
                originalAmount: payment.expected_amount,
                originalAmountFormatted: gameModeManager.formatAtomicHuman(payment.expected_amount, 4),
                amount: refund.amount,
                creditsDeducted: jsonInteger(refund.credits_deducted),
                purchaseProgressDeducted: jsonInteger(refund.purchase_progress_deducted),
                raceEntriesDeducted: Number(refund.race_entries_deducted || 0),
                packsRevoked: Array.isArray(refund.packs_revoked) ? refund.packs_revoked : [],
                premiumLevelRestored: refund.premium_level_restored || null,
                fundsSent: refund.status === 'completed',
                txHash: refund.tx_hash || null,
                reason: refund.reason,
                status: refund.status,
                requiresReview
            }
        };
    }
}

module.exports = PaymentRefundService;
