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
    this._acceptingMoves = true;
  }

  handleMove(socketId, moveData) {
    if (!this._acceptingMoves) return;
    if (!moveData || typeof moveData.direction !== 'string') return;
    const now = Date.now();
    const last = this._lastMove.get(socketId) || 0;
    if (now - last < this.moveCooldown) return; // rate limit
    this._lastMove.set(socketId, now);

    const game = this.activeGames.get(socketId);
    if (!game) return; // not in a game

    // A terminal result stays in activeGames while its atomic DB completion is retried, which
    // blocks replacement games. Game.movePlayer does not inspect gameState, so this guard is what
    // stops the retained Game object from accepting further moves.
    if (game.settlementPending || game.settlementCommitted || game.gameState === 'ended') return;

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

    // The hook performs monster movement and other side-effects before the state snapshot.
    if (moveResult && moveResult.status === 'moved' && this.postMoveHook) {
      try {
        this.postMoveHook({ socketId, game, moveResult });
      } catch (e) {
        console.error('postMoveHook error:', e);
      }
    }

    // State reflects both the player move and any monster move made by the hook.
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

    // Special events from moveResult (escape / treasure / descend). Depth and maxDepth accompany a
    // multi-level descend so the client can tell the player they took the stairs down.
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

  /**
   * Drop the move-cooldown entry for a departed socket.
   *
   * `_lastMove` is keyed by the volatile socket.id and written on every accepted move. Without this
   * call it is only emptied by shutdown(), leaving one permanent entry per socket that ever moved.
   */
  forgetSocket(socketId) {
    this._lastMove.delete(socketId);
  }

  /** Freeze gameplay before the graceful-shutdown settlement drain takes its snapshot. */
  shutdown() {
    this._acceptingMoves = false;
    this._lastMove.clear();
  }
}

module.exports = MovementManager;
