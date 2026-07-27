const Room = require('../multiplayer/Room');
const Appearance = require('../multiplayer/appearance');
const Entitlements = require('../multiplayer/entitlements');
const SocketChatProvider = require('./chat/SocketChatProvider');
const { stableId, clientIp } = require('./rateLimitContext');

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * TavernManager: transport and lifecycle for the Tavern mode.
 *
 * Owns a shared Room, a server-tick timer, and Socket.IO room broadcasts. Structured like
 * SpectatorManager. Disabled unless TAVERN_ENABLED=true: when disabled, no timer runs and
 * join requests are refused, so this is inert on instances that don't opt in.
 *
 * Movement is server-authoritative. Clients send a direction; the Room validates it. State
 * is broadcast to occupants once per server tick (clients render from these snapshots).
 */
class TavernManager {
    constructor({ io, debugManager, roomId = 'main', tickMs = null, roomData = null, roomUrl = null, entitlementProvider = null, globalChatProvider = null, chatModeration = null } = {}) {
        this.io = io;
        this.debugManager = debugManager;
        this.enabled = process.env.TAVERN_ENABLED === 'true';
        this.roomId = roomId;

        // Snapshot broadcast cadence. Default 100ms (10 Hz); override with TAVERN_TICK_MS.
        const envTick = parseInt(process.env.TAVERN_TICK_MS, 10);
        this.tickMs = tickMs || (Number.isFinite(envTick) && envTick > 0 ? envTick : 100);

        this.moveCooldownMs = 60;        // per-occupant flood guard
        this._lastMoveAt = new Map();    // socketId -> timestamp
        this.chatCooldownMs = 900;       // per-occupant chat flood guard
        this._lastChatAt = new Map();    // socketId -> timestamp
        this._tickInterval = null;
        this.entitlementProvider = entitlementProvider;

        this.room = new Room({ id: this.roomId, type: 'tavern', roomData: roomData, roomUrl: roomUrl });

        // Chat prefers the shared global provider (persistent history plus cross-page/relay
        // fan-out) so the tavern participates in one global chat with backlog. Without one
        // injected, the ephemeral tavern-scoped provider is used instead.
        this.globalChatProvider = globalChatProvider;
        this.chatProvider = new SocketChatProvider({ io: this.io, debugManager: this.debugManager });
        // Guards applied before anything reaches global chat (ban list, shared rate limiter,
        // user_id attribution). Optional so a tavern-only/ephemeral instance still works.
        this.chatModeration = chatModeration;
    }

    get channel() {
        return `tavern:${this.roomId}`;
    }

    /** Start the server tick. No-op (and no timer) unless enabled. */
    initialize() {
        if (!this.enabled) return;
        this._tickInterval = setInterval(() => this._tick(), this.tickMs);
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`Tavern enabled (room '${this.roomId}', tick ${this.tickMs}ms)`);
        }
    }

    _tick() {
        this.room.tick();
        if (this.room.size > 0) {
            this.io.to(this.channel).emit('tavern_update', this.room.snapshot());
        }
    }

    _sanitizeName(name) {
        if (typeof name !== 'string') return null;
        // Keep letters/numbers/space and a few separators; cap length.
        const cleaned = name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
        return cleaned.length ? cleaned : null;
    }

    _validateAvatar(avatar) {
        return Appearance.isValidAvatar(avatar) ? avatar : 'default';
    }

    async _entitlementsFor(socket) {
        if (typeof this.entitlementProvider !== 'function') return { premium: false, totalCreditsPurchased: 0 };
        try {
            return await this.entitlementProvider(socket);
        } catch (_) {
            return { premium: false, totalCreditsPurchased: 0 };
        }
    }

    _normalizeAppearance(data = {}, entitlements = {}) {
        const raw = data.appearance || { avatar: data.avatar };
        return Entitlements.normalizeAppearance(raw, entitlements);
    }

    _normalizeDir(data) {
        if (data && typeof data.dir === 'string') {
            switch (data.dir) {
                case 'up': return { dx: 0, dy: -1 };
                case 'down': return { dx: 0, dy: 1 };
                case 'left': return { dx: -1, dy: 0 };
                case 'right': return { dx: 1, dy: 0 };
                default: return { dx: 0, dy: 0 };
            }
        }
        return {
            dx: Math.sign(Number(data && data.dx) || 0),
            dy: Math.sign(Number(data && data.dy) || 0)
        };
    }

    async join(socket, data = {}) {
        if (!this.enabled) {
            socket.emit('tavern_error', { message: 'Tavern is not enabled on this server.' });
            return { success: false };
        }
        const name = this._sanitizeName(data.name);
        const entitlements = await this._entitlementsFor(socket);
        const appearance = this._normalizeAppearance(data, entitlements);
        const avatar = appearance.avatar;
        const occ = this.room.addOccupant(socket.id, { name, avatar, appearance });
        if (!occ) {
            socket.emit('tavern_error', { message: 'The tavern is full.' });
            return { success: false };
        }
        socket.join(this.channel);
        // Full state (map + occupants) to the joiner; the next tick shows the arrival to others.
        socket.emit('tavern_joined', { you: socket.id, state: this.room.fullState() });

        // Recent global chat backlog so the tavern shows history on arrival.
        if (this.globalChatProvider && typeof this.globalChatProvider.getHistory === 'function') {
            this.globalChatProvider.getHistory({ scope: 'global', limit: 50 })
                .then(messages => { if (messages && messages.length) socket.emit('chat_history', { messages }); })
                .catch(err => { if (this.debugManager?.CONSOLE_LOGGING) console.error('[Tavern] history load failed:', err.message); });
        }
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`[Tavern] +${String(socket.id).slice(0, 6)} (${this.room.size} present)`);
        }
        return { success: true };
    }

    move(socket, data = {}) {
        if (!this.enabled) return;
        if (!this.room.getOccupant(socket.id)) return;

        const now = Date.now();
        if (now - (this._lastMoveAt.get(socket.id) || 0) < this.moveCooldownMs) return;
        this._lastMoveAt.set(socket.id, now);

        const { dx, dy } = this._normalizeDir(data);
        if (dx === 0 && dy === 0) return;
        this.room.moveOccupant(socket.id, dx, dy); // the next tick broadcasts the result
    }

    /**
     * Publish a tavern message.
     *
     * When a global chat provider is injected this reaches every connected client and the persisted
     * history, so it must clear the same bar as the lobby path: chat ban, the reconnect-proof rate
     * limiter, and user_id attribution. Async: callers are wrapped by the socket safe-dispatch, and
     * a moderation lookup failure must never publish.
     */
    async chat(socket, data = {}) {
        if (!this.enabled) return;
        const occ = this.room.getOccupant(socket.id);
        if (!occ) return; // must be in the tavern to talk

        let text = (data && typeof data.text === 'string') ? data.text.trim() : '';
        if (!text) return;
        if (text.length > TavernManager.MAX_CHAT_LENGTH) text = text.slice(0, TavernManager.MAX_CHAT_LENGTH);

        const now = Date.now();
        if (now - (this._lastChatAt.get(socket.id) || 0) < this.chatCooldownMs) {
            // Tell the sender instead of silently dropping: a silent drop with a cleared
            // input reads as "my message disappeared".
            this._notice(socket, 'Easy, wait a moment before your next message.');
            return;
        }

        const moderation = await this._moderateChat(socket);
        if (!moderation.allowed) {
            this._notice(socket, moderation.message);
            return;
        }

        this._lastChatAt.set(socket.id, now);

        const username = occ.name || String(socket.id).slice(0, 6);
        // Escape here: delivery is trusted-escaped and rendered as HTML on the client. Routing to
        // global chat (persisted, broadcast to everyone, relayed over nostr when enabled) keeps the
        // tavern in one global conversation; tavern-scoped is used when no global provider exists.
        const provider = this.globalChatProvider || this.chatProvider;
        const scope = this.globalChatProvider ? 'global' : this.channel;
        provider.publish({
            scope,
            username,
            text: escapeHtml(text),
            ts: now,
            socketId: socket.id,
            userId: moderation.userId
        });
    }

    _notice(socket, message) {
        if (socket && typeof socket.emit === 'function') {
            socket.emit('tavern_notice', { message });
        }
    }

    /**
     * Shared-chat guards. Returns { allowed, message, userId }.
     *
     * Only enforced for messages that actually enter global chat; a tavern-scoped fallback room is
     * ephemeral and stays governed by the per-occupant cooldown alone.
     */
    async _moderateChat(socket) {
        const mod = this.chatModeration;
        if (!mod || !this.globalChatProvider) return { allowed: true, userId: null };

        if (mod.rateLimiter) {
            const rlId = stableId(socket, mod.sessionManager);
            const rlIp = clientIp(socket);
            const verdict = await mod.rateLimiter.checkLimit(rlId, 'chat:message', rlIp);
            if (!verdict.allowed) {
                return { allowed: false, message: 'Please slow down before your next message.', userId: null };
            }
            await mod.rateLimiter.recordAttempt(rlId, 'chat:message', rlIp);
        }

        let userId = null;
        try {
            const row = mod.getOrCreateUser ? await mod.getOrCreateUser(socket.id) : null;
            userId = row?.id || null;
        } catch (e) {
            if (this.debugManager?.CONSOLE_LOGGING) console.warn('[Tavern] chat user lookup failed:', e.message);
        }

        if (userId && mod.chatHistory?.isUserChatBanned) {
            let banned = false;
            try {
                banned = await mod.chatHistory.isUserChatBanned(userId);
            } catch (e) {
                if (this.debugManager?.CONSOLE_LOGGING) console.warn('[Tavern] ban lookup failed:', e.message);
            }
            if (banned) return { allowed: false, message: 'You have been banned from chat.', userId };
        }

        return { allowed: true, userId };
    }

    leave(socket) {
        this.handleDisconnect(socket.id, socket);
    }

    handleDisconnect(socketId, socket = null) {
        const existed = this.room.removeOccupant(socketId);
        this._lastMoveAt.delete(socketId);
        this._lastChatAt.delete(socketId);
        if (existed) {
            const sock = socket || (this.io.sockets?.sockets?.get?.(socketId));
            if (sock) sock.leave(this.channel);
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`[Tavern] -${String(socketId).slice(0, 6)} (${this.room.size} present)`);
            }
        }
    }

    getStats() {
        return { enabled: this.enabled, roomId: this.roomId, occupants: this.room.size };
    }

    shutdown() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
        this._lastMoveAt.clear();
        this._lastChatAt.clear();
    }
}

// Cosmetic avatar ids the server accepts. Availability and unlocks are enforced by
// the Entitlements policy during join.
TavernManager.AVATARS = Appearance.avatarIds();
TavernManager.PREMIUM_AVATARS = Appearance.premiumAvatarIds();
TavernManager.MAX_CHAT_LENGTH = 200;

module.exports = TavernManager;
