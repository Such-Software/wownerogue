/**
 * Chat Handler Module
 * Handles chat messages, commands, and chat-related rate limiting
 */

const ChatHistoryManager = require('./chatHistoryManager');
const SocketChatProvider = require('./chat/SocketChatProvider');
const { clientIp, stableId } = require('./rateLimitContext');

class ChatHandler {
    constructor({ io, broadcastManager, debugManager, addressManager, paymentHandlers, queueManager, gameModeManager, rateLimiter, db }) {
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.addressManager = addressManager;
        this.paymentHandlers = paymentHandlers;
        this.queueManager = queueManager;
        this.gameModeManager = gameModeManager;
        this.rateLimiter = rateLimiter;
        
        // Initialize chat history manager for persistent message storage
        this.chatHistory = new ChatHistoryManager({
            db: db || (gameModeManager?.db),
            debugManager: debugManager,
            maxHistoryMessages: 50
        });

        // Chat delivery + history go through a ChatProvider seam so the backend is swappable
        // (e.g. a Nostr channel later). The default provider shares the ChatHistoryManager
        // instance above, so ban checks / stats that read this.chatHistory keep working and
        // lifecycle (initialize/shutdown) stays owned here.
        this.chatProvider = new SocketChatProvider({
            io: this.io,
            broadcastManager: this.broadcastManager,
            debugManager: this.debugManager,
            historyManager: this.chatHistory
        });

        // Memory leak prevention - cleanup old timestamps
        this._chatLastSent = new Map();
        this.chatCleanupInterval = setInterval(() => this.cleanupChatTimestamps(), 300000); // 5 minutes
        
        this._awaitingAddressFor = new Set(); // Track users waiting for address confirmation
    }

    /**
     * Initialize the chat handler (must be called after construction)
     */
    async initialize() {
        await this.chatHistory.initialize();
    }

    /**
     * Send chat history to a newly connected user
     * @param {string} socketId - Socket ID of the new user
     * @param {number} messageCount - Number of messages to send (default 50)
     */
    async sendChatHistoryToUser(socketId, messageCount = 50) {
        try {
            const messages = await this.chatProvider.getHistory({ scope: 'global', limit: messageCount });
            if (messages.length > 0) {
                this.io.to(socketId).emit('chat_history', { messages });
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.log(`📜 Sent ${messages.length} chat history messages to ${socketId}`);
                }
            }
        } catch (error) {
            console.error('Failed to send chat history:', error.message);
        }
    }

    /**
     * Handle incoming chat messages with rate limiting
     */
    async handleChatMessage(socket, msg, additionalHandlers = {}) {
        try {
            // Rate limiting for chat messages — stable id + IP so reconnecting can't reset it.
            const rlId = stableId(socket, this.gameModeManager?.sessionManager);
            const rlIp = clientIp(socket);
            const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'chat:message', rlIp);

            if (!rateLimitResult.allowed) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                    `Please slow down! You can send ${rateLimitResult.remaining} more messages after ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds.`);
                return;
            }

            // Record the chat attempt
            await this.rateLimiter.recordAttempt(rlId, 'chat:message', rlIp);

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log('Message received:', msg);
            }
            
            const command = msg.toLowerCase();
            
            // Check for XMR/WOW payout address in the message using AddressManager
            const detected = this.addressManager.detectInText(msg);
            if (detected) {
                await this._handleAddressDetection(socket, detected);
                return;
            }
            
            // Handle game commands
            const handled = await this._handleGameCommand(socket, command, additionalHandlers);
            if (handled) {
                return;
            }

            // If not a command, broadcast as chat message
            await this._handleChatBroadcast(socket, msg);

        } catch (error) {
            console.error('Chat handler error:', error);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Message processing failed. Please try again.');
        }
    }

    /**
     * Get chat statistics
     */
    async getStats() {
        const historyStats = await this.chatHistory.getStats();
        return {
            chatTimestamps: this._chatLastSent.size,
            awaitingAddress: this._awaitingAddressFor.size,
            chatHistory: historyStats
        };
    }

    /**
     * Shutdown handler - cleanup resources
     */
    shutdown() {
        if (this.chatCleanupInterval) {
            clearInterval(this.chatCleanupInterval);
            this.chatCleanupInterval = null;
        }
        if (this.chatHistory) {
            this.chatHistory.shutdown();
        }
    }

    /**
     * Clear address confirmation state for a user
     */
    clearAddressConfirmation(socketId) {
        this._awaitingAddressFor.delete(socketId);
    }

    /**
     * Check if user is awaiting address confirmation
     */
    isAwaitingAddressConfirmation(socketId) {
        return this._awaitingAddressFor.has(socketId);
    }

    // Private helper methods

    async promptAddress(socket) {
        await this._promptAddress(socket);
    }

    async _handleAddressDetection(socket, detected) {
        // Rate limiting for address setting — stable id + IP.
        const rlId = stableId(socket, this.gameModeManager?.sessionManager);
        const rlIp = clientIp(socket);
        const rateLimitResult = await this.rateLimiter.checkLimit(rlId, 'address:set', rlIp);

        if (!rateLimitResult.allowed) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                `Address changes are rate limited. Try again in ${Math.ceil(rateLimitResult.retryAfter / 1000)} seconds.`);
            return;
        }

        await this.rateLimiter.recordAttempt(rlId, 'address:set', rlIp);
        this.addressManager.handleDetection(socket.id, detected);
    }

    async _handleGameCommand(socket, command, additionalHandlers) {
        switch (command) {
            case 'hello':
                this.broadcastManager.sendStatusUpdate(socket.id, 'help', 
                    'Welcome! Type "enter" to join the queue for the next block, or use the START button for immediate entry. ' +
                    'Paste your XMR/WOW address in chat to set your payout address.');
                return true;
                
            case 'enter':
                if (additionalHandlers.handleGameQueue) {
                    await additionalHandlers.handleGameQueue(socket);
                }
                return true;
                
            case 'cancel':
                if (this.addressManager.pending.has(socket.id)) {
                    this.addressManager.confirm(socket.id, false);
                    return true;
                }
                if (additionalHandlers.handleCancelEntry) {
                    await additionalHandlers.handleCancelEntry(socket);
                }
                return true;

            case 'confirm':
                if (this.addressManager.pending.has(socket.id)) {
                    this.addressManager.confirm(socket.id, true);
                    return true;
                }
                this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Nothing pending confirmation.');
                return true;
                
            case 'address':
            case 'payout':
                await this._promptAddress(socket);
                return true;
                
            case 'payment':
            case 'pay':
                // Legacy payment command path removed; auto-create request if needed
                if (this.gameModeManager) {
                    await this.paymentHandlers.createAndShowPaymentRequest(socket);
                } else {
                    this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Server is in FREE mode - no payment required.');
                }
                return true;

            case 'stats':
                if (additionalHandlers.handleStatsRequest) {
                    await additionalHandlers.handleStatsRequest(socket);
                }
                return true;
                
            default:
                // Check for /nick command (case-sensitive prefix)
                if (command.startsWith('/nick ') || command === '/nick') {
                    await this._handleNickCommand(socket, command);
                    return true;
                }
                return false; // Command not handled
        }
    }

    async _handleNickCommand(socket, command) {
        const name = command.slice(6).trim();
        if (!name) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info',
                'Usage: /nick YourName (max 20 chars, letters/numbers/underscores)');
            return;
        }

        // Validate: 1-20 chars, alphanumeric + underscores + spaces
        if (!/^[a-zA-Z0-9_ ]{1,20}$/.test(name)) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                'Invalid name. Use letters, numbers, underscores, or spaces (max 20 chars).');
            return;
        }

        if (!this.gameModeManager?.db) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Display names not available.');
            return;
        }

        try {
            await this.gameModeManager.db.query(
                'UPDATE users SET display_name = $1 WHERE socket_id = $2',
                [name.trim(), socket.id]
            );
            this.broadcastManager.sendStatusUpdate(socket.id, 'info',
                'Display name set to: ' + name.trim());
        } catch (err) {
            console.error('Failed to set display name:', err.message);
            this.broadcastManager.sendStatusUpdate(socket.id, 'error', 'Failed to set display name.');
        }
    }

    async _handleChatBroadcast(socket, msg) {
        if (typeof msg !== 'string') return;
        const trimmed = msg.trim();
        if (!trimmed) return;

        // Message length limit (reject, don't truncate)
        const MAX_MESSAGE_LENGTH = 200;
        if (trimmed.length > MAX_MESSAGE_LENGTH) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                `Message too long (${trimmed.length}/${MAX_MESSAGE_LENGTH} characters). Please shorten it.`);
            return;
        }

        // Get user info for ban check and user_id
        let userId = null;
        if (this.gameModeManager) {
            try {
                const userRow = await this.gameModeManager.getOrCreateUser(socket.id);
                userId = userRow?.id || null;

                // Check if user is chat banned
                if (userId && await this.chatHistory.isUserChatBanned(userId)) {
                    this.broadcastManager.sendStatusUpdate(socket.id, 'error',
                        'You have been banned from chat.');
                    return;
                }
            } catch (e) {
                // Continue without user lookup - allow message
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.warn('User lookup for chat failed:', e.message);
                }
            }
        }

        // Additional rate limit for broadcast messages (more restrictive)
        const now = Date.now();
        const last = this._chatLastSent.get(socket.id) || 0;
        const BROADCAST_COOLDOWN = 2000; // 2 seconds between broadcasts

        if (now - last < BROADCAST_COOLDOWN) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'warning',
                `Please wait ${Math.ceil((BROADCAST_COOLDOWN - (now - last)) / 1000)} seconds before sending another message.`);
            return;
        }

        this._chatLastSent.set(socket.id, now);

        // Complete HTML entity escaping to prevent XSS
        // Note: length already validated above, slice is just a safety net
        const safe = trimmed
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .slice(0, MAX_MESSAGE_LENGTH);
        const username = socket.id.substring(0, 6);

        // Deliver + persist through the chat provider (global scope). The provider saves to
        // history (fire-and-forget) and broadcasts, matching the previous inline behaviour.
        await this.chatProvider.publish({
            scope: 'global',
            username: username,
            text: safe,
            ts: now,
            socketId: socket.id,
            userId: userId
        });
    }

    /**
     * Cleanup old chat timestamps to prevent memory leaks
     */
    cleanupChatTimestamps() {
        const now = Date.now();
        const TIMESTAMP_EXPIRY = 600000; // 10 minutes
        let cleanedCount = 0;

        for (const [socketId, timestamp] of this._chatLastSent.entries()) {
            if (now - timestamp > TIMESTAMP_EXPIRY) {
                this._chatLastSent.delete(socketId);
                cleanedCount++;
            }
        }

        if (this.debugManager.CONSOLE_LOGGING && cleanedCount > 0) {
            console.log(`🧹 ChatHandler cleanup: removed ${cleanedCount} old timestamps`);
        }
    }

    async _promptAddress(socket) {
        let existing = null;
        try {
            if (this.gameModeManager) {
                const userRow = await this.gameModeManager.getOrCreateUser(socket.id);
                existing = userRow?.payout_address || null;
            }
        } catch (e) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.warn('Address prompt lookup failed:', e.message);
            }
        }

        socket.emit('address_prompt', {
            existingAddress: existing,
            canUpdate: true
        });

        if (existing) {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Update your payout address using the address manager.');
        } else {
            this.broadcastManager.sendStatusUpdate(socket.id, 'info', 'Add your payout address to receive rewards.');
        }
    }
}

module.exports = ChatHandler;