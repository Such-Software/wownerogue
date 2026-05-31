/**
 * Monster collision tests (Phase 3.3).
 *
 * With movesPerPlayerMove > 1 (e.g. the casino preset's 1.5x speed) the monster takes
 * multiple steps per turn. Collision must be checked after EACH sub-step, or the monster
 * can step onto the player's tile and off again between checks, phasing through the player
 * and missing the catch (a player-favorable bug that lowers the house edge).
 */

const Game = require('../src/game/game');

function openGame() {
  // Default-size dungeon so the digger generates validly; we then override the map and
  // positions with a known fully-open grid so the scenario is deterministic.
  const game = new Game('sock-test', { id: 1 });
  const FL = "'1";
  game.dungeon.map = Array.from({ length: 7 }, () => Array(7).fill(FL));
  game.gameConfig.primaryFloor = FL;
  game.gameConfig.secondaryFloor = "'2";
  game.gameState = 'active';
  game.seededRNG = () => 0; // 0 < chaseAggressiveness => always chase
  return game;
}

describe('Monster collision with multi-step movement', () => {
  test('2-step monster adjacent to the player catches it (no phasing through)', () => {
    const game = openGame();
    game.difficultyConfig.monster.movesPerPlayerMove = 2;
    game.difficultyConfig.monster.chaseAggressiveness = 1.0;
    game.monsterMoveAccumulator = 0;
    game.player.moveTo(3, 3);
    game.monster.moveTo(3, 4); // directly adjacent
    game.monster.lastKnownPlayerX = null;
    game.monster.lastKnownPlayerY = null;

    const res = game.moveMonster();

    expect(game.gameState).toBe('lost');
    expect(res.event).toBe('monster_caught');
  });

  test('single-step monster moving onto the player still catches (sanity)', () => {
    const game = openGame();
    game.difficultyConfig.monster.movesPerPlayerMove = 1;
    game.difficultyConfig.monster.chaseAggressiveness = 1.0;
    game.monsterMoveAccumulator = 0;
    game.player.moveTo(3, 3);
    game.monster.moveTo(3, 4);

    game.moveMonster();

    expect(game.gameState).toBe('lost');
  });
});
