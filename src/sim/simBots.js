// Bot policies for the balance sim. A bot is a pure decision function: given the live Game, return
// the next move {dx,dy} (or null to give up). Bots NEVER mutate the game — the harness applies the
// move through the real engine. Two skill models bracket reality:
//
//   omniscient  — knows the full map from move 1; BFS-optimal to (treasure→)exit. This is the BEST
//                 case: it is a LOWER bound on completion time, hence a LOWER bound on house-win-rate.
//   explorer    — fog-of-war: only knows cells it has seen (radius `vision`). Explores toward the
//                 nearest frontier until the exit is revealed, then heads out. This is the realistic
//                 first-time-player model (every dungeon is seen fresh).
//
// Both softly avoid the monster's current + adjacent cells when a detour exists, so bots don't walk
// into obvious suicides — but they do NOT actively evade (a known bias: real skilled players evade
// better, so monster-deaths here are an UPPER bound). The omniscient/explorer pair plus this note
// bracket the true numbers honestly rather than pretending to a single "correct" bot.

const { bfsField, stepDownField } = require('./pathfind');

function floorAt(game, x, y) {
    const m = game.dungeon.map;
    if (!m[y] || m[y][x] === undefined) return false;
    const v = m[y][x];
    return v === game.gameConfig.primaryFloor || v === game.gameConfig.secondaryFloor;
}

// Cells to softly avoid: the monster and its 4 neighbours. Passed as a penalty set the BFS treats
// as impassable UNLESS the target itself sits there.
function monsterHazard(game) {
    const s = new Set();
    if (!game.monster) return s;
    const { x, y } = game.monster;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) s.add((x + dx) + ',' + (y + dy));
    return s;
}

// Build a passability predicate over floor cells, avoiding the monster hazard set (but always
// allowing the goal cell so a goal adjacent to the monster stays reachable).
function passableFactory(game, known, hazard, goalKey) {
    return (x, y) => {
        if (known && !known.has(x + ',' + y)) return false;   // explorer: only through seen cells
        if (!floorAt(game, x, y)) return false;
        const k = x + ',' + y;
        if (hazard.has(k) && k !== goalKey) return false;
        return true;
    };
}

function omniscientBot(opts = {}) {
    const wantTreasure = opts.wantTreasure !== false;
    return {
        id: wantTreasure ? 'omniscient-greedy' : 'omniscient-escape',
        vision: Infinity,
        move(game) {
            const cols = game.width, rows = game.height;
            const hazard = monsterHazard(game);
            const exit = game.dungeon.exit;
            const treasure = game.dungeon.treasure; // null once collected
            const goingTo = (wantTreasure && treasure && !game.player.hasTreasure) ? treasure : exit;
            if (!goingTo) return null;
            const goalKey = goingTo[0] + ',' + goingTo[1];
            let passable = passableFactory(game, null, hazard, goalKey);
            let field = bfsField(cols, rows, passable, [goingTo]);
            let step = stepDownField(field, game.player.x, game.player.y, cols, rows);
            if (step) return step;
            // Blocked only by the monster hazard — retry ignoring it (accept the risk over stalling).
            passable = passableFactory(game, null, new Set(), goalKey);
            field = bfsField(cols, rows, passable, [goingTo]);
            return stepDownField(field, game.player.x, game.player.y, cols, rows);
        }
    };
}

function explorerBot(opts = {}) {
    const wantTreasure = opts.wantTreasure !== false;
    const vision = opts.vision || 8;
    const known = new Set();        // "x,y" of every cell ever seen (floor or wall)
    const seenExit = { at: null };
    const seenTreasure = { at: null };
    let lastDepth = 1;              // reset fog-of-war on a multi-level descent (fresh level)

    function reveal(game) {
        const px = game.player.x, py = game.player.y;
        const r = vision;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > r * r) continue;
                const x = px + dx, y = py + dy;
                if (y < 0 || x < 0 || y >= game.height || x >= game.width) continue;
                known.add(x + ',' + y);
            }
        }
        const ex = game.dungeon.exit;
        if (ex && known.has(ex[0] + ',' + ex[1])) seenExit.at = ex;
        const tr = game.dungeon.treasure;
        if (tr && known.has(tr[0] + ',' + tr[1])) seenTreasure.at = tr;
    }

    // Frontier = a known floor cell adjacent to an unknown cell (the edge of the explored region).
    function frontiers(game) {
        const out = [];
        for (const key of known) {
            const [x, y] = key.split(',').map(Number);
            if (!floorAt(game, x, y)) continue;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (!known.has((x + dx) + ',' + (y + dy))) { out.push([x, y]); break; }
            }
        }
        return out;
    }

    return {
        id: wantTreasure ? 'explorer-greedy' : 'explorer-escape',
        vision,
        move(game) {
            // On a descent, the old level's knowledge is stale — start the new level unexplored.
            if (game.depth && game.depth !== lastDepth) {
                known.clear(); seenExit.at = null; seenTreasure.at = null; lastDepth = game.depth;
            }
            reveal(game);
            const cols = game.width, rows = game.height;
            const hazard = monsterHazard(game);
            // Goal priority: known treasure (if wanted & uncollected) → known exit → nearest frontier.
            let goal = null;
            if (wantTreasure && seenTreasure.at && !game.player.hasTreasure) goal = seenTreasure.at;
            else if (seenExit.at && (!wantTreasure || game.player.hasTreasure || !seenTreasure.at)) goal = seenExit.at;

            if (goal) {
                const goalKey = goal[0] + ',' + goal[1];
                const passable = passableFactory(game, known, hazard, goalKey);
                const field = bfsField(cols, rows, passable, [goal]);
                const step = stepDownField(field, game.player.x, game.player.y, cols, rows);
                if (step) return step;
            }
            // Explore: head to the nearest frontier through known floor.
            const fs = frontiers(game);
            if (fs.length) {
                const passable = passableFactory(game, known, hazard, null);
                const field = bfsField(cols, rows, passable, fs);
                const step = stepDownField(field, game.player.x, game.player.y, cols, rows);
                if (step) return step;
                // Hazard-blocked — retry without avoiding the monster.
                const field2 = bfsField(cols, rows, passableFactory(game, known, new Set(), null), fs);
                const step2 = stepDownField(field2, game.player.x, game.player.y, cols, rows);
                if (step2) return step2;
            }
            return null;
        }
    };
}

const BOTS = {
    'omniscient-escape': () => omniscientBot({ wantTreasure: false }),
    'omniscient-greedy': () => omniscientBot({ wantTreasure: true }),
    'explorer-escape': (o) => explorerBot({ ...o, wantTreasure: false }),
    'explorer-greedy': (o) => explorerBot({ ...o, wantTreasure: true })
};

module.exports = { BOTS, omniscientBot, explorerBot };
