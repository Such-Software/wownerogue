/**
 * MovementManager
 * Handles rate limiting and applying player movement to games.
 */
class MovementManager {
  constructor({ activeGames, io, debugManager, moveCooldown = 100, postMoveHook = null, spectatorManager = null }) {
    this.activeGames = activeGames; // Map socketId -> Game
    this.io = io;
    this.debugManager = debugManager;
    this.moveCooldown = moveCooldown;
    this._lastMove = new Map(); // socketId -> timestamp
    this.postMoveHook = typeof postMoveHook === 'function' ? postMoveHook : null;
    this.spectatorManager = spectatorManager; // For broadcasting to spectators
  }

  handleMove(socketId, moveData) {
    if (!moveData || typeof moveData.direction !== 'string') return;
    const now = Date.now();
    const last = this._lastMove.get(socketId) || 0;
    if (now - last < this.moveCooldown) return; // rate limit
    this._lastMove.set(socketId, now);

    const game = this.activeGames.get(socketId);
    if (!game) return; // not in a game

    const dir = moveData.direction;
    let dx = 0, dy = 0;
    switch (dir) {
      case 'up': dy = -1; break;
      case 'down': dy = 1; break;
      case 'left': dx = -1; break;
      case 'right': dx = 1; break;
      default: return;
    }

    let moveResult = null;
    if (typeof game.movePlayer === 'function') {
      moveResult = game.movePlayer(dx, dy);
    }

    // Allow hook to perform monster movement or other side-effects BEFORE we snapshot state
    if (moveResult && moveResult.status === 'moved' && this.postMoveHook) {
      try {
        this.postMoveHook({ socketId, game, moveResult });
      } catch (e) {
        console.error('postMoveHook error:', e);
      }
    }

    // Build state after player + potential monster move
    let state;
    if (typeof game.getState === 'function') {
      state = game.getState();
    } else {
      state = { player: game.player };
    }
    if (this.debugManager && typeof this.debugManager.getCurrentBlockHeight === 'function') {
      state.blockHeight = this.debugManager.getCurrentBlockHeight();
    }

    this.io.to(socketId).emit('game_update', state);
    
    // Broadcast to spectators
    if (this.spectatorManager && game.id) {
      this.spectatorManager.broadcastToSpectators(game.id, state);
    }

    // Handle special events from moveResult (escape / treasure / descend). Include depth for the
    // multi-level descend so the client can tell the player they took the stairs down (not a bug).
    if (moveResult && moveResult.event) {
      this.io.to(socketId).emit('game_event', {
        event: moveResult.event, depth: moveResult.depth, maxDepth: moveResult.maxDepth
      });
    }
  }

  emitGameUpdate(socketId) {
    const game = this.activeGames.get(socketId);
    if (!game) {
      return;
    }
    let state;
    if (typeof game.getState === 'function') {
      state = game.getState();
    } else {
      state = { player: game.player };
    }
    if (this.debugManager && typeof this.debugManager.getCurrentBlockHeight === 'function') {
      state.blockHeight = this.debugManager.getCurrentBlockHeight();
    }
    this.io.to(socketId).emit('game_update', state);
    
    // Broadcast to spectators
    if (this.spectatorManager && game.id) {
      this.spectatorManager.broadcastToSpectators(game.id, state);
    }
  }
}

module.exports = MovementManager;
