/**
 * Game Manager Module
 * Handles game creation, game over scenarios, and game lifecycle management
 */

const Game = require('../game/game');

class GameManager {
    constructor({ activeGames, io, broadcastManager, debugManager, gameModeManager, spectatorManager = null }) {
        this.activeGames = activeGames;
        this.io = io;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.gameModeManager = gameModeManager;
        this.spectatorManager = spectatorManager;
    }

    /**
     * Set the spectator manager (allows late binding after initialization)
     * @param {SpectatorManager} spectatorManager
     */
    setSpectatorManager(spectatorManager) {
        this.spectatorManager = spectatorManager;
    }

    /**
     * Create a new game for a user
     * @param {Object} user - User object
     * @param {string} gameType - Type of game ('standard', 'legacy')
     * @param {Object} options - Additional game options
     * @returns {Object} Created game instance
     */
    async createGameForUser(user, gameType = 'standard', options = {}) {
        let game;

        if (gameType === 'legacy') {
            game = Game.createLegacyGame(user.id, user, options);
        } else {
            game = Game.createStandardGame(user.id, user, options);
        }

        user.joinGame(game);
        this.activeGames.set(user.id, game);

        // Insert DB record and wait for it (needed for processGameStart to find the row)
        await this._insertGameRecord(game, user);

        if (this.debugManager.CONSOLE_LOGGING) {
            console.log(`[createGameForUser] Created ${gameType} game ${game.id} for user ${user.id} (dbId: ${game.dbId || 'none'})`);
        }
        return game;
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
        try {
            const socketId = socket.id || socket;

            // IMMEDIATELY remove from active games to prevent double-processing.
            // If escape + block timeout fire in the same event loop tick, the second
            // call would find the game still here during the first call's await.
            this.activeGames.delete(socketId);

            game.gameState = status;
            const moves = game.moveCount || 0;
            const durationSeconds = game.startedAt ? Math.max(0, Math.round((Date.now() - game.startedAt) / 1000)) : null;
            const finalScore = score > 0 ? score : this._calculateScore(game, status, reason);
            const gameStats = {
                score: finalScore,
                reason: reason,
                treasuresFound: game.player.hasTreasure ? 1 : 0,
                moves,
                durationSeconds
            };
            game.endGame(status, gameStats);

            // Process game completion with payment system
            let payoutInfo = null;
            if (this.gameModeManager) {
                try {
                    payoutInfo = await this.gameModeManager.completeGame(
                        socketId,
                        game.id,
                        status === 'won',
                        game.player.hasTreasure || false,
                        { moves, durationSeconds, score: finalScore }
                    );

                    if (this.debugManager.CONSOLE_LOGGING && payoutInfo) {
                        console.log(`💰 Payout processed for ${socketId}:`, payoutInfo);
                    }
                } catch (error) {
                    console.error('Error processing game completion:', error);
                }
            }

            // Emit game over event with provably fair reveal
            const proofReveal = game.getProofReveal ? game.getProofReveal() : null;

            this.io.to(socketId).emit('game_over', {
                status: status,
                reason: reason,
                message: message,
                score: finalScore,
                moves,
                durationSeconds,
                payout: payoutInfo,
                treasure: game.player.hasTreasure || false,
                proof: proofReveal
            });

            // Persist completion details if DB available
            await this._updateGameRecord(game, socketId, status, reason, moves, durationSeconds);

            // Notify spectators that the game has ended and broadcast updated list
            if (this.spectatorManager) {
                this.spectatorManager.notifyGameEnded(game.id, {
                    status,
                    reason,
                    message,
                    score: finalScore,
                    moves,
                    durationSeconds,
                    treasure: game.player.hasTreasure || false
                });
            }

            if (this.debugManager.CONSOLE_LOGGING) {
                console.log(`🎮 Game ${game.id} ended for ${socketId}: ${status} (${reason})`);
            }

        } catch (error) {
            console.error('GameManager.handleGameOver error:', error);
            // Still try to clean up even if there was an error
            const socketId = socket?.id || socket;
            if (socketId) {
                this.activeGames.delete(socketId);
            }
        }
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
        let score = 0;
        if (status === 'won' && reason === 'escaped') {
            score += 100; // base win
            if (game.player?.hasTreasure) {
                score += 100; // treasure bonus
            }
            const moveBonus = Math.max(0, 100 - Math.max(moves - 40, 0) * 2);
            score += moveBonus;
        } else if (game.player?.hasTreasure) {
            // Reached treasure but did not escape
            score += 50;
        }
        return Math.max(0, Math.round(score));
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
                    INSERT INTO games (user_id, socket_id, game_mode, status, start_block_height, dungeon_seed, created_at)
                    VALUES ((SELECT id FROM users WHERE socket_id = $1), $2, $3, 'active', $4, $5, NOW())
                    RETURNING id
                `, [socketId, socketId, gameMode, blockHeight, game.id]);
                game.dbId = result.rows[0]?.id || null;
            } catch (err) {
                console.error('Game insert failed:', err.message);
                game.dbId = null;
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
            
            try {
                await db.query(`
                    UPDATE games SET status = $1, outcome = $2, treasure_found = $3, moves_made = $4, duration_seconds = $5, completed_at = NOW()
                    WHERE dungeon_seed = $6 AND socket_id = $7
                `, [status, outcome, game.player.hasTreasure, moves, durationSeconds, game.id, socketId]);
                
                if (this.debugManager.CONSOLE_LOGGING) {
                    console.log(`✅ Updated game record for ${socketId}: ${status} (${outcome})`);
                }
            } catch (err) {
                console.error('Game completion update failed:', err.message);
            }
        }
    }
}

module.exports = GameManager;