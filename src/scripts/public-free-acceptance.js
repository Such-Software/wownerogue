'use strict';

// A deliberately separate public acceptance lane. The local showcase harnesses retain their
// loopback, disposable database, and simulated-block guards. This script has one fixed target.
const https = require('node:https');
const { URL } = require('node:url');

const ORIGIN = 'https://play.wowne.ro';
const EXPECTED_COMMIT = '6fca51695b941f3ef495912cc77b73790b490888';
const EXPECTED_RELEASE = 'git-' + EXPECTED_COMMIT.slice(0, 12);
const ARM = '--run-public-free-acceptance';
const QUEUE_WAIT_MS = 12 * 60 * 1000;
const ROUND_WAIT_MS = 6 * 60 * 1000;
const CLEANUP_WAIT_MS = 60 * 1000;
const BROWSER_LAUNCH = Object.freeze({ headless: true, handleSIGINT: false, handleSIGTERM: false });

class Refusal extends Error {
    constructor(code) { super(code); this.code = code; }
}

function requireFact(ok, code) {
    if (!ok) throw new Refusal(code);
}

function armed(argv) {
    return argv.length === 1 && argv[0] === ARM;
}

function healthAllowed(status, value) {
    return status === 200 && value?.ready === true
        && value.release?.verified === true
        && value.release.id === EXPECTED_RELEASE
        && value.release.commit === EXPECTED_COMMIT
        && value.games?.mode === 'FREE'
        && value.money?.paymentsEnabled === false
        && value.money?.payoutsEnabled === false
        && value.checks?.database === 'up'
        && value.checks?.chain === 'up'
        && value.checks?.financialRecovery === 'reconciled'
        && value.checks?.wallet === 'not_required'
        && value.checks?.daemonIdentity === 'verified'
        && value.chain?.network === 'mainnet'
        && value.chain?.source === 'daemon'
        && Number.isSafeInteger(value.chain.height) && value.chain.height > 0;
}

function getHealth() {
    return new Promise((resolve, reject) => {
        const request = https.get(new URL('/health/ready', ORIGIN), { timeout: 10000 }, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                raw += chunk;
                if (raw.length > 32768) request.destroy(new Refusal('HEALTH_RESPONSE_TOO_LARGE'));
            });
            response.on('error', reject);
            response.on('aborted', () => reject(new Refusal('HEALTH_RESPONSE_ABORTED')));
            response.on('end', () => {
                try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); }
                catch (_) { reject(new Refusal('HEALTH_RESPONSE_INVALID')); }
            });
        });
        request.on('timeout', () => request.destroy(new Refusal('HEALTH_TIMEOUT')));
        request.on('error', reject);
    });
}

// Executed in each fresh browser context before page scripts. Keep only bounded facts and the
// two ephemeral owned socket IDs needed to reject a race containing another public player.
function browserObserver(expected) {
    const facts = {
        socket: null, ownedIds: null, policy: false, modeSeen: false, connected: false,
        unsafe: false,
        tavern: false, joinIntent: false, queue: null, left: false,
        joined: false, onlyOwned: false,
        countdown: false, matchId: null, started: false, ticks: 0, ended: false,
        ownStart: null, moved: false, settlementPending: false, ownResult: false,
        forfeitAck: false, matchError: false
    };
    window.__publicFreeAcceptance = facts;
    let factory = null;
    Object.defineProperty(window, 'io', {
        configurable: true,
        get() { return factory; },
        set(value) {
            factory = function (...args) {
                const socket = value.apply(this, args);
                facts.socket = socket;
                socket.on('connect', () => { facts.connected = true; });
                socket.on('disconnect', () => {
                    if (facts.connected) facts.unsafe = true;
                    facts.connected = false;
                });
                socket.on('game_mode_info', info => {
                    facts.modeSeen = true;
                    const match = info?.modes?.match;
                    const economies = match?.economies;
                    facts.policy = info?.release?.verified === true
                        && info.release.id === expected.release
                        && info.release.commit === expected.commit
                        && info.operatedProductProfileId === 'such-play-wow-prestige'
                        && info.mode === 'FREE' && info.freePlayEnabled === true
                        && info.cryptoType === 'WOW' && info.network === 'mainnet'
                        && info.isTestNetwork === false
                        && info.paymentsEnabled === false && info.payoutsEnabled === false
                        && info.directModeEnabled === false && info.creditsModeEnabled === false
                        && info.directPayoutsEnabled === false && info.creditsPayoutsEnabled === false
                        && info.features?.paymentRequired === false
                        && info.features?.creditsSystem === false && info.features?.payouts === false
                        && info.modes?.tavern === true && match?.enabled === true
                        && match.activeRuleset?.id === 'race'
                        && economies?.free === true
                        && economies.credits_prestige !== true && economies.crypto_race !== true
                        && Array.isArray(info.creditPackages) && info.creditPackages.length === 0
                        && Array.isArray(info.cosmeticProducts) && info.cosmeticProducts.length === 0;
                    if (!facts.policy) facts.unsafe = true;
                });
                socket.on('tavern_joined', data => {
                    facts.tavern = !!data && data.you === socket.id;
                });
                socket.on('match_queue_joined', data => {
                    facts.queue = {
                        success: data?.success === true,
                        free: data?.economy === 'free',
                        position: Number.isSafeInteger(data?.position) ? data.position : null
                    };
                });
                socket.on('match_queue_left', data => { facts.left = data?.success === true; });
                socket.on('match_joined', data => {
                    const priorJoined = facts.joined;
                    const priorOwned = facts.onlyOwned;
                    if (priorJoined && data?.matchId !== facts.matchId) facts.unsafe = true;
                    facts.joined = true;
                    if (!priorJoined) facts.matchId = data?.matchId || null;
                    const entrantsOwned = Array.isArray(data?.players)
                        && data.players.length === 2
                        && Array.isArray(facts.ownedIds) && facts.ownedIds.length === 2
                        && data.players.every(player => facts.ownedIds.includes(player?.id))
                        && data.economy === 'free' && data.ruleset?.id === 'race';
                    facts.onlyOwned = entrantsOwned && (!priorJoined || priorOwned)
                        && data?.matchId === facts.matchId && !facts.unsafe;
                    if (!facts.onlyOwned || !facts.matchId) facts.unsafe = true;
                    facts.countdown = Number.isFinite(data?.countdownMs) && data.countdownMs > 0;
                });
                socket.on('match_start', data => {
                    if (facts.joined && data?.matchId !== facts.matchId) facts.unsafe = true;
                    facts.started = facts.onlyOwned && data?.matchId === facts.matchId
                        && data?.ruleset?.id === 'race' && !facts.unsafe;
                });
                socket.on('match_tick', data => {
                    if (!facts.started || data?.matchId !== facts.matchId) return;
                    if (facts.ticks < 1000000) facts.ticks += 1;
                    const own = data?.state?.players?.find(player => player?.id === socket.id);
                    if (!Number.isSafeInteger(own?.x) || !Number.isSafeInteger(own?.y)) return;
                    if (!facts.ownStart) facts.ownStart = { x: own.x, y: own.y };
                    else if (own.x !== facts.ownStart.x || own.y !== facts.ownStart.y) facts.moved = true;
                });
                socket.on('match_settlement_pending', data => {
                    if (data?.matchId === facts.matchId) facts.settlementPending = true;
                });
                socket.on('match_end', data => {
                    if (data?.matchId !== facts.matchId) {
                        facts.unsafe = true;
                        return;
                    }
                    facts.ended = true;
                    facts.settlementPending = false;
                    facts.ownResult = Array.isArray(data?.players)
                        && data.players.some(player => player?.id === socket.id);
                });
                socket.on('player_forfeit', data => {
                    if (data?.id === socket.id) facts.forfeitAck = true;
                });
                socket.on('match_error', () => { facts.matchError = true; facts.unsafe = true; });
                return socket;
            };
        }
    });
}

function fact(page, expression) {
    return page.evaluate(expression);
}

async function requireSafeClients(pages) {
    const states = await Promise.all(pages.map(page => fact(page, () => {
        const value = window.__publicFreeAcceptance;
        return value.connected && value.modeSeen && value.policy && !value.unsafe;
    })));
    requireFact(states.every(Boolean), 'CLIENT_POLICY_OR_SESSION_CHANGED');
}

async function waitUntil(page, expression, timeout, argument = null) {
    await page.waitForFunction(expression, argument, { timeout });
}

async function safePage(page, action) {
    try { return await action(page); } catch (_) { return false; }
}

async function leaveQueue(page) {
    return safePage(page, async () => {
        const state = await fact(page, () => {
            const value = window.__publicFreeAcceptance;
            return { joined: value.joined, started: value.started,
                queued: value.queue?.success, left: value.left };
        });
        if (state.joined || state.started) return false;
        if (!state.queued || state.left) return true;
        await page.locator('#leaveMatchQueueBtn').click({ timeout: 5000 });
        await waitUntil(page, () => window.__publicFreeAcceptance.left, CLEANUP_WAIT_MS);
        return true;
    });
}

async function forfeitOwnedRound(page) {
    return safePage(page, async () => {
        const state = await fact(page, () => {
            const value = window.__publicFreeAcceptance;
            return { joined: value.joined, ended: value.ended, started: value.started,
                onlyOwned: value.onlyOwned, settlementPending: value.settlementPending };
        });
        if (!state.joined || state.ended) return true;
        if (!state.onlyOwned || state.settlementPending) return false;
        if (!state.started) {
            await waitUntil(page, () => window.__publicFreeAcceptance.started, 15000);
        }
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#leaveSpectateBtn').click({ timeout: 5000 });
        await waitUntil(page, () => window.__publicFreeAcceptance.forfeitAck, CLEANUP_WAIT_MS);
        return true;
    });
}

function cleanupState(page) {
    return fact(page, () => {
        const value = window.__publicFreeAcceptance;
        return { joinIntent: value?.joinIntent === true, queue: value?.queue || null,
            left: value?.left === true, joined: value?.joined === true,
            ended: value?.ended === true, onlyOwned: value?.onlyOwned === true };
    });
}

async function cleanupClient(page) {
    let state = await safePage(page, cleanupState);
    if (!state) return { clean: false, forfeited: false };
    if (state.joinIntent && !state.queue && !state.joined) {
        await safePage(page, current => waitUntil(current, () => {
            const value = window.__publicFreeAcceptance;
            return !!value.queue || value.joined || value.matchError;
        }, 10000));
        state = await safePage(page, cleanupState);
        if (!state) return { clean: false, forfeited: false };
    }
    if (state.joined && !state.ended) {
        const clean = await forfeitOwnedRound(page);
        return { clean, forfeited: clean };
    }
    if (state.ended || state.left || !state.joinIntent || state.queue?.success === false) {
        return { clean: true, forfeited: false };
    }
    if (state.queue?.success === true) {
        const left = await leaveQueue(page);
        state = await safePage(page, cleanupState);
        if (!state) return { clean: false, forfeited: false };
        if (state.joined && !state.ended) {
            const clean = await forfeitOwnedRound(page);
            return { clean, forfeited: clean };
        }
        return { clean: left && (state.left || state.ended), forfeited: false };
    }
    // A submitted join without any server acknowledgment might own a durable queue row.
    return { clean: false, forfeited: false };
}

async function allowOnlyPublicOrigin(context) {
    await context.route('**/*', route => {
        try {
            const url = new URL(route.request().url());
            if (url.origin === ORIGIN && url.protocol === 'https:') return route.continue();
            if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
        } catch (_) {}
        return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
        try {
            const url = new URL(socket.url());
            if (url.protocol === 'wss:' && url.host === new URL(ORIGIN).host) {
                return socket.connectToServer();
            }
        } catch (_) {}
        return socket.close();
    });
}

async function checkCanvas(page, mode) {
    await page.locator('.modebtn[data-mode="' + mode + '"]').click();
    await waitUntil(page, expected => {
        const button = document.querySelector('.modebtn[data-mode="' + expected + '"]');
        const canvas = document.querySelector('#stage canvas.rk-canvas');
        if (button?.getAttribute('aria-pressed') !== 'true' || !canvas?.width || !canvas?.height) return false;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = new Set();
        for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) {
            const x = Math.min(canvas.width - 1, Math.floor((col + 0.5) * canvas.width / 16));
            const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / 16));
            const i = (y * canvas.width + x) * 4;
            colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
        }
        return colors.size >= 3;
    }, 10000, mode);
}

async function run() {
    const result = {
        pass: false, stage: 'health', health: false, tavern: false, tiles: false,
        ascii: false, queue: false, countdown: false, start: false,
        ticks: false, controls: false, result: false, returned: false, cleanup: false,
        forfeited: false, code: null, node: process.version,
        playwright: null, chromium: null
    };
    let browser = null;
    const clients = [];
    let interrupted = false;
    let interruptSignal;
    const signal = new Promise(resolve => { interruptSignal = resolve; });
    const onInterrupt = () => { interrupted = true; interruptSignal(true); };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    const requireRunning = () => requireFact(!interrupted, 'PUBLIC_ACCEPTANCE_INTERRUPTED');
    const interruptible = async pending => {
        const wasInterrupted = await Promise.race([pending.then(() => false), signal]);
        requireFact(!wasInterrupted, 'PUBLIC_ACCEPTANCE_INTERRUPTED');
    };
    try {
        const health = await getHealth();
        requireRunning();
        requireFact(healthAllowed(health.status, health.body), 'HEALTH_OR_RELEASE_NOT_CLOSED_READY');
        result.health = true;
        result.stage = 'browser';
        const { chromium } = require('playwright-core');
        result.playwright = require('playwright-core/package.json').version;
        browser = await chromium.launch(BROWSER_LAUNCH);
        result.chromium = browser.version();
        for (let i = 0; i < 2; i++) {
            requireRunning();
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            clients.push({ context, page: null });
            context.setDefaultTimeout(10000);
            context.setDefaultNavigationTimeout(15000);
            await allowOnlyPublicOrigin(context);
            const page = await context.newPage();
            clients[i].page = page;
            await page.addInitScript(browserObserver, { commit: EXPECTED_COMMIT, release: EXPECTED_RELEASE });
            await page.goto(ORIGIN + '/tavern', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await waitUntil(page, () => window.__publicFreeAcceptance.connected
                && window.__publicFreeAcceptance.modeSeen, 15000);
            requireFact(await fact(page, () => window.__publicFreeAcceptance.policy
                && !window.__publicFreeAcceptance.unsafe), 'PUBLIC_MODE_NOT_FREE_ONLY');
            await waitUntil(page, () => {
                const button = document.querySelector('#joinBtn');
                return button && !button.disabled;
            }, 10000);
            await page.locator('#joinBtn').click();
            await waitUntil(page, () => window.__publicFreeAcceptance.tavern, 10000);
            await page.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible', timeout: 10000 });
            await checkCanvas(page, 'tiles');
            await checkCanvas(page, 'ascii');
        }
        result.tavern = result.tiles = result.ascii = true;
        result.stage = 'queue';
        const pages = clients.map(client => client.page);
        await requireSafeClients(pages);
        const ownIds = await Promise.all(pages.map(page => fact(page, () => window.__publicFreeAcceptance.socket?.id)));
        requireFact(ownIds.every(Boolean) && ownIds[0] !== ownIds[1], 'ANONYMOUS_CLIENTS_NOT_DISTINCT');
        await Promise.all(pages.map(page => page.evaluate(ids => {
            window.__publicFreeAcceptance.ownedIds = ids;
        }, ownIds)));
        for (let i = 0; i < pages.length; i++) {
            requireRunning();
            const page = pages[i];
            await page.locator('#matchQueueBtn').click();
            await page.locator('#matchPanel').waitFor({ state: 'visible' });
            const controls = await page.locator('#matchEconomies button').allTextContents();
            requireFact(controls.length === 1 && /free/i.test(controls[0]), 'QUEUE_UI_NOT_FREE_ONLY');
            await page.locator('#matchEconomies button').first().click();
            await requireSafeClients(pages);
            requireRunning();
            await page.evaluate(() => { window.__publicFreeAcceptance.joinIntent = true; });
            await page.locator('#joinMatchQueueBtn').click();
            await waitUntil(page, () => !!window.__publicFreeAcceptance.queue
                || window.__publicFreeAcceptance.joined
                || window.__publicFreeAcceptance.unsafe, 10000);
            await requireSafeClients(pages);
            const queued = await fact(page, () => window.__publicFreeAcceptance.queue);
            requireFact(queued?.success && queued.free && queued.position === i + 1, 'QUEUE_POSITION_OR_ECONOMY_UNEXPECTED');
        }
        result.queue = true;
        result.stage = 'waiting-for-real-block';
        await interruptible(Promise.all(pages.map(page => waitUntil(page, () => window.__publicFreeAcceptance.joined
            || window.__publicFreeAcceptance.unsafe,
            QUEUE_WAIT_MS))));
        await requireSafeClients(pages);
        const joined = await Promise.all(pages.map(page => fact(page, () => {
            const state = window.__publicFreeAcceptance;
            return { owned: state.onlyOwned, countdown: state.countdown, matchId: state.matchId };
        })));
        requireFact(joined.every(value => value.owned && value.countdown)
            && joined[0].matchId && joined[0].matchId === joined[1].matchId,
        'MATCH_CONTAINS_OTHER_ENTRANTS_OR_NO_COUNTDOWN');
        result.countdown = true;
        result.stage = 'race';
        await Promise.all(pages.map(page => waitUntil(page, () => window.__publicFreeAcceptance.started
            || window.__publicFreeAcceptance.unsafe,
            15000)));
        await requireSafeClients(pages);
        requireFact((await Promise.all(pages.map(page => fact(page, () =>
            window.__publicFreeAcceptance.started)))).every(Boolean), 'MATCH_START_UNAVAILABLE');
        result.start = true;
        await Promise.all(pages.map(page => waitUntil(page, () => window.__publicFreeAcceptance.ticks > 0
            && !!window.__publicFreeAcceptance.ownStart
            || window.__publicFreeAcceptance.unsafe, 10000)));
        await requireSafeClients(pages);
        requireFact((await Promise.all(pages.map(page => fact(page, () =>
            !!window.__publicFreeAcceptance.ownStart)))).every(Boolean), 'MATCH_TICK_UNAVAILABLE');
        result.ticks = true;
        for (const page of pages) {
            await page.locator('#spectatorStage').waitFor({ state: 'visible' });
            await page.locator('#spectatorStage').focus();
            for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
                if (await fact(page, () => window.__publicFreeAcceptance.moved)) break;
                await page.keyboard.press(key);
                await page.waitForTimeout(150);
            }
        }
        await Promise.all(pages.map(page => waitUntil(page, () => window.__publicFreeAcceptance.moved,
            5000)));
        await requireSafeClients(pages);
        requireFact((await Promise.all(pages.map(page => fact(page, () =>
            window.__publicFreeAcceptance.moved)))).every(Boolean), 'KEYBOARD_MOVEMENT_UNAVAILABLE');
        result.controls = true;
        await interruptible(Promise.all(pages.map(page => waitUntil(page, () => window.__publicFreeAcceptance.ended
            || window.__publicFreeAcceptance.settlementPending
            || window.__publicFreeAcceptance.unsafe, ROUND_WAIT_MS))));
        await requireSafeClients(pages);
        const terminal = await Promise.all(pages.map(page => fact(page, () => {
            const state = window.__publicFreeAcceptance;
            return state.ended && state.ownResult && !state.settlementPending;
        })));
        requireFact(terminal.every(Boolean), 'DURABLE_MATCH_RESULT_UNAVAILABLE');
        result.result = true;
        result.stage = 'tavern-return';
        await Promise.all(pages.map(async page => {
            await page.locator('#spectatorStage').waitFor({ state: 'hidden', timeout: 12000 });
            await page.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible', timeout: 12000 });
        }));
        await requireSafeClients(pages);
        requireRunning();
        result.returned = true;
        result.pass = true;
    } catch (error) {
        result.code = error instanceof Refusal ? error.code : 'PUBLIC_ACCEPTANCE_INCOMPLETE';
    } finally {
        result.stage = 'cleanup';
        let cleaned = true;
        for (const client of clients) {
            if (!client.page) continue;
            const cleanup = await cleanupClient(client.page);
            result.forfeited = result.forfeited || cleanup.forfeited;
            cleaned = cleaned && cleanup.clean;
        }
        for (const client of clients) {
            try { await client.context.close(); } catch (_) { cleaned = false; }
        }
        if (browser) {
            try { await browser.close(); } catch (_) { cleaned = false; }
        }
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        result.cleanup = cleaned;
        if (!cleaned || result.forfeited) result.pass = false;
        if (!result.pass && !result.code) result.code = cleaned ? 'ROUND_FORFEITED' : 'CLEANUP_UNCONFIRMED';
    }
    result.stage = result.pass ? 'complete' : 'incomplete';
    return result;
}

if (require.main === module) {
    if (!armed(process.argv.slice(2))) {
        process.stderr.write('PUBLIC_ACCEPTANCE_CLOSED: exact arm flag required; fixed origin and release.\n');
        process.exitCode = 2;
    } else {
        run().then(result => {
            process.stdout.write(JSON.stringify(result) + '\n');
            if (!result.pass) process.exitCode = 1;
        }, () => {
            process.stdout.write(JSON.stringify({ pass: false, code: 'PUBLIC_ACCEPTANCE_INCOMPLETE' }) + '\n');
            process.exitCode = 1;
        });
    }
}

module.exports = { armed, healthAllowed, browserObserver, allowOnlyPublicOrigin,
    BROWSER_LAUNCH,
    leaveQueue, forfeitOwnedRound, cleanupClient };
