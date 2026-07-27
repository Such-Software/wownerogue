const MovementManager = require('../src/game/movementManager');

// Minimal fake game implementing movePlayer & getState
function makeGame() {
  return {
    player: { x: 5, y: 5, getState() { return { x: this.x, y: this.y }; } },
    movePlayer(dx, dy) {
      this.player.x += dx;
      this.player.y += dy;
      return { status: 'moved' };
    },
    getState() { return { player: { x: this.player.x, y: this.player.y } }; }
  };
}

describe('MovementManager', () => {
  test('applies movement and rate limits subsequent rapid moves', () => {
    const activeGames = new Map();
    const socketId = 'sock1';
    const game = makeGame();
    activeGames.set(socketId, game);
    const emitted = [];
    const io = { to: () => ({ emit: (evt, data) => emitted.push({ evt, data }) }) };
    const debugManager = { getCurrentBlockHeight: () => 123 };
    const mm = new MovementManager({ activeGames, io, debugManager, moveCooldown: 100 });

    mm.handleMove(socketId, { direction: 'right' });
    mm.handleMove(socketId, { direction: 'right' }); // should be rate-limited

    expect(game.player.x).toBe(6); // only first move applied
    expect(emitted.filter(e => e.evt === 'game_update').length).toBe(1);
  });
});
