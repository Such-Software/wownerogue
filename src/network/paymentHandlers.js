/**
 * Payment Handlers
 * Encapsulates payment request creation, monitoring, mempool detection,
 * confirmation handling, and queue integration.
 */
class PaymentHandlers {
    constructor({ io, gameModeManager, walletService, debugManager, queueManager, broadcastManager }) {
        this.io = io;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.debugManager = debugManager;
        this.queueManager = queueManager;
        this.broadcastManager = broadcastManager;
        this.mempoolNotified = new Set();
        this.paymentMonitors = new Map();
        // Track active monitored address per socket so we can stop on disconnect/expiry
        this.socketAddressMap = new Map();
    // Track paymentIds already confirmed (avoid duplicate emits / queue actions)
    this.confirmedPayments = new Set();
        // Periodic cleanup (confirmed payment IDs older than retention window)
        this._confirmedTimestamps = new Map();
        this._confirmedRetentionMs = 6 * 60 * 60 * 1000; // 6 hours
        // Track expiry timeouts so they can be cleared / unref'd to avoid keeping process open
        this._expiryTimeouts = new Map(); // socketId -> timeout
        // Keep reference so tests can dispose / and unref so it doesn't keep event loop alive
        this._cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [pid, ts] of this._confirmedTimestamps.entries()) {
                if (now - ts > this._confirmedRetentionMs) {
                    this._confirmedTimestamps.delete(pid);
                    this.confirmedPayments.delete(pid);
                }
            }
        }, 30 * 60 * 1000); // sweep every 30 min
        if (this._cleanupInterval && this._cleanupInterval.unref) {
            // Allow process (including Jest) to exit naturally without waiting for this interval
            this._cleanupInterval.unref();
        }
    }

    async handlePaymentRequest(socket, data) {
        if (!this.gameModeManager) {
            this.io.to(socket.id).emit('payment_error', { error: 'Payment system not available' });
            return;
        }
        try {
            const { gameMode } = data;
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, gameMode);
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                gameMode: gameMode
            });
            if (this.debugManager.CONSOLE_LOGGING) console.log(`💳 Payment request created for ${socket.id}: ${paymentRequest.amount}`);
        } catch (e) {
            console.error('Error creating payment request:', e);
            this.io.to(socket.id).emit('payment_error', { error: e.message });
        }
    }

    async createAndShowPaymentRequest(socket) {
        if (!this.gameModeManager) return;
        try {
            // Ensure payout address exists for modes that may payout (PAID_SINGLE or PAID_CREDITS with payouts)
            const mode = this.gameModeManager.gameMode;
            const needsAddress = (mode === 'PAID_SINGLE') || (mode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
            if (needsAddress) {
                try {
                    const userRow = await this.gameModeManager.getOrCreateUser(socket.id);
                    if (!userRow.payout_address) {
                        this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '💳 Before paying, paste your payout address (XMR/WOW) then type confirm.');
                        // Do not proceed until address is set
                        return;
                    }
                } catch(e) {
                    console.error('Address pre-check failed:', e.message);
                }
            }
            const currentUser = socket.id && this.queueManager.getUserBySocket ? this.queueManager.getUserBySocket(socket.id) : null;
            // caller (SocketHandlers) will handle user existence; keep method generic
            const gameMode = this.gameModeManager.gameMode;
            const cryptoType = this.gameModeManager.cryptoType;
            let paymentType, amount, description;
            if (gameMode === 'PAID_SINGLE') { paymentType = 'single_game'; amount = this.gameModeManager.singleGamePrice; description = 'Single game entry'; }
            else if (gameMode === 'PAID_CREDITS') { paymentType = 'credits_package'; amount = this.gameModeManager.creditsPackagePrice; description = '10 game credits package'; }
            else { this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Invalid game mode configuration.'); return; }

            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType);
            let qrDataUrl = null; try { const { generatePaymentQR } = require('../payments/qrService'); qrDataUrl = await generatePaymentQR(paymentRequest.address, amount, cryptoType, description); } catch(e) {}
            const humanAmount = (amount / 1000000000000).toFixed(3);
            this.io.to(socket.id).emit('payment_created', { paymentId: paymentRequest.id, address: paymentRequest.address, amount: paymentRequest.amount, paymentType, gameMode, cryptoType, humanAmount, description, expiresAt: paymentRequest.expiresAt, qr: qrDataUrl });
            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', `💳 PAYMENT REQUIRED (${description})\n\nAmount: ${humanAmount} ${cryptoType}\nAddress: ${paymentRequest.address}\n\n⚠️  Send EXACTLY ${humanAmount} ${cryptoType}.\n🔄 Added to queue once mempool seen.\n⏰ Expires in 30 minutes.`);
            this._monitorAddress(socket, paymentRequest, amount, cryptoType, currentUser);
        } catch (e) {
            console.error('Error creating payment request:', e);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Failed to create payment request.');
        }
    }

    _monitorAddress(socket, paymentRequest, amount, cryptoType, currentUser) {
        // Record mapping so we can stop later
        this.socketAddressMap.set(socket.id, paymentRequest.address);

        this.walletService.startPaymentMonitoring(paymentRequest.address, async (status) => {
            if (status.in_mempool && !status.confirmed) {
                if (this.mempoolNotified.has(paymentRequest.address)) return;
                this.mempoolNotified.add(paymentRequest.address);
                socket.emit('payment_detected', { paymentId: paymentRequest.id, message: 'Payment detected in mempool! Adding you to the game queue...', amount: status.amount, confirmations: 0 });
                const existingIdx = this.queueManager.getPlayerIndex(socket.id);
                if (existingIdx === -1) {
                    this.queueManager.addPlayer({ serverId: socket.id, clientId: currentUser ? currentUser.clientId : null, paymentId: paymentRequest.id, requiresConfirmation: true, confirmed: false });
                }
                socket.emit('queue_joined', { position: (existingIdx === -1 ? this.queueManager.getQueueLength() : existingIdx + 1), message: 'Payment received! Waiting for next block to start game...', currentBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null, nextBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() + 1 : null });
            } else if (status.confirmed) {
                if (!this.confirmedPayments.has(paymentRequest.id)) {
                    this.confirmedPayments.add(paymentRequest.id);
                    socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment confirmed in block!', confirmations: status.confirmations });
                    this._confirmedTimestamps.set(paymentRequest.id, Date.now());
                    this.queueManager.markConfirmed(socket.id);
                    // Attempt immediate game start so user doesn't wait another full block
                    const currentBlock = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
                    if (currentBlock !== null) {
                        const started = this.queueManager.startGameImmediately(socket.id, currentBlock);
                        if (!started && this.debugManager.CONSOLE_LOGGING) {
                            console.log(`[PaymentHandlers] Immediate start skipped (not queued or still unconfirmed) for ${socket.id}`);
                        }
                    }
                }
                // Clean up monitoring for this socket (even if duplicate)
                this.stopMonitoringForSocket(socket.id);
            }
        }, 2000);

        // Expire request after 30 minutes if not confirmed
        const expiryTimeout = setTimeout(() => {
            const address = this.socketAddressMap.get(socket.id);
            if (address === paymentRequest.address) { // still active and not replaced
                this.stopMonitoringForSocket(socket.id);
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'Payment request expired. Type \'enter\' again to create a new payment request.');
            }
        }, 30 * 60 * 1000);
        // Store & unref so tests / process can exit
        this._expiryTimeouts.set(socket.id, expiryTimeout);
        if (expiryTimeout.unref) expiryTimeout.unref();
    }

    async handlePaymentDetected(socketId, paymentRequest, paymentStatus) {
        const currentUser = this.queueManager.getUserBySocket ? this.queueManager.getUserBySocket(socketId) : null;
        if (!currentUser) return;
        const existingIndex = this.queueManager.getPlayerIndex(socketId);
        if (existingIndex !== -1) { this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Payment confirmed, already queued!'); return; }
        if (this.queueManager.activeGames && this.queueManager.activeGames.has(socketId)) { this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Payment confirmed, but you are already in a game!'); return; }
        this.queueManager.addPlayer({ serverId: socketId, clientId: currentUser.clientId, paymentId: paymentRequest.id, requiresConfirmation: paymentStatus.in_mempool && !paymentStatus.confirmed, confirmed: paymentStatus.confirmed });
        const currentBlock = this.debugManager.getCurrentBlockHeight();
        const nextBlock = currentBlock + 1;
        if (paymentStatus.in_mempool && !paymentStatus.confirmed) {
            this.broadcastManager.sendStatusUpdate(socketId, 'success', `💰 PAYMENT DETECTED (MEMPOOL)\n\n✅ Added to queue.\n🕒 Starts at block ${nextBlock}.\n📦 Current block: ${currentBlock}`);
            this.broadcastManager.sendStatusUpdate(socketId, 'info', 'Waiting for block confirmation...');
        } else if (paymentStatus.confirmed) {
            this.broadcastManager.sendStatusUpdate(socketId, 'success', `💰 PAYMENT CONFIRMED IN BLOCK\n\n✅ Added to queue.\n🕒 Starts at block ${nextBlock}.\n📦 Current block: ${currentBlock}`);
        }
            const newBalRes = await this.db.query('SELECT credits FROM users WHERE id = $1', [currentUser.id]);
            const remaining = newBalRes.rows[0] ? newBalRes.rows[0].credits : currentUser.credits;
            if (this.io) {
                this.io.to(socketId).emit('credits_update', { balance: remaining });
            }
            if (!this.confirmedPayments.has(paymentRequest.id)) {
                this.confirmedPayments.add(paymentRequest.id);
                this.io.to(socketId).emit('payment_confirmed', { paymentId: paymentRequest.id, status: paymentStatus, nextBlock, currentBlock });
                this._confirmedTimestamps.set(paymentRequest.id, Date.now());
        }
    }

    /**
     * Stop monitoring (if any) for a given socket (disconnect/expiry)
     */
    stopMonitoringForSocket(socketId) {
        const address = this.socketAddressMap.get(socketId);
        if (address) {
            this.walletService.stopPaymentMonitoring(address);
            this.socketAddressMap.delete(socketId);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🛑 Stopped monitoring for socket ${socketId}`);
            }
        }
        const expiry = this._expiryTimeouts.get(socketId);
        if (expiry) {
            clearTimeout(expiry);
            this._expiryTimeouts.delete(socketId);
        }
    }

    /**
     * Dispose resources (intervals, monitors) - useful for tests / graceful shutdown.
     */
    dispose() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        for (const [socketId] of this.socketAddressMap.entries()) {
            this.stopMonitoringForSocket(socketId);
        }
        for (const [socketId, to] of this._expiryTimeouts.entries()) {
            clearTimeout(to);
            this._expiryTimeouts.delete(socketId);
        }
    }
}

module.exports = PaymentHandlers;
