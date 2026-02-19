/**
 * Spectator Manager
 * Manages spectator connections and game broadcasts
 * 
 * Design considerations for scalability:
 * - Efficient tracking of spectators per game
 * - Periodic game list broadcasts instead of per-update
 * - Room-based broadcasting using Socket.IO rooms
 * - Memory-efficient cleanup of stale spectators
 */

class SpectatorManager {
    constructor({ io, activeGames, broadcastManager, debugManager, queueManager = null }) {
        this.io = io;
        this.activeGames = activeGames;
        this.broadcastManager = broadcastManager;
        this.debugManager = debugManager;
        this.queueManager = queueManager; // For pending games list

        // Map of gameId -> Set of spectator socket IDs
        this._spectatorsByGame = new Map();
        
        // Map of socketId -> gameId (for quick lookup of what a spectator is watching)
        this._spectatorWatching = new Map();
        
        // Pending game subscriptions: Map of playerId -> Set of spectator socket IDs
        // Spectators waiting for a pending game to start
        this._pendingSubscriptions = new Map();
        
        // Cached game list for efficient broadcasting
        this._cachedGameList = [];
        this._gameListLastUpdate = 0;
        this._gameListCacheTimeout = 2000; // 2 second cache
        
        // Periodic game list broadcast interval
        this._broadcastInterval = null;
        this._broadcastIntervalMs = 3000; // Broadcast every 3 seconds
    }

    /**
     * Set queue manager (for late binding)
     */
    setQueueManager(queueManager) {
        this.queueManager = queueManager;
    }

    /**
     * Initialize the manager - start periodic broadcasts
     */
    initialize() {
        // Start periodic game list broadcasting
        this._broadcastInterval = setInterval(() => {
            this._broadcastGameListToLobby();
        }, this._broadcastIntervalMs);
        
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log('👁️ SpectatorManager initialized');
        }
    }

    /**
     * Get list of active games with spectator-safe info
     * @param {Object} options - Filtering/pagination options
     * @returns {Object} Object containing active games and pending games
     */
    getActiveGamesList(options = {}) {
        const { page = 1, pageSize = 20, sortBy = 'newest' } = options;
        
        // Check cache
        const now = Date.now();
        if (now - this._gameListLastUpdate < this._gameListCacheTimeout && this._cachedGameList.length > 0) {
            return this._applyPagination(this._cachedGameList, page, pageSize);
        }
        
        // Build fresh list of active games
        const games = [];
        for (const [socketId, game] of this.activeGames.entries()) {
            if (game && game.gameState === 'active') {
                games.push(this._buildGameSummary(socketId, game));
            }
        }
        
        // Sort games
        this._sortGames(games, sortBy);
        
        // Cache the list
        this._cachedGameList = games;
        this._gameListLastUpdate = now;
        
        return this._applyPagination(games, page, pageSize);
    }

    /**
     * Get list of pending games (players waiting in queue)
     * @returns {Array} List of pending games
     */
    getPendingGamesList() {
        if (!this.queueManager || typeof this.queueManager.getPendingGamesList !== 'function') {
            return [];
        }
        return this.queueManager.getPendingGamesList();
    }

    /**
     * Build a spectator-safe game summary
     * @private
     */
    _buildGameSummary(socketId, game) {
        const spectatorCount = this._spectatorsByGame.get(game.id)?.size || 0;
        
        return {
            gameId: game.id,
            playerId: socketId.substring(0, 6), // Anonymized player ID
            startedAt: game.startedAt,
            moveCount: game.moveCount || 0,
            hasTreasure: game.isComplete ? (game.player?.hasTreasure || false) : undefined,
            spectatorCount: spectatorCount,
            // Don't expose exact positions - let spectators get that when they join
            dungeonSize: {
                width: game.width || 25,
                height: game.height || 19
            },
            difficulty: game.difficultyConfig?.presetName || 'normal',
            durationSeconds: game.startedAt ? Math.floor((Date.now() - game.startedAt) / 1000) : 0
        };
    }

    /**
     * Sort games array by criteria
     * @private
     */
    _sortGames(games, sortBy) {
        switch (sortBy) {
            case 'newest':
                games.sort((a, b) => b.startedAt - a.startedAt);
                break;
            case 'oldest':
                games.sort((a, b) => a.startedAt - b.startedAt);
                break;
            case 'spectators':
                games.sort((a, b) => b.spectatorCount - a.spectatorCount);
                break;
            case 'moves':
                games.sort((a, b) => b.moveCount - a.moveCount);
                break;
            default:
                games.sort((a, b) => b.startedAt - a.startedAt);
        }
    }

    /**
     * Apply pagination to games list
     * @private
     */
    _applyPagination(games, page, pageSize) {
        const totalGames = games.length;
        const totalPages = Math.ceil(totalGames / pageSize);
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        
        return {
            games: games.slice(startIndex, endIndex),
            pagination: {
                page,
                pageSize,
                totalGames,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        };
    }

    /**
     * Add a spectator to a game
     * @param {string} spectatorSocketId - Socket ID of the spectator
     * @param {string} gameId - ID of the game to spectate
     * @returns {Object} Result with success status and initial game state
     */
    addSpectator(spectatorSocketId, gameId) {
        // Find the game by gameId
        let targetGame = null;
        let playerSocketId = null;
        
        for (const [socketId, game] of this.activeGames.entries()) {
            if (game && game.id === gameId) {
                targetGame = game;
                playerSocketId = socketId;
                break;
            }
        }
        
        if (!targetGame) {
            return { success: false, reason: 'Game not found or has ended' };
        }
        
        if (targetGame.gameState !== 'active') {
            return { success: false, reason: 'Game is no longer active' };
        }
        
        // Check if already spectating this game
        const currentlyWatching = this._spectatorWatching.get(spectatorSocketId);
        if (currentlyWatching === gameId) {
            return { success: false, reason: 'Already spectating this game' };
        }
        
        // If spectating another game, leave it first
        if (currentlyWatching) {
            this.removeSpectator(spectatorSocketId);
        }
        
        // Add to spectators set for this game
        if (!this._spectatorsByGame.has(gameId)) {
            this._spectatorsByGame.set(gameId, new Set());
        }
        this._spectatorsByGame.get(gameId).add(spectatorSocketId);
        
        // Track what this spectator is watching
        this._spectatorWatching.set(spectatorSocketId, gameId);
        
        // Join Socket.IO room for this game
        const spectatorSocket = this._getSocket(spectatorSocketId);
        if (spectatorSocket) {
            spectatorSocket.join(`spectate:${gameId}`);
        }
        
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`👁️ Spectator ${spectatorSocketId.substring(0,6)} joined game ${gameId.substring(0,8)}`);
        }
        
        // Get initial game state for spectator
        const initialState = this._getSpectatorGameState(targetGame, playerSocketId);
        
        return { 
            success: true, 
            gameId: gameId,
            playerSocketId: playerSocketId,
            initialState: initialState,
            spectatorCount: this._spectatorsByGame.get(gameId).size
        };
    }

    /**
     * Remove a spectator from their current game
     * @param {string} spectatorSocketId - Socket ID of the spectator
     * @returns {boolean} Whether removal was successful
     */
    removeSpectator(spectatorSocketId) {
        const gameId = this._spectatorWatching.get(spectatorSocketId);
        if (!gameId) return false;
        
        // Remove from game's spectator set
        const spectators = this._spectatorsByGame.get(gameId);
        if (spectators) {
            spectators.delete(spectatorSocketId);
            if (spectators.size === 0) {
                this._spectatorsByGame.delete(gameId);
            }
        }
        
        // Remove from watching map
        this._spectatorWatching.delete(spectatorSocketId);
        
        // Leave Socket.IO room
        const spectatorSocket = this._getSocket(spectatorSocketId);
        if (spectatorSocket) {
            spectatorSocket.leave(`spectate:${gameId}`);
        }
        
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`👁️ Spectator ${spectatorSocketId.substring(0,6)} left game ${gameId.substring(0,8)}`);
        }
        
        return true;
    }

    /**
     * Get what game a socket is currently spectating
     * @param {string} socketId - Socket ID to check
     * @returns {string|null} Game ID or null
     */
    getSpectatingGame(socketId) {
        return this._spectatorWatching.get(socketId) || null;
    }

    /**
     * Check if a socket is currently spectating any game
     * @param {string} socketId - Socket ID to check
     * @returns {boolean}
     */
    isSpectating(socketId) {
        return this._spectatorWatching.has(socketId);
    }

    /**
     * Get spectator count for a game
     * @param {string} gameId - Game ID
     * @returns {number}
     */
    getSpectatorCount(gameId) {
        return this._spectatorsByGame.get(gameId)?.size || 0;
    }

    /**
     * Broadcast game update to all spectators of a game
     * @param {string} gameId - Game ID
     * @param {Object} gameState - Updated game state
     */
    broadcastToSpectators(gameId, gameState) {
        const spectators = this._spectatorsByGame.get(gameId);
        if (!spectators || spectators.size === 0) return;
        
        // Use Socket.IO room for efficient broadcasting
        this.io.to(`spectate:${gameId}`).emit('spectator_update', {
            gameId: gameId,
            gameState: gameState,
            timestamp: Date.now()
        });
    }

    /**
     * Notify spectators that a game has ended
     * @param {string} gameId - Game ID
     * @param {Object} gameOverData - Game over information
     */
    notifyGameEnded(gameId, gameOverData) {
        const spectators = this._spectatorsByGame.get(gameId);
        
        // Emit game over to spectators if any
        if (spectators && spectators.size > 0) {
            this.io.to(`spectate:${gameId}`).emit('spectate_ended', {
                gameId: gameId,
                reason: 'game_over',
                gameOverData: gameOverData
            });
            
            // Remove all spectators from this game's tracking
            for (const spectatorId of spectators) {
                this._spectatorWatching.delete(spectatorId);
                const sock = this._getSocket(spectatorId);
                if (sock) sock.leave(`spectate:${gameId}`);
            }
            this._spectatorsByGame.delete(gameId);
        }
        
        // Invalidate cache and immediately broadcast updated game list
        this._gameListLastUpdate = 0;
        this._broadcastGameListToLobby();
    }

    /**
     * Get spectator-safe game state
     * @private
     */
    _getSpectatorGameState(game, playerSocketId) {
        // Return a sanitized version of the game state
        if (typeof game.getState === 'function') {
            const state = game.getState();
            return {
                ...state,
                playerId: playerSocketId.substring(0, 6),
                isSpectating: true
            };
        }
        
        // Fallback for legacy game structure
        return {
            player: game.player ? {
                x: game.player.x,
                y: game.player.y,
                hasTreasure: undefined // Hidden from spectators during live games
            } : null,
            monster: game.monster ? {
                x: game.monster.x,
                y: game.monster.y
            } : null,
            visibleTiles: game.visibleTiles,
            lighting: game.lightingAndFov?.getLightingData ? game.lightingAndFov.getLightingData() : null,
            torches: game.dungeon?.torches || [],
            playerId: playerSocketId.substring(0, 6),
            isSpectating: true
        };
    }

    /**
     * Broadcast game list to users in the lobby (not in a game, not spectating)
     * @private
     */
    _broadcastGameListToLobby() {
        // Get fresh game list
        const gameListData = this.getActiveGamesList({ page: 1, pageSize: 50 });
        
        // Get pending games
        const pendingGames = this.getPendingGamesList();
        
        // Add pending games to the response
        gameListData.pendingGames = pendingGames;
        
        // Always broadcast, even when empty — clients need to clear their lists
        this.io.to('lobby').emit('active_games', gameListData);
    }

    /**
     * Add a socket to the lobby room
     * @param {string} socketId - Socket ID
     */
    joinLobby(socketId) {
        const sock = this._getSocket(socketId);
        if (sock) {
            sock.join('lobby');
        }
    }

    /**
     * Remove a socket from the lobby room
     * @param {string} socketId - Socket ID
     */
    leaveLobby(socketId) {
        const sock = this._getSocket(socketId);
        if (sock) {
            sock.leave('lobby');
        }
    }

    /**
     * Get a socket by ID
     * @private
     */
    _getSocket(socketId) {
        return this.io.sockets.sockets.get(socketId);
    }

    /**
     * Get statistics about spectator system
     * @returns {Object}
     */
    getStats() {
        return {
            totalSpectators: this._spectatorWatching.size,
            gamesBeingWatched: this._spectatorsByGame.size,
            cachedGameListSize: this._cachedGameList.length,
            spectatorsByGame: Object.fromEntries(
                Array.from(this._spectatorsByGame.entries()).map(([gameId, set]) => [
                    gameId.substring(0, 8),
                    set.size
                ])
            )
        };
    }

    /**
     * Cleanup when a socket disconnects
     * @param {string} socketId - Socket ID that disconnected
     */
    handleDisconnect(socketId) {
        // Remove from spectating if applicable
        this.removeSpectator(socketId);
        // Leave lobby is automatic when socket disconnects
    }

    /**
     * Shutdown the manager
     */
    shutdown() {
        if (this._broadcastInterval) {
            clearInterval(this._broadcastInterval);
            this._broadcastInterval = null;
        }
        this._spectatorsByGame.clear();
        this._spectatorWatching.clear();
        this._cachedGameList = [];
    }
}

module.exports = SpectatorManager;
