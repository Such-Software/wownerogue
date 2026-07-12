#!/usr/bin/env node
// Per-network difficulty calibrator (v2), rebuilt around what the size-probe revealed:
//
//   Dungeon SIZE trades one edge-source for another — a bigger map lengthens the run (timer edge
//   UP) but gives the player more room to dodge (monster edge DOWN), so house-win self-cancels
//   around ~60% until you go monstrous (210x105, 650-move slogs). Size is therefore NOT a clean
//   house-edge lever.
//
// So we split the two concerns:
//   • SIZE ∝ √(blockTime)  — pure PACING. A run's completion time stays a consistent fraction of
//     the block interval, so it feels chain-appropriate (GRIN sprint … BTC epic) and the timer
//     contributes a stable baseline. Clamped to stay playable.
//   • MONSTER speed         — the house EDGE lever (monotonic: meaner monster → more catches),
//     solved per network to hit the target house-win at the pacing size.
//
// CAVEAT: the bots don't actively evade the monster, so the solved monster-speed is a STARTING
// POINT that under-provisions vs skilled humans — validate/retune the monster with real telemetry.
// The SIZE∝blockTime half is bot-robust (it keys off completion TIME, which the explorer models).
//
// USAGE: node src/sim/calibrate.js [--target 0.70] [--preset casino] [--runs 160] [--cadence 320]

const { runOneGame } = require('./simulate');
const { BOTS } = require('./simBots');
const { meanBlockTimeMsFor } = require('../chain/chainProfile');
const { DIFFICULTY_PRESETS } = require('../game/difficultyConfig');

const BASE_BLOCK_MS = 120000; // WOW/XMR — the reference the size scale is relative to

function parseArgs(argv) {
    const a = { target: 0.70, preset: 'casino', bot: 'explorer-greedy', runs: 160, cadence: 320,
                nets: ['WOW', 'XMR', 'LTC', 'BTC', 'GRIN'], moveCap: 5000,
                sizeMin: 0.7, sizeMax: 1.6, spdMin: 0.6, spdMax: 2.2 };
    for (let i = 2; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--target') a.target = parseFloat(argv[++i]);
        else if (t === '--preset') a.preset = argv[++i];
        else if (t === '--bot') a.bot = argv[++i];
        else if (t === '--runs') a.runs = parseInt(argv[++i], 10);
        else if (t === '--cadence') a.cadence = parseInt(argv[++i], 10);
        else if (t === '--nets') a.nets = argv[++i].split(',');
    }
    return a;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Pacing size multiplier: √(blockTime / reference), clamped to a playable band.
function pacingScale(net, args) {
    return clamp(Math.sqrt(meanBlockTimeMsFor(net) / BASE_BLOCK_MS), args.sizeMin, args.sizeMax);
}

// Measure house-win (+ timer/monster split) at a given size and monster speed on one network.
function measure(preset, net, width, height, monsterSpeed, args) {
    process.env.DIFFICULTY_PRESET = preset;
    process.env.PAYMENTS_ENABLED = 'false';
    process.env.MONSTER_SPEED = String(monsterSpeed);
    const bt = meanBlockTimeMsFor(net);
    const factory = BOTS[args.bot];
    let house = 0, timer = 0, caught = 0, escaped = 0, moveSum = 0;
    for (let i = 0; i < args.runs; i++) {
        const r = runOneGame(factory, { vision: 8, moveCap: args.moveCap, gameOptions: { width, height } });
        if (r.outcome === 'escaped') {
            const tOut = 1 - Math.exp(-(r.moves * args.cadence) / bt);
            house += tOut; timer += tOut; escaped++; moveSum += r.moves;
        } else { house += 1; caught += (r.outcome === 'caught' ? 1 : 0); }
    }
    return { house: house / args.runs, timerShare: timer / args.runs, monsterShare: caught / args.runs,
             escapeRate: escaped / args.runs, medMovesEscaped: escaped ? Math.round(moveSum / escaped) : NaN };
}

// Binary-search monster speed (monotonic in house-win) to the target, at the pacing size.
function solve(preset, net, args) {
    const base = DIFFICULTY_PRESETS[preset].dungeon;
    const scale = pacingScale(net, args);
    const width = Math.max(20, Math.round(base.width * scale));
    const height = Math.max(12, Math.round(base.height * scale));
    let lo = args.spdMin, hi = args.spdMax, best = null, flag = '';
    const loM = measure(preset, net, width, height, lo, args);
    if (loM.house >= args.target) { best = loM; best.speed = lo; flag = 'floored (min monster already ≥ target)'; }
    else {
        const hiM = measure(preset, net, width, height, hi, args);
        if (hiM.house < args.target) { best = hiM; best.speed = hi; flag = 'CAPPED (max monster < target)'; }
        else {
            for (let it = 0; it < 8; it++) {
                const mid = (lo + hi) / 2;
                const m = measure(preset, net, width, height, mid, args);
                best = m; best.speed = mid;
                if (m.house < args.target) lo = mid; else hi = mid;
            }
        }
    }
    return { net, scale, width, height, speed: best.speed, ...best, flag };
}

function pct(x) { return isNaN(x) ? '  -- ' : (x * 100).toFixed(1).padStart(5) + '%'; }

function main() {
    const args = parseArgs(process.argv);
    delete process.env.MONSTER_SPEED;
    const line = '─'.repeat(98);
    const base = DIFFICULTY_PRESETS[args.preset].dungeon;
    console.log('\nPer-network calibration → target house-win %s   preset=%s (base %dx%d)',
        (args.target * 100).toFixed(0) + '%', args.preset, base.width, base.height);
    console.log('SIZE ∝ √blockTime (pacing); MONSTER speed solved for edge.  bot=%s runs/eval=%d cadence=%dms',
        args.bot, args.runs, args.cadence);
    console.log(line);
    console.log(['net'.padEnd(5), 'block', 'dims'.padEnd(9), 'mSpeed', 'house', '(timer', 'monst)', 'esc%', 'note'].join('  '));
    console.log(line);
    const table = {};
    for (const net of args.nets) {
        const s = solve(args.preset, net, args);
        table[net] = { width: s.width, height: s.height, monsterSpeed: Math.round(s.speed * 100) / 100 };
        console.log([
            net.padEnd(5), (meanBlockTimeMsFor(net) / 60000 + 'm').padStart(5), `${s.width}x${s.height}`.padEnd(9),
            s.speed.toFixed(2).padStart(6), pct(s.house), pct(s.timerShare), pct(s.monsterShare) + ')',
            pct(s.escapeRate), s.flag
        ].join('  '));
    }
    console.log(line);
    console.log('\nSolved NETWORK_TUNING (paste into difficultyConfig):');
    console.log(JSON.stringify(table, null, 0));
    console.log('\nmSpeed = monster movesPerPlayerMove. timer/monst = share of house-win from the');
    console.log('block deadline vs from being caught. CAVEAT: bots don\'t evade → monster speed is a');
    console.log('starting point; the SIZE column is the bot-robust part. Re-run with real cadence.\n');
}

if (require.main === module) main();
module.exports = { measure, solve, pacingScale };
