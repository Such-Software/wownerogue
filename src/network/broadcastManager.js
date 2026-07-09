/**
 * Broadcast Manager Module
 * Handles all socket.io event broadcasting for the Wownerogue game server
 * Supports current player-specific events and future spectator broadcasting
 */

class BroadcastManager {
    constructor(io, debugManager = null) {
        this.io = io;
        this.debugManager = debugManager;
        this._lastBroadcastBlock = null;
        this._lastUserCount = -1;
    }

    setDebugManager(debugManager) {
        this.debugManager = debugManager;
    }

    // ====== GLOBAL BROADCASTS (All Clients) ======

    /**
     * Broadcast connected user count to all clients
     */
    broadcastUserCount() {
        // Try multiple ways to get the count
        let count = 0;
        if (this.io.sockets && this.io.sockets.sockets) {
            count = this.io.sockets.sockets.size || 0;
        } else if (this.io.engine) {
            count = this.io.engine.clientsCount || 0;
        }
        
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`👥 Broadcasting user count: ${count} (last was ${this._lastUserCount})`);
        }

        // Always broadcast to ensure new clients get the count
        this._lastUserCount = count;
        this.io.emit('user_count', { count });
    }

    /**
     * Broadcast block height to all connected clients
     * @param {number} blockHeight - Current block height
     */
    broadcastBlockHeight(blockHeight) {
        // Only log when the height actually changes to avoid per-client spam
        if (blockHeight !== this._lastBroadcastBlock) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`📡 Broadcasting block height ${blockHeight} to all clients`);
            }
            this._lastBroadcastBlock = blockHeight;
        }
        this.io.emit('blockheight', { blockHeight });
    }

    /**
     * Broadcast chat message to all connected clients
     * @param {string} username - Username of the sender
     * @param {string} message - Chat message content
     * @param {number} timestamp - Message timestamp
     * @param {string} publicId - Short, non-sensitive public id of the sender (NOT the raw
     *   full socket.id — S1 defense in depth; the full socket.id must never leave the server)
     */
    broadcastChatMessage(username, message, timestamp, publicId) {
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`💬 Broadcasting chat message from ${publicId}: "${message}"`);
        }

        this.io.emit('chat_broadcast', {
            username: username,
            message: message,
            timestamp: timestamp,
            publicId: publicId
        });
    }

    // ====== PLAYER-SPECIFIC BROADCASTS ======

    /**
     * Send status update to a specific player
     * @param {string} socketId - The socket ID of the player
     * @param {string} type - Type of status (info, error, warning, connection, help, etc.)
     * @param {string} message - The status message
     */
    sendStatusUpdate(socketId, type, message) {
        this.io.to(socketId).emit('status_update', {
            type: type,
            message: message,
            timestamp: Date.now()
        });
    }

    /**
     * Send welcome message to a newly connected client
     * @param {string} clientId - The client ID
     */
    sendWelcome(clientId) {
        this.io.to(clientId).emit('welcome', clientId);
    }

    /**
     * Send game state update to player and any spectators
     * @param {string} playerSocketId - The socket ID of the player
     * @param {object} gameState - The game state to broadcast
     */
    sendGameUpdate(playerSocketId, gameState) {
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`📡 sendGameUpdate to ${playerSocketId}:`);
            console.log(`  - Lighting data: ${!!gameState.lighting} (${gameState.lighting ? Object.keys(gameState.lighting).length : 0} rows)`);
            console.log(`  - Torch data: ${!!gameState.torches} (${gameState.torches ? gameState.torches.length : 0} torches)`);
        }

        // Send to the player
        this.io.to(playerSocketId).emit('game_update', gameState);
        
        // TODO: Future spectator support
        // Get list of spectators for this game and broadcast to them too
        // const spectators = getSpectatorsForPlayer(playerSocketId);
        // spectators.forEach(spectatorId => {
        //     this.io.to(spectatorId).emit('spectator_update', {
        //         playerSocketId: playerSocketId,
        //         gameState: gameState
        //     });
        // });
    }

    /**
     * Send game start event to player
     * @param {string} socketId - The socket ID of the player
     * @param {object} gameState - Initial game state
     */
    sendGameStart(socketId, gameState) {
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`🎮 SENDING GAME_START to ${socketId}`);
        }
        this.io.to(socketId).emit('game_start', gameState);
    }

    /**
     * Send game over event to player
     * @param {string} socketId - The socket ID of the player
     * @param {object} gameOverData - Game over information
     */
    sendGameOver(socketId, gameOverData) {
        this.io.to(socketId).emit('game_over', gameOverData);
    }

    /**
     * Send waiting status to player (for queue system)
     * @param {string} socketId - The socket ID of the player
     * @param {object} waitingData - Waiting status information
     */
    sendWaitingStatus(socketId, waitingData) {
        this.io.to(socketId).emit('waiting_status', waitingData);
    }

    /**
     * Send queue cancelled event to player
     * @param {string} socketId - The socket ID of the player
     */
    sendQueueCancelled(socketId) {
        this.io.to(socketId).emit('queue_cancelled');
    }

    /**
     * Send simple message to player
     * @param {string} socketId - The socket ID of the player
     * @param {string} message - The message content
     */
    sendMessage(socketId, message) {
        this.io.to(socketId).emit('message', message);
    }

    /**
     * Send socket registration confirmation
     * @param {string} socketId - The socket ID
     * @param {object} registrationData - Registration confirmation data
     */
    sendSocketRegistered(socketId, registrationData) {
        this.io.to(socketId).emit('socket_registered', registrationData);
    }

    /**
     * Send debug pong response
     * @param {string} socketId - The socket ID
     * @param {object} pongData - Debug pong data
     */
    sendDebugPong(socketId, pongData) {
        this.io.to(socketId).emit('debug_pong', pongData);
    }

    // ====== FUTURE SPECTATOR SUPPORT ======

    /**
     * Get spectators for a specific player's game
     * @param {string} playerSocketId - The player's socket ID
     * @returns {string[]} Array of spectator socket IDs
     * TODO: Implement spectator tracking system
     */
    getSpectatorsForPlayer(playerSocketId) {
        // Future implementation: return array of spectator socket IDs
        return [];
    }

    /**
     * Add spectator to a player's game
     * @param {string} playerSocketId - The player's socket ID
     * @param {string} spectatorSocketId - The spectator's socket ID
     * TODO: Implement spectator tracking system
     */
    addSpectator(playerSocketId, spectatorSocketId) {
        // Future implementation: track spectators per game
        console.log(`TODO: Add spectator ${spectatorSocketId} to watch player ${playerSocketId}`);
    }

    /**
     * Remove spectator from a player's game
     * @param {string} playerSocketId - The player's socket ID
     * @param {string} spectatorSocketId - The spectator's socket ID
     * TODO: Implement spectator tracking system
     */
    removeSpectator(playerSocketId, spectatorSocketId) {
        // Future implementation: remove spectator tracking
        console.log(`TODO: Remove spectator ${spectatorSocketId} from watching player ${playerSocketId}`);
    }
}

module.exports = BroadcastManager;
