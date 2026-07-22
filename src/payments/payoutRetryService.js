/**
 * PayoutRetryService - Handles retrying failed payouts
 *
 * Processes payouts that have status 'pending' (stuck) or 'failed' (retryable)
 * with retry_count below the maximum threshold.
 */

const { AppError } = require('../utils/errors');
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function errorText(error, depth = 0) {
    if (depth > 4 || error == null) return '';
    if (typeof error === 'string') return error;
    const parts = [error.message, error.details && JSON.stringify(error.details)];
    if (error.cause && error.cause !== error) parts.push(errorText(error.cause, depth + 1));
    return parts.filter(Boolean).join(' ');
}

// These wallet failures happen before transfer_split broadcasts and are therefore safe to retry.
function isKnownPreBroadcastFailure(error) {
    return /not enough (unlocked )?(money|balance|outputs)|insufficient|no unlocked|unlocked balance/i
        .test(errorText(error));
}

class PayoutRetryService {
    constructor({ db, walletService, debugManager, maxRetries = 3, retryIntervalMs = 300000, staleProcessingMs = null, alertService = null, isEnabled = null }) {
        this.db = db;
        this.walletService = walletService;
        this.debugManager = debugManager;
        this.maxRetries = maxRetries;
        this.retryIntervalMs = retryIntervalMs; // Default: 5 minutes
        // A worker that dies after claiming a payout leaves an ambiguous `processing` row.
        // Never infer that no transfer happened and resend it: quarantine it for reconciliation.
        this.staleProcessingMs = staleProcessingMs == null
            ? Math.max(retryIntervalMs * 3, 15 * 60 * 1000)
            : Math.max(60000, Number(staleProcessingMs) || 0);
        this.alertService = alertService; // For sending failure notifications
        this.isEnabled = typeof isEnabled === 'function' ? isEnabled : () => true;
        this.isProcessing = false;
        this.retryTimer = null;
    }

    /**
     * Start the retry service
     */
    start() {
        if (!this.isEnabled()) {
            console.log('🛑 Payout retry service not started (master payouts disabled)');
            return;
        }
        if (this.retryTimer) {
            console.log('⚠️ Payout retry service already running');
            return;
        }

        console.log(`🔄 Starting payout retry service (interval: ${this.retryIntervalMs / 1000}s, max retries: ${this.maxRetries})`);

        // Run immediately on start
        this.processRetries();

        // Then run on interval
        this.retryTimer = setInterval(() => this.processRetries(), this.retryIntervalMs);
    }

    /**
     * Stop the retry service
     */
    stop() {
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
            console.log('🛑 Payout retry service stopped');
        }
    }

    /**
     * Process all retryable payouts
     */
    async processRetries() {
        if (!this.isEnabled()) return;
        if (this.isProcessing) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('⏳ Payout retry already in progress, skipping...');
            }
            return;
        }

        this.isProcessing = true;

        try {
            const recovered = await this.db.query(`
                UPDATE payouts
                SET status = 'needs_review',
                    last_error = CASE
                        WHEN last_error IS NULL OR last_error = ''
                            THEN 'Stale processing claim; broadcast outcome is unknown'
                        ELSE LEFT(last_error, 400) || ' | Stale processing claim; broadcast outcome is unknown'
                    END,
                    last_retry_at = NOW()
                WHERE status = 'processing'
                  AND COALESCE(last_retry_at, created_at) <
                      NOW() - ($1::bigint * INTERVAL '1 millisecond')
                RETURNING id
            `, [this.staleProcessingMs]);
            if ((recovered.rowCount || recovered.rows?.length || 0) > 0) {
                console.error(`❌ Quarantined ${recovered.rowCount || recovered.rows.length} stale processing payout(s) for manual review`);
            }

            // Atomically CLAIM legacy failed payouts before releasing row locks. Pending payouts
            // belong exclusively to GameModeManager's batcher; selecting them here created a race
            // where both workers could send the same row after this transaction committed.
            const result = await this.db.withTransaction(async (client) => {
                const candidates = await client.query(`
                    SELECT p.*
                    FROM payouts p
                    WHERE p.status = 'failed'
                      AND p.retry_count < $1
                      AND (p.last_retry_at IS NULL OR p.last_retry_at < NOW() - INTERVAL '1 minute')
                    ORDER BY p.created_at ASC
                    LIMIT 10
                    FOR UPDATE SKIP LOCKED
                `, [this.maxRetries]);
                if (!candidates.rows.length) return candidates;

                const ids = candidates.rows.map(row => row.id);
                const claimed = await client.query(`
                    UPDATE payouts
                    SET status = 'processing', last_retry_at = NOW()
                    WHERE id = ANY($1) AND status = 'failed'
                    RETURNING *
                `, [ids]);
                return claimed;
            });

            if (result.rows.length === 0) {
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.log('✅ No payouts to retry');
                }
                return;
            }

            console.log(`🔄 Processing ${result.rows.length} payout(s) for retry`);

            for (const payout of result.rows) {
                await this.retryPayout(payout);
            }

        } catch (error) {
            console.error('❌ Error in payout retry process:', error.message);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Retry a single payout
     */
    async retryPayout(payout) {
        const { id, user_id, game_id, payout_address, amount, multiplier, reason, retry_count, status } = payout;

        if (!this.isEnabled()) {
            // If the switch flipped after processRetries claimed the row, release it without
            // changing retry_count. It remains a liability but cannot be dispatched.
            await this.db.query(`
                UPDATE payouts SET status = 'failed', last_error = 'Retry paused: payouts disabled'
                WHERE id = $1 AND status = 'processing'
            `, [id]).catch(() => {});
            return;
        }

        console.log(`🔄 Retrying payout ${id} (attempt ${(retry_count || 0) + 1}/${this.maxRetries})`);

        try {
            // CRITICAL: If payout has a tx_hash, check blockchain BEFORE retrying
            // This prevents double-spending if RPC succeeded but DB update failed
            if (payout.tx_hash) {
                try {
                    const txStatus = await this.walletService.checkTransactionStatus(payout.tx_hash);
                    if (txStatus.exists) {
                        // Transaction is in blockchain/mempool - mark as completed, don't retry!
                        await this.db.withTransaction(async (client) => {
                            // Transition to completed ONLY if not already completed. The RETURNING
                            // tells us whether THIS call did the transition, so we count user stats
                            // exactly once (the previous guard checked the same row it had just
                            // updated, so it never counted at all).
                            const transitioned = await client.query(`
                                UPDATE payouts
                                SET status = 'completed', processed_at = NOW()
                                WHERE id = $1 AND status <> 'completed'
                                RETURNING id
                            `, [id]);

                            if (transitioned.rows.length > 0) {
                                await client.query(`
                                    UPDATE users
                                    SET total_amount_won = COALESCE(total_amount_won, 0) + $1,
                                        total_payouts_received = COALESCE(total_payouts_received, 0) + 1
                                    WHERE id = $2
                                `, [amount, user_id]);
                            }
                        });
                        console.log(`✅ Payout ${id} already in blockchain (${txStatus.confirmations} confirmations), marked completed`);
                        return;
                    }
                    // A single "not found" is not proof that a transaction was never broadcast:
                    // wallet/daemon lag, pruning, or a transient index failure can all hide it.
                    // Never turn a recorded transaction hash into an automatic second send.
                    await this.db.query(`
                        UPDATE payouts
                        SET status = 'needs_review',
                            last_error = $1,
                            last_retry_at = NOW()
                        WHERE id = $2 AND status IN ('processing', 'failed')
                    `, ['Recorded transaction hash was not found; manual reconciliation required', id]);
                    console.error(`❌ Payout ${id} has a recorded tx_hash that was not found; marked needs_review`);
                    return;
                } catch (checkError) {
                    // If we can't check blockchain status, don't risk double-spend - mark for manual review
                    console.error(`❌ Cannot verify tx_hash for payout ${id}, marking for manual review:`, checkError.message);
                    await this.db.query(`
                        UPDATE payouts
                        SET status = 'needs_review',
                            last_error = $1,
                            last_retry_at = NOW()
                        WHERE id = $2
                    `, [`Cannot verify blockchain status: ${checkError.message}`, id]);
                    return;
                }
            }

            // A legacy failure with no transaction hash is only auto-retryable when its recorded
            // error proves transfer_split failed before broadcast. Timeouts/transport errors are
            // ambiguous and go to manual review instead of risking a second on-chain payment.
            if (!payout.tx_hash && !isKnownPreBroadcastFailure(payout.last_error || '')) {
                await this.db.query(`
                    UPDATE payouts
                    SET status = 'needs_review',
                        last_error = $1,
                        last_retry_at = NOW()
                    WHERE id = $2 AND status IN ('processing', 'failed')
                `, [`Automatic retry refused: ambiguous prior failure (${payout.last_error || 'no error recorded'})`, id]);
                console.error(`❌ Payout ${id} has no provably pre-broadcast failure; marked needs_review`);
                return;
            }

            // Attempt the payout
            if (!payout_address) {
                throw new AppError(`No payout address found for payout ${id}`);
            }

            const payoutResult = await this.walletService.processPayout({
                userId: user_id,
                gameId: game_id,
                address: payout_address,
                amount,
                multiplier,
                description: `Retry payout ${id} for game ${game_id}`
            });

            const txHash = typeof payoutResult?.txHash === 'string'
                ? payoutResult.txHash.trim()
                : '';
            if (payoutResult?.success !== true || !TX_HASH_PATTERN.test(txHash)) {
                throw new AppError(`Payout ${id} retry returned no valid transaction-hash evidence`);
            }

            // Store tx_hash, mark completed, and count stats ATOMICALLY in one transaction,
            // so the process can't die between writing tx_hash and marking completed (which
            // previously left a tx_hash on a non-completed row). The conditional transition
            // (status <> 'completed') makes stat-counting exactly-once.
            await this.db.withTransaction(async (client) => {
                const transitioned = await client.query(`
                    UPDATE payouts
                    SET tx_hash = $1,
                        fee = $2,
                        status = 'completed',
                        processed_at = NOW(),
                        retry_count = COALESCE(retry_count, 0) + 1,
                        last_retry_at = NOW()
                    WHERE id = $3 AND status = 'processing'
                    RETURNING id
                `, [txHash, payoutResult.fee || null, id]);

                if (transitioned.rows.length > 0) {
                    await client.query(`
                        UPDATE users
                        SET total_amount_won = COALESCE(total_amount_won, 0) + $1,
                            total_payouts_received = COALESCE(total_payouts_received, 0) + 1
                        WHERE id = $2
                    `, [amount, user_id]);
                }
            });

            console.log(`✅ Payout ${id} retry succeeded: ${txHash}`);

        } catch (error) {
            const newRetryCount = (retry_count || 0) + 1;
            const safeToRetry = isKnownPreBroadcastFailure(error);
            const newStatus = safeToRetry
                ? (newRetryCount >= this.maxRetries ? 'permanently_failed' : 'failed')
                : 'needs_review';

            await this.db.query(`
                UPDATE payouts
                SET status = $1,
                    retry_count = $2,
                    last_error = $3,
                    last_retry_at = NOW()
                WHERE id = $4 AND status IN ('processing', 'failed')
            `, [newStatus, newRetryCount, errorText(error).slice(0, 500), id]);

            if (newStatus === 'needs_review') {
                console.error(`❌ Payout ${id} failed ambiguously and requires manual review: ${errorText(error)}`);
            } else if (newStatus === 'permanently_failed') {
                console.error(`❌ Payout ${id} permanently failed after ${newRetryCount} attempts: ${error.message}`);

                // Send email alert for permanent failure
                if (this.alertService) {
                    try {
                        await this.alertService.alertPayoutFailed({
                            id,
                            game_id,
                            amount,
                            payout_address,
                            retry_count: newRetryCount,
                            last_error: error.message
                        });
                    } catch (alertError) {
                        console.error('Failed to send payout failure alert:', alertError.message);
                    }
                }
            } else {
                console.warn(`⚠️ Payout ${id} retry failed (attempt ${newRetryCount}/${this.maxRetries}): ${error.message}`);
            }
        }
    }

    /**
     * Get retry service status
     */
    getStatus() {
        return {
            running: !!this.retryTimer,
            isProcessing: this.isProcessing,
            maxRetries: this.maxRetries,
            retryIntervalMs: this.retryIntervalMs
        };
    }
}

module.exports = PayoutRetryService;
