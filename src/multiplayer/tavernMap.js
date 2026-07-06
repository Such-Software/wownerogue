/**
 * Default Tavern layout — a small room with hand-placed props (bar, tables), generated
 * procedurally so every row is guaranteed the same width.
 *
 * Legend:
 *   '#' wall            '=' bar counter      'o' table / stool     (all solid)
 *   '.' floor           '@' spawn point (walkable)
 *
 * Anything NOT in FLOOR_CHARS is treated as solid by the Room engine. The layout is
 * generated procedurally so every row is guaranteed the same width (ragged ASCII maps
 * are a classic source of off-by-one collision bugs).
 */

// Characters an Occupant may stand on.
const FLOOR_CHARS = new Set(['.', '@']);

/**
 * Build the default tavern as an array of equal-length strings.
 * @param {number} cols
 * @param {number} rows
 * @returns {string[]}
 */
function buildDefaultTavern(cols = 26, rows = 13) {
    const grid = [];
    for (let y = 0; y < rows; y++) {
        const row = new Array(cols);
        for (let x = 0; x < cols; x++) {
            const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
            row[x] = border ? '#' : '.';
        }
        grid.push(row);
    }

    const put = (x, y, ch) => {
        if (grid[y] && grid[y][x] !== undefined && grid[y][x] !== '#') grid[y][x] = ch;
    };

    // Bar counter along the top interior wall.
    for (let x = 3; x <= 16; x++) put(x, 2, '=');

    // Table + stool clusters (2x2 blocks of 'o').
    const tables = [[5, 5], [12, 5], [18, 5], [5, 9], [12, 9], [18, 9]];
    for (const [tx, ty] of tables) {
        put(tx, ty, 'o'); put(tx + 1, ty, 'o');
        put(tx, ty + 1, 'o'); put(tx + 1, ty + 1, 'o');
    }

    // Spawn pad near the entrance (bottom-center). Two tiles so early tests have a
    // deterministic adjacent pair to exercise occupant-collision rules.
    put(12, 11, '@');
    put(13, 11, '@');

    return grid.map(r => r.join(''));
}

const TAVERN_LAYOUT = buildDefaultTavern();

module.exports = { TAVERN_LAYOUT, FLOOR_CHARS, buildDefaultTavern };
