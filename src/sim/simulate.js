#!/usr/bin/env node
// Balance-calibration harness for Wownerogue.
//
// WHY THIS EXISTS: dungeon difficulty presets each *declare* a targetHouseWinRate, but nothing ever
// MEASURED it, and single-player runs are bounded by a RANDOM block deadline (D ~ Exp(mean = the
// network's block time)). So the real house edge is a convolution of the completion-time
// distribution with the network's block cadence — un-guessable by hand, and different on every
// chain even though dungeon size is currently identical across chains.
//
// WHAT IT DOES: drives the REAL engine (src/game/game.js — same dungeon generator, monster AI and
// movement as production) with headless bots to many terminal outcomes, then reports, per preset:
//   • escape / treasure / caught / stuck rates
//   • completion-move and completion-time percentiles
//   • MEASURED house-win-rate for each network, vs the preset's declared target
//
// THE KEY IDENTITY: for a run that escapes at time T, P(a block lands first) = exp(-T / blockTime),
// so we integrate the random deadline out analytically instead of Monte-Carlo'ing it:
//   house_win_rate(net) = mean over runs of [ caught|stuck ? 1 : exp(-T_escape / meanBlockTime(net)) ]
//
// USAGE:
//   node src/sim/simulate.js [--runs 200] [--bot explorer-greedy] [--presets normal,casino]
//                            [--nets WOW,XMR,LTC,BTC,GRIN] [--cadence 320] [--json]
// Bots: omniscient-escape | omniscient-greedy | explorer-escape | explorer-greedy (default).

const Game = require('../game/game');
const { BOTS } = require('./simBots');
const { DIFFICULTY_PRESETS } = require('../game/difficultyConfig');
const { meanBlockTimeMsFor, PROFILES } = require('../chain/chainProfile');

function parseArgs(argv) {
    const a = { runs: 200, bot: 'explorer-greedy', presets: ['easy', 'normal', 'hard', 'casino'],
                nets: ['WOW', 'XMR', 'LTC', 'BTC', 'GRIN'], cadence: 320, json: false, moveCap: 6000 };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--runs') a.runs = parseInt(argv[++i], 10);
        else if (t === '--bot') a.bot = argv[++i];
        else if (t === '--presets') a.presets = argv[++i].split(',');
        else if (t === '--nets') a.nets = argv[++i].split(',');
        else if (t === '--cadence') a.cadence = parseInt(argv[++i], 10);
        else if (t === '--movecap') a.moveCap = parseInt(argv[++i], 10);
        else if (t === '--json') a.json = true;
    }
    return a;
}

// Drive ONE game to a terminal outcome with the real engine. Returns {outcome, moves, treasure}.
// outcome: 'escaped' (reached exit) | 'caught' (monster) | 'stuck' (bot gave up / hit move cap —
// treated as a timeout, i.e. a house win, since the player never got out).
function runOneGame(botFactory, opts) {
    const game = new Game('sim', { id: 0, username: 'sim' }, opts.gameOptions || {});
    const bot = botFactory({ vision: opts.vision });
    let lastX = -1, lastY = -1, stallTicks = 0, invalidStreak = 0;
    while (game.gameState === 'active' && game.moveCount < opts.moveCap) {
        const step = bot.move(game);
        if (!step) break; // bot has no reachable goal/frontier → stuck
        const res = game.movePlayer(step.dx, step.dy);
        if (res.status === 'invalid') {
            if (++invalidStreak > 8) break; // pathfinder wedged against geometry → bail
            continue;
        }
        invalidStreak = 0;
        if (game.gameState === 'won') return { outcome: 'escaped', moves: game.moveCount, treasure: !!game.player.hasTreasure };
        if (game.gameState === 'lost') return { outcome: 'caught', moves: game.moveCount, treasure: !!game.player.hasTreasure };
        game.moveMonster();
        if (game.gameState === 'lost') return { outcome: 'caught', moves: game.moveCount, treasure: !!game.player.hasTreasure };
        // Stall guard: bot orbiting the same cell (BFS tie / hazard bounce) makes no net progress.
        if (game.player.x === lastX && game.player.y === lastY) { if (++stallTicks > 12) break; }
        else { stallTicks = 0; lastX = game.player.x; lastY = game.player.y; }
    }
    return { outcome: 'stuck', moves: game.moveCount, treasure: !!game.player.hasTreasure };
}

function pct(sorted, p) {
    if (!sorted.length) return NaN;
    const i = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
    return sorted[i];
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

function simulatePreset(preset, args) {
    process.env.DIFFICULTY_PRESET = preset;
    process.env.PAYMENTS_ENABLED = 'false';
    const botFactory = BOTS[args.bot];
    if (!botFactory) throw new Error('unknown bot: ' + args.bot + ' (have: ' + Object.keys(BOTS).join(', ') + ')');
    const runs = [];
    for (let i = 0; i < args.runs; i++) runs.push(runOneGame(botFactory, { vision: 8, moveCap: args.moveCap }));

    const escaped = runs.filter(r => r.outcome === 'escaped');
    const caught = runs.filter(r => r.outcome === 'caught');
    const stuck = runs.filter(r => r.outcome === 'stuck');
    const withTreasure = escaped.filter(r => r.treasure);
    const escMoves = escaped.map(r => r.moves).sort((a, b) => a - b);
    const escSecs = escMoves.map(m => (m * args.cadence) / 1000);

    // Measured house-win-rate per network via the analytic deadline identity.
    const houseWin = {};
    for (const net of args.nets) {
        const bt = meanBlockTimeMsFor(net);
        // Escaped at time T survives iff the block lands AFTER T: P(survive)=exp(-T/bt), so the
        // house wins that run with prob 1-exp(-T/bt). Caught/stuck → house wins outright (=1).
        const contrib = runs.map(r => r.outcome === 'escaped'
            ? (1 - Math.exp(-(r.moves * args.cadence) / bt))
            : 1);
        houseWin[net] = mean(contrib);
    }

    return {
        preset,
        dims: `${DIFFICULTY_PRESETS[preset].dungeon.width}x${DIFFICULTY_PRESETS[preset].dungeon.height}`,
        target: DIFFICULTY_PRESETS[preset].targetHouseWinRate,
        n: runs.length,
        escapeRate: escaped.length / runs.length,
        treasureRate: withTreasure.length / runs.length,
        caughtRate: caught.length / runs.length,
        stuckRate: stuck.length / runs.length,
        escMoveP50: pct(escMoves, 0.5), escMoveP90: pct(escMoves, 0.9),
        escSecP50: pct(escSecs, 0.5), escSecP90: pct(escSecs, 0.9),
        houseWin
    };
}

function fmtPct(x) { return (isNaN(x) ? '  -- ' : (x * 100).toFixed(1).padStart(5) + '%'); }
function fmtNum(x) { return isNaN(x) ? '  --' : String(Math.round(x)).padStart(4); }

function report(results, args) {
    const line = '─'.repeat(96);
    console.log('\nWownerogue balance sim — bot=%s  runs/preset=%d  cadence=%dms/move', args.bot, args.runs, args.cadence);
    console.log('Block times (min): ' + args.nets.map(n => `${n} ${(meanBlockTimeMsFor(n) / 60000)}`).join('  '));
    console.log(line);
    console.log(['preset'.padEnd(8), 'dims'.padEnd(8), 'esc%', 'trs%', 'cgt%', 'stk%',
                 'escMv50', 'escS50', 'escS90'].join('  '));
    console.log(line);
    for (const r of results) {
        console.log([
            r.preset.padEnd(8), r.dims.padEnd(8), fmtPct(r.escapeRate), fmtPct(r.treasureRate),
            fmtPct(r.caughtRate), fmtPct(r.stuckRate), fmtNum(r.escMoveP50).padStart(7),
            (isNaN(r.escSecP50) ? '--' : r.escSecP50.toFixed(0) + 's').padStart(6),
            (isNaN(r.escSecP90) ? '--' : r.escSecP90.toFixed(0) + 's').padStart(6)
        ].join('  '));
    }
    console.log(line);
    console.log('\nMEASURED house-win-rate by network  (declared target in [brackets]):');
    console.log(line);
    console.log(['preset'.padEnd(8), 'target', ...args.nets.map(n => n.padStart(6))].join('  '));
    console.log(line);
    for (const r of results) {
        console.log([
            r.preset.padEnd(8),
            ('[' + (r.target * 100).toFixed(0) + '%]').padStart(6),
            ...args.nets.map(n => fmtPct(r.houseWin[n]))
        ].join('  '));
    }
    console.log(line);
    console.log('esc%=escaped  trs%=escaped WITH treasure  cgt%=monster caught  stk%=never got out');
    console.log('escMv50=median moves to escape  escS50/90=escape seconds p50/p90 (moves×cadence)');
    console.log('Note: NEITHER bot actively evades the monster, so both OVER-count catches — a');
    console.log('skilled evading human wins more, so real house-win is likely BELOW these numbers.');
    console.log('explorer-* wanders (dodges the monster by luck, slower); omniscient-* beelines');
    console.log('(faster but walks into the monster). Read them as an upper band, not a tight bracket.\n');
}

function main() {
    const args = parseArgs(process.argv);
    const results = args.presets.map(p => simulatePreset(p, args));
    if (args.json) { console.log(JSON.stringify({ args, results }, null, 2)); return; }
    report(results, args);
}

if (require.main === module) main();
module.exports = { runOneGame, simulatePreset };
