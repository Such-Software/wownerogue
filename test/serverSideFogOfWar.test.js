/**
 * Server-side fog of war.
 *
 * `Game.getState()` used to put the absolute entrance/exit/treasure coordinates AND the monster's
 * exact position into every `game_start` / `game_update` frame, relying entirely on the browser
 * renderer to decline to draw them. Anyone reading the socket payload in devtools could walk
 * straight to the treasure and the exit from move 0: in a paid mode, a direct attack on the payout,
 * and the same frame is forwarded verbatim to spectators.
 *
 * Concealment is now enforced where it is authoritative: the server. Discovery is STICKY so a
 * feature you have found stays on your map after you walk away, matching the client's notion of
 * explored memory.
 */

const Game = require('../src/game/game');

const KEYS = ['DUNGEON_LEVELS', 'DIFFICULTY_PRESET', 'CRYPTO_TYPE'];
const SAVE = {};
beforeEach(() => {
    KEYS.forEach(k => { SAVE[k] = process.env[k]; delete process.env[k]; });
    process.env.DIFFICULTY_PRESET = 'normal';
});
afterEach(() => {
    KEYS.forEach(k => { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; });
});

const user = () => ({ id: 0, username: 'test', endGame() {} });

/** Force a point into (or out of) the player's current FOV. */
function setVisible(game, point, visible) {
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    if (visible) {
        game.visibleTiles[y] = game.visibleTiles[y] || {};
        game.visibleTiles[y][x] = '.';
    } else if (game.visibleTiles[y]) {
        delete game.visibleTiles[y][x];
    }
}

describe('server-side fog of war', () => {
    test('undiscovered exit and treasure are withheld from the state frame', () => {
        process.env.DUNGEON_LEVELS = '1';
        const game = new Game('sock', user(), {});
        // Nothing but the spawn room is in view at game start.
        setVisible(game, game.dungeon.exit, false);
        if (game.dungeon.treasure) setVisible(game, game.dungeon.treasure, false);

        const state = game.getState();
        expect(state.exit).toBeNull();
        expect(state.treasure).toBeNull();
        // The dungeon itself still knows; only the wire frame is redacted.
        expect(game.dungeon.exit).toEqual(expect.any(Array));
    });

    test('a feature is disclosed once seen, and STAYS disclosed after it leaves view', () => {
        process.env.DUNGEON_LEVELS = '1';
        const game = new Game('sock', user(), {});
        const exit = game.dungeon.exit;

        expect(game.getState().exit).toBeNull();

        setVisible(game, exit, true);
        expect(game.getState().exit).toEqual(exit);

        // Walk away: explored memory must persist, or a found staircase would vanish off the map.
        setVisible(game, exit, false);
        expect(game.getState().exit).toEqual(exit);
    });

    test('the monster is only reported while it is actually in view', () => {
        process.env.DUNGEON_LEVELS = '1';
        const game = new Game('sock', user(), {});
        expect(game.monster).toBeTruthy();

        setVisible(game, game.monster, false);
        expect(game.getState().monster).toBeNull();

        setVisible(game, game.monster, true);
        const seen = game.getState().monster;
        expect(seen).toBeTruthy();
        expect(seen.x).toBe(game.monster.x);
        expect(seen.y).toBe(game.monster.y);

        // Unlike features, the monster moves: concealment is NOT sticky, or you could track the
        // hunter through walls for the rest of the run.
        setVisible(game, game.monster, false);
        expect(game.getState().monster).toBeNull();
    });

    test('discovery survives repeated getState calls without re-checking visibility', () => {
        process.env.DUNGEON_LEVELS = '1';
        const game = new Game('sock', user(), {});
        setVisible(game, game.dungeon.entrance, true);
        expect(game.getState().entrance).toEqual(game.dungeon.entrance);
        setVisible(game, game.dungeon.entrance, false);
        expect(game.getState().entrance).toEqual(game.dungeon.entrance);
        expect(game.getState().entrance).toEqual(game.dungeon.entrance);
    });
});
