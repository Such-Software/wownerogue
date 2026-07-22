/**
 * Game Manager Module
 * Handles game creation, game over scenarios, and game lifecycle management
 */

const Game = require('../game/game');

class GameManager {
    constructor({
        activeGames,
        io,
        broadcastManager,
        debugManager,
        gameModeManager,
        spectatorManager = null,
        settlementRetryBaseMs = 1000,
        settlementRetryMaxMs = 30000
    }) {
        this.activeGames = activeGames;
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
        this.spectatorManager = spectatorManager;
        this.suspendedGameManager = null;
        this._pendingSettlements = new Map();
        this._settlementRetryBaseMs = Math.max(1, Number(settlementRetryBaseMs) || 1000);
        this._settlementRetryMaxMs = Math.max(
            this._settlementRetryBaseMs,
            Number(settlementRetryMaxMs) || 30000
        );
        this._isShuttingDown = false;
        this._admissionClosed = false;
        this._creationsInFlight = new Set();
    }

    /**
     * Set the spectator manager (allows late binding after initialization)
     * @param {SpectatorManager} spectatorManager
     */
    setSpectatorManager(spectatorManager) {
        this.spectatorManager = spectatorManager;
    }

    /** Late binding avoids a constructor cycle with reconnect support. */
    setSuspendedGameManager(suspendedGameManager) {
        this.suspendedGameManager = suspendedGameManager;
    }

    /**
     * Create a new game for a user
     * @param {Object} user - User object
     * @param {string} gameType - Type of game ('standard', 'legacy')
     * @param {Object} options - Additional game options
     * @returns {Object} Created game instance
     */
    async createGameForUser(user, gameType = 'standard', options = {}) {
        if (this._admissionClosed) {
            const error = new Error('Game admission is closed for server shutdown');
            error.code = 'SERVER_SHUTTING_DOWN';
            throw error;
        }
        const creation = this._createGameForUser(user, gameType, options);
        this._creationsInFlight.add(creation);
        try {
            return await creation;
        } finally {
            this._creationsInFlight.delete(creation);
        }
    }

    async _createGameForUser(user, gameType = 'standard', options = {}) {
        // Settlement-pending games intentionally remain in activeGames. This is the last-line
        // guard against starting/charging a replacement run while the previous terminal result
        // is not yet durable (and also closes ordinary double-start races between handlers).
        if (this.activeGames.has(user.id)) {
            throw new Error('User already has an active or settlement-pending game');
        }

        let game;

        if (gameType === 'legacy') {
            game = Game.createLegacyGame(user.id, user, options);
        } else {
            game = Game.createStandardGame(user.id, user, options);
        }

        // Persist before exposing the game or charging entry. Paid-start processing updates this
        // exact row; allowing play to continue after a failed INSERT can consume a payment/credit
        // with no durable game or payout-liability anchor.
        await this._insertGameRecord(game, user);

        if (this.gameModeManager?.paymentsEnabled && !game.dbId) {
            throw new Error('Durable game record is required before a paid game can start');
        }

        user.joinGame(game);
        this.activeGames.set(user.id, game);

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`[createGameForUser] Created ${gameType} game ${game.id} for user ${user.id} (dbId: ${game.dbId || 'none'})`);
        }
        return game;
    }

    /** Synchronously close the lowest-level solo creation gate. */
    beginShutdown() {
        this._admissionClosed = true;
        this._isShuttingDown = true;
    }

    /** Wait for creations that crossed the gate before beginShutdown(). */
    async drainAdmissions() {
        while (this._creationsInFlight.size > 0) {
            await Promise.allSettled(Array.from(this._creationsInFlight));
        }
        return { pending: 0 };
    }

    /**
     * Handle game over scenarios with comprehensive cleanup and payouts
     * @param {Object} socket - Socket instance (or fake socket with just id)
     * @param {Object} game - Game instance
     * @param {string} status - Game status ('won', 'lost')
     * @param {string} reason - Reason for game ending ('escaped', 'monster', 'timeout')
     * @param {string} message - Message to display to user
     * @param {number} score - Game score
     */
    async handleGameOver(socket, game, status, reason, message, score = 0) {
        const socketId = socket?.id || socket;
        if (!socketId || !game?.id) return { success: false, reason: 'Invalid game completion' };
        if (game.settlementCommitted) return { success: true, reason: 'Game already completed' };

        // Escape, monster collision, and block timeout may converge in one event-loop turn. The
        // first caller freezes the authoritative terminal facts synchronously; every later caller
        // shares that exact settlement attempt instead of overwriting it or paying twice.
        const existing = this._pendingSettlements.get(game.id);
        if (existing) return this._attemptSettlement(existing);

        try {
            const moves = game.moveCount || 0;
            const durationSeconds = game.startedAt
                ? Math.max(0, Math.round((Date.now() - game.startedAt) / 1000))
                : null;
            const finalScore = score > 0 ? score : this._calculateScore(game, status, reason);
            const treasure = !!game.player?.hasTreasure;
            const terminal = Object.freeze({
                status,
                reason,
                message,
                score: finalScore,
                moves,
                durationSeconds,
                treasure,
                won: status === 'won',
                outcome: reason === 'escaped' ? 'escaped' : reason
            });

            // Mark terminal before any await. Keep ownership in activeGames until the transaction
            // commits: movement and all existing start paths can then fail closed on this entry.
            game.gameState = status;
            game.settlementPending = true;
            const settlement = {
                game,
                socketId,
                terminal,
                proof: null,
                attempts: 0,
                retryTimer: null,
                inFlight: null,
                pendingNoticeSent: false,
                committed: false
            };
            this._pendingSettlements.set(game.id, settlement);
            try {
                game.endGame(status, {
                    score: finalScore,
                    reason,
                    treasuresFound: treasure ? 1 : 0,
                    moves,
                    durationSeconds
                });
            } catch (error) {
                // In-memory user stats and rendering state are secondary to the durable result.
                // A local callback failure must not suppress the settlement retry.
                console.error('In-memory game finalization failed:', error.message || error);
            }
            try {
                settlement.proof = game.getProofReveal ? game.getProofReveal() : null;
            } catch (error) {
                console.error('Game proof reveal failed:', error.message || error);
            }
            return await this._attemptSettlement(settlement);
        } catch (error) {
            // Never release a terminal game merely because orchestration failed. If an intent was
            // installed it remains retryable; otherwise retain the game and flag it for operators.
            game.settlementPending = true;
            console.error('GameManager.handleGameOver error:', error.message || error);
            return { success: false, reason: 'Game settlement pending' };
        }
    }

    async _attemptSettlement(settlement) {
        if (!settlement || settlement.committed) return { success: true, reason: 'Game already completed' };
        if (settlement.inFlight) return settlement.inFlight;

        const attempt = (async () => {
            settlement.attempts += 1;
            const socketId = this._socketIdForGame(settlement.game, settlement.socketId);
            settlement.socketId = socketId;
            let payoutInfo;

            try {
                if (this.gameModeManager) {
                    const terminal = settlement.terminal;
                    payoutInfo = await this.gameModeManager.completeGame(
                        socketId,
                        settlement.game.id,
                        terminal.won,
                        terminal.treasure,
                        {
                            moves: terminal.moves,
                            durationSeconds: terminal.durationSeconds,
                            score: terminal.score,
                            reason: terminal.reason,
                            outcome: terminal.outcome
                        }
                    );
                } else {
                    const terminal = settlement.terminal;
                    await this._updateGameRecord(
                        settlement.game,
                        socketId,
                        terminal.status,
                        terminal.reason,
                        terminal.moves,
                        terminal.durationSeconds
                    );
                    payoutInfo = { success: true, payout: null };
                }
            } catch (error) {
                console.error('Error processing game completion:', error.message || error);
                payoutInfo = { success: false };
            }

            // `completeGame` deliberately normalizes transaction errors into success:false.
            // Treat every other shape as non-durable and retry; only explicit success releases
            // the game and publishes a result.
            if (!payoutInfo || payoutInfo.success !== true) {
                this._emitSettlementPending(settlement);
                this._scheduleSettlementRetry(settlement);
                return payoutInfo || { success: false, reason: 'Game settlement pending' };
            }

            settlement.committed = true;
            settlement.game.settlementPending = false;
            settlement.game.settlementCommitted = true;
            if (settlement.retryTimer) {
                clearTimeout(settlement.retryTimer);
                settlement.retryTimer = null;
            }
            this._pendingSettlements.delete(settlement.game.id);

            // Capture the reconnect-adjusted socket before releasing ownership. Remove only this
            // exact game so a theoretically newer entry can never be deleted by a late retry.
            const committedSocketId = this._socketIdForGame(settlement.game, settlement.socketId);
            for (const [activeSocketId, activeGame] of this.activeGames.entries()) {
                if (activeGame === settlement.game) this.activeGames.delete(activeSocketId);
            }
            const stableUserId = settlement.game.dbUserId ?? settlement.game.userId;
            if (stableUserId != null) {
                try {
                    this.suspendedGameManager?.removeSuspendedGame?.(stableUserId, { countExpired: false });
                } catch (error) {
                    console.error('Committed suspended-game cleanup failed:', error.message || error);
                }
            }

            await this._publishCommittedSettlement(settlement, payoutInfo, committedSocketId);
            return payoutInfo;
        })();

        settlement.inFlight = attempt;
        try {
            return await attempt;
        } finally {
            if (settlement.inFlight === attempt) settlement.inFlight = null;
        }
    }

    _scheduleSettlementRetry(settlement) {
        if (this._isShuttingDown || !settlement || settlement.committed || settlement.retryTimer) return;
        const exponent = Math.min(Math.max(settlement.attempts - 1, 0), 10);
        const delay = Math.min(this._settlementRetryBaseMs * (2 ** exponent), this._settlementRetryMaxMs);
        const timer = setTimeout(() => {
            if (settlement.retryTimer === timer) settlement.retryTimer = null;
            if (settlement.committed || !this._pendingSettlements.has(settlement.game.id)) return;
            this._attemptSettlement(settlement).catch(error => {
                console.error('Solo settlement retry failed:', error.message || error);
            });
        }, delay);
        timer.unref?.();
        settlement.retryTimer = timer;
    }

    _emitSettlementPending(settlement) {
        if (settlement.pendingNoticeSent) return;
        settlement.pendingNoticeSent = true;
        const socketId = this._socketIdForGame(settlement.game, settlement.socketId);
        try {
            this.io.to(socketId).emit('game_settlement_pending', {
                gameId: settlement.game.id,
                code: 'GAME_FINISH_NOT_DURABLE',
                retrying: true
            });
        } catch (error) {
            // Socket delivery is best-effort. It must never prevent the authoritative DB retry.
            console.error('Solo settlement-pending broadcast failed:', error.message || error);
        }
    }

    _socketIdForGame(game, fallback) {
        for (const [socketId, activeGame] of this.activeGames.entries()) {
            if (activeGame === game) return socketId;
        }
        return game?.socketId || fallback;
    }

    async _publishCommittedSettlement(settlement, payoutInfo, socketId) {
        const { game, terminal, proof } = settlement;

        try {
            this.io.to(socketId).emit('game_over', {
                status: terminal.status,
                reason: terminal.reason,
                message: terminal.message,
                score: terminal.score,
                moves: terminal.moves,
                durationSeconds: terminal.durationSeconds,
                payout: payoutInfo,
                treasure: terminal.treasure,
                proof
            });
        } catch (error) {
            console.error('Game-over broadcast failed:', error.message || error);
        }

        try {
            this.spectatorManager?.notifyGameEnded(game.id, {
                status: terminal.status,
                reason: terminal.reason,
                message: terminal.message,
                score: terminal.score,
                moves: terminal.moves,
                durationSeconds: terminal.durationSeconds,
                treasure: terminal.treasure
            });
        } catch (error) {
            console.error('Spectator game-over broadcast failed:', error.message || error);
        }

        if (terminal.score > 0) {
            try {
                let displayName = null;
                if (this.gameModeManager?.db) {
                    const userRow = await this.gameModeManager.db.query(
                        `SELECT COALESCE(display_name,
                            CASE WHEN payout_address IS NOT NULL
                                THEN LEFT(payout_address, 4) || '...' || RIGHT(payout_address, 4)
                                ELSE 'Anon#' || id
                            END) as name
                        FROM users WHERE socket_id = $1`, [socketId]);
                    displayName = userRow.rows[0]?.name || 'Unknown';
                }
                this.io.emit('leaderboard_update', {
                    name: displayName || 'Unknown',
                    score: terminal.score,
                    treasure: terminal.treasure
                });
                if (terminal.status === 'won') {
                    this.io.emit('win_feed', {
                        name: displayName || 'Someone',
                        treasure: terminal.treasure,
                        score: terminal.score,
                        paid: !!payoutInfo?.payout?.amount
                    });
                }
            } catch (error) {
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.warn('Leaderboard broadcast failed:', error.message);
                }
            }
        }

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`🎮 Game ${game.id} ended for ${socketId}: ${terminal.status} (${terminal.reason}), score: ${terminal.score}`);
        }
    }

    /**
     * Stop timers and make bounded, serialized final attempts before the DB pool closes.
     * Returns unresolved count so the process shutdown path can log/escalate it truthfully.
     */
    async shutdown({ timeoutMs = 4000, retryIntervalMs = 50 } = {}) {
        this.beginShutdown();
        for (const settlement of this._pendingSettlements.values()) {
            if (settlement.retryTimer) clearTimeout(settlement.retryTimer);
            settlement.retryTimer = null;
        }

        const initial = this._pendingSettlements.size;
        const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
        do {
            const pending = Array.from(this._pendingSettlements.values());
            if (pending.length === 0) break;
            await Promise.allSettled(pending.map(settlement => this._attemptSettlement(settlement)));
            if (this._pendingSettlements.size === 0 || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.max(1, retryIntervalMs)));
        } while (Date.now() < deadline);

        return { initial, settled: initial - this._pendingSettlements.size, pending: this._pendingSettlements.size };
    }

    /**
     * Check if monster caught player
     * @param {Object} player - Player object
     * @param {Object} monster - Monster object
     * @returns {boolean} True if monster caught player
     */
    checkMonsterKill(player, monster) {
        return monster.x === player.x && monster.y === player.y;
    }

    /**
     * Log game update debug information
     * @param {string} socketId - Socket ID
     * @param {Object} gameState - Game state object
     */
    logGameUpdate(socketId, gameState) {
        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`🔍 GAME UPDATE DEBUG for ${socketId}:`);
            console.log(`  - Player position: (${gameState.player?.x}, ${gameState.player?.y})`);
            console.log(`  - Visible tiles keys: ${Object.keys(gameState.visibleTiles || {}).length} rows`);
            console.log(`  - Lighting data included: ${!!gameState.lighting}`);
            if (gameState.lighting) {
                const lightingTileCount = Object.keys(gameState.lighting).reduce((acc, yKey) => 
                    acc + Object.keys(gameState.lighting[yKey] || {}).length, 0);
                console.log(`  - Lighting tiles count: ${lightingTileCount}`);
            }
            console.log(`  - Torch data included: ${!!gameState.torches}`);
            if (gameState.torches) {
                console.log(`  - Torch count: ${gameState.torches.length}`);
            }
            console.log(`Sending game_update to ${socketId} after player move.`);
        }
    }

    /**
     * Get statistics about active games
     * @returns {Object} Game statistics
     */
    getStats() {
        const gameTypes = new Map();
        const gameStates = new Map();
        
        for (const [socketId, game] of this.activeGames.entries()) {
            // Count by game type (if available)
            const type = game.type || 'unknown';
            gameTypes.set(type, (gameTypes.get(type) || 0) + 1);
            
            // Count by game state
            const state = game.gameState || 'active';
            gameStates.set(state, (gameStates.get(state) || 0) + 1);
        }

        return {
            totalActive: this.activeGames.size,
            byType: Object.fromEntries(gameTypes),
            byState: Object.fromEntries(gameStates)
        };
    }

    /**
     * Force cleanup of stale games (emergency cleanup)
     * @param {Function} isStaleGame - Function that takes (socketId, game) and returns true if game should be cleaned
     * @returns {number} Number of games cleaned up
     */
    cleanupStaleGames(isStaleGame) {
        let cleaned = 0;
        const toDelete = [];
        
        for (const [socketId, game] of this.activeGames.entries()) {
            if (isStaleGame(socketId, game)) {
                toDelete.push(socketId);
            }
        }
        
        for (const socketId of toDelete) {
            if (this.activeGames.delete(socketId)) {
                cleaned++;
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`🧹 Cleaned up stale game for ${socketId}`);
                }
            }
        }
        
        return cleaned;
    }

    // Private helper methods

    _calculateScore(game, status, reason) {
        if (!game) return 0;
        const moves = game.moveCount || 0;
        const duration = game.startedAt
            ? Math.max(1, Math.round((Date.now() - game.startedAt) / 1000))
            : 120;

        if (status === 'won' && reason === 'escaped') {
            let score = 100; // base escape bonus

            // Treasure bonus
            if (game.player?.hasTreasure) {
                score += 200;
            }

            // Speed bonus: max 300, loses 5 points per second after 20s
            score += Math.max(0, 300 - Math.max(duration - 20, 0) * 5);

            // Efficiency bonus: max 200, loses 3 points per move after 30 moves
            score += Math.max(0, 200 - Math.max(moves - 30, 0) * 3);

            return Math.round(score);
        } else if (game.player?.hasTreasure) {
            return 50; // found treasure but died
        }
        return 0;
    }

    /**
     * Insert a database record for the game
     * @param {Object} game - Game instance
     * @param {Object} user - User object
     */
    async _insertGameRecord(game, user) {
        if (this.gameModeManager && this.gameModeManager.db) {
            const db = this.gameModeManager.db;
            const gameMode = this.gameModeManager.gameMode || 'FREE';
            const blockHeight = this.debugManager.getCurrentBlockHeight ? this.debugManager.getCurrentBlockHeight() : null;
            const socketId = user.id; // user.id is the socket id string

            try {
                const result = await db.query(`
                    INSERT INTO games (
                        user_id, socket_id, game_mode, status, start_block_height, dungeon_seed,
                        proof_version, fairness_offer_id, fairness_offer_issued_at,
                        proof_commitment, server_seed, client_seed, effective_seed,
                        layout_fingerprint, layout_fingerprints, generator_version,
                        proof_context, created_at
                    )
                    VALUES (
                        (SELECT id FROM users WHERE socket_id = $1), $2, $3, 'active', $4, $5,
                        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
                    )
                    RETURNING id, user_id
                `, [
                    socketId,
                    socketId,
                    gameMode,
                    blockHeight,
                    game.id,
                    game.gameProof?.proofVersion || 1,
                    game.gameProof?.offerId || null,
                    game.gameProof?.offerIssuedAt ? new Date(game.gameProof.offerIssuedAt) : null,
                    game.gameProof?.commitment || null,
                    game.gameProof?.serverSeed || null,
                    game.gameProof?.clientSeed || '',
                    game.gameProof?.seed || null,
                    game.gameProof?.layoutFingerprint || null,
                    game.gameProof?.layoutFingerprints ? JSON.stringify(game.gameProof.layoutFingerprints) : null,
                    game.gameProof?.generatorVersion || null,
                    game.gameProof?.context ? JSON.stringify(game.gameProof.context) : null
                ]);
                game.dbId = result.rows[0]?.id || null;

                // Stamp the stable DB users.id onto the in-memory game object so
                // suspend/restore and completeGame can key on it WITHOUT any socket_id
                // lookup (socket ids are volatile across reconnects). game.userId is the
                // canonical field; game.dbUserId is kept as an alias for the disconnect/
                // suspend path that already reads it.
                const stableUserId = result.rows[0]?.user_id ?? null;
                if (stableUserId != null) {
                    game.userId = stableUserId;
                    if (game.dbUserId == null) game.dbUserId = stableUserId;
                }

                // Entry block height captured at creation so the suspend path can persist
                // it (blockRec) and the reconnect timeout logic stays consistent.
                game.blockRec = blockHeight;

                // Reference to the DB pool so restoreGame can keep games.socket_id aligned
                // to the reconnecting socket without needing its own DB handle.
                game.db = db;
            } catch (err) {
                console.error('Game insert failed:', err.message);
                game.dbId = null;
                throw err;
            }
        }
    }

    /**
     * Update game record with completion details
     * @param {Object} game - Game instance
     * @param {string} socketId - Socket ID
     * @param {string} status - Final game status
     * @param {string} reason - Reason for ending
     */
    async _updateGameRecord(game, socketId, status, reason, moves = 0, durationSeconds = null) {
        if (this.gameModeManager && this.gameModeManager.db) {
            const db = this.gameModeManager.db;
            const outcome = reason === 'escaped' ? 'escaped' : (reason === 'monster' ? 'caught_by_monster' : reason);
            const score = this._calculateScore(game, status, reason);

            try {
                await db.query(`
                    UPDATE games SET status = $1, outcome = $2, treasure_found = $3, moves_made = $4,
                        duration_seconds = $5, score = $8, completed_at = NOW(),
                        proof_revealed_at = NOW()
                    WHERE dungeon_seed = $6 AND socket_id = $7
                `, [status, outcome, game.player.hasTreasure, moves, durationSeconds, game.id, socketId, score]);

                // Update user's high score if this is a new personal best
                if (score > 0) {
                    await db.query(`
                        UPDATE users SET high_score = GREATEST(COALESCE(high_score, 0), $1)
                        WHERE socket_id = $2
                    `, [score, socketId]);
                }

                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`✅ Updated game record for ${socketId}: ${status} (${outcome}), score: ${score}`);
                }
            } catch (err) {
                console.error('Game completion update failed:', err.message);
            }
        }
    }
}

module.exports = GameManager;
