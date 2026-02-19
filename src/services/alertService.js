/**
 * AlertService - Email alerts for admin monitoring
 *
 * Sends alerts via Resend for:
 * - Low wallet balance
 * - Failed payouts
 * - Wallet disconnection
 * - High pending payout queue
 */

class AlertService {
    constructor({ walletService, db, debugManager }) {
        this.walletService = walletService;
        this.db = db;
        this.debugManager = debugManager;

        // Resend configuration
        this.resendApiKey = process.env.RESEND_API_KEY;
        this.adminEmail = process.env.ADMIN_EMAIL;
        this.fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@monerogue.app';

        // Balance thresholds (atomic units)
        // BALANCE_WARN: sends email alert
        // BALANCE_CRITICAL: sends email AND halts new games
        this.balanceWarnThreshold = parseInt(process.env.BALANCE_WARN) || parseInt(process.env.LOW_BALANCE_THRESHOLD) || 100000000000; // 0.1 XMR default
        this.balanceCriticalThreshold = parseInt(process.env.BALANCE_CRITICAL) || 10000000000; // 0.01 XMR default
        this.highPendingThreshold = parseInt(process.env.HIGH_PENDING_THRESHOLD) || 10;

        // Track critical balance state for game halt
        this.isBalanceCritical = false;
        this.lastBalanceCheck = null;

        // Cooldowns (prevent alert spam)
        this.alertCooldown = parseInt(process.env.ALERT_COOLDOWN_MS) || 3600000; // 1 hour
        this.lastAlertSent = new Map();

        // Track wallet disconnect duration
        this.walletDisconnectedSince = null;
        this.walletDisconnectAlertThreshold = 300000; // 5 minutes

        this.enabled = !!(this.resendApiKey && this.adminEmail);

        if (this.enabled) {
            console.log('📧 Alert service enabled - alerts will be sent to', this.adminEmail);
        } else {
            console.log('📧 Alert service disabled - set RESEND_API_KEY and ADMIN_EMAIL to enable');
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
    async sendAlert(type, { subject, html }) {
        if (!this.enabled) {
            return { sent: false, reason: 'Alert service not configured' };
        }

        if (this.isOnCooldown(type)) {
            return { sent: false, reason: 'On cooldown' };
        }

        try {
            // Dynamic import to avoid requiring resend if not configured
            const { Resend } = require('resend');
            const resend = new Resend(this.resendApiKey);

            const result = await resend.emails.send({
                from: this.fromEmail,
                to: this.adminEmail,
                subject: subject,
                html: html
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
            const unlockedBalance = balance.unlocked_balance || 0;
            this.lastBalanceCheck = Date.now();

            const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
            const decimals = cryptoType === 'WOW' ? 11 : 12;
            const divisor = Math.pow(10, decimals);

            const balanceFormatted = (unlockedBalance / divisor).toFixed(6);

            // Check CRITICAL threshold first (more severe)
            if (unlockedBalance < this.balanceCriticalThreshold) {
                // Set critical flag - this will halt new games
                if (!this.isBalanceCritical) {
                    this.isBalanceCritical = true;
                    console.warn(`🚨 CRITICAL: Wallet balance is critically low (${balanceFormatted} ${cryptoType}). New games are HALTED.`);
                }

                const thresholdFormatted = (this.balanceCriticalThreshold / divisor).toFixed(6);

                await this.sendAlert('balance_critical', {
                    subject: `🚨 CRITICAL: Wallet Balance Depleted - ${balanceFormatted} ${cryptoType}`,
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

                const thresholdFormatted = (this.balanceWarnThreshold / divisor).toFixed(6);

                await this.sendAlert('balance_warn', {
                    subject: `⚠️ Wallet Balance Low - ${balanceFormatted} ${cryptoType}`,
                    html: `
                        <h2>⚠️ Low Wallet Balance Warning</h2>
                        <p>The payout wallet balance is running low:</p>
                        <ul>
                            <li><strong>Current Balance:</strong> ${balanceFormatted} ${cryptoType}</li>
                            <li><strong>Warning Threshold:</strong> ${thresholdFormatted} ${cryptoType}</li>
                            <li><strong>Critical Threshold:</strong> ${(this.balanceCriticalThreshold / divisor).toFixed(6)} ${cryptoType}</li>
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
                // Balance is healthy - clear critical flag if set
                if (this.isBalanceCritical) {
                    this.isBalanceCritical = false;
                    console.log(`✅ Wallet balance restored above thresholds. Games can resume.`);
                }
            }
        } catch (error) {
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
            const unlockedBalance = balance.unlocked_balance || 0;

            if (unlockedBalance < this.balanceCriticalThreshold) {
                this.isBalanceCritical = true;
                const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
                const decimals = cryptoType === 'WOW' ? 11 : 12;
                const balanceFormatted = (unlockedBalance / Math.pow(10, decimals)).toFixed(4);
                return {
                    halted: true,
                    reason: `Sorry, the house balance is too low to initiate new games (${balanceFormatted} ${cryptoType}). Please try again later.`
                };
            }

            this.isBalanceCritical = false;
            return { halted: false };
        } catch (error) {
            console.error('Failed to check balance for game start:', error.message);
            // On error, don't halt games - let them proceed
            return { halted: false };
        }
    }

    /**
     * Check for wallet disconnection
     */
    async checkWalletConnection() {
        if (this.walletService?.isHealthy) {
            this.walletDisconnectedSince = null;
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
     * Alert when a payout permanently fails
     */
    async alertPayoutFailed(payout) {
        const cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        const divisor = cryptoType === 'WOW' ? 1e11 : 1e12;
        const amountFormatted = (payout.amount / divisor).toFixed(6);

        await this.sendAlert('payout_failed', {
            subject: `💀 Payout Permanently Failed - ${amountFormatted} ${cryptoType}`,
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
