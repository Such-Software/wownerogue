/**
 * Queue Handler Module
 * Handles game queue operations, validation, and queue management
 */

const { normalizeError } = require('../utils/errors');

class QueueHandler {
    constructor({ queueManager, gameModeManager, paymentHandlers, activeGames, broadcastManager, debugManager, rateLimiter }) {
        this.queueManager = queueManager;
        this.gameModeManager = gameModeManager;
        this.paymentHandlers = paymentHandlers;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.rateLimiter = rateLimiter;
    }

    /**
     * Handle game queue request (typing "enter") with rate limiting
     */
    async handleGameQueue(socket, getUserBySocket, opts = {}) {
        try {
            // Explicit FREE play (Pleb board) intent, honoured only when the instance allows free
            // play; otherwise the paid eligibility check below applies. Matches the auto_start free
            // path so a free queued game never raises the payment modal.
            const wantsFree = opts.free === true && this.gameModeManager?.freePlayEnabled;
            let authorizedFairnessProof = opts.fairnessProof || null;
            let authorizedPaymentId = null;
            const rateLimitResult = await this.rateLimiter.checkLimit(socket.id, 'game:queue');
            if (!rateLimitResult.allowed) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', 
                    `Please wait ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds before trying to join queue again.`);
                return;
            }

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Player ${socket.id} requested to enter the dungeon`);
            }
            
            const currentUser = getUserBySocket(socket.id);
            if (!currentUser) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Error: Could not add to queue. Please try again.');
                return;
            }

            const existingIndex = this.queueManager.getPlayerIndex(socket.id);
            if (existingIndex !== -1) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'You are already in the queue!');
                return;
            }

            if (this.activeGames.has(socket.id)) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'You are already in a game!');
                return;
            }

            // Payment eligibility and payout address requirements do not apply to free play.
            if (!wantsFree) {
                const paymentCheckResult = await this._checkPaymentEligibility(socket.id);
                if (!paymentCheckResult.allowed) {
                    switch (paymentCheckResult.action) {
                        case 'set_address':
                            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '⚠️ Paste your payout address first, then type confirm.');
                            break;
                        case 'make_payment':
                            await this.paymentHandlers.createAndShowPaymentRequest(socket, {
                                fairnessProof: opts.fairnessProof || null,
                                legalAcknowledgement: opts.legalAcknowledgement
                            });
                            break;
                        default:
                            this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                                paymentCheckResult.reason || 'Not allowed to join queue');
                    }
                    return;
                }
                if (paymentCheckResult.effectiveMode === 'PAID_SINGLE') {
                    authorizedFairnessProof = paymentCheckResult.fairnessProof || null;
                    authorizedPaymentId = paymentCheckResult.paymentId || null;
                    if (this.gameModeManager._requiresPaidFairnessV2?.() && !authorizedFairnessProof) {
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                            'This paid entry has no durable fairness binding and requires support review.');
                        return;
                    }
                }
            }

            await this.rateLimiter.recordAttempt(socket.id, 'game:queue');

            let userId = null;
            if (this.paymentHandlers?.gameModeManager?.getOrCreateUser) {
                try {
                    const dbUser = await this.paymentHandlers.gameModeManager.getOrCreateUser(socket.id);
                    userId = dbUser.id;
                } catch (e) {}
            }

            // Reached only in free mode or with an already authorized paid entry. `free` carries the
            // Pleb-board intent to processGameStart when the block lands, so no credit/payment is taken.
            this.queueManager.addPlayer({
                serverId: socket.id,
                clientId: currentUser.clientId,
                userId: userId,
                paymentId: authorizedPaymentId,
                requiresConfirmation: false,
                confirmed: true,
                free: wantsFree,
                fairnessProof: authorizedFairnessProof
            });

            const currentBlock = this.debugManager.getCurrentBlockHeight();
            const nextBlock = currentBlock + 1;
            this.broadcastManager.sendStatusUpdate(socket.id, 'queue', 
                `Added to queue! You will enter when block ${nextBlock} is found. Current block: ${currentBlock}`);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🕒 QUEUE ENTRY: Player ${socket.id} queued for block ${nextBlock}. Queue length: ${this.queueManager.getQueueLength()}`);
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to join queue');
            console.error('handleGameQueue error:', normalized.message);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', normalized.message);
        }
    }

    /**
     * Handle queue cancellation
     */
    handleCancelEntry(socket) {
        this.queueManager.removePlayer(socket.id);
        this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Removed from queue.');
    }

    /**
     * Start games for waiting players when a new block is found
     */
    async startGamesForWaiting(blockHeight) {
        return await this.queueManager.startGamesForWaiting(blockHeight);
    }

    /**
     * Get queue statistics
     */
    getStats() {
        return {
            length: this.queueManager.getQueueLength(),
        };
    }

    /**
     * Check if early entry is allowed for the current mode
     * @returns {Object} { allowed: boolean, reason: string }
     */
    isEarlyEntryAllowed() {
        if (!this.gameModeManager) {
            return { allowed: true, reason: 'No game mode manager' };
        }

        const config = this.gameModeManager.configSnapshot;
        const earlyEntry = config?.earlyEntry;

        if (!earlyEntry?.enabled) {
            return { allowed: false, reason: 'Early entry is disabled' };
        }

        const mode = this.gameModeManager.gameMode;

        if (mode === 'FREE' && !earlyEntry.allowInFreeMode) {
            return { allowed: false, reason: 'Early entry not allowed in free mode' };
        }
        
        if (mode === 'PAID_CREDITS' && !earlyEntry.allowInCreditsMode) {
            return { allowed: false, reason: 'Early entry not allowed in credits mode' };
        }

        // Direct payment buys a full block, so PAID_SINGLE never allows early entry.
        if (mode === 'PAID_SINGLE') {
            return { allowed: false, reason: 'Early entry not allowed for direct payment games' };
        }

        return { allowed: true, reason: `Early entry allowed for ${mode}` };
    }

    /**
     * Handle early entry request: start the game immediately instead of waiting for the next block.
     * The player dies if the next block is found before they escape.
     */
    async handleEarlyEntry(socket, getUserBySocket, opts = {}) {
        try {
            const rateLimitResult = await this.rateLimiter.checkLimit(socket.id, 'game:queue');
            if (!rateLimitResult.allowed) {
                const msg = `Please wait ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds before trying again.`;
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning', msg);
                return { success: false, reason: 'rate_limited' };
            }

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`⚡ Player ${socket.id} requested early entry`);
            }

            const earlyEntryCheck = this.isEarlyEntryAllowed();
            if (!earlyEntryCheck.allowed) {
                socket.emit('early_entry_error', { message: earlyEntryCheck.reason });
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', earlyEntryCheck.reason);
                return { success: false, reason: earlyEntryCheck.reason };
            }

            const currentUser = getUserBySocket(socket.id);
            if (!currentUser) {
                const msg = 'Error: Could not start game. Please try again.';
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', msg);
                return { success: false, reason: 'user_not_found' };
            }

            if (this.queueManager.isPlayerQueued(socket.id)) {
                const msg = 'You are already in the queue! Use early entry only when not queued.';
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', msg);
                return { success: false, reason: 'already_queued' };
            }

            if (this.activeGames.has(socket.id)) {
                const msg = 'You are already in a game!';
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', msg);
                return { success: false, reason: 'already_in_game' };
            }

            const paymentCheckResult = await this._checkPaymentEligibility(socket.id);
            if (!paymentCheckResult.allowed) {
                switch (paymentCheckResult.action) {
                    case 'set_address':
                        this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '⚠️ Paste your payout address first, then type confirm.');
                        break;
                    case 'make_payment':
                        await this.paymentHandlers.createAndShowPaymentRequest(socket, {
                            legalAcknowledgement: opts.legalAcknowledgement
                        });
                        break;
                    default:
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                            paymentCheckResult.reason || 'Not allowed to start game');
                }
                return { success: false, reason: paymentCheckResult.reason };
            }

            await this.rateLimiter.recordAttempt(socket.id, 'game:queue');

            // The player's blockRec is the current block, so they die when block currentBlock + 1
            // is found.
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            const result = await this.queueManager.startEarlyGame(socket.id, currentUser, currentBlock, {
                fairnessProof: opts.fairnessProof || null
            });
            
            if (result.success) {
                socket.emit('early_entry_success', { blockHeight: currentBlock });
                
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    `⚡ Early entry! Game started on block ${currentBlock}. Escape before block ${currentBlock + 1}!`);
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`⚡ EARLY ENTRY: Player ${socket.id} started on block ${currentBlock}`);
                }
                return { success: true, blockHeight: currentBlock };
            } else {
                socket.emit('early_entry_error', { message: result.reason || 'Failed to start early game' });
                
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', result.reason || 'Failed to start early game');
                return { success: false, reason: result.reason };
            }

        } catch (error) {
            const normalized = normalizeError(error, 'Failed to start early game');
            console.error('handleEarlyEntry error:', normalized.message);
            socket.emit('early_entry_error', { message: normalized.message });
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', normalized.message);
            return { success: false, reason: normalized.message };
        }
    }

    // Private helper methods

    /**
     * Check payment eligibility and payout address requirements
     * @param {string} socketId - Socket ID
     * @returns {Object} { allowed: boolean, action?: string, reason?: string }
     */
    async _checkPaymentEligibility(socketId) {
        if (!this.gameModeManager) {
            return { allowed: true, reason: 'Free mode' };
        }

        try {
            // Eligibility resolves first: on a mixed instance the entry may consume a credit or a
            // confirmed direct payment, and those modes have different payout policies. The address
            // gate applies to the mode processGameStart will actually use.
            const eligibility = await this.gameModeManager.canUserStartGame(socketId);

            if (!eligibility.allowed) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`❌ Payment required for ${socketId}: ${eligibility.reason}`);
                }

                return {
                    allowed: false,
                    action: eligibility.action === 'purchase_credits' ? 'make_payment' : 'make_payment',
                    reason: eligibility.reason
                };
            }

            const effectiveMode = eligibility.effectiveMode || this.gameModeManager.gameMode;
            const needsAddress = typeof this.gameModeManager.requiresPayoutAddressForMode === 'function'
                ? this.gameModeManager.requiresPayoutAddressForMode(effectiveMode)
                : ((effectiveMode === 'PAID_SINGLE')
                    || (effectiveMode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled));

            if (needsAddress) {
                const user = await this.gameModeManager.getOrCreateUser(socketId);
                if (!user.payout_address) {
                    return {
                        allowed: false,
                        action: 'set_address',
                        reason: 'Payout address required'
                    };
                }
            }

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`✅ Payment validated for ${socketId}: ${eligibility.reason}`);
            }
            
            return {
                allowed: true,
                reason: eligibility.reason,
                effectiveMode,
                paymentId: eligibility.paymentId || null,
                fairnessProof: eligibility.fairnessProof || null
            };
            
        } catch (error) {
            console.error('Error checking payment eligibility:', error);
            
            // A failed payment check blocks queue entry in any paid mode.
            if (this.gameModeManager.gameMode !== 'FREE') {
                return {
                    allowed: false,
                    reason: 'Payment system error. Please try again or contact support.'
                };
            }
            
            // FREE mode degrades gracefully: queue entry continues when the payment system errors.
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log('Payment system unavailable, allowing free mode queue entry');
            }
            this.broadcastManager.sendStatusUpdate(socketId, 'warning', 'Payment system unavailable. Playing in FREE mode.');
            return { allowed: true, reason: 'Free mode fallback' };
        }
    }
}

module.exports = QueueHandler;
