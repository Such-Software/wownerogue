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

        // Thresholds
        this.lowBalanceThreshold = parseInt(process.env.LOW_BALANCE_THRESHOLD) || 100000000000; // 0.1 XMR
        this.highPendingThreshold = parseInt(process.env.HIGH_PENDING_THRESHOLD) || 10;

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
     * Check wallet balance and alert if low
     */
    async checkWalletBalance() {
        if (!this.walletService?.isHealthy) {
            return;
        }

        try {
            const balance = await this.walletService.getBalance();

            if (balance.unlocked_balance < this.lowBalanceThreshold) {
                const balanceFormatted = (balance.unlocked_balance / 1e12).toFixed(6);
                const thresholdFormatted = (this.lowBalanceThreshold / 1e12).toFixed(6);
                const cryptoType = process.env.CRYPTO_TYPE || 'XMR';

                await this.sendAlert('low_balance', {
                    subject: `⚠️ Wallet Balance Low - ${balanceFormatted} ${cryptoType}`,
                    html: `
                        <h2>Low Wallet Balance Warning</h2>
                        <p>The payout wallet balance is running low:</p>
                        <ul>
                            <li><strong>Current Balance:</strong> ${balanceFormatted} ${cryptoType}</li>
                            <li><strong>Unlocked:</strong> ${balanceFormatted} ${cryptoType}</li>
                            <li><strong>Threshold:</strong> ${thresholdFormatted} ${cryptoType}</li>
                        </ul>
                        <p>Please top up the wallet to ensure payouts can continue.</p>
                        <hr>
                        <p style="color: #666; font-size: 12px;">
                            Server: ${process.env.NODE_ENV || 'development'}<br>
                            Time: ${new Date().toISOString()}
                        </p>
                    `
                });
            }
        } catch (error) {
            console.error('Failed to check wallet balance for alerts:', error.message);
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
        const amountFormatted = (payout.amount / 1e12).toFixed(6);

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
