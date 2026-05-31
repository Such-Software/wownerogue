/**
 * Connection Handler Module
 * Handles socket connection, registration, and session management
 */

const user = require('../db/user');

class ConnectionHandler {
    constructor({ io, broadcastManager, debugManager, sessionManager, rateLimiter }) {
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.sessionManager = sessionManager;
        this.rateLimiter = rateLimiter;
        
        this.clientSocketMap = new Map();
        
        // Memory leak prevention - cleanup old mappings
        this.mapCleanupInterval = setInterval(() => this.cleanupMappings(), 300000); // 5 minutes
    }

    /**
     * Handle new socket connection with rate limiting and session management
     */
    async handleConnection(socket) {
        try {
            // Rate limiting for connections
            const ip = socket.handshake.address;
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

            // Record the connection attempt
            await this.rateLimiter.recordAttempt(ip, 'connection:new', ip);

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log('A user connected');
                console.log(socket.client.id);
                console.log(socket.handshake.address);
            }

            // Session resume/create (DB authoritative) + ephemeral in-memory user object for legacy game logic
            const resumeToken = this._getResumeToken(socket);
            const sessionInfo = await this._initializeSession(socket, resumeToken);

            // Always create an in-memory user (legacy systems rely on it) but map to socket.id
            new user.User(socket.id, socket.handshake.address);
            const memUser = this._setupMemoryUser(socket);

            // Emit session/welcome events
            this._emitSessionEvents(socket, sessionInfo);

            // Send current state
            this._sendConnectionStatus(socket);

            // Broadcast updated user count to all clients (small delay to ensure socket is registered)
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
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`Client registered: ${socket.id} (server) <-> ${data.clientId} (client)`);
        }
        
        // Clean up any existing mappings for these IDs to prevent memory leaks
        this._cleanupExistingMappings(socket.id, data.clientId);
        
        this.clientSocketMap.set(data.clientId, socket.id);
        this.clientSocketMap.set(socket.id, data.clientId);
        
        socket.emit('socket_registered', {
            clientId: data.clientId,
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
        
        // Clean up client socket mappings
        const clientId = this.clientSocketMap.get(socket.id);
        if (clientId) {
            this.clientSocketMap.delete(clientId);
        }
        this.clientSocketMap.delete(socket.id);
        
        // Clean up user records
        user.removeUser(socket.client.id);
        
        // Broadcast updated user count to all clients
        this.broadcastManager.broadcastUserCount();
        
        // Call additional cleanup if provided
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
            clientSocketMappings: this.clientSocketMap.size / 2, // Divided by 2 since we store bidirectional mappings
            rateLimiterStats: this.rateLimiter.getStats()
        };
    }

    /**
     * Shutdown handler - cleanup resources
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
            // Prefer the handshake `auth` payload (not logged by proxies); fall back to the
            // query string for backward compatibility with older clients during rollout.
            return socket.handshake.auth?.resumeToken
                || socket.handshake.query?.resumeToken
                || null;
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
            // For database connection issues, allow connection but without session features
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
                    credits: sessionInfo.user.credits || 0
                });
            } else {
                this.io.to(socket.id).emit('session_token', { token: sessionInfo.token });
                
                // Only emit address_confirmed for NEW sessions (not resumed ones)
                // Resumed sessions already get payoutAddress in session_resumed
                if (sessionInfo.user.payout_address) {
                    this.io.to(socket.id).emit('address_confirmed', {
                        address: sessionInfo.user.payout_address,
                        message: 'Payout address restored.'
                    });
                }
            }

            // Credits convenience push (include creditsPerGame for games remaining calculation)
            this.io.to(socket.id).emit('credits_update', {
                balance: sessionInfo.user.credits || 0,
                creditsPerGame: this.gameModeManager?.creditsPerGameCost || 1
            });

            // Notify user if credits were recovered from unprocessed payments
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
            // fallback legacy welcome
            this.io.to(socket.client.id).emit('welcome', socket.client.id);
        }
    }

    _sendConnectionStatus(socket) {
        // Send current block height
        const currentBlock = this.debugManager.getCurrentBlockHeight();
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`📈 Sending current block height ${currentBlock} to new connection ${socket.id}`);
        }
        this.io.to(socket.id).emit('blockheight', { blockHeight: currentBlock });
        
        // Send connection status
        this.broadcastManager.sendStatusUpdate(socket.id, 'connection', 'Connected to Wownerogue server');
    }

    _cleanupExistingMappings(socketId, clientId) {
        // Remove any existing mappings to prevent duplicates and memory leaks
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
        
        // Get all active socket IDs from the IO server
        if (this.io && this.io.sockets && this.io.sockets.sockets) {
            for (const socketId of this.io.sockets.sockets.keys()) {
                activeSocketIds.add(socketId);
            }
        }

        let cleanedCount = 0;
        const toDelete = [];

        // Find mappings that reference non-existent sockets
        for (const [key, value] of this.clientSocketMap.entries()) {
            // If key looks like a socket ID and it's not active
            if (key.length > 10 && !activeSocketIds.has(key)) {
                toDelete.push(key);
                toDelete.push(value); // Also remove the reverse mapping
            }
        }

        // Remove stale mappings
        for (const key of toDelete) {
            if (this.clientSocketMap.delete(key)) {
                cleanedCount++;
            }
        }

        if (this.debugManager.CONSOLE_LOGGING && cleanedCount > 0) {
            console.log(`🧹 ConnectionHandler cleanup: removed ${cleanedCount} stale mappings`);
        }
    }
}

module.exports = ConnectionHandler;