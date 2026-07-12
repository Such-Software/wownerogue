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
            // The player explicitly chose FREE play (Pleb board). Only honoured when the instance
            // allows free play; otherwise fall through to the paid eligibility check below. Mirrors
            // the auto_start free path so the "Next block · Free Play" choice doesn't wrongly pop the
            // payment modal for a free queued game.
            const wantsFree = opts.free === true && this.gameModeManager?.freePlayEnabled;
            // Rate limiting for queue attempts
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

            // Check if already waiting
            const existingIndex = this.queueManager.getPlayerIndex(socket.id);
            if (existingIndex !== -1) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'You are already in the queue!');
                return;
            }

            // Check if already in a game
            if (this.activeGames.has(socket.id)) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'You are already in a game!');
                return;
            }

            // Check payment eligibility and payout address requirements — SKIPPED for free play.
            if (!wantsFree) {
                const paymentCheckResult = await this._checkPaymentEligibility(socket.id);
                if (!paymentCheckResult.allowed) {
                    // Handle the specific reason for denial
                    switch (paymentCheckResult.action) {
                        case 'set_address':
                            this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '⚠️ Paste your payout address first, then type confirm.');
                            break;
                        case 'make_payment':
                            await this.paymentHandlers.createAndShowPaymentRequest(socket);
                            break;
                        default:
                            this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                                paymentCheckResult.reason || 'Not allowed to join queue');
                    }
                    return;
                }
            }

            // Record the queue attempt
            await this.rateLimiter.recordAttempt(socket.id, 'game:queue');

            // Get session info to pass userId
            let userId = null;
            if (this.paymentHandlers?.gameModeManager?.getOrCreateUser) {
                try {
                    const dbUser = await this.paymentHandlers.gameModeManager.getOrCreateUser(socket.id);
                    userId = dbUser.id;
                } catch (e) {}
            }

            // Add to waiting queue (in free mode or already authorized paid mode). `free` carries the
            // Pleb-board intent to processGameStart when the block lands, so no credit/payment is taken.
            this.queueManager.addPlayer({
                serverId: socket.id,
                clientId: currentUser.clientId,
                userId: userId,
                requiresConfirmation: false,
                confirmed: true,
                free: wantsFree
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
            // Add more specific queue stats if needed
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
        
        // Check master toggle
        if (!earlyEntry?.enabled) {
            return { allowed: false, reason: 'Early entry is disabled' };
        }

        const mode = this.gameModeManager.gameMode;
        
        // Check mode-specific toggles
        if (mode === 'FREE' && !earlyEntry.allowInFreeMode) {
            return { allowed: false, reason: 'Early entry not allowed in free mode' };
        }
        
        if (mode === 'PAID_CREDITS' && !earlyEntry.allowInCreditsMode) {
            return { allowed: false, reason: 'Early entry not allowed in credits mode' };
        }
        
        // PAID_SINGLE (direct payment) should NOT allow early entry - players paid for a full block
        if (mode === 'PAID_SINGLE') {
            return { allowed: false, reason: 'Early entry not allowed for direct payment games' };
        }

        return { allowed: true, reason: `Early entry allowed for ${mode}` };
    }

    /**
     * Handle early entry request - start game immediately without waiting for next block
     * Risk: Player will die if next block is found before they escape
     */
    async handleEarlyEntry(socket, getUserBySocket) {
        try {
            // Rate limiting
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

            // Check if early entry is allowed
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

            // Check if already in queue
            if (this.queueManager.isPlayerQueued(socket.id)) {
                const msg = 'You are already in the queue! Use early entry only when not queued.';
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', msg);
                return { success: false, reason: 'already_queued' };
            }

            // Check if already in a game
            if (this.activeGames.has(socket.id)) {
                const msg = 'You are already in a game!';
                socket.emit('early_entry_error', { message: msg });
                this.broadcastManager.sendStatusUpdate(socket.id, 'error', msg);
                return { success: false, reason: 'already_in_game' };
            }

            // Check payment eligibility
            const paymentCheckResult = await this._checkPaymentEligibility(socket.id);
            if (!paymentCheckResult.allowed) {
                switch (paymentCheckResult.action) {
                    case 'set_address':
                        this.broadcastManager.sendStatusUpdate(socket.id, 'payment', '⚠️ Paste your payout address first, then type confirm.');
                        break;
                    case 'make_payment':
                        await this.paymentHandlers.createAndShowPaymentRequest(socket);
                        break;
                    default:
                        this.broadcastManager.sendStatusUpdate(socket.id, 'error', 
                            paymentCheckResult.reason || 'Not allowed to start game');
                }
                return { success: false, reason: paymentCheckResult.reason };
            }

            // Record the attempt
            await this.rateLimiter.recordAttempt(socket.id, 'game:queue');

            // Start the game immediately
            const currentBlock = this.debugManager.getCurrentBlockHeight();
            
            // For early entry, the player's blockRec is set to current block
            // This means they will die when the NEXT block is found (currentBlock + 1)
            const result = await this.queueManager.startEarlyGame(socket.id, currentUser, currentBlock);
            
            if (result.success) {
                // Emit early entry success event
                socket.emit('early_entry_success', { blockHeight: currentBlock });
                
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 
                    `⚡ Early entry! Game started on block ${currentBlock}. Escape before block ${currentBlock + 1}!`);
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`⚡ EARLY ENTRY: Player ${socket.id} started on block ${currentBlock}`);
                }
                return { success: true, blockHeight: currentBlock };
            } else {
                // Emit early entry error event
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
            // Check payout address requirement for payout-eligible modes
            const payoutEligible = (this.gameModeManager.gameMode === 'PAID_SINGLE') || 
                                 (this.gameModeManager.gameMode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
            
            if (payoutEligible) {
                const user = await this.gameModeManager.getOrCreateUser(socketId);
                if (!user.payout_address) {
                    return { 
                        allowed: false, 
                        action: 'set_address',
                        reason: 'Payout address required' 
                    };
                }
            }

            // Check general payment eligibility
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
            
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`✅ Payment validated for ${socketId}: ${eligibility.reason}`);
            }
            
            return { allowed: true, reason: eligibility.reason };
            
        } catch (error) {
            console.error('Error checking payment eligibility:', error);
            
            // In paid mode, don't add to queue if payment check fails
            if (this.gameModeManager.gameMode !== 'FREE') {
                return {
                    allowed: false,
                    reason: 'Payment system error. Please try again or contact support.'
                };
            }
            
            // Only in FREE mode, continue to queue on payment system errors
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log('Payment system unavailable, allowing free mode queue entry');
            }
            this.broadcastManager.sendStatusUpdate(socketId, 'warning', 'Payment system unavailable. Playing in FREE mode.');
            return { allowed: true, reason: 'Free mode fallback' };
        }
    }
}

module.exports = QueueHandler;