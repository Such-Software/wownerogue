/**
 * PayoutRetryService - Handles retrying failed payouts
 *
 * Processes payouts that have status 'pending' (stuck) or 'failed' (retryable)
 * with retry_count below the maximum threshold.
 */

const { AppError } = require('../utils/errors');

class PayoutRetryService {
    constructor({ db, walletService, debugManager, maxRetries = 3, retryIntervalMs = 300000 }) {
        this.db = db;
        this.walletService = walletService;
        this.debugManager = debugManager;
        this.maxRetries = maxRetries;
        this.retryIntervalMs = retryIntervalMs; // Default: 5 minutes
        this.isProcessing = false;
        this.retryTimer = null;
    }

    /**
     * Start the retry service
     */
    start() {
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
        if (this.isProcessing) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('⏳ Payout retry already in progress, skipping...');
            }
            return;
        }

        this.isProcessing = true;

        try {
            // Find payouts that need retry:
            // 1. Status is 'pending' (stuck - RPC may have succeeded but DB update failed)
            // 2. Status is 'failed' with retry_count < maxRetries
            // Exclude very recent failures (wait at least 1 minute before retry)
            const result = await this.db.query(`
                SELECT p.*
                FROM payouts p
                WHERE (
                    (p.status = 'pending' AND p.created_at < NOW() - INTERVAL '2 minutes')
                    OR (p.status = 'failed' AND p.retry_count < $1 AND (p.last_retry_at IS NULL OR p.last_retry_at < NOW() - INTERVAL '1 minute'))
                )
                AND p.status != 'permanently_failed'
                ORDER BY p.created_at ASC
                LIMIT 10
            `, [this.maxRetries]);

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
                            await client.query(`
                                UPDATE payouts
                                SET status = 'completed', processed_at = NOW()
                                WHERE id = $1
                            `, [id]);

                            // Update user stats (may have been missed if original DB update failed)
                            await client.query(`
                                UPDATE users
                                SET total_amount_won = COALESCE(total_amount_won, 0) + $1,
                                    total_payouts_received = COALESCE(total_payouts_received, 0) + 1
                                WHERE id = $2 AND NOT EXISTS (
                                    SELECT 1 FROM payouts
                                    WHERE id = $3 AND status = 'completed' AND processed_at IS NOT NULL
                                )
                            `, [amount, user_id, id]);
                        });
                        console.log(`✅ Payout ${id} already in blockchain (${txStatus.confirmations} confirmations), marked completed`);
                        return;
                    }
                    // tx_hash exists in DB but NOT in blockchain - safe to retry
                    console.log(`⚠️ Payout ${id} has tx_hash but not found in blockchain, will retry`);
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

            // IMMEDIATELY store tx_hash (same pattern as gameModeManager)
            if (payoutResult.success && payoutResult.txHash) {
                await this.db.query(`
                    UPDATE payouts SET tx_hash = $1, fee = $2 WHERE id = $3
                `, [payoutResult.txHash, payoutResult.fee, id]);
            }

            // Update payout record with success
            await this.db.withTransaction(async (client) => {
                await client.query(`
                    UPDATE payouts
                    SET status = 'completed',
                        processed_at = NOW(),
                        retry_count = COALESCE(retry_count, 0) + 1,
                        last_retry_at = NOW()
                    WHERE id = $1
                `, [id]);

                // Update user stats
                await client.query(`
                    UPDATE users
                    SET total_amount_won = COALESCE(total_amount_won, 0) + $1,
                        total_payouts_received = COALESCE(total_payouts_received, 0) + 1
                    WHERE id = $2
                `, [amount, user_id]);
            });

            console.log(`✅ Payout ${id} retry succeeded: ${payoutResult.txHash}`);

        } catch (error) {
            const newRetryCount = (retry_count || 0) + 1;
            const newStatus = newRetryCount >= this.maxRetries ? 'permanently_failed' : 'failed';

            await this.db.query(`
                UPDATE payouts
                SET status = $1,
                    retry_count = $2,
                    last_error = $3,
                    last_retry_at = NOW()
                WHERE id = $4
            `, [newStatus, newRetryCount, error.message, id]);

            if (newStatus === 'permanently_failed') {
                console.error(`❌ Payout ${id} permanently failed after ${newRetryCount} attempts: ${error.message}`);
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
