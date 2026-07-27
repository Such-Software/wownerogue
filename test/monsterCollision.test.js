/**
 * Monster collision tests (Phase 3.3).
 *
 * With movesPerPlayerMove > 1 (e.g. the casino preset's 1.5x speed) the monster takes
 * multiple steps per turn. Collision must be checked after EACH sub-step, or the monster
 * can step onto the player's tile and off again between checks, phasing through the player
 * and missing the catch (a player-favorable bug that lowers the house edge).
 */

const Game = require('../src/game/game');
const DungeonGenerator = require('../src/game/dungeon');

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
  test('two-room fallback spawns the monster deterministically on a distant passable tile', () => {
    const FL = "'1";
    const map = Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) =>
      (x === 0 || y === 0 || x === 6 || y === 6) ? '#' : FL));
    const dungeon = {
      map,
      rooms: [],
      entrance: [1, 1],
      exit: [5, 5],
      treasure: [4, 4],
      torches: []
    };
    const generatedFingerprint = DungeonGenerator.layoutFingerprint(dungeon);
    const generate = jest.spyOn(DungeonGenerator, 'generate').mockReturnValue(dungeon);
    const previousLevels = process.env.DUNGEON_LEVELS;
    process.env.DUNGEON_LEVELS = '1';
    try {
      const game = new Game('fallback-spawn', { id: 1 }, { width: 7, height: 7, cryptoType: 'XMR' });
      expect(game.monster.getState()).toMatchObject({ x: 5, y: 4 });
      expect(game.dungeon.map[game.monster.y][game.monster.x]).toBe(FL);
      expect(game.monster.isAt(game.player.x, game.player.y)).toBe(false);
      expect(game.monster.isAt(game.dungeon.exit[0], game.dungeon.exit[1])).toBe(false);
      expect(game.monster.isAt(game.dungeon.treasure[0], game.dungeon.treasure[1])).toBe(false);
      expect(DungeonGenerator.layoutFingerprint(game.dungeon)).toBe(generatedFingerprint);
    } finally {
      generate.mockRestore();
      if (previousLevels === undefined) delete process.env.DUNGEON_LEVELS;
      else process.env.DUNGEON_LEVELS = previousLevels;
    }
  });

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
