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

        // Ordinary network disconnects retain the existing bounded in-memory grace period.
        // A durable restart snapshot is different: PostgreSQL is the authority and the process
        // must keep the reconstructed object available until its owner reconnects (or an operator
        // explicitly resolves the active row). Expiring only the Map entry would strand the
        // durable active game and silently make it unresumable.
        if (additionalState.durableRestartSnapshot !== true) {
            this._scheduleCleanup(dbUserId);
        }

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
     * @returns {Promise<Object|null>} The restored game or null if no suspended game
     */
    async restoreGame(dbUserId, newSocketId, newUser) {
        const suspended = this.suspendedGames.get(dbUserId);
        if (!suspended) {
            return null;
        }

        const game = suspended.game;

        // A settlement retry may have committed after disconnect but before reconnect. Never
        // resurrect that terminal object as an active game; the durable result is authoritative.
        if (game?.settlementCommitted) {
            this.suspendedGames.delete(dbUserId);
            return null;
        }

        // Claim a durable restart snapshot and realign the socket in one PostgreSQL statement
        // before exposing the game as playable. If the row is no longer exactly active for this
        // game/user/seed, no snapshot is consumed and no in-memory state is revived.
        const db = game.db || suspended.db || null;
        if (suspended.durableRestartSnapshot === true) {
            if (!db || !game.dbId || !game.id) {
                throw new Error('Durable solo restart snapshot is missing its database identity');
            }
            const claimed = await db.query(`
                WITH valid_game AS MATERIALIZED (
                    SELECT id
                    FROM games
                    WHERE id = $1 AND user_id = $2 AND dungeon_seed = $3
                      AND status = 'active' AND completed_at IS NULL
                    FOR UPDATE
                ), consumed AS (
                    DELETE FROM solo_restart_snapshots s
                    USING valid_game g
                    WHERE s.game_id = g.id AND s.user_id = $2 AND s.snapshot_version = $4
                    RETURNING s.game_id
                )
                UPDATE games
                SET socket_id = $5
                WHERE id = $1 AND EXISTS (SELECT 1 FROM consumed)
                RETURNING id
            `, [game.dbId, dbUserId, game.id, suspended.snapshotVersion, newSocketId]);
            if (claimed.rowCount !== 1) {
                const error = new Error('Durable solo restart snapshot could not be claimed');
                error.code = 'SOLO_RESTART_SNAPSHOT_CLAIM_FAILED';
                throw error;
            }
        } else if (db && game.id) {
            const aligned = await db.query(
                `UPDATE games SET socket_id = $1
                 WHERE dungeon_seed = $2 AND status = 'active' AND completed_at IS NULL
                 RETURNING id`,
                [newSocketId, game.id]
            );
            if (aligned.rowCount !== 1) {
                const error = new Error('Suspended solo game is no longer active');
                error.code = 'SUSPENDED_GAME_REALIGN_FAILED';
                throw error;
            }
        }

        // Only mutate the cache/object after the durable claim succeeds. A transient database
        // failure therefore leaves the suspended entry intact for a later reconnect attempt.
        this._cancelCleanup(dbUserId);

        // Update game with new socket ID
        game.socketId = newSocketId;

        // Keep a stable DB user id on the game object so completeGame can key on it
        // without any socket_id lookup. It is normally stamped at creation; backfill
        // from the alias just in case an older game object only carries one of them.
        if (game.userId == null && game.dbUserId != null) game.userId = game.dbUserId;
        if (game.dbUserId == null && game.userId != null) game.dbUserId = game.userId;

        // Update the user reference if provided
        if (newUser) {
            game.user = newUser;
            // A terminal-pending object is restored only as an ownership lock while its DB
            // transaction retries. Re-counting it as a newly joined game would corrupt in-memory
            // stats and leave currentGame pointing at an ended run after settlement succeeds.
            if (!game.settlementPending && !game.settlementCommitted) newUser.joinGame(game);
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
    removeSuspendedGame(dbUserId, { countExpired = true } = {}) {
        this._cancelCleanup(dbUserId);
        const had = this.suspendedGames.delete(dbUserId);
        if (had && countExpired) {
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
