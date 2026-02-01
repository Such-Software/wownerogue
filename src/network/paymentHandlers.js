/**
 * Payment Handlers
 * Encapsulates payment request creation, monitoring, mempool detection,
 * confirmation handling, and queue integration.
 */

const { normalizeError } = require('../utils/errors');

class PaymentHandlers {
    constructor({ io, gameModeManager, walletService, debugManager, queueManager, broadcastManager, sessionManager }) {
        this.io = io;
        this.gameModeManager = gameModeManager;
        this.walletService = walletService;
        this.debugManager = debugManager;
        this.queueManager = queueManager;
        this.broadcastManager = broadcastManager;
        this.sessionManager = sessionManager;
        this.mempoolNotified = new Set();
        this.paymentMonitors = new Map();
        // Track pending payment metadata per socket (may reuse existing)
        this.socketPaymentMap = new Map(); // socketId -> { address, paymentId, amount, cryptoType, createdAt }
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
            const { type, packageId } = data;
            const paymentType = type || data.gameMode || 'single_game';
            const options = { packageId, reuseExisting: true };
            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType, options);
            const cryptoType = this.gameModeManager.cryptoType;
            
            // Generate QR code
            let qrDataUrl = null;
            try {
                const { generatePaymentQR } = require('../payments/qrService');
                qrDataUrl = await generatePaymentQR(
                    paymentRequest.address,
                    paymentRequest.amount,
                    cryptoType,
                    paymentType === 'credits_package' ? 'Credits package' : 'Single game',
                    this.gameModeManager.currencyDecimals
                );
            } catch (qrErr) {
                console.warn('QR generation failed:', qrErr.message);
            }
            
            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                amountFormatted: paymentRequest.amountFormatted,
                humanAmount: paymentRequest.amountFormatted,
                currency: cryptoType,
                cryptoType: cryptoType,
                package: paymentRequest.package,
                paymentType: paymentType,
                qr: qrDataUrl,
                reused: !!paymentRequest.reused
            });
            
            // CRITICAL: Start payment monitoring!
            // Stop any existing monitoring for this socket first
            this.stopMonitoringForSocket(socket.id);
            
            // Get current user for queue management
            const currentUser = this.queueManager?.getUserBySocket ? 
                this.queueManager.getUserBySocket(socket.id) : { serverId: socket.id };
            
            // Start monitoring for payment
            this._monitorAddress(socket, paymentRequest, paymentRequest.amount, cryptoType, currentUser, paymentType);
            
            if (this.debugManager.CONSOLE_LOGGING) console.log(`💳 Payment request created for ${socket.id}: ${paymentRequest.amount}`);
        } catch (e) {
            const err = normalizeError(e, 'Failed to create payment request');
            console.error('Error creating payment request:', err.message);
            this.io.to(socket.id).emit('payment_error', { error: err.safeMessage });
        }
    }

    async createAndShowPaymentRequest(socket, options = {}) {
        if (!this.gameModeManager) return;
        
        // If both direct and credits modes are enabled, let the user choose
        const bothModesEnabled = this.gameModeManager.directModeEnabled && this.gameModeManager.creditsModeEnabled;
        const forceShowOptions = options.showOptions === true;
        
        if (bothModesEnabled && !options.paymentType) {
            // Send event to show payment options modal on client
            this.io.to(socket.id).emit('show_payment_options', {
                reason: 'choose_payment_method',
                message: 'Choose how you want to play'
            });
            return;
        }
        
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
                } catch (e) {
                    const err = normalizeError(e, 'Failed to verify payout address');
                    console.error('Address pre-check failed:', err.message);
                }
            }
            const currentUser = socket.id && this.queueManager.getUserBySocket ? this.queueManager.getUserBySocket(socket.id) : null;
            // caller (SocketHandlers) will handle user existence; keep method generic
            const gameMode = this.gameModeManager.gameMode;
            const cryptoType = this.gameModeManager.cryptoType;
            let paymentType = options.paymentType;
            let amount;
            let description;

            // Determine payment type if not specified
            if (!paymentType) {
                if (gameMode === 'PAID_SINGLE' || this.gameModeManager.directModeEnabled) {
                    paymentType = 'single_game';
                } else if (gameMode === 'PAID_CREDITS') {
                    paymentType = 'credits_package';
                }
            }

            if (paymentType === 'single_game') {
                amount = this.gameModeManager.singleGamePrice;
                description = 'Single game entry';
            } else if (paymentType === 'credits_package') {
                const primaryPackage = this.gameModeManager.getPrimaryCreditPackage();
                amount = Number(primaryPackage?.price ?? this.gameModeManager.creditsPackagePrice);
                const credits = primaryPackage?.credits ?? this.gameModeManager.creditsPerGameCost * 10;
                description = `${credits} credit package`;
            } else {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Invalid game mode configuration.');
                return;
            }

            const paymentRequest = await this.gameModeManager.createPaymentRequest(socket.id, paymentType, { 
                reuseExisting: true,
                packageId: options.packageId 
            });
            const reused = !!paymentRequest.reused;
            const formattedAmount = paymentRequest.amountFormatted ?? this.gameModeManager.formatAtomicHuman(amount, 3);
            let qrDataUrl = null;
            try {
                const { generatePaymentQR } = require('../payments/qrService');
                qrDataUrl = await generatePaymentQR(
                    paymentRequest.address,
                    paymentRequest.amount,
                    cryptoType,
                    description,
                    this.gameModeManager.currencyDecimals
                );
            } catch (e) {}

            this.io.to(socket.id).emit('payment_created', {
                paymentId: paymentRequest.id,
                address: paymentRequest.address,
                amount: paymentRequest.amount,
                amountFormatted: formattedAmount,
                humanAmount: formattedAmount,
                paymentType,
                gameMode,
                cryptoType,
                description,
                expiresAt: paymentRequest.expiresAt,
                qr: qrDataUrl,
                package: paymentRequest.package,
                reused
            });

            const statusHeader = reused
                ? '🔁 Existing payment request still pending. Use the details below to pay.'
                : `💳 PAYMENT REQUIRED (${description})`;

            const statusBody = `\n\nAmount: ${formattedAmount} ${cryptoType}\nAddress: ${paymentRequest.address}\n\n⚠️  Send EXACTLY ${formattedAmount} ${cryptoType}.\n🔄 Added to queue once mempool seen.\n⏰ Expires in 30 minutes.`;

            this.broadcastManager.sendStatusUpdate(
                socket.id,
                'payment',
                `${statusHeader}${statusBody}`
            );

            // If we reused an existing request, ensure we refresh monitoring to avoid duplicate watchers
            this.stopMonitoringForSocket(socket.id);
            this._monitorAddress(socket, paymentRequest, paymentRequest.amount, cryptoType, currentUser, paymentType);
        } catch (e) {
            const err = normalizeError(e, 'Failed to create payment request');
            console.error('Error creating payment request:', err.message);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', err.safeMessage);
        }
    }

    _monitorAddress(socket, paymentRequest, amount, cryptoType, currentUser, paymentType = 'single_game') {
        // Record mapping so we can stop later (replace existing entry)
        this.socketPaymentMap.set(socket.id, {
            address: paymentRequest.address,
            paymentId: paymentRequest.id,
            amount: paymentRequest.amount,
            cryptoType,
            paymentType,
            package: paymentRequest.package,
            createdAt: Date.now()
        });

        this.walletService.startPaymentMonitoring(paymentRequest.address, async (status) => {
            if (status.in_mempool && !status.confirmed) {
                if (this.mempoolNotified.has(paymentRequest.address)) return;
                this.mempoolNotified.add(paymentRequest.address);
                socket.emit('payment_detected', { paymentId: paymentRequest.id, message: 'Payment detected in mempool! Adding you to the game queue...', amount: status.amount, confirmations: 0 });
                const existingIdx = this.queueManager.getPlayerIndex(socket.id);
                if (existingIdx === -1) {
                    // Try to get DB userId from session
                    let userId = null;
                    if (this.sessionManager?.sessions?.has(socket.id)) {
                        userId = this.sessionManager.sessions.get(socket.id).id;
                    }

                    this.queueManager.addPlayer({ 
                        serverId: socket.id, 
                        clientId: currentUser ? currentUser.clientId : null, 
                        userId: userId,
                        paymentId: paymentRequest.id, 
                        requiresConfirmation: true, 
                        confirmed: false 
                    });
                }
                socket.emit('queue_joined', { position: (existingIdx === -1 ? this.queueManager.getQueueLength() : existingIdx + 1), message: 'Payment received! Waiting for next block to start game...', currentBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null, nextBlock: this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() + 1 : null });
            } else if (status.confirmed) {
                // SECURITY: Use in-memory Set as fast-path, but DB is source of truth
                // This prevents double-processing on server restart
                if (this.confirmedPayments.has(paymentRequest.id)) {
                    // Already processed in this session, skip
                    this.stopMonitoringForSocket(socket.id);
                    return;
                }

                // Mark in memory to prevent duplicate processing within this session
                this.confirmedPayments.add(paymentRequest.id);
                this._confirmedTimestamps.set(paymentRequest.id, Date.now());

                // Handle credits_package: add credits to user
                const mapping = this.socketPaymentMap.get(socket.id);
                if (mapping && mapping.paymentType === 'credits_package' && this.gameModeManager) {
                    try {
                        // processCreditsPackageConfirmation now atomically checks status='pending'
                        const creditsResult = await this.gameModeManager.processCreditsPackageConfirmation(
                            socket.id,
                            paymentRequest.id,
                            mapping.package
                        );
                        if (creditsResult.success) {
                            socket.emit('credits_update', { balance: creditsResult.newBalance });
                            socket.emit('payment_confirmed', {
                                paymentId: paymentRequest.id,
                                message: `Payment confirmed! Added ${creditsResult.creditsAdded} credits. New balance: ${creditsResult.newBalance}`,
                                creditsAdded: creditsResult.creditsAdded,
                                newBalance: creditsResult.newBalance,
                                confirmations: status.confirmations
                            });
                            this.broadcastManager.sendStatusUpdate(socket.id, 'success',
                                `✅ CREDITS PURCHASED!\n\n+${creditsResult.creditsAdded} credits added.\nNew balance: ${creditsResult.newBalance} credits.\n\nType 'enter' to start a game!`);
                        } else if (creditsResult.alreadyProcessed) {
                            // Payment was already confirmed (e.g., after server restart) - just notify user
                            console.log(`[PaymentHandlers] Payment ${paymentRequest.id} already processed, skipping duplicate`);
                            socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment already processed.', confirmations: status.confirmations });
                        } else {
                            console.error('Failed to process credits package:', creditsResult.reason);
                            socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment confirmed but failed to add credits. Contact support.', confirmations: status.confirmations });
                        }
                    } catch (e) {
                        console.error('Error processing credits package confirmation:', e.message);
                        socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment confirmed in block!', confirmations: status.confirmations });
                    }
                } else {
                    // single_game payment - standard flow
                    // CRITICAL: Atomically update payment status and check if we actually updated it
                    // This prevents double-processing on server restart
                    let wasUpdated = false;
                    try {
                        if (this.gameModeManager && this.gameModeManager.db) {
                            const updateResult = await this.gameModeManager.db.query(`
                                UPDATE payments
                                SET status = 'confirmed',
                                    confirmed_at = NOW()
                                WHERE id = $1 AND status = 'pending'
                                RETURNING id
                            `, [paymentRequest.id]);
                            wasUpdated = updateResult.rows.length > 0;
                            if (this.debugManager.CONSOLE_LOGGING) {
                                console.log(`[PaymentHandlers] Payment ${paymentRequest.id} status update: ${wasUpdated ? 'success' : 'already confirmed'}`);
                            }
                        }
                    } catch (dbErr) {
                        console.error('[PaymentHandlers] Failed to update payment status in DB:', dbErr.message);
                    }

                    // Only proceed with game logic if we actually confirmed this payment
                    if (!wasUpdated) {
                        console.log(`[PaymentHandlers] Payment ${paymentRequest.id} already confirmed, skipping duplicate processing`);
                        socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment already processed.', confirmations: status.confirmations });
                        this.stopMonitoringForSocket(socket.id);
                        return;
                    }

                    socket.emit('payment_confirmed', { paymentId: paymentRequest.id, message: 'Payment confirmed in block!', confirmations: status.confirmations });

                    // IMPORTANT: If payment confirmed before mempool detection (fast blocks),
                    // the player may not be in the queue yet. Add them now with confirmed=true.
                    const existingIdx = this.queueManager.getPlayerIndex(socket.id);
                    if (existingIdx === -1) {
                        console.log(`[PaymentHandlers] Payment confirmed but player not in queue - adding now (socket: ${socket.id})`);
                        // Try to get DB userId from session
                        let userId = null;
                        if (this.sessionManager?.sessions?.has(socket.id)) {
                            userId = this.sessionManager.sessions.get(socket.id).id;
                        }
                        this.queueManager.addPlayer({
                            serverId: socket.id,
                            clientId: currentUser ? currentUser.clientId : null,
                            userId: userId,
                            paymentId: paymentRequest.id,
                            requiresConfirmation: false, // Already confirmed
                            confirmed: true
                        });
                    } else {
                        // Player was in queue from mempool detection, just mark confirmed
                        this.queueManager.markConfirmed(socket.id);
                    }

                    // Attempt immediate game start so user doesn't wait another full block
                    const currentBlock = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
                    if (currentBlock !== null) {
                        const started = await this.queueManager.startGameImmediately(socket.id, currentBlock);
                        if (!started) {
                            console.log(`[PaymentHandlers] Immediate start failed for ${socket.id} - player will start on next block`);
                            if (this.debugManager.CONSOLE_LOGGING) {
                                this.queueManager.debugDumpQueue();
                            }
                        } else {
                            console.log(`[PaymentHandlers] ✅ Immediate game start successful for ${socket.id}`);
                        }
                    } else {
                        console.log(`[PaymentHandlers] No block height available - player will start on next block`);
                    }
                }
                // Clean up monitoring for this socket (even if duplicate)
                this.stopMonitoringForSocket(socket.id);
            }
        }, 2000);

        // Expire request after 30 minutes if not confirmed
        const expiryTimeout = setTimeout(() => {
            const mapping = this.socketPaymentMap.get(socket.id);
            if (mapping && mapping.address === paymentRequest.address) { // still active and not replaced
                this.stopMonitoringForSocket(socket.id);
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 'Payment request expired. Type \'enter\' again to create a new payment request.');
            }
        }, 30 * 60 * 1000);
        // Store & unref so tests / process can exit
        this._expiryTimeouts.set(socket.id, expiryTimeout);
    }

    /**
     * Check if a socket has active payment monitoring
     * @param {string} socketId - The socket ID to check
     * @returns {boolean} True if monitoring is active
     */
    hasActiveMonitoring(socketId) {
        return this.socketPaymentMap.has(socketId);
    }

    /**
     * Stop monitoring (if any) for a given socket (disconnect/expiry)
     */
    stopMonitoringForSocket(socketId) {
        const mapping = this.socketPaymentMap.get(socketId);
        if (mapping) {
            this.walletService.stopPaymentMonitoring(mapping.address);
            this.socketPaymentMap.delete(socketId);
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
        for (const socketId of Array.from(this.socketPaymentMap.keys())) {
            this.stopMonitoringForSocket(socketId);
        }
        for (const [socketId, to] of this._expiryTimeouts.entries()) {
            clearTimeout(to);
            this._expiryTimeouts.delete(socketId);
        }
    }
}

module.exports = PaymentHandlers;
