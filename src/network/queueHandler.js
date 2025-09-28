/**
 * Queue Handler Module
 * Handles game queue operations, validation, and queue management
 */

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
    async handleGameQueue(socket, getUserBySocket) {
        try {
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

            // Check payment eligibility and payout address requirements
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

            // Record the queue attempt
            await this.rateLimiter.recordAttempt(socket.id, 'game:queue');

            // Add to waiting queue (in free mode or already authorized paid mode)
            this.queueManager.addPlayer({
                serverId: socket.id,
                clientId: currentUser.clientId,
                requiresConfirmation: false,
                confirmed: true
            });

            const currentBlock = this.debugManager.getCurrentBlockHeight();
            const nextBlock = currentBlock + 1;
            this.broadcastManager.sendStatusUpdate(socket.id, 'queue', 
                `Added to queue! You will enter when block ${nextBlock} is found. Current block: ${currentBlock}`);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🕒 QUEUE ENTRY: Player ${socket.id} queued for block ${nextBlock}. Queue length: ${this.queueManager.getQueueLength()}`);
            }
        } catch (error) {
            console.error('handleGameQueue error:', error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Failed to join queue. Please try again.');
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
    startGamesForWaiting(blockHeight) {
        return this.queueManager.startGamesForWaiting(blockHeight);
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