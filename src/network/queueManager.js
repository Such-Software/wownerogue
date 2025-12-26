/**
 * Queue Manager
 * Encapsulates logic for players waiting for the next block to start a game.
 * Responsible for:
 *  - Managing queue entries (add/remove/confirm)
 *  - Starting games when a new block arrives
 *  - Preserving unconfirmed (mempool-only) entries across blocks
 */

const { normalizeError } = require('../utils/errors');

class QueueManager {
    constructor({ debugManager, broadcastManager, io, createGameForUser, getUserBySocket, activeGames, gameModeManager, consoleLogging }) {
        this.debugManager = debugManager;
        this.broadcastManager = broadcastManager;
        this.io = io;
        this.createGameForUser = createGameForUser; // (user, gameType, options) => Game
        this.getUserBySocket = getUserBySocket; // (socketId) => User
        this.activeGames = activeGames; // Map socketId -> Game
        this.gameModeManager = gameModeManager;
        this.CONSOLE_LOGGING = !!consoleLogging;
        this._waitingPlayers = []; // internal queue
    }

    addPlayer({ serverId, clientId, entryTime = Date.now(), paymentId = null, requiresConfirmation = false, confirmed = true }) {
        if (this.getPlayerIndex(serverId) !== -1) return; // already queued
        this._waitingPlayers.push({ serverId, clientId, entryTime, paymentId, requiresConfirmation, confirmed });
        if (this.CONSOLE_LOGGING) {
            console.log(`[QueueManager] Added player ${serverId} (confirmed=${confirmed}, requiresConfirmation=${requiresConfirmation}). Queue length: ${this._waitingPlayers.length}`);
        }
    }

    removePlayer(serverId) {
        const idx = this.getPlayerIndex(serverId);
        if (idx !== -1) {
            this._waitingPlayers.splice(idx, 1);
            if (this.CONSOLE_LOGGING) {
                console.log(`[QueueManager] Removed player ${serverId}. Queue length: ${this._waitingPlayers.length}`);
            }
            return true;
        }
        return false;
    }

    markConfirmed(serverId) {
        const entry = this._waitingPlayers.find(p => p.serverId === serverId);
        if (entry) {
            entry.confirmed = true;
            entry.requiresConfirmation = false;
            if (this.CONSOLE_LOGGING) console.log(`[QueueManager] Marked player ${serverId} confirmed.`);
        }
    }

    getPlayerIndex(serverId) { return this._waitingPlayers.findIndex(p => p.serverId === serverId); }
    isPlayerQueued(serverId) { return this.getPlayerIndex(serverId) !== -1; }
    getQueueLength() { return this._waitingPlayers.length; }
    getQueuePosition(serverId) { const i = this.getPlayerIndex(serverId); return i === -1 ? -1 : i + 1; }

    startGamesForWaiting(blockHeight) {
        if (this.CONSOLE_LOGGING) {
            console.log(`[QueueManager] Starting games for ${this._waitingPlayers.length} waiting players at block ${blockHeight}`);
        }
        const remainingQueue = [];
        while (this._waitingPlayers.length > 0) {
            const entry = this._waitingPlayers.shift();
            const serverId = entry.serverId;

            if (this.CONSOLE_LOGGING) console.log(`[QueueManager] Processing queued player ${serverId}`);
            const currentUser = this.getUserBySocket(serverId);
            if (!currentUser) {
                if (this.CONSOLE_LOGGING) console.warn(`[QueueManager] User not found for ${serverId}, skipping.`);
                continue;
            }

            // Keep unconfirmed paid entries in queue
            if (entry.requiresConfirmation && !entry.confirmed) {
                remainingQueue.push(entry);
                if (this.CONSOLE_LOGGING) console.log(`[QueueManager] Skipping unconfirmed paid entry ${serverId}`);
                continue;
            }

            currentUser.blockRec = blockHeight;
            if (this.CONSOLE_LOGGING) {
                console.log(`[QueueManager] Player ${serverId} enters on block ${blockHeight} (dies after ${blockHeight + 1})`);
            }
            try {
                const game = this.createGameForUser(currentUser, 'standard');
                const gameState = game.getState();
                gameState.blockHeight = blockHeight;
                // Include provably fair commitment
                if (game.getProofCommitment) {
                    gameState.proof = game.getProofCommitment();
                }
                this.io.to(serverId).emit('game_start', gameState);
                if (this.CONSOLE_LOGGING) console.log(`[QueueManager] Game started for ${serverId}`);
            } catch (error) {
                const normalized = normalizeError(error, 'Failed to start game');
                console.error('[QueueManager] Error creating game:', normalized.message);
                this.io.to(serverId).emit('message', 'Error starting game: ' + normalized.message);
            }
        }
        if (remainingQueue.length > 0) {
            this._waitingPlayers = remainingQueue.concat(this._waitingPlayers);
            if (this.CONSOLE_LOGGING) {
                console.log(`[QueueManager] Re-queued ${remainingQueue.length} unconfirmed entries.`);
                remainingQueue.forEach(e => {
                    console.log(`[QueueManager]   -> ${e.serverId} confirmed=${e.confirmed} requiresConfirmation=${e.requiresConfirmation}`);
                });
            }
        }
    }

    debugDumpQueue() {
        if (!this.CONSOLE_LOGGING) return;
        console.log('[QueueManager] Current queue dump:');
        this._waitingPlayers.forEach((e,i) => {
            console.log(`  [${i}] ${e.serverId} confirmed=${e.confirmed} requiresConfirmation=${e.requiresConfirmation}`);
        });
    }

    /**
     * Immediately start a game for a single confirmed player (e.g. payment confirmed AFTER
     * the block tick already processed). This prevents an additional full-block wait.
     * Returns true if a game was started.
     */
    startGameImmediately(serverId, blockHeight) {
        const idx = this.getPlayerIndex(serverId);
        if (idx === -1) return false; // not queued
        const entry = this._waitingPlayers[idx];
        if (entry.requiresConfirmation && !entry.confirmed) {
            // Still not confirmed; cannot start
            return false;
        }
        // Remove from queue
        this._waitingPlayers.splice(idx, 1);
        const currentUser = this.getUserBySocket(serverId);
        if (!currentUser) return false;
        currentUser.blockRec = blockHeight; // lifetime until next block
        try {
            const game = this.createGameForUser(currentUser, 'standard');
            const gameState = game.getState();
            gameState.blockHeight = blockHeight;
            // Include provably fair commitment
            if (game.getProofCommitment) {
                gameState.proof = game.getProofCommitment();
            }
            this.io.to(serverId).emit('game_start', gameState);
            if (this.CONSOLE_LOGGING) console.log(`[QueueManager] (immediate) Game started for ${serverId} at block ${blockHeight}`);
            return true;
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to start immediate game');
            console.error('[QueueManager] Error starting immediate game:', normalized.message);
            this.io.to(serverId).emit('message', 'Error starting game: ' + normalized.message);
            return false;
        }
    }

    /**
     * Start a game immediately for early entry (not from queue)
     * Used when player opts for early entry without waiting for block
     * @param {string} serverId - Socket ID
     * @param {Object} currentUser - User object
     * @param {number} blockHeight - Current block height
     * @returns {Object} { success: boolean, reason?: string }
     */
    async startEarlyGame(serverId, currentUser, blockHeight) {
        if (!currentUser) {
            return { success: false, reason: 'User not found' };
        }

        // Check if already in a game
        if (this.activeGames && this.activeGames.has(serverId)) {
            return { success: false, reason: 'Already in a game' };
        }

        // Set blockRec to current block - player dies when next block (currentBlock + 1) is found
        currentUser.blockRec = blockHeight;
        currentUser.isEarlyEntry = true; // Mark as early entry for potential special handling

        try {
            const game = this.createGameForUser(currentUser, 'standard', { earlyEntry: true });
            const gameState = game.getState();
            gameState.blockHeight = blockHeight;
            gameState.isEarlyEntry = true;
            gameState.deathBlock = blockHeight + 1; // Explicit death block for client display

            // Include provably fair commitment
            if (game.getProofCommitment) {
                gameState.proof = game.getProofCommitment();
            }

            this.io.to(serverId).emit('game_start', gameState);
            
            if (this.CONSOLE_LOGGING) {
                console.log(`[QueueManager] ⚡ Early entry game started for ${serverId} at block ${blockHeight} (dies at ${blockHeight + 1})`);
            }
            
            return { success: true };
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to start early game');
            console.error('[QueueManager] Error starting early game:', normalized.message);
            this.io.to(serverId).emit('message', 'Error starting game: ' + normalized.message);
            return { success: false, reason: normalized.message };
        }
    }

    /**
     * Get list of pending games (players waiting in queue)
     * Used by spectator system to show upcoming games
     * @returns {Array} List of pending game entries
     */
    getPendingGamesList() {
        return this._waitingPlayers.map(entry => ({
            playerId: entry.serverId.substring(0, 6), // Anonymized
            queuedAt: entry.entryTime,
            isConfirmed: entry.confirmed,
            waitingForConfirmation: entry.requiresConfirmation && !entry.confirmed
        }));
    }
}

module.exports = QueueManager;
