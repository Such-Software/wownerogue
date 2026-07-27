/**
 * Connection Handler Module
 * Handles socket connection, registration, and session management
 */

const user = require('../db/user');
const { clientIp } = require('./rateLimitContext');
const { gameNameFor } = require('../game/helpers/gameModeUtils');

class ConnectionHandler {
    constructor({ io, broadcastManager, debugManager, sessionManager, rateLimiter }) {
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.sessionManager = sessionManager;
        this.rateLimiter = rateLimiter;
        
        this.clientSocketMap = new Map();

        // Per-IP concurrent-socket cap. The rate limiter caps the RATE of new connections and
        // game starts, but not how many sockets one IP HOLDS OPEN; a client can trickle in
        // under the rate limit and keep hundreds alive to hoard resources and spectator slots.
        // The default of 10 is generous for shared NATs and multi-tab use.
        this.maxSocketsPerIp = parseInt(process.env.MAX_SOCKETS_PER_IP, 10) || 10;
        this.socketsByIp = new Map();   // ip -> Set<socketId>
        this.socketIpMap = new Map();   // socketId -> ip, for O(1) disconnect cleanup

        this.mapCleanupInterval = setInterval(() => this.cleanupMappings(), 300000); // 5 minutes
    }

    /** Register a live socket for its IP. @returns {boolean} false if the IP is at the cap. */
    _trackIpSocket(ip, socketId) {
        if (!ip) return true; // unattributable connections are not blocked
        let set = this.socketsByIp.get(ip);
        if (set && set.size >= this.maxSocketsPerIp && !set.has(socketId)) {
            return false;
        }
        if (!set) { set = new Set(); this.socketsByIp.set(ip, set); }
        set.add(socketId);
        this.socketIpMap.set(socketId, ip);
        return true;
    }

    /** Drop a socket from its IP's live set. */
    _untrackIpSocket(socketId) {
        const ip = this.socketIpMap.get(socketId);
        if (!ip) return;
        const set = this.socketsByIp.get(ip);
        if (set) {
            set.delete(socketId);
            if (set.size === 0) this.socketsByIp.delete(ip);
        }
        this.socketIpMap.delete(socketId);
    }

    /**
     * Handle new socket connection with rate limiting and session management
     */
    async handleConnection(socket) {
        try {
            // The real client IP (honouring a trusted reverse proxy via TRUST_PROXY) so per-IP
            // connection limits stay correct behind a proxy.
            const ip = clientIp(socket) || socket.handshake.address;
            const rateLimitResult = await this.rateLimiter.checkLimit(ip, 'connection:new', ip);
            
            if (!rateLimitResult.allowed) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`🚫 Connection rate limited for IP ${ip}. Retry after: ${rateLimitResult.retryAfter}ms`);
                }
                socket.emit('rate_limited', {
                    action: 'connection',
                    retryAfter: rateLimitResult.retryAfter,
                    message: 'Too many connection attempts. Please wait before trying again.'
                });
                socket.disconnect(true);
                return;
            }

            await this.rateLimiter.recordAttempt(ip, 'connection:new', ip);

            if (!this._trackIpSocket(ip, socket.id)) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`🚫 Concurrent socket cap (${this.maxSocketsPerIp}) reached for IP ${ip}`);
                }
                socket.emit('rate_limited', {
                    action: 'connection',
                    message: 'Too many simultaneous connections from your network.'
                });
                socket.disconnect(true);
                return;
            }

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log('A user connected');
                console.log(socket.client.id);
                console.log(socket.handshake.address);
            }

            // The DB is authoritative for the session; the in-memory user is ephemeral state
            // for game logic that keys off socket.id.
            const resumeToken = this._getResumeToken(socket);
            const sessionInfo = await this._initializeSession(socket, resumeToken);

            new user.User(socket.id, socket.handshake.address);
            const memUser = this._setupMemoryUser(socket);

            this._emitSessionEvents(socket, sessionInfo);

            this._sendConnectionStatus(socket);

            // Delayed so the socket is registered with the IO server before it is counted.
            setTimeout(() => this.broadcastManager.broadcastUserCount(), 100);

            return { sessionInfo, memUser };

        } catch (error) {
            console.error('Connection handler error:', error);
            socket.emit('connection_error', { message: 'Failed to establish connection' });
            socket.disconnect(true);
        }
    }

    /**
     * Handle client registration with cleanup
     */
    handleRegisterClient(socket, data) {
        // The client-supplied id becomes both a key and a value in clientSocketMap, and
        // getUserBySocket follows that mapping, so an oversized or colliding id would poison
        // the map. Validate before storing.
        const clientId = data && data.clientId;
        if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(clientId)) {
            socket.emit('socket_registered', { serverId: socket.id, success: false, error: 'Invalid clientId' });
            return;
        }

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Client registered: ${socket.id} (server) <-> ${clientId} (client)`);
        }

        this._cleanupExistingMappings(socket.id, clientId);

        this.clientSocketMap.set(clientId, socket.id);
        this.clientSocketMap.set(socket.id, clientId);

        socket.emit('socket_registered', {
            clientId: clientId,
            serverId: socket.id,
            success: true
        });
    }

    /**
     * Handle disconnection with proper cleanup
     */
    handleDisconnect(socket, additionalCleanup = null) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log('User disconnected', socket.client.id);
        }
        
        this._untrackIpSocket(socket.id);

        const clientId = this.clientSocketMap.get(socket.id);
        if (clientId) {
            this.clientSocketMap.delete(clientId);
        }
        this.clientSocketMap.delete(socket.id);
        
        // The user registry is keyed by socket.id (see `new user.User(socket.id, ...)` in
        // handleConnection). socket.client.id is a DIFFERENT value under the Engine.IO 4
        // protocol, so deleting by it alone removes nothing and leaks one User per connection,
        // each able to pin a whole Game instance through `currentGame`. Remove both keys:
        // socket.id is the real one, client.id covers any entry stored under the older key.
        user.removeUser(socket.id);
        if (socket.client?.id && socket.client.id !== socket.id) user.removeUser(socket.client.id);
        
        this.broadcastManager.broadcastUserCount();

        if (additionalCleanup && typeof additionalCleanup === 'function') {
            additionalCleanup(socket);
        }
    }

    /**
     * Get user by socket ID with fallback mapping
     */
    getUserBySocket(socketId) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Looking up user with socketId: ${socketId}`);
        }
        
        let foundUser = user.getUserBySocketId(socketId);
        
        if (!foundUser && this.clientSocketMap.has(socketId)) {
            const mappedId = this.clientSocketMap.get(socketId);
            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`Socket ID ${socketId} not found directly, trying mapped ID: ${mappedId}`);
            }
            foundUser = user.getUserBySocketId(mappedId);
        }
        
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`User lookup result for ${socketId}: ${foundUser ? "FOUND" : "NOT FOUND"}`);
        }
        return foundUser;
    }

    /**
     * Get connection statistics
     */
    getStats() {
        return {
            clientSocketMappings: this.clientSocketMap.size / 2, // Halved: mappings are stored in both directions
            rateLimiterStats: this.rateLimiter.getStats()
        };
    }

    /**
     * Release resources held by this handler.
     */
    shutdown() {
        if (this.mapCleanupInterval) {
            clearInterval(this.mapCleanupInterval);
            this.mapCleanupInterval = null;
        }
    }

    // Private helper methods

    _getResumeToken(socket) {
        try {
            // Session credentials belong only in Socket.IO's handshake auth payload. Query
            // strings are routinely retained by reverse-proxy/access logs and must never resume
            // an account, even when an older client still sends one there.
            return socket.handshake.auth?.resumeToken || null;
        } catch (_) {
            return null;
        }
    }

    async _initializeSession(socket, resumeToken) {
        if (!this.sessionManager) {
            return null;
        }

        try {
            return await this.sessionManager.resumeOrCreate({
                socketId: socket.id,
                ipAddress: socket.handshake.address,
                resumeToken
            });
        } catch (e) {
            console.error('Session initialization failed:', e.message);
            // A compare-and-swap loser presented a credential another concurrent connection
            // already consumed. Do not downgrade it into an anonymous live socket: the outer
            // connection handler will emit a generic error and disconnect it.
            if (e.code === 'SESSION_TOKEN_REPLAY') throw e;
            // A database outage still permits a connection, just without session features.
            if (e.message.includes('Database not connected')) {
                console.log('⚠️ Database not ready, allowing connection without session features');
                return null;
            }
            return null;
        }
    }

    _setupMemoryUser(socket) {
        const memUser = user.getUserBySocketId(socket.id);
        if (memUser) {
            memUser.clientId = socket.client.id;
        }
        return memUser;
    }

    _emitSessionEvents(socket, sessionInfo) {
        if (sessionInfo) {
            if (sessionInfo.resumed) {
                this.io.to(socket.id).emit('session_resumed', {
                    token: sessionInfo.token,
                    payoutAddress: sessionInfo.user.payout_address || null,
                    credits: sessionInfo.user.credits || 0,
                    totalCreditsPurchased: sessionInfo.user.total_credits_purchased || 0
                });
            } else {
                this.io.to(socket.id).emit('session_token', { token: sessionInfo.token });
                
                // Only new sessions need address_confirmed; resumed ones carry payoutAddress
                // in session_resumed.
                if (sessionInfo.user.payout_address) {
                    this.io.to(socket.id).emit('address_confirmed', {
                        address: sessionInfo.user.payout_address,
                        message: 'Payout address restored.'
                    });
                }
            }

            // creditsPerGame lets the client compute games remaining without a round trip.
            this.io.to(socket.id).emit('credits_update', {
                balance: sessionInfo.user.credits || 0,
                totalCreditsPurchased: sessionInfo.user.total_credits_purchased || 0,
                creditsPerGame: this.gameModeManager?.creditsPerGameCost || 1
            });

            if (sessionInfo.recovered && sessionInfo.recovered.creditsRecovered > 0) {
                this.broadcastManager.sendStatusUpdate(socket.id, 'success',
                    `💰 Payment recovered! ${sessionInfo.recovered.creditsRecovered} credits have been added to your balance.`);
                this.io.to(socket.id).emit('credits_recovered', {
                    creditsRecovered: sessionInfo.recovered.creditsRecovered,
                    paymentsProcessed: sessionInfo.recovered.paymentsProcessed,
                    newBalance: sessionInfo.user.credits || 0
                });
            }
        } else {
            // Without a session, clients still expect a welcome keyed by client.id.
            this.io.to(socket.client.id).emit('welcome', socket.client.id);
        }
    }

    _sendConnectionStatus(socket) {
        const currentBlock = this.debugManager.getCurrentBlockHeight();
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`📈 Sending current block height ${currentBlock} to new connection ${socket.id}`);
        }
        // Include the cosmetic chain tip so a client that connects mid-block still gets the ambient
        // chain readout instead of waiting up to a full block interval for the next broadcast.
        const tip = this.debugManager.getChainTip ? this.debugManager.getChainTip() : null;
        this.io.to(socket.id).emit(
            'blockheight',
            this.broadcastManager.blockHeightPayload
                ? this.broadcastManager.blockHeightPayload(currentBlock, tip)
                : { blockHeight: currentBlock }
        );

        this.broadcastManager.sendStatusUpdate(socket.id, 'connection', `Connected to ${gameNameFor(process.env.CRYPTO_TYPE)} server`);
    }

    _cleanupExistingMappings(socketId, clientId) {
        const existingSocketForClient = this.clientSocketMap.get(clientId);
        const existingClientForSocket = this.clientSocketMap.get(socketId);
        
        if (existingSocketForClient && existingSocketForClient !== socketId) {
            this.clientSocketMap.delete(existingSocketForClient);
        }
        if (existingClientForSocket && existingClientForSocket !== clientId) {
            this.clientSocketMap.delete(existingClientForSocket);
        }
    }

    /**
     * Periodic cleanup of stale mappings to prevent memory leaks
     */
    cleanupMappings() {
        const activeSocketIds = new Set();

        if (this.io && this.io.sockets && this.io.sockets.sockets) {
            for (const socketId of this.io.sockets.sockets.keys()) {
                activeSocketIds.add(socketId);
            }
        }

        let cleanedCount = 0;
        const toDelete = [];

        // Length distinguishes a socket ID from a client-supplied id closely enough to pick
        // the socket-keyed direction; the paired reverse mapping goes with it.
        for (const [key, value] of this.clientSocketMap.entries()) {
            if (key.length > 10 && !activeSocketIds.has(key)) {
                toDelete.push(key);
                toDelete.push(value);
            }
        }

        for (const key of toDelete) {
            if (this.clientSocketMap.delete(key)) {
                cleanedCount++;
            }
        }

        // Reconcile per-IP tracking against live sockets: a missed disconnect would leave a
        // leaked entry that wrongly counts toward the cap for that IP.
        for (const [socketId, ip] of this.socketIpMap.entries()) {
            if (!activeSocketIds.has(socketId)) {
                const set = this.socketsByIp.get(ip);
                if (set) { set.delete(socketId); if (set.size === 0) this.socketsByIp.delete(ip); }
                this.socketIpMap.delete(socketId);
                cleanedCount++;
            }
        }

        if (this.debugManager.CONSOLE_LOGGING && cleanedCount > 0) {
            console.log(`🧹 ConnectionHandler cleanup: removed ${cleanedCount} stale mappings`);
        }
    }
}

module.exports = ConnectionHandler;
