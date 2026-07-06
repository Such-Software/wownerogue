/**
 * ChatProvider — abstraction over chat message delivery and history.
 *
 * The seam that lets the chat backend be swapped (e.g. for a Nostr channel) without changing
 * callers. Application concerns — commands, moderation, rate limiting, XSS escaping — stay in
 * the caller (ChatHandler / TavernManager); a provider only delivers and (optionally) stores.
 *
 * Scopes:
 *   'global'       → the whole server (the main lobby chat).
 *   'tavern:<id>'  → a single Socket.IO room (tavern chat), ephemeral by default.
 */
class ChatProvider {
    // eslint-disable-next-line no-empty-function
    async initialize() {}

    /**
     * Deliver (and optionally persist) a chat message.
     * @param {object} msg
     * @param {string} msg.scope      'global' or a room channel.
     * @param {string} msg.username   Display name / short id.
     * @param {string} msg.text       Message text (caller has already sanitized/escaped it).
     * @param {number} [msg.ts]       Timestamp (ms).
     * @param {string} [msg.socketId]
     * @param {number|null} [msg.userId]
     */
    async publish(msg) { // eslint-disable-line no-unused-vars
        throw new Error('ChatProvider.publish not implemented');
    }

    /**
     * Recent messages for a scope, oldest → newest.
     * @param {object} opts
     * @param {string} [opts.scope]
     * @param {number} [opts.limit]
     * @returns {Promise<Array>}
     */
    async getHistory({ scope = 'global', limit = 50 } = {}) { // eslint-disable-line no-unused-vars
        return [];
    }

    // eslint-disable-next-line no-empty-function
    async shutdown() {}
}

module.exports = ChatProvider;
