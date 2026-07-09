const ChatProvider = require('./ChatProvider');

/**
 * SocketChatProvider — the default ChatProvider, backed by Socket.IO for delivery and (for
 * global chat) the Postgres-backed ChatHistoryManager for persistence.
 *
 * Behaviour matches the pre-seam chat exactly:
 *   • global scope → persist via the history manager + broadcast to everyone
 *     (broadcastManager.broadcastChatMessage, i.e. io.emit 'chat_broadcast').
 *   • room scope   → deliver only to that Socket.IO room, ephemeral (no history).
 *
 * A history manager may be injected (so ChatHandler shares its existing instance) or omitted
 * (tavern chat, which is ephemeral). When omitted, this provider persists nothing.
 */
class SocketChatProvider extends ChatProvider {
    constructor({ io, broadcastManager = null, debugManager = null, historyManager = null } = {}) {
        super();
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.history = historyManager;   // null → ephemeral (no persistence)
        this._ownsHistory = false;       // true only if this provider created the manager
    }

    async initialize() {
        if (this._ownsHistory && this.history) await this.history.initialize();
    }

    async publish(msg = {}) {
        const { scope = 'global', username, text, ts = Date.now(), socketId = null, userId = null } = msg;

        // Defense in depth (S1): never broadcast the raw full socket.id to other clients — it is
        // a hijackable handle. Derive a short, non-sensitive public id for display/attribution.
        const publicId = userId != null ? String(userId) : (socketId ? String(socketId).substring(0, 6) : null);

        if (scope === 'global') {
            if (this.history) {
                // Fire-and-forget persistence, exactly as before (must not block delivery).
                this.history.saveMessage({ socketId, username, message: text, type: 'chat', userId })
                    .catch(err => console.error('Failed to save chat message:', err.message));
            }
            if (this.broadcastManager) {
                this.broadcastManager.broadcastChatMessage(username, text, ts, publicId);
            } else {
                this.io.emit('chat_broadcast', { username, message: text, timestamp: ts, publicId });
            }
            return;
        }

        // Room-scoped (e.g. tavern): delivered only to occupants of that room. The `scope`
        // field lets a room client filter these from any global broadcasts it also receives.
        this.io.to(scope).emit('chat_broadcast', { username, message: text, timestamp: ts, publicId, scope });
    }

    async getHistory({ scope = 'global', limit = 50 } = {}) {
        if (scope === 'global' && this.history) return this.history.getRecentMessages(limit);
        return [];
    }

    async shutdown() {
        if (this._ownsHistory && this.history) this.history.shutdown();
    }
}

module.exports = SocketChatProvider;
