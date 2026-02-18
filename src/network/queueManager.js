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

    addPlayer({ serverId, clientId, userId = null, entryTime = Date.now(), paymentId = null, requiresConfirmation = false, confirmed = true }) {
        if (this.getPlayerIndex(serverId) !== -1) return; // already queued
        this._waitingPlayers.push({ serverId, clientId, userId, entryTime, paymentId, requiresConfirmation, confirmed });
        if (this.CONSOLE_LOGGING) {
            console.log(`[QueueManager] Added player ${serverId} (userId=${userId}, confirmed=${confirmed}, requiresConfirmation=${requiresConfirmation}). Queue length: ${this._waitingPlayers.length}`);
        }
    }

    /**
     * Update the serverId (socket.id) for a queued player when their session resumes
     */
    updateSocketId(userId, newSocketId) {
        const entry = this._waitingPlayers.find(p => p.userId === userId);
        if (entry) {
            if (this.CONSOLE_LOGGING) {
                console.log(`[QueueManager] Updating socket ID for user ${userId}: ${entry.serverId} -> ${newSocketId}`);
            }
            entry.serverId = newSocketId;
            return true;
        }
        return false;
    }

    /**
     * Check if a player entry has persistent data that should be preserved on disconnect
     */
    isValuableEntry(serverId) {
        const idx = this.getPlayerIndex(serverId);
        if (idx === -1) return false;
        const entry = this._waitingPlayers[idx];
        return !!(entry.paymentId || entry.userId);
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

    async startGamesForWaiting(blockHeight) {
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
                const game = await this.createGameForUser(currentUser, 'standard');
                const gameState = game.getState();
                gameState.blockHeight = blockHeight;
                // Include provably fair commitment
                if (game.getProofCommitment) {
                    gameState.proof = game.getProofCommitment();
                }

                // Process game start (credits deduction / payment link)
                if (this.gameModeManager) {
                    const startRes = await this.gameModeManager.processGameStart(serverId, game.id);
                    if (!startRes.success) {
                        // Abort game + clean up orphaned DB record
                        if (this.activeGames) this.activeGames.delete(serverId);
                        this._cleanupOrphanedGame(game);
                        this.io.to(serverId).emit('message', 'Error starting game: ' + (startRes.reason || 'Payment processing failed'));
                        continue;
                    }
                    // Emit credits_update if credits were spent
                    if (startRes.creditsRemaining !== undefined) {
                        this.io.to(serverId).emit('credits_update', { balance: startRes.creditsRemaining });
                    }
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
    async startGameImmediately(serverId, blockHeight) {
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
            const game = await this.createGameForUser(currentUser, 'standard');
            const gameState = game.getState();
            gameState.blockHeight = blockHeight;
            // Include provably fair commitment
            if (game.getProofCommitment) {
                gameState.proof = game.getProofCommitment();
            }

            // Process game start (credits deduction / payment link)
            if (this.gameModeManager) {
                const startRes = await this.gameModeManager.processGameStart(serverId, game.id);
                if (!startRes.success) {
                    // Abort game + clean up orphaned DB record
                    if (this.activeGames) this.activeGames.delete(serverId);
                    this._cleanupOrphanedGame(game);
                    this.io.to(serverId).emit('message', 'Error starting game: ' + (startRes.reason || 'Payment processing failed'));
                    return false;
                }
                // Emit credits_update if credits were spent
                if (startRes.creditsRemaining !== undefined) {
                    this.io.to(serverId).emit('credits_update', { balance: startRes.creditsRemaining });
                }
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
            const game = await this.createGameForUser(currentUser, 'standard', { earlyEntry: true });
            const gameState = game.getState();
            gameState.blockHeight = blockHeight;
            gameState.isEarlyEntry = true;
            gameState.deathBlock = blockHeight + 1; // Explicit death block for client display

            // Include provably fair commitment
            if (game.getProofCommitment) {
                gameState.proof = game.getProofCommitment();
            }

            // Process game start (credits deduction / payment link)
            if (this.gameModeManager) {
                const startRes = await this.gameModeManager.processGameStart(serverId, game.id);
                if (!startRes.success) {
                    // Abort game + clean up orphaned DB record
                    if (this.activeGames) this.activeGames.delete(serverId);
                    this._cleanupOrphanedGame(game);
                    return { success: false, reason: startRes.reason || 'Payment processing failed' };
                }
                // Emit credits_update if credits were spent
                if (startRes.creditsRemaining !== undefined) {
                    this.io.to(serverId).emit('credits_update', { balance: startRes.creditsRemaining });
                }
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
     * Clean up a game record from the DB when processGameStart fails.
     * Prevents orphaned "active" records that never complete.
     */
    _cleanupOrphanedGame(game) {
        if (game && game.dbId && this.gameModeManager && this.gameModeManager.db) {
            this.gameModeManager.db.query(
                `UPDATE games SET status = 'expired', outcome = 'aborted', completed_at = NOW() WHERE id = $1`,
                [game.dbId]
            ).catch(err => console.error('[QueueManager] Failed to clean up orphaned game:', err.message));
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

    /**
     * Get full queue details for admin dashboard (not anonymized)
     * @returns {Array} Full queue entries with all details
     */
    getQueueDetailsForAdmin() {
        const now = Date.now();
        return this._waitingPlayers.map((entry, index) => ({
            position: index + 1,
            serverId: entry.serverId,
            playerId: entry.serverId.substring(0, 6), // For display
            entryTime: entry.entryTime ? new Date(entry.entryTime).toISOString() : null,
            waitingSeconds: entry.entryTime ? Math.floor((now - entry.entryTime) / 1000) : 0,
            paymentId: entry.paymentId || null,
            userId: entry.userId || null,
            requiresConfirmation: !!entry.requiresConfirmation,
            confirmed: !!entry.confirmed,
            isValuable: this._isValuableEntry(entry)
        }));
    }
}

module.exports = QueueManager;
