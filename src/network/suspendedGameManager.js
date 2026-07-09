/**
 * Suspended Game Manager
 * Handles preservation and restoration of game states when users disconnect and reconnect.
 * 
 * This allows users who disconnect during:
 * - Active gameplay in the dungeon
 * - Waiting in queue for next block
 * - Awaiting payment confirmation
 * 
 * to seamlessly resume their session when they reconnect.
 */

const { normalizeError } = require('../utils/errors');

class SuspendedGameManager {
    constructor({ debugManager, activeGames, cleanupTimeoutMs = 300000 }) {
        this.debugManager = debugManager;
        this.activeGames = activeGames;
        
        // Map of DB userId -> suspended game state
        this.suspendedGames = new Map();
        
        // Map of DB userId -> cleanup timeout handle
        this.cleanupTimers = new Map();
        
        // How long to keep suspended games before cleanup (default 5 minutes)
        this.cleanupTimeoutMs = cleanupTimeoutMs;
        
        // Statistics
        this.stats = {
            gamesSuspended: 0,
            gamesRestored: 0,
            gamesExpired: 0
        };
    }

    /**
     * Suspend a game when user disconnects
     * @param {number} dbUserId - Database user ID
     * @param {string} oldSocketId - The disconnecting socket ID
     * @param {Object} game - The game instance
     * @param {Object} additionalState - Additional state to preserve
     * @returns {boolean} True if game was suspended
     */
    suspendGame(dbUserId, oldSocketId, game, additionalState = {}) {
        if (!dbUserId || !game) {
            return false;
        }

        // Store the suspended game state
        const suspendedState = {
            game: game,
            originalSocketId: oldSocketId,
            suspendedAt: Date.now(),
            gameId: game.id,
            playerPosition: game.player ? { x: game.player.x, y: game.player.y } : null,
            hasTreasure: game.player?.hasTreasure || false,
            moveCount: game.moveCount || 0,
            blockHeight: game.blockHeight || null,
            // Entry block height (blockRec) for reconnect timeout continuity (C3).
            // Prefer an explicit value from the caller, then the value captured on the
            // game object at creation. Never invent one — a missing value stays null so
            // the timeout logic treats it as "not yet observed" rather than instant-death.
            blockRec: (additionalState.blockRec !== undefined && additionalState.blockRec !== null)
                ? additionalState.blockRec
                : (game.blockRec ?? game.blockHeight ?? null),
            ...additionalState
        };

        this.suspendedGames.set(dbUserId, suspendedState);
        this.stats.gamesSuspended++;

        // Set cleanup timer
        this._scheduleCleanup(dbUserId);

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`🔄 [SuspendedGameManager] Suspended game ${game.id} for user ${dbUserId}`);
            console.log(`   Position: (${suspendedState.playerPosition?.x}, ${suspendedState.playerPosition?.y})`);
            console.log(`   Has treasure: ${suspendedState.hasTreasure}`);
            console.log(`   Moves: ${suspendedState.moveCount}`);
        }

        return true;
    }

    /**
     * Check if a user has a suspended game
     * @param {number} dbUserId - Database user ID
     * @returns {boolean} True if user has suspended game
     */
    hasSuspendedGame(dbUserId) {
        return this.suspendedGames.has(dbUserId);
    }

    /**
     * Get suspended game state without removing it
     * @param {number} dbUserId - Database user ID
     * @returns {Object|null} Suspended game state or null
     */
    getSuspendedState(dbUserId) {
        return this.suspendedGames.get(dbUserId) || null;
    }

    /**
     * Restore a suspended game for a reconnecting user
     * @param {number} dbUserId - Database user ID
     * @param {string} newSocketId - The new socket ID
     * @param {Object} newUser - The new User object
     * @returns {Object|null} The restored game or null if no suspended game
     */
    restoreGame(dbUserId, newSocketId, newUser) {
        const suspended = this.suspendedGames.get(dbUserId);
        if (!suspended) {
            return null;
        }

        // Cancel cleanup timer
        this._cancelCleanup(dbUserId);

        const game = suspended.game;

        // Update game with new socket ID
        game.socketId = newSocketId;

        // Keep a stable DB user id on the game object so completeGame can key on it
        // without any socket_id lookup. It is normally stamped at creation; backfill
        // from the alias just in case an older game object only carries one of them.
        if (game.userId == null && game.dbUserId != null) game.userId = game.dbUserId;
        if (game.dbUserId == null && game.userId != null) game.dbUserId = game.userId;

        // Align the persisted game row's socket_id to the reconnecting socket so
        // downstream row-matching (game-over UPDATE, completion) stays consistent.
        // Fire-and-forget so restoreGame remains synchronous for its callers.
        try {
            const db = game.db || suspended.db || null;
            if (db && game.id) {
                Promise.resolve(
                    db.query('UPDATE games SET socket_id = $1 WHERE dungeon_seed = $2', [newSocketId, game.id])
                ).catch((err) => {
                    if (this.debugManager?.CONSOLE_LOGGING) {
                        console.warn(`[SuspendedGameManager] socket_id realign failed for game ${game.id}: ${err.message}`);
                    }
                });
            }
        } catch (err) {
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.warn(`[SuspendedGameManager] socket_id realign threw for game ${game.id}: ${normalizeError(err).message}`);
            }
        }

        // Update the user reference if provided
        if (newUser) {
            game.user = newUser;
            newUser.joinGame(game);
        }

        // Re-add to active games with new socket ID
        this.activeGames.set(newSocketId, game);

        // Remove from suspended
        this.suspendedGames.delete(dbUserId);
        this.stats.gamesRestored++;

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`✅ [SuspendedGameManager] Restored game ${game.id} for user ${dbUserId}`);
            console.log(`   Old socket: ${suspended.originalSocketId} -> New socket: ${newSocketId}`);
            console.log(`   Suspended for: ${Math.round((Date.now() - suspended.suspendedAt) / 1000)}s`);
        }

        return {
            game,
            suspendedState: suspended,
            // Expose the entry block height so the reconnect path can restore
            // memUser.blockRec and keep the block-timeout logic continuous (C3).
            blockRec: suspended.blockRec ?? null
        };
    }

    /**
     * Remove a suspended game without restoring it
     * @param {number} dbUserId - Database user ID
     * @returns {boolean} True if game was removed
     */
    removeSuspendedGame(dbUserId) {
        this._cancelCleanup(dbUserId);
        const had = this.suspendedGames.delete(dbUserId);
        if (had) {
            this.stats.gamesExpired++;
        }
        return had;
    }

    /**
     * Get statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            currentSuspended: this.suspendedGames.size
        };
    }

    /**
     * Schedule cleanup for a suspended game
     * @private
     */
    _scheduleCleanup(dbUserId) {
        // Cancel any existing timer
        this._cancelCleanup(dbUserId);

        const timer = setTimeout(() => {
            const suspended = this.suspendedGames.get(dbUserId);
            if (suspended) {
                if (this.debugManager?.CONSOLE_LOGGING) {
                    console.log(`⏰ [SuspendedGameManager] Game ${suspended.gameId} expired for user ${dbUserId}`);
                }
                this.suspendedGames.delete(dbUserId);
                this.cleanupTimers.delete(dbUserId);
                this.stats.gamesExpired++;
            }
        }, this.cleanupTimeoutMs);

        // Don't prevent process exit
        if (timer.unref) timer.unref();

        this.cleanupTimers.set(dbUserId, timer);
    }

    /**
     * Cancel cleanup timer for a user
     * @private
     */
    _cancelCleanup(dbUserId) {
        const timer = this.cleanupTimers.get(dbUserId);
        if (timer) {
            clearTimeout(timer);
            this.cleanupTimers.delete(dbUserId);
        }
    }

    /**
     * Cleanup all suspended games (for graceful shutdown)
     */
    cleanup() {
        for (const [userId, timer] of this.cleanupTimers) {
            clearTimeout(timer);
        }
        this.cleanupTimers.clear();
        this.suspendedGames.clear();
    }
}

module.exports = SuspendedGameManager;
