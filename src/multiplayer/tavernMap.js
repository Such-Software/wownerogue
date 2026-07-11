/**
 * Default Tavern layout — a hand-built room rendered through the theme atlas. Every row is the same
 * width (ragged ASCII maps are a classic off-by-one collision bug), and the legend below drives both
 * the client tiles (sceneModel TAVERN_LEGEND/TILE_OF) and Room walkability.
 *
 * Legend:
 *   '#' wall     'W' window    '=' bar counter   'k' keg (barrel)   'h' shelf of bottles
 *   'T' table    'c' chair     'B' barrel        'C' crate          'D' door
 *   '.' floor    'r' rug       '@' spawn
 *
 * Walkable = FLOOR_CHARS ('.', '@', 'r' rug, 'c' chair, 'D' door). Everything else is solid, so
 * players weave between the furniture. The bartender stands BEHIND the bar (the row between the top
 * wall and the counter).
 */

// Characters an Occupant may stand on. Chairs are walkable so standing on one reads as "sitting".
const FLOOR_CHARS = new Set(['.', '@', 'r', 'c', 'D']);

function buildDefaultTavern(cols = 28, rows = 15) {
    const grid = [];
    for (let y = 0; y < rows; y++) {
        const row = new Array(cols);
        for (let x = 0; x < cols; x++) {
            const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
            row[x] = border ? '#' : '.';
        }
        grid.push(row);
    }
    // set: overwrite anything (incl. walls, for windows/door). put: don't clobber walls.
    const set = (x, y, ch) => { if (grid[y] && x >= 0 && x < cols) grid[y][x] = ch; };
    const put = (x, y, ch) => { if (grid[y] && grid[y][x] !== undefined && grid[y][x] !== '#') grid[y][x] = ch; };

    // Windows punched into the top wall and the two side walls.
    for (let x = 3; x < cols - 3; x += 4) set(x, 0, 'W');
    for (let y = 4; y < rows - 3; y += 4) { set(0, y, 'W'); set(cols - 1, y, 'W'); }

    // The bar: a counter across the top interior (row 2), a shelf of bottles behind it (row 1),
    // and a keg (barrel) bracketing each end. Row 1 is the bartender's space, sealed off by the
    // counter — players can't get behind it.
    const barY = 2, barX0 = 3, barX1 = cols - 5;
    for (let x = barX0; x <= barX1; x++) set(x, barY, '=');
    for (let x = barX0; x <= barX1; x += 2) set(x, barY - 1, 'h'); // bottles behind the bar
    set(barX0 - 1, barY, 'k'); set(barX1 + 1, barY, 'k');           // kegs bracket the counter

    // Tables (each with a chair below it), spread across the main floor with walkable aisles.
    const tables = [[5, 6], [12, 6], [19, 6], [5, 10], [12, 10], [19, 10]];
    for (const [tx, ty] of tables) { put(tx, ty, 'T'); put(tx, ty + 1, 'c'); }

    // (No rug for now — the rug tile renders green, which reads wrong on the wood floor.)

    // Corner decor — barrels and crates.
    put(1, 1, 'B'); put(cols - 2, 1, 'C'); put(1, rows - 2, 'C'); put(cols - 2, rows - 2, 'B');

    // Fixtures lining the room so it reads lived-in instead of a big empty floor: barrels/crates
    // (material variety) plus fire fixtures — braziers ('i') throwing flickering light in the
    // corners and a hearth ('F') anchoring the left wall. All solid, all clear of windows/spawn/
    // tables/aisles. The renderers paint the animated flame + glow on the fire tiles.
    const wallDecor = [
        [1, 6, 'B'], [1, 10, 'C'],
        [cols - 2, 6, 'C'], [cols - 2, 10, 'B'],
        [2, rows - 2, 'B'], [cols - 3, rows - 2, 'C'],
        [barX0 - 1, barY + 1, 'B'], [barX1 + 1, barY + 1, 'C'], // a barrel/crate tucked beside each keg
        [1, 4, 'i'], [cols - 2, 4, 'i'],                        // braziers flanking the bar
        [1, rows - 3, 'i'], [cols - 2, rows - 3, 'i'],          // braziers in the lower corners
        [1, 8, 'F']                                             // hearth on the left wall
    ];
    for (const [dx, dy, dch] of wallDecor) put(dx, dy, dch);

    // Door + spawn pad at the bottom-centre (two spawn tiles for deterministic adjacency tests).
    const mid = Math.floor(cols / 2);
    set(mid, rows - 1, 'D');
    put(mid, rows - 2, '@'); put(mid - 1, rows - 2, '@');

    return grid.map(r => r.join(''));
}

const TAVERN_LAYOUT = buildDefaultTavern();

module.exports = { TAVERN_LAYOUT, FLOOR_CHARS, buildDefaultTavern };
