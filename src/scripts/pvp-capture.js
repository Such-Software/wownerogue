#!/usr/bin/env node
'use strict';

/**
 * Deterministic, free-only PvP capture harness.
 *
 * This is deliberately a separate loopback-only process. It does not import the application,
 * database, queues, wallet, or payment services, and it cannot attach to an existing deployment.
 * The real MatchRoom/MatchEngine and browser render kit are reused so captures exercise the same
 * multiplayer simulation and visuals without creating any financial state.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');
const { io: createSocketClient } = require('socket.io-client');

const MatchRoom = require('../multiplayer/MatchRoom');
const MatchEngine = require('../multiplayer/MatchEngine');
const { defineRuleset, resolveMatchRuleset } = require('../game/rulesets');

const LOOPBACK_HOST = '127.0.0.1';
const SAFETY_CONFIRMATION = '--confirm-local-free-only';
// Curated deterministic seed: with the default four bots, bot-1 takes the treasure route and
// escapes on tick 44. That produces a concise beginning/middle/win arc for a short promo clip.
const DEFAULT_SEED = 'beb270f3806a97e9ef73c8f83a6eae19a92f90ab38af9ad8b365cb74c41b2702';
const CAPTURE_RULESET_IDS = Object.freeze(['race', 'last-alive', 'score-attack', 'coop-escape']);
// MatchRoom's difficulty stack intentionally accepts operator overrides. A marketing replay must
// not: otherwise the same seed could silently produce different maps, monsters, or treasure when
// invoked from two shells. Refuse every gameplay-affecting inherited override instead of trying
// to guess which production profile the caller intended.
const CAPTURE_STATE_ENV_KEYS = Object.freeze([
    'CRYPTO_TYPE',
    'DIFFICULTY_PRESET',
    'GAME_MODE',
    'NETWORK_TUNING_DISABLED',
    'DUNGEON_WIDTH',
    'DUNGEON_HEIGHT',
    'DUNGEON_DUG_PERCENTAGE',
    'DUNGEON_ROOM_WIDTH_MIN',
    'DUNGEON_ROOM_WIDTH_MAX',
    'DUNGEON_ROOM_HEIGHT_MIN',
    'DUNGEON_ROOM_HEIGHT_MAX',
    'DUNGEON_CORRIDOR_MIN',
    'DUNGEON_CORRIDOR_MAX',
    'DUNGEON_LEVELS',
    'MONSTER_SPEED',
    'MONSTER_CHASE',
    'MONSTER_VISION',
    'MONSTER_DISTANCE',
    'TREASURE_ROOM_POSITION',
    'TREASURE_EXIT_DISTANCE'
]);
const BOT_NAMES = ['Rook', 'Nyx', 'Moss', 'Ember', 'Rune', 'Vale', 'Kite', 'Ash'];
const BOT_AVATARS = [
    'char-ranger', 'char-rogue', 'char-barbarian', 'char-wizard',
    'char-monk', 'char-bard', 'char-villager', 'char-goblin'
];
const DIRECTIONS = Object.freeze([
    Object.freeze({ dx: 1, dy: 0 }),
    Object.freeze({ dx: 0, dy: 1 }),
    Object.freeze({ dx: -1, dy: 0 }),
    Object.freeze({ dx: 0, dy: -1 })
]);
const HTML_ROOT = path.resolve(__dirname, '../../html');

function helpText() {
    return `Wowngeon deterministic PvP ad-video harness

Usage:
  NODE_ENV=development node scripts/pvp-capture.js ${SAFETY_CONFIRMATION} [options]

Safety:
  Runs a separate server bound only to 127.0.0.1, creates only an in-memory FREE match,
  and refuses production or any environment with payment, wallet, payout, or crypto switches.
  It never connects to a deployed app, database, daemon, wallet, or payment provider.

Options:
  --help                    Show this help without starting anything
  ${SAFETY_CONFIRMATION}  Required explicit safety acknowledgement
  --seed HEX64              Deterministic 64-character hex seed
  --players N               Bot count, 2-8 (default: 4)
  --ticks N                 Hard capture limit, 1-2000 (default: 180)
  --tick-ms N               Real-time frame step, 50-1000 (default: 180)
  --ruleset ID              race, last-alive, score-attack, or coop-escape (default: race)
  --mode MODE               tiles, ascii, or iso (default: tiles)
  --focus BOT_ID            Follow-camera anchor player (default: bot-1)
  --camera MODE             action or focus (default: action)
  --viewport WIDTHxHEIGHT   Video viewport (default: 1280x720)
  --output FILE.webm        Video destination (default: /tmp/wowngeon-pvp-capture.webm)
  --trace FILE.json         Deterministic input/state trace destination
  --screenshot FILE.png     Optional final-frame screenshot
  --headed                  Show the capture browser while recording
  --no-video                Run deterministic Socket.IO bot control and write only the trace

Examples:
  NODE_ENV=development npm run capture:pvp -- ${SAFETY_CONFIRMATION}
  NODE_ENV=test node scripts/pvp-capture.js ${SAFETY_CONFIRMATION} --ruleset last-alive --no-video --ticks 80
`;
}

function needValue(argv, index, flag) {
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
}

function parseViewport(value) {
    const match = /^(\d{3,4})x(\d{3,4})$/i.exec(String(value || ''));
    if (!match) throw new Error('--viewport must look like 1280x720');
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 640 || width > 3840 || height < 360 || height > 2160) {
        throw new Error('--viewport must be between 640x360 and 3840x2160');
    }
    return { width, height };
}

function parseArgs(argv = []) {
    const options = {
        confirmed: false,
        help: false,
        seed: DEFAULT_SEED,
        players: 4,
        ticks: 180,
        tickMs: 180,
        ruleset: 'race',
        mode: 'tiles',
        focus: 'bot-1',
        camera: 'action',
        viewport: { width: 1280, height: 720 },
        output: path.join(os.tmpdir(), 'wowngeon-pvp-capture.webm'),
        trace: null,
        screenshot: null,
        headed: false,
        noVideo: false
    };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') options.help = true;
        else if (flag === SAFETY_CONFIRMATION) options.confirmed = true;
        else if (flag === '--headed') options.headed = true;
        else if (flag === '--no-video') options.noVideo = true;
        else if (flag === '--seed') options.seed = needValue(argv, i++, flag).toLowerCase();
        else if (flag === '--players') options.players = Number(needValue(argv, i++, flag));
        else if (flag === '--ticks') options.ticks = Number(needValue(argv, i++, flag));
        else if (flag === '--tick-ms') options.tickMs = Number(needValue(argv, i++, flag));
        else if (flag === '--ruleset') options.ruleset = needValue(argv, i++, flag).toLowerCase();
        else if (flag === '--mode') options.mode = needValue(argv, i++, flag).toLowerCase();
        else if (flag === '--focus') options.focus = needValue(argv, i++, flag);
        else if (flag === '--camera') options.camera = needValue(argv, i++, flag).toLowerCase();
        else if (flag === '--viewport') options.viewport = parseViewport(needValue(argv, i++, flag));
        else if (flag === '--output') options.output = path.resolve(needValue(argv, i++, flag));
        else if (flag === '--trace') options.trace = path.resolve(needValue(argv, i++, flag));
        else if (flag === '--screenshot') options.screenshot = path.resolve(needValue(argv, i++, flag));
        else throw new Error(`Unknown option: ${flag}`);
    }

    options.trace = options.trace || options.output.replace(/\.webm$/i, '') + '.json';
    return options;
}

function validateOptions(options) {
    if (!/^[0-9a-f]{64}$/i.test(String(options.seed || ''))) {
        throw new Error('--seed must be exactly 64 hexadecimal characters');
    }
    for (const [key, min, max] of [['players', 2, 8], ['ticks', 1, 2000], ['tickMs', 50, 1000]]) {
        if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) {
            throw new Error(`--${key === 'tickMs' ? 'tick-ms' : key} must be an integer from ${min} through ${max}`);
        }
    }
    if (!['tiles', 'ascii', 'iso'].includes(options.mode)) {
        throw new Error('--mode must be tiles, ascii, or iso; network-loaded renderers are forbidden');
    }
    if (!CAPTURE_RULESET_IDS.includes(options.ruleset)) {
        throw new Error(`--ruleset must be one of: ${CAPTURE_RULESET_IDS.join(', ')}`);
    }
    const ruleset = resolveMatchRuleset(options.ruleset);
    const minimumPlayers = Math.max(2, ruleset.players.min);
    if (options.players < minimumPlayers || options.players > ruleset.players.max) {
        throw new Error(`--players must satisfy ${options.ruleset}'s ${minimumPlayers}-${ruleset.players.max} player limit`);
    }
    if (!['action', 'focus'].includes(options.camera)) {
        throw new Error('--camera must be action or focus');
    }
    if (!/^bot-[1-8]$/.test(options.focus) || Number(options.focus.slice(4)) > options.players) {
        throw new Error('--focus must identify one of the configured bots (for example bot-1)');
    }
    if (!options.noVideo && !/\.webm$/i.test(options.output)) {
        throw new Error('--output must end in .webm');
    }
    if (!/\.json$/i.test(options.trace)) throw new Error('--trace must end in .json');
    if (options.screenshot && !/\.png$/i.test(options.screenshot)) {
        throw new Error('--screenshot must end in .png');
    }
    return options;
}

function enabled(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function assertCaptureStateEnvironment(env = process.env) {
    const configured = CAPTURE_STATE_ENV_KEYS.filter(key => String(env?.[key] || '').trim());
    if (configured.length) {
        throw new Error(
            `PvP capture refuses inherited gameplay tuning: ${configured.join(', ')}`
        );
    }
    return true;
}

function assertCaptureSafety(env, options) {
    if (!options.confirmed) {
        throw new Error(`Refusing to start without ${SAFETY_CONFIRMATION}`);
    }
    const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
    if (!['development', 'test'].includes(nodeEnv)) {
        throw new Error('PvP capture is allowed only with NODE_ENV=development or NODE_ENV=test');
    }
    const dangerous = [
        'PAYMENTS_ENABLED', 'DIRECT_PAYMENT_ENABLED', 'CREDITS_ENABLED',
        'PAYOUTS_ENABLED', 'DIRECT_PAYOUTS_ENABLED', 'CREDITS_PAYOUTS_ENABLED', 'CREDITS_PAYOUT_ENABLED',
        'MATCH_PAYOUTS_ENABLED', 'MATCH_CRYPTO_RACE_ENABLED', 'ALLOW_MAINNET_PAYOUTS'
    ].filter(key => enabled(env[key]));
    if (dangerous.length) {
        throw new Error(`PvP capture refuses money-enabled environments: ${dangerous.join(', ')}`);
    }
    const walletConfiguration = [
        'PRIMARY_WALLET_ENDPOINT', 'WALLET_RPC_URL', 'MONERO_WALLET_RPC_URL', 'WOW_WALLET_RPC_URL'
    ].filter(key => String(env[key] || '').trim());
    if (walletConfiguration.length) {
        throw new Error(`PvP capture refuses wallet-configured environments: ${walletConfiguration.join(', ')}`);
    }
    assertCaptureStateEnvironment(env);
    return true;
}

function captureRuleset(rulesetId = 'race') {
    if (!CAPTURE_RULESET_IDS.includes(rulesetId)) {
        throw new Error(`Unsupported capture ruleset: ${rulesetId}`);
    }
    const base = resolveMatchRuleset(rulesetId);
    return defineRuleset({
        ...base,
        economy: { ...base.economy, model: 'free', houseFeePercent: 0 },
        metadata: {
            ...base.metadata,
            captureFreeOnly: true
        }
    });
}

function capturePresentation(rulesetOrId = 'race') {
    const id = typeof rulesetOrId === 'string' ? rulesetOrId : rulesetOrId?.id;
    const presentations = {
        race: {
            id: 'race', title: 'ESCAPE RACE', eyebrow: 'LIVE DUNGEON SPORT',
            participantNoun: 'RACERS', activeNoun: 'RACING', action: 'RACING TO THE EXIT', rosterAction: 'RACING',
            footer: 'DETERMINISTIC SERVER-AUTHORITATIVE RACE'
        },
        'last-alive': {
            id: 'last-alive', title: 'LAST ALIVE', eyebrow: 'LIVE DUNGEON COMBAT',
            participantNoun: 'RIVALS', activeNoun: 'STANDING', action: 'HUNTING RIVALS', rosterAction: 'HUNTING',
            footer: 'DETERMINISTIC SERVER-AUTHORITATIVE COMBAT'
        },
        'score-attack': {
            id: 'score-attack', title: 'SCORE ATTACK', eyebrow: 'LIVE DUNGEON CHALLENGE',
            participantNoun: 'CHALLENGERS', activeNoun: 'ACTIVE', action: 'BUILDING SCORE', rosterAction: 'SCORING',
            footer: 'DETERMINISTIC SERVER-AUTHORITATIVE SCORE ATTACK'
        },
        'coop-escape': {
            id: 'coop-escape', title: 'CO-OP ESCAPE', eyebrow: 'LIVE TEAM DUNGEON',
            participantNoun: 'HEROES', activeNoun: 'IN DUNGEON', action: 'ESCAPING TOGETHER', rosterAction: 'ESCAPING',
            footer: 'DETERMINISTIC SERVER-AUTHORITATIVE CO-OP'
        }
    };
    return presentations[id] || presentations.race;
}

function captureEntrants(playerCount) {
    const entrants = {};
    for (let index = 0; index < playerCount; index++) {
        const id = `bot-${index + 1}`;
        entrants[id] = {
            userId: index + 1,
            name: BOT_NAMES[index],
            avatar: BOT_AVATARS[index],
            appearance: { avatar: BOT_AVATARS[index] }
        };
    }
    return entrants;
}

function createCaptureRoom(options) {
    // Protect direct library callers too; runCapture validates its supplied environment, while
    // the engine itself reads process.env dynamically.
    assertCaptureStateEnvironment(process.env);
    const room = new MatchRoom({
        id: `capture-${options.seed.slice(0, 16)}`,
        economy: 'free',
        ruleset: captureRuleset(options.ruleset),
        maxPlayers: options.players,
        entrants: captureEntrants(options.players),
        seed: options.seed,
        startBlockHeight: 1,
        cryptoType: 'WOW',
        entryFeeAtomic: 0,
        potAtomic: 0,
        houseFeeAtomic: 0,
        houseFeePercent: 0
    });
    assertFreeRoom(room);
    return room;
}

function assertFreeRoom(room) {
    if (!room || room.economy !== 'free') throw new Error('Capture invariant failed: room is not free');
    if (room.ruleset?.economy?.model !== 'free') {
        throw new Error('Capture invariant failed: ruleset economy is not free');
    }
    for (const field of ['entryFeeAtomic', 'potAtomic', 'houseFeeAtomic', 'houseFeePercent']) {
        if (Number(room[field] || 0) !== 0) {
            throw new Error(`Capture invariant failed: ${field} is non-zero`);
        }
    }
    return true;
}

function pointKey(x, y) {
    return `${x},${y}`;
}

function orderedDirections(botIndex) {
    const start = botIndex % DIRECTIONS.length;
    return DIRECTIONS.slice(start).concat(DIRECTIONS.slice(0, start));
}

function firstPathStep(grid, start, target, { botIndex = 0, blocked = new Set() } = {}) {
    if (!start || !target || !Array.isArray(grid) || !grid.length) return null;
    if (start.x === target.x && start.y === target.y) return null;
    const queue = [start];
    const seen = new Set([pointKey(start.x, start.y)]);
    const previous = new Map();
    const directions = orderedDirections(botIndex);
    let found = false;

    while (queue.length && !found) {
        const current = queue.shift();
        for (const direction of directions) {
            const next = { x: current.x + direction.dx, y: current.y + direction.dy };
            const key = pointKey(next.x, next.y);
            if (seen.has(key)) continue;
            const tile = grid[next.y] && grid[next.y][next.x];
            const passable = tile === "'1" || tile === "'2" || tile === '>' || tile === '$M' || tile === 0;
            if (!passable) continue;
            if (blocked.has(key) && !(next.x === target.x && next.y === target.y)) continue;
            seen.add(key);
            previous.set(key, current);
            if (next.x === target.x && next.y === target.y) {
                found = true;
                break;
            }
            queue.push(next);
        }
    }

    if (!found) return null;
    let cursor = target;
    let parent = previous.get(pointKey(cursor.x, cursor.y));
    while (parent && !(parent.x === start.x && parent.y === start.y)) {
        cursor = parent;
        parent = previous.get(pointKey(cursor.x, cursor.y));
    }
    return { dx: Math.sign(cursor.x - start.x), dy: Math.sign(cursor.y - start.y) };
}

function planBotMove(botId, state) {
    const players = Array.isArray(state?.players) ? state.players : [];
    const self = players.find(player => player && player.id === botId);
    if (!self || self.alive === false || self.finished) return { dx: 0, dy: 0 };
    const botIndex = Math.max(0, Number(botId.slice(4)) - 1);
    const tick = Number(state.tick) || 0;
    const rulesetId = state?.ruleset?.id || 'race';

    // Bots move at distinct cadences. Besides keeping a crowded field readable on video, this
    // prevents deterministic head-on PvP swaps from leaving two adjacent rivals bouncing forever.
    if (botIndex > 0 && tick % (botIndex + 3) !== 0) return { dx: 0, dy: 0 };

    let target = null;
    let targetPlayerId = null;
    if (rulesetId === 'last-alive') {
        const rivals = players.filter(player => player && player.id !== botId &&
            player.alive !== false && !player.finished);
        rivals.sort((a, b) => {
            const aDistance = Math.abs(a.x - self.x) + Math.abs(a.y - self.y);
            const bDistance = Math.abs(b.x - self.x) + Math.abs(b.y - self.y);
            return aDistance - bDistance || a.id.localeCompare(b.id);
        });
        if (rivals[0]) {
            targetPlayerId = rivals[0].id;
            target = { x: rivals[0].x, y: rivals[0].y };
        }
    } else {
        // Race and score-attack give the lead bot a cinematic treasure route. Co-op sends every
        // hero directly toward extraction so the footage tells a clear team objective story.
        const treasure = state.treasure;
        if (rulesetId !== 'coop-escape' && botIndex === 0 && treasure &&
            treasure.carrierId == null && !self.hasTreasure) {
            target = { x: treasure.x, y: treasure.y };
        }
        if (!target && Array.isArray(state.exit)) target = { x: state.exit[0], y: state.exit[1] };
    }
    if (!target) return { dx: 0, dy: 0 };

    const blocked = new Set();
    for (const player of players) {
        if (!player || player.id === botId || player.alive === false || player.finished) continue;
        if (player.id === targetPlayerId) continue;
        blocked.add(pointKey(player.x, player.y));
    }
    if (state.monster) blocked.add(pointKey(state.monster.x, state.monster.y));

    const start = { x: self.x, y: self.y };
    return firstPathStep(state.visibleTiles, start, target, { botIndex, blocked })
        || firstPathStep(state.visibleTiles, start, target, { botIndex, blocked: new Set() })
        || { dx: 0, dy: 0 };
}

function captureStateHash(state) {
    return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function capturePlayerSnapshot(room) {
    return room.toGameState().players.map(player => {
        const authoritative = room.playerStates.get(player.id) || {};
        return {
            ...player,
            score: Number(authoritative.score) || 0,
            moves: Number(authoritative.moves) || 0,
            killedBy: authoritative.killedBy || null
        };
    });
}

function captureResultSummary(room, players = capturePlayerSnapshot(room)) {
    const winner = players.find(player => player.id === room.winnerId) || null;
    const winnerName = String(winner?.name || winner?.id || 'NO ONE').toUpperCase();
    const ticks = Number(room.tickCount) || 0;
    const detail = `FREE EXHIBITION • ${ticks} TICK${ticks === 1 ? '' : 'S'}`;

    switch (room.ruleset?.id) {
    case 'last-alive': {
        const standing = players.filter(player => player.alive !== false && !player.finished);
        const decisive = winner && standing.length === 1 && standing[0].id === winner.id;
        const allOut = standing.length === 0;
        return {
            headline: decisive ? `${winnerName} IS LAST ALIVE`
                : (winner ? (allOut ? `${winnerName} SURVIVED LONGEST` : `${winnerName} LEADS AT THE BELL`)
                    : 'NO ONE LEFT STANDING'),
            detail,
            cooperative: false,
            winnerStatus: decisive ? 'WINNER' : (winner ? (allOut ? 'LAST OUT' : 'LEADER') : null)
        };
    }
    case 'score-attack':
        return {
            headline: winner ? `${winnerName} TOPS THE BOARD` : 'SCORE ATTACK COMPLETE',
            detail: winner ? `${Number(winner.score) || 0} POINTS • ${detail}` : detail,
            cooperative: false,
            winnerStatus: winner ? 'TOP SCORE' : null
        };
    case 'coop-escape': {
        const escaped = players.filter(player => player.escaped).length;
        const complete = escaped === players.length && players.length > 0;
        return {
            headline: complete ? 'TEAM ESCAPED TOGETHER' : `${escaped} OF ${players.length} ESCAPED`,
            detail,
            cooperative: true,
            winnerStatus: null
        };
    }
    default: {
        const decisive = room.endReason === 'escaped';
        return {
            headline: winner ? (decisive ? `${winnerName} WINS THE RACE` : `${winnerName} LEADS AT THE BELL`)
                : 'THE DUNGEON WINS',
            detail,
            cooperative: false,
            winnerStatus: winner ? (decisive ? 'WINNER' : 'LEADER') : null
        };
    }
    }
}

function mimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ({
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.json': 'application/json; charset=utf-8',
        '.ttf': 'font/ttf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2'
    })[ext] || 'application/octet-stream';
}

function capturePageHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wownerogue — Deterministic PvP Capture</title>
<style>
@font-face{font-family:PixelOperator;src:url('/styles/fonts/pixel-operator/PixelOperator.ttf') format('truetype');font-display:swap}
@font-face{font-family:PixelOperator;src:url('/styles/fonts/pixel-operator/PixelOperator-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
:root{--green:#62e875;--gold:#f4c45d;--ink:#07090c;--panel:#10151b;--muted:#8d99a8}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#05070a;color:#eef3f7;font-family:PixelOperator,ui-monospace,monospace}
body{background:radial-gradient(circle at 50% -20%,rgba(52,123,70,.32),transparent 46%),linear-gradient(#0b0e12,#05070a 62%)}
#frame{height:100%;display:grid;grid-template-rows:82px 1fr 52px;padding:18px 26px 16px;gap:10px}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:20px}
.eyebrow{color:var(--green);font-size:12px;letter-spacing:.22em}.title{font-size:31px;font-weight:700;letter-spacing:.035em}.title b{color:var(--green)}
#hud{display:flex;gap:7px;align-items:center}#hud span,.badge{border:1px solid #34404d;background:rgba(16,21,27,.9);border-radius:5px;padding:7px 10px;font-size:12px}
.badge{color:#b8f8c2;border-color:#397348}.gold{color:var(--gold)!important}
#stage{position:relative;min-height:0;overflow:hidden;background:#000;border:1px solid #35404c;border-radius:10px;box-shadow:0 24px 80px #000,inset 0 0 70px rgba(0,0,0,.65)}
#stage:after{content:"";position:absolute;inset:0;pointer-events:none;z-index:10;box-shadow:inset 0 0 80px rgba(0,0,0,.58)}#stage canvas{display:block}
#status{color:#d4dbe3}#seed{color:var(--muted);font-size:12px}.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green);margin-right:7px}
#roster{position:absolute;z-index:20;right:12px;top:12px;width:184px;display:grid;gap:5px;pointer-events:none}
.roster-row{display:grid;grid-template-columns:7px 1fr auto;align-items:center;gap:7px;min-height:29px;padding:5px 7px;border:1px solid rgba(102,116,134,.58);border-radius:5px;background:rgba(7,10,14,.84);box-shadow:0 3px 14px rgba(0,0,0,.42);font-size:11px;letter-spacing:.04em}
.roster-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px rgba(98,232,117,.7)}.roster-name{overflow:hidden;text-overflow:ellipsis}.roster-state{color:#a9b5c3;font-size:9px;letter-spacing:.09em}.roster-row.out{opacity:.48}.roster-row.done .roster-dot{background:var(--gold);box-shadow:0 0 6px rgba(244,196,93,.7)}
#result{position:absolute;z-index:30;left:50%;top:50%;transform:translate(-50%,-50%);min-width:360px;max-width:82%;padding:22px;text-align:center;border:1px solid var(--gold);border-radius:9px;background:rgba(7,9,12,.94);box-shadow:0 22px 80px #000;opacity:0;transition:opacity .35s}#result.show{opacity:1}
#result-headline{font-size:25px;color:var(--gold);letter-spacing:.04em}#result-detail{margin-top:7px;color:#cbd5df;font-size:13px;letter-spacing:.07em}
@media(max-aspect-ratio:3/4){#frame{grid-template-rows:110px 1fr 70px;padding:24px 18px 22px}.title{font-size:28px}header{align-items:flex-start;flex-direction:column;gap:7px}#hud{width:100%;justify-content:space-between}#roster{width:160px;right:9px;top:9px}.roster-row{min-height:27px;padding:4px 6px}footer{align-items:flex-start;flex-direction:column;justify-content:center;gap:5px}#result{min-width:310px}}
</style>
<script src="/js/render/sceneModel.js"></script><script src="/js/render/fxLayer.js"></script>
<script src="/js/render/skins.js"></script><script src="/js/render/charCustomize.js"></script>
<script src="/js/render/atlas.js"></script><script src="/js/render/charSprites.js"></script>
<script src="/js/render/zoomControl.js"></script><script src="/js/render/packRegistry.js"></script>
<script src="/js/render/assetPacks.js"></script><script src="/js/render/avatarVisuals.js"></script>
<script src="/js/render/asciiRenderer.js"></script><script src="/js/render/tileRenderer.js"></script>
<script src="/js/render/isoRenderer.js"></script><script>window.WOWNGEON_RUNTIME={rendererCdnEnabled:false};</script>
<script src="/js/render/renderModes.js"></script>
</head>
<body><main id="frame"><header><div><div class="eyebrow" id="eyebrow">LIVE DUNGEON SPORT</div><div class="title">WOWNERO<b>GUE</b> <span id="mode-title">PVP</span></div></div><div id="hud"><span class="badge">FREE EXHIBITION</span><span id="tick">TICK 000</span><span id="participants" class="gold">CONNECTING</span></div></header>
<section id="stage" aria-label="Deterministic multiplayer capture"><div id="roster" aria-label="Player status"></div><div id="result"><div id="result-headline"></div><div id="result-detail"></div></div></section>
<footer><div id="status"><i class="live"></i><span id="status-copy">DETERMINISTIC SERVER-AUTHORITATIVE PVP</span></div><div id="seed"></div></footer></main>
<script src="/socket.io/socket.io.js"></script>
<script>
(function(){'use strict';
var query=new URLSearchParams(location.search),token=query.get('token'),mode=query.get('mode')||'tiles',focus=query.get('focus')||'bot-1',cameraMode=query.get('camera')||'action';
var stage=document.getElementById('stage'),RK=window.RK||{};RK.entitlements={premium:true,level:'capture',packs:{}};RK.RENDER_MODE_TEST_UNLOCKS=true;
// A landscape dungeon letterboxes badly inside a 9:16 ad. Use a tighter follow shot in portrait
// while retaining the wider tactical composition for landscape captures.
var portrait=stage.clientHeight>stage.clientWidth*1.15;
var renderer=RK.createRenderer(mode,stage,{cell:30}),camera=RK.attachCamera(stage,{zoom:portrait?2.75:1.55,min:.6,max:portrait?4.5:2.8,controls:false}),presentation=null,actionFocus=null,actionFocusUntil=-1,finalWinnerId=null,finalWinnerStatus='WINNER';
var socket=io({auth:{role:'spectator',token:token},transports:['websocket'],reconnection:false});
function byId(id){return document.getElementById(id);}
function applyPresentation(next){
 if(!next)return;presentation=next;byId('eyebrow').textContent=next.eyebrow;byId('mode-title').textContent=next.title;
 byId('status-copy').textContent=next.footer;document.title='Wownerogue — '+next.title+' Capture';
}
function playerState(player){
 if(finalWinnerId&&player.id===finalWinnerId)return finalWinnerStatus;
 if(player.alive===false)return 'OUT';
 if(player.finished||player.escaped)return presentation&&presentation.id==='last-alive'?'SAFE':(presentation&&presentation.id==='score-attack'?'BANKED':'ESCAPED');
 if(player.hasTreasure)return 'TREASURE';
 return presentation?(presentation.rosterAction||presentation.action):'ACTIVE';
}
function renderRoster(players){
 var roster=byId('roster');while(roster.firstChild)roster.removeChild(roster.firstChild);
 (players||[]).forEach(function(player){
  var row=document.createElement('div'),dot=document.createElement('i'),name=document.createElement('span'),state=document.createElement('span');
  row.className='roster-row'+(player.alive===false?' out':((player.finished||player.escaped)?' done':''));dot.className='roster-dot';name.className='roster-name';state.className='roster-state';
  name.textContent=String(player.name||player.id||'PLAYER').toUpperCase();state.textContent=playerState(player);row.appendChild(dot);row.appendChild(name);row.appendChild(state);roster.appendChild(row);
 });
}
function actionActor(events,tick){
 if(cameraMode!=='action')return;
 for(var i=(events||[]).length-1;i>=0;i--){var event=events[i]||{};
  if(event.type==='player_death'||event.type==='treasure_pickup'||event.type==='player_exit'){
   actionFocus=(event.killedBy&&String(event.killedBy).indexOf('bot-')===0)?event.killedBy:event.id;actionFocusUntil=tick+5;return;
  }
 }
}
function chooseFocus(state){
 var players=state.players||[],active=players.filter(function(player){return player.alive!==false&&!player.finished;});
 if(actionFocus&&Number(state.tick)<=actionFocusUntil&&players.some(function(player){return player.id===actionFocus;}))return actionFocus;
 if(active.some(function(player){return player.id===focus;}))return focus;
 return active[0]?active[0].id:focus;
}
function cameraZoom(state,focusId){
 var players=(state.players||[]).filter(function(player){return player.alive!==false&&!player.finished;}),chosen=players.find(function(player){return player.id===focusId;});
 var close=portrait?3.05:1.9,wide=portrait?2.15:1.18;if(!chosen||players.length<2)return close;
 var spread=0;players.forEach(function(player){spread=Math.max(spread,Math.abs(player.x-chosen.x)+Math.abs(player.y-chosen.y));});
 if(spread<=6)return close;if(spread>=18)return wide;return close-(close-wide)*((spread-6)/12);
}
socket.on('connect',function(){socket.emit('capture_spectate');});
socket.on('capture_state',function(payload){
 var state=payload&&payload.state;if(!state)return;applyPresentation(payload.presentation||state.ruleset);actionActor(payload.events,state.tick||0);var cameraFocus=chooseFocus(state),scene=RK.sceneFromGameState(state,{focusPlayerId:cameraFocus,cryptoType:'WOW'});
 // The fixed screen-space roster is the capture label layer. Suppress world-space name text so a
 // melee pile-up stays readable instead of drawing six names on the same dungeon cell.
 (scene.entities||[]).forEach(function(entity){if(entity.kind==='player')entity.label=null;});
 renderer.render(scene);camera.setZoom(cameraZoom(state,cameraFocus));camera.update(renderer);byId('tick').textContent='TICK '+String(state.tick||0).padStart(3,'0');
 var active=(state.players||[]).filter(function(p){return p.alive!==false&&!p.finished;}).length;byId('participants').textContent=active+' '+(presentation?presentation.activeNoun:'ACTIVE');
 byId('seed').textContent='SEED '+String(payload.seedHash||'').slice(0,16).toUpperCase();renderRoster(state.players||[]);
 window.__PVP_CAPTURE_LAST_STATE__=state;
});
socket.on('capture_ready',function(){window.__PVP_CAPTURE_READY__=true;});
socket.on('capture_end',function(payload){applyPresentation(payload.presentation);var outcome=payload.outcome||{};finalWinnerId=payload.winnerId||null;finalWinnerStatus=outcome.winnerStatus||'WINNER';renderRoster(payload.players||[]);byId('result-headline').textContent=outcome.headline||'MATCH COMPLETE';byId('result-detail').textContent=outcome.detail||'FREE EXHIBITION';byId('result').classList.add('show');window.__PVP_CAPTURE_DONE__=true;});
socket.on('connect_error',function(error){window.__PVP_CAPTURE_ERROR__=error&&error.message;});
}());
</script></body></html>`;
}

function safeStaticPath(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch (_) { return null; }
    const relative = decoded.replace(/^\/+/, '');
    const resolved = path.resolve(HTML_ROOT, relative);
    if (resolved !== HTML_ROOT && !resolved.startsWith(`${HTML_ROOT}${path.sep}`)) return null;
    return resolved;
}

async function createCaptureServer(room, token) {
    const bots = new Map();
    const server = http.createServer((req, res) => {
        const host = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
            res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Loopback host required');
            return;
        }
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (pathname === '/' || pathname === '/capture') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            res.end(capturePageHtml());
            return;
        }
        if (pathname === '/runtime-config.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('window.WOWNGEON_RUNTIME={rendererCdnEnabled:false};');
            return;
        }
        const filename = safeStaticPath(pathname);
        if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeType(filename), 'Cache-Control': 'no-store' });
        fs.createReadStream(filename).pipe(res);
    });
    const io = new SocketIOServer(server, { serveClient: true, transports: ['websocket'] });

    io.use((socket, next) => {
        const auth = socket.handshake.auth || {};
        if (auth.token !== token) return next(new Error('capture authentication failed'));
        if (auth.role === 'spectator') return next();
        if (auth.role === 'bot' && room.occupants.has(auth.botId)) return next();
        return next(new Error('invalid capture role'));
    });
    io.on('connection', socket => {
        const auth = socket.handshake.auth || {};
        if (auth.role === 'bot') {
            bots.set(auth.botId, socket);
            socket.on('disconnect', () => {
                if (bots.get(auth.botId) === socket) bots.delete(auth.botId);
            });
        } else {
            socket.join('capture-spectators');
            socket.on('capture_spectate', () => {
                socket.emit('capture_state', {
                    state: room.toGameState(),
                    seedHash: room.seedHash,
                    presentation: capturePresentation(room.ruleset)
                });
                socket.emit('capture_ready');
            });
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, resolve);
    });
    const address = server.address();
    return {
        server,
        io,
        bots,
        port: address.port,
        url: `http://${LOOPBACK_HOST}:${address.port}`,
        close: async () => {
            await new Promise(resolve => io.close(resolve));
            if (server.listening) await new Promise(resolve => server.close(resolve));
        }
    };
}

function connectBot(baseUrl, token, botId) {
    const socket = createSocketClient(baseUrl, {
        auth: { role: 'bot', botId, token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true
    });
    socket.on('capture_input_request', payload => {
        const move = planBotMove(botId, payload.state);
        socket.emit('capture_input', { tick: payload.tick, dx: move.dx, dy: move.dy });
    });
    return socket;
}

function waitForSocket(socket, timeoutMs = 5000) {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket.IO connection timed out')), timeoutMs);
        socket.once('connect', () => { clearTimeout(timeout); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timeout); reject(error); });
    });
}

function requestBotInput(socket, tick, state, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('capture_input', onInput);
            reject(new Error(`Bot ${socket.handshake?.auth?.botId || socket.id} missed tick ${tick}`));
        }, timeoutMs);
        function onInput(payload) {
            if (!payload || payload.tick !== tick) return;
            clearTimeout(timeout);
            socket.off('capture_input', onInput);
            const dx = Math.sign(Number(payload.dx) || 0);
            const dy = Math.sign(Number(payload.dy) || 0);
            if (Math.abs(dx) + Math.abs(dy) > 1) return reject(new Error(`Invalid bot input at tick ${tick}`));
            resolve({ dx, dy });
        }
        socket.on('capture_input', onInput);
        socket.emit('capture_input_request', { tick, state });
    });
}

async function launchRecorder(serverUrl, token, options) {
    let playwright;
    try { playwright = require('playwright-core'); }
    catch (_) {
        throw new Error('playwright-core is not installed; use --no-video for the control/trace harness');
    }
    const executable = playwright.chromium.executablePath();
    if (!executable || !fs.existsSync(executable)) {
        throw new Error('The installed Playwright Chromium executable is missing; use --no-video (no downloads are attempted)');
    }
    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowngeon-pvp-video-'));
    let browser = null;
    let context = null;
    try {
        browser = await playwright.chromium.launch({ headless: !options.headed });
        context = await browser.newContext({
            viewport: options.viewport,
            recordVideo: { dir: videoDir, size: options.viewport }
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error));
        const captureUrl = `${serverUrl}/capture?token=${encodeURIComponent(token)}` +
            `&mode=${encodeURIComponent(options.mode)}&focus=${encodeURIComponent(options.focus)}` +
            `&camera=${encodeURIComponent(options.camera)}&ruleset=${encodeURIComponent(options.ruleset)}`;
        await page.goto(captureUrl, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__PVP_CAPTURE_READY__ === true || !!window.__PVP_CAPTURE_ERROR__, null, { timeout: 10000 });
        const captureError = await page.evaluate(() => window.__PVP_CAPTURE_ERROR__ || null);
        if (captureError) throw new Error(`Capture page failed: ${captureError}`);
        await page.waitForTimeout(600);

        const cleanup = () => {
            // videoDir is an exact directory created by mkdtemp above; never accept a caller path.
            fs.rmSync(videoDir, { recursive: true, force: true });
        };
        return {
            page,
            finish: async () => {
                if (options.screenshot) {
                    fs.mkdirSync(path.dirname(options.screenshot), { recursive: true });
                    await page.screenshot({ path: options.screenshot });
                }
                const video = page.video();
                await page.close();
                await context.close();
                fs.mkdirSync(path.dirname(options.output), { recursive: true });
                await video.saveAs(options.output);
                await browser.close();
                cleanup();
                if (pageErrors.length) throw pageErrors[0];
                return options.output;
            },
            abort: async () => {
                await context.close().catch(() => {});
                await browser.close().catch(() => {});
                cleanup();
            }
        };
    } catch (error) {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        fs.rmSync(videoDir, { recursive: true, force: true });
        throw error;
    }
}

function sleep(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function captureTraceHeader(room, presentation, options) {
    return {
        schemaVersion: 2,
        harness: 'wowngeon-pvp-capture',
        safety: { isolatedLoopback: true, economy: 'free', moneyServicesImported: false },
        determinism: {
            gameplayEnvironmentOverrides: 'refused',
            cryptoType: 'WOW',
            seedControlsAuthoritativeSimulation: true
        },
        seed: room.seed,
        seedHash: room.seedHash,
        roomId: room.id,
        ruleset: room._rulesetSummary(),
        presentation,
        players: Array.from(room.occupants.values()).map(occupant => ({
            id: occupant.id, name: occupant.name, avatar: occupant.avatar
        })),
        tickMs: options.tickMs,
        maxTicks: options.ticks,
        camera: {
            mode: options.camera,
            focus: options.focus,
            renderer: options.mode,
            viewport: { ...options.viewport }
        },
        ticks: []
    };
}

async function runCapture(options, env = process.env) {
    validateOptions(options);
    assertCaptureSafety(env, options);
    if (env !== process.env) assertCaptureStateEnvironment(process.env);
    const room = createCaptureRoom(options);
    const token = crypto.randomBytes(24).toString('hex');
    const captureServer = await createCaptureServer(room, token);
    const presentation = capturePresentation(room.ruleset);
    const botClients = [];
    let recorder = null;
    const trace = captureTraceHeader(room, presentation, options);

    try {
        for (const botId of room.occupants.keys()) {
            const client = connectBot(captureServer.url, token, botId);
            botClients.push(client);
        }
        await Promise.all(botClients.map(socket => waitForSocket(socket)));
        if (captureServer.bots.size !== options.players) throw new Error('Not every deterministic bot connected');

        if (!options.noVideo) recorder = await launchRecorder(captureServer.url, token, options);
        room.start();
        assertFreeRoom(room);
        captureServer.io.to('capture-spectators').emit('capture_state', {
            state: room.toGameState(), seedHash: room.seedHash, presentation, events: []
        });

        const engine = new MatchEngine({ room, tickMs: options.tickMs });
        for (let sequence = 1; sequence <= options.ticks && room.status === 'active'; sequence++) {
            const state = room.toGameState();
            const botIds = Array.from(room.occupants.keys());
            const moves = await Promise.all(botIds.map(botId => {
                const socket = captureServer.bots.get(botId);
                if (!socket) throw new Error(`Bot disconnected: ${botId}`);
                return requestBotInput(socket, sequence, state);
            }));
            const inputRecord = {};
            for (let index = 0; index < botIds.length; index++) {
                const botId = botIds[index];
                const move = moves[index];
                inputRecord[botId] = move;
                if (Math.abs(move.dx) + Math.abs(move.dy) === 1) room.queueMove(botId, move.dx, move.dy);
            }
            const result = engine.tick();
            const nextState = room.toGameState();
            trace.ticks.push({
                tick: result.tick,
                inputs: inputRecord,
                events: result.events,
                stateHash: captureStateHash(nextState)
            });
            captureServer.io.to('capture-spectators').emit('capture_state', {
                state: nextState, seedHash: room.seedHash, presentation, events: result.events
            });
            // High-score normally ends at its deadline. Once every entrant is dead or has banked
            // an exit there are no legal inputs left, so this isolated exhibition may resolve its
            // local deadline immediately instead of recording a long, motionless tail.
            if (room.status === 'active' && room.ruleset.id === 'score-attack' &&
                room.activePlayerCount === 0) {
                engine.expire('capture_resolved');
            }
            await sleep(options.noVideo ? 0 : options.tickMs);
        }

        if (room.status === 'active') {
            engine.expire('capture_limit');
        } else {
            room.finalize();
        }
        assertFreeRoom(room);
        const finalState = room.toGameState();
        const players = capturePlayerSnapshot(room);
        const outcome = captureResultSummary(room, players);
        trace.result = {
            status: room.status,
            reason: room.endReason,
            winnerId: room.winnerId,
            ticks: room.tickCount,
            finalStateHash: captureStateHash(finalState),
            outcome,
            players: players.map(player => ({
                id: player.id,
                placement: player.placement,
                score: player.score,
                moves: player.moves,
                escaped: player.escaped,
                hasTreasure: player.hasTreasure,
                alive: player.alive,
                killedBy: player.killedBy
            }))
        };
        captureServer.io.to('capture-spectators').emit('capture_state', {
            state: finalState, seedHash: room.seedHash, presentation, events: []
        });
        captureServer.io.to('capture-spectators').emit('capture_end', {
            winnerId: room.winnerId,
            players,
            presentation,
            outcome
        });
        await sleep(options.noVideo ? 0 : 1400);

        fs.mkdirSync(path.dirname(options.trace), { recursive: true });
        fs.writeFileSync(options.trace, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
        if (recorder) await recorder.finish();
        return { room, trace, output: options.noVideo ? null : options.output, tracePath: options.trace };
    } catch (error) {
        if (recorder) await recorder.abort();
        throw error;
    } finally {
        for (const socket of botClients) socket.close();
        await captureServer.close();
    }
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(helpText());
            return;
        }
        const result = await runCapture(options);
        process.stdout.write(`PvP capture complete: ruleset=${result.room.ruleset.id} winner=${result.room.winnerId || 'none'} ticks=${result.room.tickCount}\n`);
        if (result.output) process.stdout.write(`Video: ${result.output}\n`);
        process.stdout.write(`Trace: ${result.tracePath}\n`);
    } catch (error) {
        process.stderr.write(`PvP capture refused/failed: ${error.message}\n\n${helpText()}`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    CAPTURE_RULESET_IDS,
    CAPTURE_STATE_ENV_KEYS,
    DEFAULT_SEED,
    LOOPBACK_HOST,
    SAFETY_CONFIRMATION,
    assertCaptureStateEnvironment,
    assertCaptureSafety,
    assertFreeRoom,
    capturePageHtml,
    capturePlayerSnapshot,
    capturePresentation,
    captureResultSummary,
    captureRuleset,
    captureStateHash,
    captureTraceHeader,
    createCaptureRoom,
    firstPathStep,
    helpText,
    parseArgs,
    parseViewport,
    planBotMove,
    runCapture,
    validateOptions
};
