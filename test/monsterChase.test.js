const MovementManager = require('../src/game/movementManager');

function makeChaseGame() {
  // Minimal game stub with player + monster and deterministic chase
  return {
    player: { x: 1, y: 1, getState() { return { x: this.x, y: this.y }; } },
    monster: { x: 5, y: 1, getState() { return { x: this.x, y: this.y }; } },
    movePlayer(dx, dy) {
      this.player.x += dx; this.player.y += dy; return { status: 'moved' }; 
    },
    moveMonster() { // simple horizontal chase
      if (this.monster.x > this.player.x) this.monster.x--; else if (this.monster.x < this.player.x) this.monster.x++; 
      if (this.monster.y > this.player.y) this.monster.y--; else if (this.monster.y < this.player.y) this.monster.y++; 
    },
    getState() { return { player: { x: this.player.x, y: this.player.y }, monster: { x: this.monster.x, y: this.monster.y } }; }
  };
}

describe('Monster chase integration (MovementManager hook)', () => {
  test('monster advances toward player each move', () => {
    const activeGames = new Map();
    const socketId = 'sock-monster';
    const game = makeChaseGame();
    activeGames.set(socketId, game);
    const emitted = [];
    const io = { to: () => ({ emit: (evt, data) => emitted.push({ evt, data }) }) };
    const debugManager = { getCurrentBlockHeight: () => 999 };
    // Provide postMoveHook similar to server wiring
    const mm = new MovementManager({ activeGames, io, debugManager, moveCooldown: 0, postMoveHook: ({ game }) => game.moveMonster() });

    // Player moves right 3 times; monster should close distance
    const startDistance = game.monster.x - game.player.x;
    for (let i = 0; i < 3; i++) {
      mm.handleMove(socketId, { direction: 'right' });
    }
    const endDistance = game.monster.x - game.player.x;
    expect(endDistance).toBeLessThan(startDistance); // monster got closer
    // Ensure we emitted 3 updates
    expect(emitted.filter(e => e.evt === 'game_update').length).toBe(3);
  });
});
