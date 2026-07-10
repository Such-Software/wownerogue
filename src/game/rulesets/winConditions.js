/**
 * Win-condition strategies. Each is a small object the MatchRoom consults at three decision points,
 * so the room no longer hardcodes "first to the exit wins":
 *
 *   onExit(room, id)  — a player reached the exit. Decide whether that ends the match / sets a winner.
 *   onDeath(room)     — a player just died. Decide whether the match is now over.
 *   rank(room)        — final ordering (best-first) used by finalize() for placement + winnerId.
 *
 * FIRST_TO_EXIT reproduces the classic race behavior byte-for-byte (so existing matches are
 * unchanged); LAST_ALIVE and HIGH_SCORE are the new PvP / score modes.
 */
const { WIN } = require('./Ruleset');

function manhattanToExit(room, occ, onlyIfAlive, state) {
    const exit = room.dungeon.exit;
    if (!exit || !occ) return Infinity;
    if (onlyIfAlive && (!state || !state.alive)) return Infinity;
    return Math.abs(occ.x - exit[0]) + Math.abs(occ.y - exit[1]);
}

function buildRanked(room, onlyIfAlive) {
    return Array.from(room.playerStates.entries()).map(([id, state]) => {
        const occ = room.occupants.get(id);
        return { id, state, occ, dist: manhattanToExit(room, occ, onlyIfAlive, state) };
    });
}

const FIRST_TO_EXIT = {
    onExit(room, id) {
        if (!room.winnerId) {
            room.winnerId = id;
            room.endReason = 'escaped';
            room.status = 'finished';
        }
    },
    onDeath(room) {
        if (room.activePlayerCount === 0 && room.finishCount === 0 && room.status === 'active') {
            room.endReason = 'all_dead';
            room.status = 'finished';
        }
    },
    // Verbatim port of the original finalize() sort.
    rank(room) {
        const preWinner = room.winnerId;
        const ranked = buildRanked(room, true);
        ranked.sort((a, b) => {
            if (preWinner) {
                const aw = a.id === preWinner ? 1 : 0;
                const bw = b.id === preWinner ? 1 : 0;
                if (aw !== bw) return bw - aw;
            }
            const finishedA = a.state.finished ? 1 : 0;
            const finishedB = b.state.finished ? 1 : 0;
            if (finishedA !== finishedB) return finishedB - finishedA;
            const aliveA = a.state.alive ? 1 : 0;
            const aliveB = b.state.alive ? 1 : 0;
            if (aliveA !== aliveB) return aliveB - aliveA;
            if (a.dist !== b.dist) return a.dist - b.dist;
            const tA = a.state.hasTreasure ? 1 : 0;
            const tB = b.state.hasTreasure ? 1 : 0;
            if (tA !== tB) return tB - tA;
            if (a.state.moves !== b.state.moves) return a.state.moves - b.state.moves;
            return a.id.localeCompare(b.id);
        });
        return ranked;
    }
};

// Last player still alive-and-in-play wins. Reaching the exit means you SURVIVED (safe) but does
// not instantly win; the match ends when at most one contender remains.
const LAST_ALIVE = {
    _maybeEnd(room) {
        const started = room.playerStates.size;
        if (started >= 2 && room.activePlayerCount <= 1 && room.status === 'active') {
            room.status = 'finished';
            room.endReason = room.activePlayerCount === 1 ? 'last_alive' : 'all_dead';
        }
    },
    onExit(room /*, id */) { LAST_ALIVE._maybeEnd(room); },
    onDeath(room) { LAST_ALIVE._maybeEnd(room); },
    rank(room) {
        // in-play (last standing) > escaped survivor > dead-later > dead-earlier; then treasure, id.
        const tier = (s) => (s.alive && !s.finished ? 3 : (s.escaped ? 2 : (s.alive ? 1 : 0)));
        const ranked = buildRanked(room, false);
        ranked.sort((a, b) => {
            const ta = tier(a.state), tb = tier(b.state);
            if (ta !== tb) return tb - ta;
            // among the dead, whoever died later ranks higher (survived longer)
            const da = a.state.deathOrder || 0, db = b.state.deathOrder || 0;
            if (da !== db) return db - da;
            const tA = a.state.hasTreasure ? 1 : 0, tB = b.state.hasTreasure ? 1 : 0;
            if (tA !== tB) return tB - tA;
            if (a.dist !== b.dist) return a.dist - b.dist;
            return a.id.localeCompare(b.id);
        });
        return ranked;
    }
};

// Highest score when everyone is resolved (or the clock expires). No instant win on exit.
const HIGH_SCORE = {
    onExit(/* room, id */) { /* escaping just finishes the player; scoring decides the winner */ },
    onDeath(room) {
        if (room.activePlayerCount === 0 && room.status === 'active') {
            room.endReason = 'resolved';
            room.status = 'finished';
        }
    },
    rank(room) {
        const pre = (s, dist) => {
            let v = 0;
            if (s.escaped) v += 200;
            if (s.hasTreasure) v += 200;
            v += Math.max(0, 300 - Math.max(s.moves - 30, 0) * 3);
            if (!s.escaped && Number.isFinite(dist)) v += Math.max(0, 100 - dist * 2);
            return v;
        };
        const ranked = buildRanked(room, false);
        ranked.sort((a, b) => {
            const sa = pre(a.state, a.dist), sb = pre(b.state, b.dist);
            if (sa !== sb) return sb - sa;
            if (a.state.moves !== b.state.moves) return a.state.moves - b.state.moves;
            return a.id.localeCompare(b.id);
        });
        return ranked;
    }
};

// ALL_ESCAPE (co-op) — a lightweight variant of race: the match ends when everyone still alive has
// escaped (or all died). Ranking falls back to the race ordering.
const ALL_ESCAPE = {
    onExit(room) {
        if (room.activePlayerCount === 0 && room.finishCount > 0 && room.status === 'active') {
            room.endReason = 'all_escaped';
            room.status = 'finished';
        }
    },
    onDeath(room) {
        if (room.activePlayerCount === 0 && room.status === 'active') {
            room.endReason = room.finishCount > 0 ? 'all_escaped' : 'all_dead';
            room.status = 'finished';
        }
    },
    rank(room) { return FIRST_TO_EXIT.rank(room); }
};

const STRATEGIES = {
    [WIN.FIRST_TO_EXIT]: FIRST_TO_EXIT,
    [WIN.LAST_ALIVE]: LAST_ALIVE,
    [WIN.HIGH_SCORE]: HIGH_SCORE,
    [WIN.ALL_ESCAPE]: ALL_ESCAPE
};

function resolveWinCondition(type) {
    return STRATEGIES[type] || FIRST_TO_EXIT;
}

module.exports = { resolveWinCondition, FIRST_TO_EXIT, LAST_ALIVE, HIGH_SCORE, ALL_ESCAPE };
