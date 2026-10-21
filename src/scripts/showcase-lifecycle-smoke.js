'use strict';

// Real application lifecycle rehearsal. The only synthetic input is the app's existing local
// simulated-block source, at its normal cadence. Queue, scheduler, match engine, database writes,
// socket events, client controls, and results all run through production application code.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Client } = require('pg');
const { chromium } = require('playwright-core');

const execFile = promisify(childProcess.execFile);
const ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(ROOT, 'src');
const APP_ENTRY = path.join(SRC_ROOT, 'index.js');
const OUTPUT_BASE = path.join(os.homedir(), 'Build', 'wowngeon', 'showcase-lifecycle');
const ROLES = ['mica', 'moth'];
const SOCKET_EVENTS = ['connect', 'game_mode_info', 'match_queue_joined', 'match_joined', 'match_start', 'match_tick', 'match_end'];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function requireCheck(condition, code) {
    if (condition) return;
    const error = new Error(code);
    error.code = code;
    throw error;
}

function parseArgs(argv) {
    let outputRoot = OUTPUT_BASE;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--output-root') {
            assert(argv[i + 1], '--output-root requires a directory');
            outputRoot = path.resolve(argv[++i]);
        } else {
            throw new Error(`Unknown argument: ${argv[i]}`);
        }
    }
    return outputRoot;
}

function isLoopback(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function waitFor(predicate, timeoutMs, description, intervalMs = 50) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            Promise.resolve().then(predicate).then(value => {
                if (value) return resolve(value);
                if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${description}`));
                setTimeout(check, intervalMs);
            }, reject);
        };
        check();
    });
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function cleanEnv(values) {
    const env = {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: os.homedir(),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        TMPDIR: os.tmpdir(),
        ...values
    };
    return env;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function binaryDirectory() {
    const candidates = ['/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/16/bin', '/usr/bin'];
    return candidates.find(dir => fs.existsSync(path.join(dir, 'initdb')) && fs.existsSync(path.join(dir, 'pg_ctl')));
}

async function run(command, args, options = {}) {
    return execFile(command, args, {
        cwd: options.cwd || SRC_ROOT,
        env: options.env || cleanEnv({}),
        timeout: options.timeout || 30000,
        maxBuffer: 2 * 1024 * 1024
    });
}

function startProcess(command, args, options = {}) {
    const proc = childProcess.spawn(command, args, {
        cwd: options.cwd || SRC_ROOT,
        env: options.env || cleanEnv({}),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = Buffer.alloc(0);
    const retainTail = chunk => {
        output = Buffer.concat([output, chunk]).subarray(-256 * 1024);
    };
    let launchFailed = false;
    proc.once('error', () => { launchFailed = true; });
    proc.stdout.on('data', retainTail);
    proc.stderr.on('data', retainTail);
    return { proc, getOutput: () => output.toString(), launchFailed: () => launchFailed };
}

function classifyStartupFailure(output) {
    const categories = [
        ['EGRESS_GUARD_TCP_IPV4', /showcase lifecycle smoke denied network egress:TCP_IPV4/],
        ['EGRESS_GUARD_TCP_IPV6', /showcase lifecycle smoke denied network egress:TCP_IPV6/],
        ['EGRESS_GUARD_TCP_HOSTNAME', /showcase lifecycle smoke denied network egress:TCP_HOSTNAME/],
        ['EGRESS_GUARD_TCP_EMPTY', /showcase lifecycle smoke denied network egress:TCP_EMPTY/],
        ['EGRESS_GUARD_TCP', /showcase lifecycle smoke denied network egress:TCP(?:\r?\n|$)/],
        ['EGRESS_GUARD_DNS', /showcase lifecycle smoke denied network egress:DNS/],
        ['EGRESS_GUARD_UDP', /showcase lifecycle smoke denied network egress:UDP/],
        ['APP_ENV_INVALID', /Startup aborted/],
        ['APP_DATABASE_FAILED', /Database connection failed/],
        ['APP_MIGRATION_FAILED', /Migration failed/],
        ['APP_PAYMENT_INIT_FAILED', /Failed to initialize payment system/],
        ['APP_DEPENDENCY_MISSING', /Cannot find module/],
        ['APP_PORT_UNAVAILABLE', /EADDRINUSE/],
        ['APP_FATAL_EXCEPTION', /uncaughtException|unhandledRejection/]
    ];
    return categories.find(([, pattern]) => pattern.test(output))?.[0] || 'APPLICATION_EXITED';
}

function classifyHarnessFailure(error, phase) {
    const sqlStateCodes = {
        '42P01': 'DATABASE_TABLE_UNDEFINED',
        '42703': 'DATABASE_COLUMN_UNDEFINED',
        '42883': 'DATABASE_FUNCTION_UNDEFINED',
        '42501': 'DATABASE_PERMISSION_DENIED',
        '23514': 'DATABASE_CONSTRAINT_REJECTED'
    };
    if (sqlStateCodes[error?.code]) return sqlStateCodes[error.code];
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) return 'DATABASE_QUERY_FAILED';
    if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code;
    const message = String(error?.message || '');
    const patterns = [
        ['FREE_ECONOMY_MISSING', /Free\/Pleb queue option|free economy control/],
        ['PAID_ECONOMY_EXPOSED', /A paid queue appeared/],
        ['QUEUE_JOIN_FAILED', /Both clients did not enter the real free queue|Queued for free/],
        ['MATCH_START_TIMEOUT', /real simulated-block scheduler callback|match_start/],
        ['LIVE_MATCH_STATE_INVALID', /No live match state|Unexpected live match policy|socket is absent from the live public match state/],
        ['EXIT_ROUTE_UNAVAILABLE', /No walkable path from the selected player to the exit/],
        ['EXIT_ROUTE_EMPTY', /Exit route unexpectedly has no movement steps/],
        ['BROWSER_RUNTIME_FAILURE', /Browser runtime errors|Unexpected HTTP failures|external egress/],
        ['QUEUE_UI_TIMEOUT', /matchQueueBtn|matchPanel|matchEconomies|joinMatchQueueBtn/]
    ];
    return patterns.find(([, pattern]) => pattern.test(message))?.[0]
        || (phase === 'queue-and-match' ? 'QUEUE_AND_MATCH_FAILED' : 'UNCLASSIFIED');
}

async function httpStatus(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, response => {
            response.resume();
            resolve(response.statusCode);
        });
        request.setTimeout(1000, () => request.destroy(new Error('HTTP readiness timeout')));
        request.on('error', reject);
    });
}

async function getJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
                catch (_) { reject(new Error('Health endpoint returned invalid JSON')); }
            });
        });
        request.setTimeout(1000, () => request.destroy(new Error('Health request timeout')));
        request.on('error', reject);
    });
}

function observeSocketScript() {
    return `(() => {
      const eventNames = ${JSON.stringify(SOCKET_EVENTS)};
      window.__lifecycle = { socket: null, events: {}, latestState: null, starts: 0, ends: [] };
      let factory = null;
      const wrap = value => {
        if (typeof value !== 'function') return value;
        return function(...args) {
          const socket = value.apply(this, args);
          window.__lifecycle.socket = socket;
          eventNames.forEach(name => socket.on(name, payload => {
            const log = window.__lifecycle.events[name] || (window.__lifecycle.events[name] = []);
            log.push(payload);
            if (log.length > 30) log.shift();
            if (name === 'match_joined' && payload && payload.state?.gameState) window.__lifecycle.latestState = payload.state.gameState;
            if (name === 'match_joined' && payload && payload.gameState) window.__lifecycle.latestState = payload.gameState;
            if (name === 'match_start') {
              window.__lifecycle.starts += 1;
              if (payload && payload.gameState) window.__lifecycle.latestState = payload.gameState;
            }
            if (name === 'match_tick' && payload && payload.state) window.__lifecycle.latestState = payload.state;
            if (name === 'match_tick' && payload && payload.gameState) window.__lifecycle.latestState = payload.gameState;
            if (name === 'match_end') window.__lifecycle.ends.push(payload);
          }));
          return socket;
        };
      };
      Object.defineProperty(window, 'io', {
        configurable: true,
        get() { return factory; },
        set(value) { factory = wrap(value); }
      });
    })();`;
}

function shortestPath(state, start, goal) {
    const grid = state && state.visibleTiles;
    if (!Array.isArray(grid) || grid.length === 0) {
        const error = new Error('Match state has no public dungeon grid');
        error.code = 'LIVE_GRID_MISSING';
        throw error;
    }
    if (!Array.isArray(goal) || goal.length !== 2) {
        const error = new Error('Live match state does not expose the race exit');
        error.code = 'LIVE_EXIT_MISSING';
        throw error;
    }
    const walkable = tile => tile === "'1" || tile === "'2" || tile === '>' || tile === '$M';
    const key = (x, y) => `${x},${y}`;
    const occupied = new Set((state.players || [])
        .filter(player => player.id !== start.id && player.alive !== false && player.finished !== true)
        .map(player => key(player.x, player.y)));
    const queue = [{ x: start.x, y: start.y, path: [] }];
    const seen = new Set([key(start.x, start.y)]);
    const deltas = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    while (queue.length) {
        const node = queue.shift();
        if (node.x === goal[0] && node.y === goal[1]) return node.path;
        for (const [dx, dy] of deltas) {
            const x = node.x + dx;
            const y = node.y + dy;
            const nextKey = key(x, y);
            if (seen.has(nextKey) || occupied.has(nextKey) || !walkable(grid[y]?.[x])) continue;
            seen.add(nextKey);
            queue.push({ x, y, path: [...node.path, { x, y, key: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'][deltas.findIndex(d => d[0] === dx && d[1] === dy)] }] });
        }
    }
    const error = new Error('No walkable path from the selected player to the exit');
    error.code = 'EXIT_ROUTE_UNAVAILABLE';
    throw error;
}

async function main() {
    assert(process.platform === 'linux', 'Run this lifecycle smoke on the Linux developer workstation with PostgreSQL installed');
    assert(process.getuid && process.getuid() !== 0, 'Refusing to run PostgreSQL as root');
    assert(process.env.NODE_ENV !== 'production', 'Refusing to run with NODE_ENV=production');
    assert(fs.existsSync(APP_ENTRY), 'Application entrypoint is missing from the source tree');
    assert(!fs.existsSync(path.join(SRC_ROOT, '.env')), 'The isolated source tree must not contain a dotenv file');

    const outputRoot = parseArgs(process.argv.slice(2));
    assert(!/[^A-Za-z0-9._/-]/.test(outputRoot), 'Output root may contain only letters, digits, slash, dot, underscore, or hyphen');
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const outputDir = fs.mkdtempSync(path.join(outputRoot, 'run-'));
    fs.chmodSync(outputDir, 0o700);
    const egressGuardPath = path.join(__dirname, 'showcase-network-guard.js');
    const pgDir = path.join(outputDir, 'pgdata');
    const socketDir = path.join(outputDir, 'pgsock');
    fs.mkdirSync(socketDir, { mode: 0o700 });
    const pgBin = binaryDirectory();
    assert(pgBin, 'PostgreSQL initdb/pg_ctl binaries were not found');
    const dbPort = await getFreePort();
    const appPort = await getFreePort();
    const dbName = 'wowngeon_showcase';
    const dbUser = 'wowngeon_smoke';
    const dbEnv = cleanEnv({ PGHOST: socketDir, PGPORT: String(dbPort), PGUSER: dbUser, PGDATABASE: dbName });

    await run(path.join(pgBin, 'initdb'), ['-D', pgDir, '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8', '-U', dbUser], { env: cleanEnv({}) });
    const pgCtl = path.join(pgBin, 'pg_ctl');
    const pgOptions = ['-h', '', '-k', socketDir, '-p', String(dbPort), '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700']
        .map(shellQuote).join(' ');
    let postgresNeedsStop = false;
    let appProcess = null;
    let browser = null;
    const failures = [];
    const blockedEgress = [];
    const httpErrors = [];
    const screenshots = {};
    const contextPages = {};
    let phase = 'postgres-init';
    let startupHealthCode = 'APPLICATION_NOT_READY';
    let completedReport = null;
    let primaryFailure = null;
    const cleanupFailures = [];

    try {
        phase = 'postgres-start';
        // Retain cleanup intent even if pg_ctl times out after starting the server.
        postgresNeedsStop = true;
        await run(pgCtl, ['-D', pgDir, '-l', path.join(outputDir, 'postgres.log'), '-o', pgOptions, 'start'], { env: dbEnv });
        phase = 'postgres-create-database';
        await run(path.join(pgBin, 'createdb'), ['-h', socketDir, '-p', String(dbPort), '-U', dbUser, dbName], { env: dbEnv });
        phase = 'application-startup';
        const appEnv = cleanEnv({
            NODE_ENV: 'debug', DOTENV_CONFIG_PATH: '/dev/null', HOST: '127.0.0.1', PORT: String(appPort),
            DB_HOST: socketDir, DB_PORT: String(dbPort), DB_NAME: dbName, DB_USER: dbUser, DB_PASSWORD: '',
            PAYMENTS_ENABLED: 'false', PAYOUTS_ENABLED: 'false', FREE_PLAY_ENABLED: 'true', GAME_MODE: 'free',
            SMIRK_ENABLED: 'false', TAVERN_ENABLED: 'true', MATCH_ENABLED: 'true', MATCH_RULESET: 'race',
            MATCH_CRYPTO_RACE_ENABLED: 'false', MATCH_PAYOUTS_ENABLED: 'false',
            SIMULATED_BLOCKS: 'true', BLOCK_SOURCE: 'simulated', DEBUG_HOTKEYS: 'false',
            MATCH_TICK_MS: '100', MATCH_MAX_PLAYERS: '4', MATCH_COUNTDOWN_MS: '1000',
            MATCH_AVAILABILITY_RECONCILE_MS: '1000',
            PRIMARY_WALLET_ENDPOINT: 'http://127.0.0.1:9', RPC_ENDPOINTS: 'http://127.0.0.1:9',
            PRIMARY_RPC_ENDPOINT: 'http://127.0.0.1:9', FALLBACK_RPC_ENDPOINT: 'http://127.0.0.1:9',
            WOWNGEON_SHOWCASE_GUARD: '1',
            WOWNGEON_SHOWCASE_PG_SOCKET: path.join(socketDir, `.s.PGSQL.${dbPort}`),
            NODE_OPTIONS: `--require="${egressGuardPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        });
        assert(appEnv.DB_PASSWORD === '' && appEnv.PAYMENTS_ENABLED === 'false' && appEnv.PAYOUTS_ENABLED === 'false', 'Financially closed local configuration was not established');
        const appChild = startProcess(process.execPath, [APP_ENTRY], { cwd: SRC_ROOT, env: appEnv });
        appProcess = appChild.proc;
        await waitFor(async () => {
            if (appChild.launchFailed()) {
                const error = new Error('Application process could not start');
                error.code = 'APPLICATION_SPAWN_FAILED';
                throw error;
            }
            if (appProcess.exitCode != null || appProcess.signalCode != null) {
                const error = new Error('Application ended before readiness');
                error.code = classifyStartupFailure(appChild.getOutput());
                throw error;
            }
            try {
                const response = await getJson(`http://127.0.0.1:${appPort}/health/ready`);
                const checks = response.body.checks || {};
                startupHealthCode = checks.database === 'down' ? 'DATABASE_NOT_READY'
                    : checks.wallet === 'up' ? 'WALLET_ENDPOINT_ACTIVE'
                        : checks.financialRecovery === 'pending' ? 'FINANCIAL_RECOVERY_PENDING'
                            : response.status === 404 ? 'READINESS_ROUTE_MISSING'
                                : 'APPLICATION_NOT_READY';
                if (response.status !== 200 || response.body.ready !== true) return false;
                assert(response.body.checks?.database === 'up', 'Health probe did not confirm the migrated database');
                assert(response.body.checks?.wallet === 'not_required', 'Health probe indicates wallet initialization is required');
                assert(response.body.walletHealthy === false, 'Health probe indicates a wallet RPC connection');
                assert(response.body.money?.paymentsEnabled === false && response.body.money?.payoutsEnabled === false, 'Health probe does not confirm the money paths are closed');
                assert(response.body.chain?.source === 'simulated', 'Health probe does not confirm the local block fixture');
                return true;
            } catch (error) {
                if (/Health probe/.test(error.message)) throw error;
                return false;
            }
        }, 60000, 'real application startup and full database migrations', 250).catch(error => {
            if (!error.code) error.code = startupHealthCode;
            throw error;
        });

        phase = 'browser-setup';
        browser = await chromium.launch({ headless: true });
        for (const role of ROLES) {
            const context = await browser.newContext({ userAgent: `WowngeonLifecycleSmoke/${role}`, viewport: { width: 1280, height: 900 } });
            context.on('requestfailed', request => {
                const url = new URL(request.url());
                if (!isLoopback(url.hostname) || Number(url.port || 80) !== appPort) blockedEgress.push(url.origin);
            });
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
                if (url.protocol === 'http:' && isLoopback(url.hostname) && Number(url.port || 80) === appPort) return route.continue();
                blockedEgress.push(url.origin);
                return route.abort('blockedbyclient');
            });
            await context.routeWebSocket('**/*', ws => {
                const url = new URL(ws.url());
                if (url.protocol === 'ws:' && isLoopback(url.hostname) && Number(url.port || 80) === appPort) ws.connectToServer();
                else blockedEgress.push(url.origin);
            });
            const page = await context.newPage();
            await page.addInitScript(observeSocketScript());
            page.on('pageerror', error => failures.push(error.message));
            page.on('response', response => {
                if (response.status() >= 400) httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname });
            });
            page.on('console', message => {
                if (message.type() === 'error') failures.push(message.text());
            });
            contextPages[role] = { context, page };
        }

        phase = 'tavern-join';
        await Promise.all(Object.values(contextPages).map(({ page }) => page.goto(`http://127.0.0.1:${appPort}/tavern`)));
        for (const { page } of Object.values(contextPages)) {
            await page.locator('#joinBtn').waitFor({ state: 'visible' });
            await page.waitForFunction(() => window.__lifecycle?.socket?.connected === true);
            await page.locator('#name').waitFor({ state: 'visible' });
        }
        for (const [role, name] of [['mica', 'Mica'], ['moth', 'Moth']]) {
            const page = contextPages[role].page;
            await page.locator('#name').fill(name);
            await page.locator('#joinBtn').click();
            await page.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible', timeout: 10000 });
        }
        await waitFor(async () => {
            const ids = await Promise.all(ROLES.map(role => contextPages[role].page.evaluate(() => window.__lifecycle.socket?.id || null)));
            return ids.every(Boolean);
        }, 10000, 'two page-owned sockets');
        const socketIds = {};
        for (const role of ROLES) socketIds[role] = await contextPages[role].page.evaluate(() => window.__lifecycle.socket.id);
        assert(socketIds.mica && socketIds.moth && socketIds.mica !== socketIds.moth, 'Fresh browser contexts did not own distinct sockets');

        phase = 'arena-open';
        const queueReady = contextPages.mica.page;
        await queueReady.locator('#matchQueueBtn').waitFor({ state: 'visible', timeout: 10000 });
        await queueReady.locator('#matchQueueBtn').click();
        await queueReady.locator('#matchPanel').waitFor({ state: 'visible' });
        await waitFor(() => queueReady.locator('#matchEconomies button').count(), 5000, 'free economy control');
        const economyControls = await queueReady.locator('#matchEconomies button').allTextContents();
        assert(economyControls.some(text => /free|pleb/i.test(text)), 'Free/Pleb queue option is absent');
        assert(!economyControls.some(text => /prestige|crypto|paid/i.test(text)), `A paid queue appeared in free-only mode: ${economyControls.join(', ')}`);
        const freeOption = queueReady.locator('#matchEconomies button').filter({ hasText: /free|pleb/i }).first();
        await freeOption.click();
        phase = 'queue-join';
        const joinQueue = async role => {
            const page = contextPages[role].page;
            if (role !== 'mica') {
                await page.locator('#matchQueueBtn').click();
                await page.locator('#matchPanel').waitFor({ state: 'visible' });
            }
            await page.locator('#matchEconomies button').filter({ hasText: /free|pleb/i }).first().click();
            await page.locator('#joinMatchQueueBtn').click();
            await page.getByText(/Queued for free/i).waitFor({ timeout: 10000 });
            return page.evaluate(() => window.__lifecycle.events.match_queue_joined?.slice(-1)[0]);
        };
        const queued = await Promise.all(ROLES.map(joinQueue));
        assert(queued.every(result => result?.success === true && result.economy === 'free'), 'Both clients did not enter the real free queue');

        phase = 'match-start';
        await Promise.all(ROLES.map(role => contextPages[role].page.waitForFunction(() =>
            window.__lifecycle.starts > 0 && window.__lifecycle.latestState?.tick > 0 && window.__lifecycle.latestState?.matchId,
        null, { timeout: 65000 })));
        const matchId = await contextPages.mica.page.evaluate(() => window.__lifecycle.latestState?.matchId);
        assert(matchId, 'No live match state arrived after the real simulated-block scheduler callback');
        for (const role of ROLES) {
            const state = await contextPages[role].page.evaluate(() => window.__lifecycle.latestState);
            assert(state?.economy === 'free' && state.ruleset?.id === 'race', `Unexpected live match policy for ${role}`);
            requireCheck(state.matchId === matchId, 'PAGE_MATCH_ID_MISMATCH');
            screenshots[`${role}-match-start.png`] = path.join(outputDir, `${role}-match-start.png`);
            await contextPages[role].page.screenshot({ path: screenshots[`${role}-match-start.png`] });
        }

        // The browser socket id selects the actual entrant. Find a public path from that entrant
        // to the actual exit, then use keyboard events and await server ticks after every step.
        phase = 'escape-race';
        const driver = contextPages.mica.page;
        let state = await driver.evaluate(() => window.__lifecycle.latestState);
        if (!state || !Array.isArray(state.players)) {
            const error = new Error('The live match state or entrant list is missing');
            error.code = 'LIVE_MATCH_STATE_MISSING';
            throw error;
        }
        const player = state.players.find(value => value.id === socketIds.mica);
        if (!player) {
            const error = new Error('Mica page-owned socket is absent from the live public match state');
            error.code = 'PLAYER_STATE_MISSING';
            throw error;
        }
        const pathToExit = shortestPath(state, player, state.exit);
        if (pathToExit.length === 0) {
            const error = new Error('Exit route unexpectedly has no movement steps');
            error.code = 'EXIT_ROUTE_EMPTY';
            throw error;
        }
        for (const step of pathToExit) {
            const oldTick = state.tick;
            await driver.locator('body').click({ position: { x: 5, y: 5 } });
            await driver.keyboard.press(step.key);
            try {
                await driver.waitForFunction(({ old, x, y }) => {
                    const current = window.__lifecycle.latestState;
                    const self = current?.players?.find(value => value.id === window.__lifecycle.socket.id);
                    return current?.tick > old && self?.x === x && self?.y === y;
                }, { old: oldTick, x: step.x, y: step.y }, { timeout: 1500 });
            } catch (_) {
                const latest = await driver.evaluate(() => window.__lifecycle.latestState);
                const self = latest?.players?.find(value => value.id === window.__lifecycle.socket.id);
                const ended = await driver.evaluate(() => window.__lifecycle.ends.length > 0);
                if (ended || (self && (self.alive === false || self.finished === true) && self.escaped !== true)) {
                    const error = new Error('The controlled entrant became terminal before escaping');
                    error.code = 'PLAYER_TERMINAL_DURING_ROUTE';
                    throw error;
                }
                const error = new Error('Keyboard movement did not reach its authoritative server position');
                error.code = 'KEYBOARD_MOVE_TIMEOUT';
                throw error;
            }
            state = await driver.evaluate(() => window.__lifecycle.latestState);
        }
        phase = 'match-result';
        await driver.waitForFunction(() => window.__lifecycle.ends.length > 0, null, { timeout: 10000 });
        const result = await driver.evaluate(() => window.__lifecycle.ends.slice(-1)[0]);
        assert(result && result.matchId === matchId, 'The live match did not return its result to the driving page');
        const controlledResult = result.players?.find(value => value.id === socketIds.mica);
        if (!controlledResult?.escaped) {
            const error = new Error('The controlled entrant reached a terminal result without escaping');
            error.code = controlledResult?.killedBy === 'monster'
                ? 'PLAYER_KILLED_BY_MONSTER'
                : 'PLAYER_TERMINAL_WITHOUT_ESCAPE';
            throw error;
        }
        phase = 'return-to-tavern';
        await driver.locator('#spectatorStage').waitFor({ state: 'hidden', timeout: 12000 });
        await driver.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible', timeout: 5000 });
        screenshots['mica-result-return.png'] = path.join(outputDir, 'mica-result-return.png');
        await driver.screenshot({ path: screenshots['mica-result-return.png'] });

        phase = 'database-result-check';
        const db = new Client({ host: socketDir, port: dbPort, database: dbName, user: dbUser });
        await db.connect();
        try {
            const match = await db.query(`SELECT id, status, economy, variant, entry_fee_atomic, pot_atomic, house_fee_atomic FROM matches WHERE id = $1`, [matchId]);
            requireCheck(match.rowCount === 1, 'MATCH_ROW_MISSING');
            requireCheck(match.rows[0].status === 'finished' && match.rows[0].economy === 'free' && match.rows[0].variant === 'race', 'MATCH_POLICY_MISMATCH');
            requireCheck(Number(match.rows[0].entry_fee_atomic) === 0 && Number(match.rows[0].pot_atomic) === 0 && Number(match.rows[0].house_fee_atomic) === 0, 'MATCH_MONEY_FIELDS_NONZERO');
            const entrants = await db.query(`SELECT socket_id, placement, escaped FROM match_entrants WHERE match_id = $1 ORDER BY socket_id`, [matchId]);
            requireCheck(entrants.rowCount === 2, 'MATCH_ENTRANT_COUNT_MISMATCH');
            const entrantSockets = new Set(entrants.rows.map(row => row.socket_id));
            requireCheck(ROLES.every(role => entrantSockets.has(socketIds[role])), 'MATCH_ENTRANT_SOCKET_MISMATCH');
            requireCheck(entrants.rows.some(row => row.socket_id === socketIds.mica && row.escaped), 'CONTROLLED_ENTRANT_ESCAPE_NOT_PERSISTED');
            const finance = await db.query(`SELECT
                (SELECT COUNT(*) FROM payments) AS payments,
                (SELECT COUNT(*) FROM payouts) AS payouts,
                (SELECT COUNT(*) FROM credit_transactions) AS credit_transactions,
                (SELECT COUNT(*) FROM race_entry_transactions) AS race_entry_transactions`);
            requireCheck(Object.values(finance.rows[0]).every(value => Number(value) === 0), 'FINANCIAL_LEDGER_NOT_EMPTY');
            const users = await db.query(`SELECT
                (SELECT COUNT(DISTINCT socket_id) FROM match_entrants WHERE match_id = $1 AND socket_id = ANY($2::text[])) AS page_sockets,
                (SELECT COUNT(DISTINCT user_id) FROM match_entrants WHERE match_id = $1 AND socket_id = ANY($2::text[])) AS page_users,
                (SELECT COALESCE(SUM(credits), 0) FROM users) AS total_credits`, [matchId, [socketIds.mica, socketIds.moth]]);
            requireCheck(Number(users.rows[0].page_sockets) === 2 && Number(users.rows[0].page_users) === 2, 'ANONYMOUS_USER_BINDING_MISMATCH');
            requireCheck(Number(users.rows[0].total_credits) === 0, 'NONZERO_USER_CREDITS');
        } finally {
            await db.end();
        }

        assert(blockedEgress.length === 0, `Browser attempted external egress: ${blockedEgress.join(', ')}`);
        assert(httpErrors.length === 0, `Unexpected HTTP failures: ${JSON.stringify(httpErrors)}`);
        assert(failures.length === 0, `Browser runtime errors: ${failures.join(' | ')}`);
        completedReport = {
            result: 'passed',
            fixture: { blocks: 'existing local simulated-block source at normal 30-second cadence', database: 'fresh private Unix-socket PostgreSQL cluster', wallets: 'disabled and not initialized', payments: 'disabled', payouts: 'disabled' },
            flow: ['two anonymous Tavern sessions', 'free queue', 'real scheduler countdown', 'Escape Race', 'actual keyboard path to exit', 'persisted result', 'automatic return to Tavern'],
            match: { id: matchId, economy: 'free', ruleset: 'race', entrants: 2, walletOrPaymentRows: 0 },
            screenshots,
            browserErrors: failures.length,
            externalRequestsBlocked: blockedEgress.length,
            unexpectedHttpErrors: httpErrors.length
        };
    } catch (error) {
        primaryFailure = { phase, code: classifyHarnessFailure(error, phase) };
    } finally {
        if (browser) {
            try { await browser.close(); }
            catch (_) { cleanupFailures.push('BROWSER_CLOSE_FAILED'); }
        }
        if (appProcess && appProcess.exitCode == null && appProcess.signalCode == null) {
            const stopped = () => appProcess.exitCode != null || appProcess.signalCode != null;
            try {
                appProcess.kill('SIGTERM');
                try { await waitFor(stopped, 15000, 'application shutdown'); }
                catch (_) {
                    appProcess.kill('SIGKILL');
                    await waitFor(stopped, 5000, 'application forced shutdown');
                }
            } catch (_) { cleanupFailures.push('APPLICATION_STOP_FAILED'); }
        }
        if (postgresNeedsStop) {
            try {
                await run(pgCtl, ['-D', pgDir, '-m', 'fast', 'stop'], { env: dbEnv, timeout: 15000 });
                postgresNeedsStop = false;
            } catch (_) {
                cleanupFailures.push('POSTGRES_STOP_FAILED');
                // Best effort still targets only the private fixture, and never erases failure.
                try { await run(pgCtl, ['-D', pgDir, '-m', 'immediate', 'stop'], { env: dbEnv, timeout: 15000 }); }
                catch (_) { /* The failed report retains the cleanup cause. */ }
            }
        }
    }

    if (primaryFailure || cleanupFailures.length > 0) {
        const failure = primaryFailure || { phase: 'cleanup', code: cleanupFailures[0] };
        if (cleanupFailures.length > 0) {
            process.stderr.write(`Lifecycle fixture cleanup failed (${cleanupFailures.join(',')}).\n`);
        }
        throw new Error(`Lifecycle smoke failed during ${failure.phase} (${failure.code}). Private run artifacts: ${outputDir}`);
    }
    completedReport.cleanup = { browser: 'closed', application: 'stopped', postgres: 'stopped' };
    fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(completedReport, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ result: completedReport.result, outputDir, match: completedReport.match,
        cleanup: completedReport.cleanup, screenshots: Object.keys(screenshots) }, null, 2)}\n`);
}

main().catch(error => {
    const safeMessage = typeof error?.message === 'string' && /^Lifecycle smoke failed during [a-z-]+ \([A-Z0-9_]+\)\. Private run artifacts: \/[A-Za-z0-9._/-]+$/.test(error.message)
        ? error.message
        : 'Lifecycle smoke could not start (UNCLASSIFIED)';
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
});
