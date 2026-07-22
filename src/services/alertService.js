/**
 * AlertService - Email alerts for admin monitoring
 *
 * Sends alerts via Resend for:
 * - Low wallet balance
 * - Failed payouts
 * - Wallet disconnection
 * - High pending payout queue
 * - Manual-review and stale financial outbox rows
 */

const money = require('../money/atomic');

function positiveAtomic(value, fallback) {
    try {
        const input = value == null || value === '' ? fallback : String(value).replace(/_/g, '');
        const exact = money.toBig(input);
        return exact > 0n ? exact : money.toBig(fallback);
    } catch (_) {
        return money.toBig(fallback);
    }
}

function formatAtomicFixed(value, decimals, digits) {
    const exact = money.toBig(value);
    const negative = exact < 0n;
    const abs = negative ? -exact : exact;
    const scale = 10n ** BigInt(decimals);
    const whole = abs / scale;
    const fraction = (abs % scale).toString().padStart(decimals, '0')
        .slice(0, digits).padEnd(digits, '0');
    return `${negative ? '-' : ''}${whole}${digits > 0 ? `.${fraction}` : ''}`;
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class AlertService {
    constructor({ walletService, db, debugManager }) {
        this.walletService = walletService;
        this.db = db;
        this.debugManager = debugManager;

        // Notifications hub (preferred): DB-backed dedup/throttle that survives restarts, so a stuck
        // condition is ~5 emails, not thousands. Falls back to direct Resend if NOTIFY_HUB_URL unset.
        this.hubUrl = process.env.NOTIFY_HUB_URL || '';   // e.g. http://10.42.1.20:8765/api/notify
        this.notifySource = process.env.NOTIFY_SOURCE || process.env.GAME_NAME || 'wowngeon';

        // Resend configuration (legacy fallback)
        this.resendApiKey = process.env.RESEND_API_KEY;
        this.adminEmail = process.env.ADMIN_EMAIL;
        this.fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@monerogue.app';

        // Balance thresholds (atomic units)
        // BALANCE_WARN: sends email alert
        // BALANCE_CRITICAL: sends email AND halts new games
        this.balanceWarnThreshold = positiveAtomic(
            process.env.BALANCE_WARN || process.env.LOW_BALANCE_THRESHOLD,
            100000000000n
        ); // 0.1 XMR default
        this.balanceCriticalThreshold = positiveAtomic(process.env.BALANCE_CRITICAL, 10000000000n); // 0.01 XMR default
        this.highPendingThreshold = parseInt(process.env.HIGH_PENDING_THRESHOLD) || 10;
        this.financialReviewStaleMs = positiveInteger(
            process.env.FINANCIAL_REVIEW_STALE_MS,
            15 * 60 * 1000
        );

        // Track critical balance state for game halt
        this.isBalanceCritical = false;
        this.lastBalanceCheck = null;

        // Cooldowns (prevent alert spam)
        this.alertCooldown = parseInt(process.env.ALERT_COOLDOWN_MS) || 3600000; // 1 hour
        this.lastAlertSent = new Map();

        // Track wallet disconnect duration
        this.walletDisconnectedSince = null;
        this.walletDisconnectAlertThreshold = 300000; // 5 minutes

        this.enabled = !!(this.hubUrl || (this.resendApiKey && this.adminEmail));

        if (this.hubUrl) {
            console.log('📧 Alerts → notifications hub:', this.hubUrl, `(source=${this.notifySource})`);
        } else if (this.enabled) {
            console.log('📧 Alert service enabled (direct Resend) - alerts to', this.adminEmail);
        } else {
            console.log('📧 Alert service disabled - set NOTIFY_HUB_URL (or RESEND_API_KEY + ADMIN_EMAIL)');
        }
    }

    /**
     * Check if an alert type is on cooldown
     */
    isOnCooldown(alertType) {
        const lastSent = this.lastAlertSent.get(alertType) || 0;
        return Date.now() - lastSent < this.alertCooldown;
    }

    /**
     * Send an email alert via Resend
     */
    async sendAlert(type, { subject, html, level = 'warn', body = '' }) {
        if (!this.enabled) {
            return { sent: false, reason: 'Alert service not configured' };
        }

        // Preferred: the central hub dedups + throttles (DB-backed, so it survives restarts — unlike
        // the in-memory cooldown that re-spammed on every restart). Stable key = source:type.
        if (this.hubUrl) {
            return this._postHub({
                key: `${this.notifySource}:${type}`,
                level,
                title: subject,
                body: body || this._stripHtml(html),
            });
        }

        // Legacy fallback: direct Resend with the in-memory cooldown.
        if (this.isOnCooldown(type)) {
            return { sent: false, reason: 'On cooldown' };
        }
        try {
            const { Resend } = require('resend');
            const resend = new Resend(this.resendApiKey);
            const result = await resend.emails.send({
                from: this.fromEmail, to: this.adminEmail, subject, html,
            });
            this.lastAlertSent.set(type, Date.now());
            console.log(`📧 Alert sent: ${type} - ${subject}`);
            return { sent: true, id: result.data?.id };
        } catch (error) {
            console.error(`❌ Failed to send alert: ${error.message}`);
            return { sent: false, error: error.message };
        }
    }

    /**
     * Clear a firing alert in the hub (one ✅ resolve if it had alerted). No-op without the hub.
     */
    async resolveAlert(type) {
        if (!this.hubUrl) return { sent: false, reason: 'no hub' };
        return this._postHub({ key: `${this.notifySource}:${type}`, resolve: true });
    }

    async _postHub({ key, level, title = '', body = '', resolve = false }) {
        try {
            const res = await fetch(this.hubUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: this.notifySource, key, level, title, body, resolve }),
            });
            const data = await res.json().catch(() => ({}));
            if (data.sent) console.log(`📧 hub ${resolve ? 'resolve' : 'alert'} sent: ${key}`);
            return { sent: !!data.sent, deduped: !!data.deduped, hub: true };
        } catch (error) {
            console.error(`❌ notify hub post failed (${key}): ${error.message}`);
            return { sent: false, error: error.message };
        }
    }

    _stripHtml(html) {
        return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    }

    /**
     * Check wallet balance and alert if low or critical
     * BALANCE_WARN: sends email alert
     * BALANCE_CRITICAL: sends email AND sets isBalanceCritical flag (halts new games)
     */
    async checkWalletBalance() {
        if (!this.walletService?.isHealthy) {
            return;
        }

        try {
            const balance = await this.walletService.getBalance();
            const unlockedBalance = money.toBig(balance.unlocked_balance ?? 0);
            this.lastBalanceCheck = Date.now();

            const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
            const decimals = cryptoType === 'WOW' ? 11 : 12;
            const balanceFormatted = formatAtomicFixed(unlockedBalance, decimals, 6);

            // Check CRITICAL threshold first (more severe)
            if (unlockedBalance < this.balanceCriticalThreshold) {
                // Set critical flag - this will halt new games
                if (!this.isBalanceCritical) {
                    this.isBalanceCritical = true;
                    console.warn(`🚨 CRITICAL: Wallet balance is critically low (${balanceFormatted} ${cryptoType}). New games are HALTED.`);
                }

                const thresholdFormatted = formatAtomicFixed(this.balanceCriticalThreshold, decimals, 6);

                await this.sendAlert('balance_critical', {
                    subject: `🚨 CRITICAL: Wallet Balance Depleted - ${balanceFormatted} ${cryptoType}`,
                    level: 'crit',
                    html: `
                        <h2 style="color: #dc3545;">🚨 CRITICAL: Wallet Balance Depleted</h2>
                        <p><strong>NEW GAMES HAVE BEEN HALTED.</strong></p>
                        <p>The payout wallet balance is critically low:</p>
                        <ul>
                            <li><strong>Current Balance:</strong> ${balanceFormatted} ${cryptoType}</li>
                            <li><strong>Critical Threshold:</strong> ${thresholdFormatted} ${cryptoType}</li>
                        </ul>
                        <p style="color: #dc3545;"><strong>Users cannot start new paid games until the wallet is topped up.</strong></p>
                        <p>Please add funds immediately to restore service.</p>
                        <hr>
                        <p style="color: #666; font-size: 12px;">
                            Server: ${process.env.NODE_ENV || 'development'}<br>
                            Time: ${new Date().toISOString()}
                        </p>
                    `
                });
            }
            // Check WARN threshold (less severe)
            else if (unlockedBalance < this.balanceWarnThreshold) {
                // Clear critical flag if we were critical but now just warning
                if (this.isBalanceCritical) {
                    this.isBalanceCritical = false;
                    console.log(`✅ Wallet balance restored above critical threshold. Games can resume.`);
                }

                const thresholdFormatted = formatAtomicFixed(this.balanceWarnThreshold, decimals, 6);

                await this.sendAlert('balance_warn', {
                    subject: `⚠️ Wallet Balance Low - ${balanceFormatted} ${cryptoType}`,
                    html: `
                        <h2>⚠️ Low Wallet Balance Warning</h2>
                        <p>The payout wallet balance is running low:</p>
                        <ul>
                            <li><strong>Current Balance:</strong> ${balanceFormatted} ${cryptoType}</li>
                            <li><strong>Warning Threshold:</strong> ${thresholdFormatted} ${cryptoType}</li>
                            <li><strong>Critical Threshold:</strong> ${formatAtomicFixed(this.balanceCriticalThreshold, decimals, 6)} ${cryptoType}</li>
                        </ul>
                        <p>Please top up the wallet soon to avoid service interruption.</p>
                        <p>If balance drops below the critical threshold, new games will be automatically halted.</p>
                        <hr>
                        <p style="color: #666; font-size: 12px;">
                            Server: ${process.env.NODE_ENV || 'development'}<br>
                            Time: ${new Date().toISOString()}
                        </p>
                    `
                });
            } else {
                // Balance is healthy - clear critical flag + any firing balance alerts in the hub
                if (this.isBalanceCritical) {
                    this.isBalanceCritical = false;
                    console.log(`✅ Wallet balance restored above thresholds. Games can resume.`);
                }
                this.resolveAlert('balance_critical');
                this.resolveAlert('balance_warn');
            }
        } catch (error) {
            // Unknown balance is not evidence of sufficient reserves. Admission remains
            // closed until a later exact wallet reading proves the reserve is healthy.
            this.isBalanceCritical = true;
            console.error('Failed to check wallet balance for alerts:', error.message);
        }
    }

    /**
     * Check if new paid games should be halted due to critical balance
     * @returns {boolean} true if games should be halted
     */
    shouldHaltGames() {
        return this.isBalanceCritical;
    }

    /**
     * Force refresh the balance check (useful when called before game start)
     * @returns {Object} { halted: boolean, reason?: string }
     */
    async checkBalanceForGameStart() {
        if (!this.walletService?.isHealthy) {
            return { halted: true, reason: 'Wallet service is unavailable. Please try again later.' };
        }

        try {
            const balance = await this.walletService.getBalance();
            const unlockedBalance = money.toBig(balance.unlocked_balance ?? 0);

            if (unlockedBalance < this.balanceCriticalThreshold) {
                this.isBalanceCritical = true;
                const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
                const decimals = cryptoType === 'WOW' ? 11 : 12;
                const balanceFormatted = formatAtomicFixed(unlockedBalance, decimals, 4);
                return {
                    halted: true,
                    reason: `Sorry, the house balance is too low to initiate new games (${balanceFormatted} ${cryptoType}). Please try again later.`
                };
            }

            this.isBalanceCritical = false;
            return { halted: false };
        } catch (error) {
            console.error('Failed to check balance for game start:', error.message);
            this.isBalanceCritical = true;
            return { halted: true, reason: 'Wallet balance could not be verified. Please try again later.' };
        }
    }

    /**
     * Check for wallet disconnection
     */
    async checkWalletConnection() {
        if (this.walletService?.isHealthy) {
            if (this.walletDisconnectedSince) {          // was down, now back → clear the hub alert
                this.walletDisconnectedSince = null;
                this.resolveAlert('wallet_disconnect');
            }
            return;
        }

        if (!this.walletDisconnectedSince) {
            this.walletDisconnectedSince = Date.now();
            return;
        }

        const disconnectedFor = Date.now() - this.walletDisconnectedSince;

        if (disconnectedFor > this.walletDisconnectAlertThreshold) {
            const minutes = Math.floor(disconnectedFor / 60000);

            await this.sendAlert('wallet_disconnect', {
                subject: `🔴 Wallet RPC Disconnected (${minutes}+ min)`,
                html: `
                    <h2>Wallet RPC Connection Lost</h2>
                    <p>The wallet RPC has been unreachable for <strong>${minutes} minutes</strong>.</p>
                    <p>Payouts cannot be processed while the wallet is disconnected.</p>
                    <p>Please check:</p>
                    <ul>
                        <li>Is the wallet-rpc process running?</li>
                        <li>Is the wallet file accessible?</li>
                        <li>Is there enough disk space?</li>
                    </ul>
                    <hr>
                    <p style="color: #666; font-size: 12px;">
                        Endpoint: ${process.env.PRIMARY_WALLET_ENDPOINT || 'not configured'}<br>
                        Time: ${new Date().toISOString()}
                    </p>
                `
            });
        }
    }

    /**
     * Check for pending payouts queue
     */
    async checkPendingPayouts() {
        if (!this.db) return;

        try {
            const result = await this.db.query(`
                SELECT COUNT(*) as count FROM payouts
                WHERE status = 'pending' OR status = 'failed'
            `);

            const pendingCount = parseInt(result.rows[0]?.count) || 0;

            if (pendingCount >= this.highPendingThreshold) {
                await this.sendAlert('high_pending', {
                    subject: `⚠️ High Pending Payouts: ${pendingCount}`,
                    html: `
                        <h2>High Pending Payout Queue</h2>
                        <p>There are <strong>${pendingCount}</strong> pending or failed payouts in the queue.</p>
                        <p>This may indicate:</p>
                        <ul>
                            <li>Wallet connectivity issues</li>
                            <li>Insufficient balance</li>
                            <li>Network congestion</li>
                        </ul>
                        <p>Please check the admin dashboard for details.</p>
                        <hr>
                        <p style="color: #666; font-size: 12px;">
                            Threshold: ${this.highPendingThreshold}<br>
                            Time: ${new Date().toISOString()}
                        </p>
                    `
                });
            }
        } catch (error) {
            console.error('Failed to check pending payouts for alerts:', error.message);
        }
    }

    /**
     * Alert on ambiguous transfer outcomes and financial outbox rows that have stopped moving.
     * These are visibility alerts only: neither state is changed and no transfer is retried.
     */
    async checkFinancialReviewRows() {
        if (!this.db) return;

        try {
            const result = await this.db.query(`
                SELECT
                    (SELECT COUNT(*) FROM payouts
                     WHERE status = 'needs_review') AS payout_review_count,
                    (SELECT COUNT(*) FROM payment_refunds
                     WHERE status = 'needs_review') AS refund_review_count,
                    (SELECT COUNT(*) FROM payouts
                     WHERE status = 'processing'
                       AND COALESCE(last_retry_at, created_at)
                           < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
                        AS stale_payout_processing_count,
                    (SELECT COUNT(*) FROM payment_refunds
                     WHERE status IN ('requested', 'processing')
                       AND COALESCE(processing_started_at, requested_at, updated_at, created_at)
                           < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
                        AS stale_refund_nonterminal_count
            `, [this.financialReviewStaleMs]);

            const row = result.rows[0] || {};
            const payoutReviewCount = parseInt(row.payout_review_count) || 0;
            const refundReviewCount = parseInt(row.refund_review_count) || 0;
            const stalePayoutCount = parseInt(row.stale_payout_processing_count) || 0;
            const staleRefundCount = parseInt(row.stale_refund_nonterminal_count) || 0;
            const reviewCount = payoutReviewCount + refundReviewCount;
            const staleCount = stalePayoutCount + staleRefundCount;

            if (reviewCount > 0) {
                await this.sendAlert('financial_needs_review', {
                    subject: `🚨 Financial transfers need review: ${reviewCount}`,
                    level: 'crit',
                    body: `${payoutReviewCount} payout(s) and ${refundReviewCount} refund(s) are in needs_review. Do not retry them; reconcile against wallet history and transaction evidence.`,
                    html: `
                        <h2>Financial transfers require manual review</h2>
                        <ul>
                            <li><strong>Payouts:</strong> ${payoutReviewCount}</li>
                            <li><strong>Refunds:</strong> ${refundReviewCount}</li>
                        </ul>
                        <p>Do not resend these transfers. Reconcile each row against wallet history and transaction evidence.</p>
                    `
                });
            } else {
                await this.resolveAlert('financial_needs_review');
            }

            if (staleCount > 0) {
                const staleMinutes = Math.ceil(this.financialReviewStaleMs / 60000);
                await this.sendAlert('financial_nonterminal_stale', {
                    subject: `🚨 Stale financial transfers: ${staleCount}`,
                    level: 'crit',
                    body: `${stalePayoutCount} payout processing row(s) and ${staleRefundCount} refund requested/processing row(s) have not moved for at least ${staleMinutes} minutes. Treat processing as an ambiguous wallet outcome.`,
                    html: `
                        <h2>Financial transfers are stale</h2>
                        <ul>
                            <li><strong>Processing payouts:</strong> ${stalePayoutCount}</li>
                            <li><strong>Requested/processing refunds:</strong> ${staleRefundCount}</li>
                            <li><strong>Age threshold:</strong> ${staleMinutes} minutes</li>
                        </ul>
                        <p>A processing row may represent a broadcast transfer. Do not retry it until wallet reconciliation proves no transfer occurred.</p>
                    `
                });
            } else {
                await this.resolveAlert('financial_nonterminal_stale');
            }
        } catch (error) {
            console.error('Failed to check financial review rows for alerts:', error.message);
        }
    }

    /**
     * Alert when a payout permanently fails
     */
    async alertPayoutFailed(payout) {
        const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        const amountFormatted = formatAtomicFixed(payout.amount, cryptoType === 'WOW' ? 11 : 12, 6);

        await this.sendAlert('payout_failed', {
            subject: `💀 Payout Permanently Failed - ${amountFormatted} ${cryptoType}`,
            level: 'crit',
            html: `
                <h2>Payout Permanently Failed</h2>
                <p>A payout has failed after all retry attempts:</p>
                <ul>
                    <li><strong>Payout ID:</strong> ${payout.id}</li>
                    <li><strong>Game ID:</strong> ${payout.game_id}</li>
                    <li><strong>Amount:</strong> ${amountFormatted} ${cryptoType}</li>
                    <li><strong>Address:</strong> ${payout.payout_address?.substring(0, 20)}...</li>
                    <li><strong>Retry Count:</strong> ${payout.retry_count}</li>
                    <li><strong>Last Error:</strong> ${payout.last_error || 'Unknown'}</li>
                </ul>
                <p>Manual intervention may be required.</p>
                <hr>
                <p style="color: #666; font-size: 12px;">
                    Time: ${new Date().toISOString()}
                </p>
            `
        });
    }

    /**
     * Run all checks (call this periodically)
     */
    async runChecks() {
        await this.checkWalletBalance();
        await this.checkWalletConnection();
        await this.checkPendingPayouts();
        await this.checkFinancialReviewRows();
    }

    /**
     * Start periodic checking
     */
    startPeriodicChecks(intervalMs = 300000) { // Default 5 minutes
        if (!this.enabled) {
            return;
        }

        // Run initial check after a short delay
        setTimeout(() => this.runChecks(), 10000);

        // Then run periodically
        this.checkInterval = setInterval(() => {
            this.runChecks();
        }, intervalMs);

        console.log(`📧 Alert checks will run every ${intervalMs / 60000} minutes`);
    }

    /**
     * Stop periodic checking
     */
    stopPeriodicChecks() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
}

module.exports = AlertService;
