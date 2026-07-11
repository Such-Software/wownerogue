// Grid BFS used by the balance-sim bots. Kept dependency-free (no ROT) so the sim is a thin,
// auditable layer over the REAL game engine — it never reimplements game rules, only navigation.

// Breadth-first distance field from one or more source cells over a passability predicate.
// Returns a rows×cols Int32Array-of-arrays where unreachable = -1. 4-connected (the game moves
// in cardinal directions only).
function bfsField(cols, rows, passable, sources) {
    const dist = [];
    for (let y = 0; y < rows; y++) dist.push(new Array(cols).fill(-1));
    const q = [];
    for (const [sx, sy] of sources) {
        if (sy >= 0 && sy < rows && sx >= 0 && sx < cols && dist[sy][sx] === -1) {
            dist[sy][sx] = 0;
            q.push([sx, sy]);
        }
    }
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < q.length) {
        const [x, y] = q[head++];
        const d = dist[y][x];
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (dist[ny][nx] !== -1) continue;
            if (!passable(nx, ny)) continue;
            dist[ny][nx] = d + 1;
            q.push([nx, ny]);
        }
    }
    return dist;
}

// Given a distance field (to a target), return the cardinal step {dx,dy} that most reduces
// distance from (px,py), or null if there's no downhill neighbour (unreachable / already there).
function stepDownField(dist, px, py, cols, rows) {
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const here = dist[py] && dist[py][px];
    if (here == null || here < 0) return null;
    let best = null, bestD = here;
    for (const [dx, dy] of DIRS) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nd = dist[ny][nx];
        if (nd >= 0 && nd < bestD) { bestD = nd; best = { dx, dy }; }
    }
    return best;
}

module.exports = { bfsField, stepDownField };
