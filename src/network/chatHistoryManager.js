/**
 * Chat History Manager
 * Handles persistent storage and retrieval of chat messages
 */

class ChatHistoryManager {
    constructor({ db, debugManager, maxHistoryMessages = 50, inMemoryFallbackSize = 100 }) {
        this.db = db;
        this.debugManager = debugManager;
        this.maxHistoryMessages = maxHistoryMessages;
        
        // In-memory fallback for when DB is not available
        this._inMemoryHistory = [];
        this._inMemoryFallbackSize = inMemoryFallbackSize;
        
        // Cache recent messages in memory for fast access
        this._recentMessagesCache = [];
        this._cacheSize = maxHistoryMessages;
        this._cacheInitialized = false;
        
        // Cleanup old messages periodically (once per day)
        this._cleanupInterval = null;
        this._maxMessageAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    }

    /**
     * Initialize the manager - load recent messages into cache
     */
    async initialize() {
        try {
            if (this.db) {
                // Ensure table exists
                await this._ensureTable();
                
                // Load recent messages into cache
                await this._refreshCache();
                
                // Start cleanup interval (run once per day)
                this._cleanupInterval = setInterval(() => {
                    this.cleanupOldMessages().catch(err => {
                        console.error('Chat history cleanup error:', err.message);
                    });
                }, 24 * 60 * 60 * 1000);
                
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.log(`💬 ChatHistoryManager initialized with ${this._recentMessagesCache.length} cached messages`);
                }
            } else {
                console.warn('ChatHistoryManager: No database available, using in-memory fallback');
            }
            this._cacheInitialized = true;
        } catch (error) {
            console.error('ChatHistoryManager initialization error:', error.message);
            // Fall back to in-memory mode
            this._cacheInitialized = true;
        }
    }

    /**
     * Ensure the chat_messages table exists
     */
    async _ensureTable() {
        if (!this.db) return;
        
        try {
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id SERIAL PRIMARY KEY,
                    socket_id VARCHAR(255),
                    username VARCHAR(50),
                    message TEXT NOT NULL,
                    message_type VARCHAR(20) DEFAULT 'chat',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create index if it doesn't exist
            await this.db.query(`
                CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at 
                ON chat_messages(created_at DESC)
            `);
        } catch (error) {
            // Table might already exist, that's fine
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('Chat table check:', error.message);
            }
        }
    }

    /**
     * Refresh the in-memory cache from database
     */
    async _refreshCache() {
        if (!this.db) return;
        
        try {
            const result = await this.db.query(`
                SELECT id, socket_id, username, message, message_type, created_at
                FROM chat_messages
                ORDER BY created_at DESC
                LIMIT $1
            `, [this._cacheSize]);
            
            // Reverse to get chronological order (oldest first)
            this._recentMessagesCache = result.rows.reverse().map(row => ({
                id: row.id,
                socketId: row.socket_id,
                username: row.username,
                message: row.message,
                type: row.message_type,
                timestamp: new Date(row.created_at).getTime()
            }));
        } catch (error) {
            console.error('Failed to refresh chat cache:', error.message);
        }
    }

    /**
     * Save a chat message
     * @param {Object} messageData - Message data
     * @param {string} messageData.socketId - Socket ID of sender
     * @param {string} messageData.username - Display username (playerId)
     * @param {string} messageData.message - Message content
     * @param {string} messageData.type - Message type (chat, system, event)
     * @param {number} [messageData.userId] - Optional user ID from database
     * @returns {Object} Saved message with id and timestamp
     */
    async saveMessage({ socketId, username, message, type = 'chat', userId = null }) {
        const timestamp = Date.now();
        const playerId = username; // username IS the playerId (6-char display ID)
        const messageObj = {
            socketId,
            username,
            playerId,
            message,
            type,
            timestamp,
            userId
        };

        // Add to in-memory cache immediately
        this._recentMessagesCache.push(messageObj);
        if (this._recentMessagesCache.length > this._cacheSize) {
            this._recentMessagesCache.shift();
        }

        // Also add to fallback array
        this._inMemoryHistory.push(messageObj);
        if (this._inMemoryHistory.length > this._inMemoryFallbackSize) {
            this._inMemoryHistory.shift();
        }

        // Persist to database asynchronously (best effort)
        if (this.db) {
            try {
                const result = await this.db.query(`
                    INSERT INTO chat_messages (socket_id, username, player_id, user_id, message, message_type, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, NOW())
                    RETURNING id
                `, [socketId, username, playerId, userId, message, type]);

                messageObj.id = result.rows[0]?.id;
            } catch (error) {
                console.error('Failed to persist chat message:', error.message);
                // Message is still in memory, so users will see it
            }
        }

        return messageObj;
    }

    /**
     * Get recent messages for a new user
     * Uses hybrid strategy: last hour of messages, OR last 10 messages if < 10 in last hour
     * @param {number} maxCount - Maximum number of messages to retrieve (default: 50)
     * @param {number} minCount - Minimum messages to show if recent activity is low (default: 10)
     * @returns {Array} Array of recent messages
     */
    async getRecentMessages(maxCount = 50, minCount = 10) {
        // Try database first for hybrid strategy
        if (this.db) {
            try {
                // Hybrid query: Get messages from last hour, OR last N messages if fewer than minCount
                const result = await this.db.query(`
                    WITH recent_hour AS (
                        SELECT id, socket_id, username, player_id, message, message_type, created_at
                        FROM chat_messages
                        WHERE deleted_at IS NULL
                        AND created_at > NOW() - INTERVAL '1 hour'
                        ORDER BY created_at DESC
                        LIMIT $1
                    ),
                    fallback AS (
                        SELECT id, socket_id, username, player_id, message, message_type, created_at
                        FROM chat_messages
                        WHERE deleted_at IS NULL
                        ORDER BY created_at DESC
                        LIMIT $2
                    )
                    SELECT * FROM (
                        SELECT * FROM recent_hour
                        UNION
                        SELECT * FROM fallback
                    ) combined
                    ORDER BY created_at ASC
                    LIMIT $1
                `, [maxCount, minCount]);

                return result.rows.map(row => ({
                    id: row.id,
                    socketId: row.socket_id,
                    username: row.username,
                    playerId: row.player_id || row.username,
                    message: row.message,
                    type: row.message_type,
                    timestamp: new Date(row.created_at).getTime()
                }));
            } catch (error) {
                console.error('Failed to get recent messages from DB:', error.message);
            }
        }

        // Fallback to cache (filter out deleted messages)
        const limit = Math.min(maxCount, this._cacheSize);

        if (this._cacheInitialized && this._recentMessagesCache.length > 0) {
            const activeMessages = this._recentMessagesCache.filter(m => !m.deletedAt);
            return activeMessages.slice(-limit);
        }

        // Final fallback to in-memory
        if (this._inMemoryHistory.length > 0) {
            const activeMessages = this._inMemoryHistory.filter(m => !m.deletedAt);
            return activeMessages.slice(-limit);
        }

        return [];
    }

    /**
     * Clean up old messages (older than 30 days by default)
     * @param {number} maxAgeMs - Maximum message age in milliseconds
     * @returns {number} Number of messages deleted
     */
    async cleanupOldMessages(maxAgeMs = this._maxMessageAge) {
        if (!this.db) return 0;
        
        try {
            const cutoffDate = new Date(Date.now() - maxAgeMs);
            const result = await this.db.query(`
                DELETE FROM chat_messages
                WHERE created_at < $1
            `, [cutoffDate]);
            
            const deletedCount = result.rowCount || 0;
            
            if (this.debugManager?.CONSOLE_LOGGING && deletedCount > 0) {
                console.log(`🧹 Cleaned up ${deletedCount} old chat messages`);
            }
            
            return deletedCount;
        } catch (error) {
            console.error('Chat cleanup error:', error.message);
            return 0;
        }
    }

    /**
     * Check if a user is banned from chat
     * @param {number} userId - User ID to check
     * @returns {boolean} True if user is banned
     */
    async isUserChatBanned(userId) {
        if (!userId || !this.db) return false;

        try {
            const result = await this.db.query(
                'SELECT chat_banned FROM users WHERE id = $1',
                [userId]
            );
            return result.rows[0]?.chat_banned === true;
        } catch (error) {
            console.error('Failed to check chat ban status:', error.message);
            return false;
        }
    }

    /**
     * Soft delete a message (admin moderation)
     * @param {number} messageId - Message ID to delete
     * @param {string} deletedBy - Admin identifier
     * @param {string} reason - Reason for deletion
     * @returns {boolean} True if deleted successfully
     */
    async deleteMessage(messageId, deletedBy = 'admin', reason = null) {
        if (!this.db) return false;

        try {
            const result = await this.db.query(`
                UPDATE chat_messages
                SET deleted_at = NOW(), deleted_by = $2, delete_reason = $3
                WHERE id = $1 AND deleted_at IS NULL
                RETURNING id
            `, [messageId, deletedBy, reason]);

            if (result.rowCount > 0) {
                // Also remove from in-memory caches
                this._recentMessagesCache = this._recentMessagesCache.filter(m => m.id !== messageId);
                this._inMemoryHistory = this._inMemoryHistory.filter(m => m.id !== messageId);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Failed to delete chat message:', error.message);
            return false;
        }
    }

    /**
     * Get messages for admin view (includes deleted)
     * @param {number} limit - Number of messages
     * @param {boolean} includeDeleted - Whether to include deleted messages
     * @returns {Array} Messages for admin
     */
    async getMessagesForAdmin(limit = 100, includeDeleted = false) {
        if (!this.db) return [];

        try {
            const result = await this.db.query(`
                SELECT
                    c.id, c.socket_id, c.username, c.player_id, c.user_id,
                    c.message, c.message_type, c.created_at,
                    c.deleted_at, c.deleted_by, c.delete_reason,
                    u.payout_address, u.chat_banned
                FROM chat_messages c
                LEFT JOIN users u ON c.user_id = u.id
                ${includeDeleted ? '' : 'WHERE c.deleted_at IS NULL'}
                ORDER BY c.created_at DESC
                LIMIT $1
            `, [limit]);

            return result.rows.map(row => ({
                id: row.id,
                socketId: row.socket_id,
                username: row.username,
                playerId: row.player_id,
                userId: row.user_id,
                message: row.message,
                type: row.message_type,
                timestamp: new Date(row.created_at).getTime(),
                createdAt: row.created_at,
                deletedAt: row.deleted_at,
                deletedBy: row.deleted_by,
                deleteReason: row.delete_reason,
                payoutAddress: row.payout_address,
                chatBanned: row.chat_banned
            }));
        } catch (error) {
            console.error('Failed to get admin messages:', error.message);
            return [];
        }
    }

    /**
     * Get message count for statistics
     * @returns {Object} Statistics about chat messages
     */
    async getStats() {
        const stats = {
            cachedMessages: this._recentMessagesCache.length,
            inMemoryFallback: this._inMemoryHistory.length,
            totalInDb: null
        };
        
        if (this.db) {
            try {
                const result = await this.db.query('SELECT COUNT(*) as count FROM chat_messages');
                stats.totalInDb = parseInt(result.rows[0]?.count || 0);
            } catch (error) {
                // Ignore errors for stats
            }
        }
        
        return stats;
    }

    /**
     * Shutdown - cleanup intervals
     */
    shutdown() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }
}

module.exports = ChatHistoryManager;
