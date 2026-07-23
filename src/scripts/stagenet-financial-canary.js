#!/usr/bin/env node
'use strict';

/*
 * Repository-owned Monerogue XMR stagenet financial canary.
 *
 * This is deliberately a one-transfer, one-game harness. It refuses public targets,
 * mainnet, reused databases, self-payment, ambiguous live intent, and transfer retries.
 * It never prints wallet addresses, session tokens, transaction hashes, or proof seeds.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const {
    CANARY_HANDSHAKE_PROTOCOL,
    computeProof,
    equalProof,
    normalizeIdentity,
    readDatabaseIdentity,
    readNonceFile
} = require('../services/canaryDatabaseIdentity');

const APP_ROOT = path.resolve(__dirname, '..');
const FLOOR = new Set(["'1", "'2"]);
const STEP_VECTORS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
const LIVE_CONFIRM = 'I_UNDERSTAND_THIS_BROADCASTS_ONE_XMR_STAGENET_TRANSFER';
const SAFE_PROFILE_CONFIRM = 'EASY_STATIC_MONSTER_ONE_LEVEL';
const OPERATED_PROFILE_ID = 'such-monerogue-stagenet';
const REQUIRED_MIGRATIONS = Object.freeze([
    '035_payment_entitlements_and_entry_evidence.sql',
    '037_payment_receipt_evidence.sql',
    '038_economic_identity_immutability.sql',
    '039_unresolved_solo_payout_review.sql',
    '040_paid_match_entropy_precommit.sql',
    '041_financial_event_outbox.sql',
    '042_immutable_financial_event_snapshots.sql',
    '043_durable_solo_restart_snapshots.sql'
]);

const SCENARIOS = Object.freeze({
    'direct-2x': Object.freeze({
        id: 'direct-2x',
        databaseTag: 'direct',
        paymentType: 'single_game',
        gameMode: 'PAID_SINGLE',
        collectTreasure: false,
        multiplier: 2,
        payoutReason: 'escape',
        scenarioConfirm: 'DIRECT_2X_ESCAPE'
    }),
    'credits-3x': Object.freeze({
        id: 'credits-3x',
        databaseTag: 'credits',
        paymentType: 'credits_package',
        gameMode: 'PAID_CREDITS',
        collectTreasure: true,
        multiplier: 3,
        payoutReason: 'escape_with_treasure',
        scenarioConfirm: 'CREDITS_PACKAGE_THEN_3X_TREASURE_ESCAPE'
    })
});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function phase(message) {
    process.stdout.write(`[stagenet-canary] ${message}\n`);
}

function safeMessage(value) {
    return String(value || 'unknown error')
        .replace(/\b[1-9A-HJ-NP-Za-km-z]{90,120}\b/g, '[redacted-address]')
        .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-64-byte-value]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(password|token|authorization|seed|tx_?hash)\b["']?\s*[:=]\s*["']?[^\s,;}]+/gi,
            '$1=[redacted]');
}

function isLoopback(hostname) {
    const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function assertLocalUrl(url, label, expectedPort = null) {
    assert(url instanceof URL, `${label} must be a URL`);
    assert(['http:', 'https:'].includes(url.protocol), `${label} must use HTTP(S)`);
    assert(isLoopback(url.hostname), `${label} must name localhost explicitly`);
    assert(!url.username && !url.password, `${label} must not embed credentials`);
    assert(!url.search && !url.hash, `${label} must not contain a query or fragment`);
    if (expectedPort !== null) {
        assert(url.port === String(expectedPort), `${label} must use dedicated canary port ${expectedPort}`);
    }
}

function boundedPositiveInt(env, name, fallback, maximum) {
    const value = Number(env[name] || fallback);
    assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
    assert(value <= maximum, `${name} exceeds its safety bound of ${maximum}`);
    return value;
}

function optionalPositiveAtomic(env, name) {
    const raw = String(env[name] || '').trim().replace(/_/g, '');
    if (!raw) return null;
    assert(/^\d+$/.test(raw), `${name} must be a positive atomic-unit integer`);
    const value = BigInt(raw);
    assert(value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
        `${name} must be positive and exactly representable by wallet RPC`);
    return value;
}

function readConfiguration(env = process.env) {
    const mode = String(env.E2E_MODE || 'preflight').trim();
    assert(['preflight', 'database-preflight', 'live-stagenet'].includes(mode),
        'E2E_MODE must be preflight, database-preflight, or live-stagenet');

    const scenarioName = String(env.E2E_SCENARIO || '').trim();
    const scenario = scenarioName ? SCENARIOS[scenarioName] : null;
    if (scenarioName) assert(scenario, 'E2E_SCENARIO must be direct-2x or credits-3x');
    if (mode !== 'preflight') {
        assert(scenario, 'E2E_SCENARIO is required for database and live modes');
    }

    let target;
    try {
        target = new URL(env.E2E_TARGET || 'http://127.0.0.1:3102');
    } catch (_) {
        throw new Error('E2E_TARGET must be a valid URL');
    }
    assertLocalUrl(target, 'E2E_TARGET', 3102);
    assert(target.pathname === '/' || target.pathname === '', 'E2E_TARGET must not contain a path');

    const packageId = String(env.E2E_CREDITS_PACKAGE_ID || 'small').trim();
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(packageId),
        'E2E_CREDITS_PACKAGE_ID must be a simple product id');

    return Object.freeze({
        mode,
        scenario,
        target,
        packageId,
        paymentTimeoutMs: boundedPositiveInt(env, 'E2E_PAYMENT_TIMEOUT_MS', 30 * 60 * 1000, 45 * 60 * 1000),
        payoutTimeoutMs: boundedPositiveInt(env, 'E2E_PAYOUT_TIMEOUT_MS', 15 * 60 * 1000, 30 * 60 * 1000),
        rpcPollMs: boundedPositiveInt(env, 'E2E_RPC_POLL_MS', 2000, 10000),
        botMoveDelayMs: boundedPositiveInt(env, 'E2E_BOT_MOVE_DELAY_MS', 140, 1000),
        botMaxMoves: boundedPositiveInt(env, 'E2E_BOT_MAX_MOVES', 3000, 3000),
        botTimeoutMs: boundedPositiveInt(env, 'E2E_BOT_TIMEOUT_MS', 8 * 60 * 1000, 8 * 60 * 1000),
        databaseNonceFile: String(env.E2E_DATABASE_NONCE_FILE || '').trim(),
        maxTransferAtomic: optionalPositiveAtomic(env, 'E2E_MAX_TRANSFER_ATOMIC'),
        feeCushionAtomic: optionalPositiveAtomic(env, 'E2E_FEE_CUSHION_ATOMIC') || 1000000000n
    });
}

function assertLiveSafety(config, env = process.env) {
    assert(config.mode === 'live-stagenet', 'live safety checks apply only to live-stagenet mode');
    assert(config.scenario, 'an explicit live scenario is required');
    assert(env.E2E_CONFIRM === LIVE_CONFIRM,
        `live run requires E2E_CONFIRM=${LIVE_CONFIRM}`);
    assert(env.E2E_SCENARIO_CONFIRM === config.scenario.scenarioConfirm,
        `live run requires E2E_SCENARIO_CONFIRM=${config.scenario.scenarioConfirm}`);
    assert(env.E2E_CANARY_PROFILE === SAFE_PROFILE_CONFIRM,
        `live run requires E2E_CANARY_PROFILE=${SAFE_PROFILE_CONFIRM}`);
    assert(config.maxTransferAtomic !== null,
        'live run requires an explicit E2E_MAX_TRANSFER_ATOMIC ceiling');
    assert(config.databaseNonceFile,
        'live run requires E2E_DATABASE_NONCE_FILE for the exact database handshake');
}

function canonicalAcknowledgement(disclosure) {
    assert(disclosure && typeof disclosure === 'object', 'commerce disclosure is missing');
    assert(disclosure.paidAcknowledgementRequired === true,
        'canary requires paid-action acknowledgement enforcement');
    assert(typeof disclosure.policyVersion === 'string'
        && disclosure.policyVersion.length >= 1
        && disclosure.policyVersion.length <= 64,
    'commerce disclosure has no valid policy version');
    assert(disclosure.service?.cryptoType === 'XMR'
        && disclosure.service?.network === 'stagenet'
        && disclosure.service?.isTestNetwork === true,
    'commerce disclosure is not canonical XMR stagenet policy');
    assert(disclosure.service?.paymentsEnabled === true
        && disclosure.service?.directPaidEntryEnabled === true
        && disclosure.service?.paidCreditsEnabled === true
        && disclosure.service?.soloPayoutsEnabled === true
        && disclosure.service?.anyPayoutsEnabled === true
        && disclosure.service?.paidPrestigeOnly === false
        && disclosure.service?.cryptoMatchPayoutsEnabled === false,
    'commerce disclosure does not describe both payout-enabled paid solo modes');
    assert(disclosure.operatedProduct?.id === OPERATED_PROFILE_ID,
        'commerce disclosure is not the reviewed Such Software monerogue.app profile');
    assert(String(disclosure.operatedProduct?.scopeNotice || '').includes('2×/3×')
        && String(disclosure.operatedProduct?.noRealValueNotice || '').includes('NO REAL VALUE'),
    'commerce disclosure is missing the 2x/3x or NO REAL VALUE operated-product warning');
    return Object.freeze({
        policyVersion: disclosure.policyVersion,
        ageEligible: true,
        termsRead: true,
        riskAccepted: true,
        testnetUnderstood: true
    });
}

async function jsonRequest(target, relative, options = {}) {
    const response = await fetch(new URL(relative, target), {
        ...options,
        signal: AbortSignal.timeout(options.timeout || 15000)
    });
    let body = null;
    try { body = await response.json(); } catch (_) { /* handled by callers */ }
    return { response, body };
}

async function fetchCanonicalAcknowledgement(config) {
    const result = await jsonRequest(config.target, '/api/disclosures');
    assert(result.response.status === 200, 'commerce disclosure endpoint is not HTTP 200');
    const cacheControl = String(result.response.headers.get('cache-control') || '').toLowerCase();
    assert(cacheControl.includes('no-store'), 'commerce disclosure endpoint is not no-store');
    const acknowledgement = canonicalAcknowledgement(result.body);
    assert(result.body?.links?.terms === '/terms'
        && result.body?.links?.privacy === '/privacy'
        && result.body?.links?.responsiblePlay === '/responsible-play',
    'commerce disclosure links are incomplete');
    return { disclosure: result.body, acknowledgement };
}

function enabledEconomyIds(economies) {
    if (!economies || typeof economies !== 'object' || Array.isArray(economies)) return [];
    return Object.keys(economies)
        .filter(key => economies[key] === true)
        .sort();
}

function assertPublicModeContract(modes) {
    assert(modes?.operatedProductProfileId === OPERATED_PROFILE_ID
        && modes?.cryptoMatchPayoutsEnabled === false,
    'game-mode endpoint is not the reviewed no-crypto-PvP operated profile');
    assert(modes?.soloEnabled === true && modes?.FREE?.enabled === true,
        'the original solo mode and free solo entry must be enabled');
    assert(modes?.PAID_SINGLE?.enabled === true
        && modes?.PAID_CREDITS?.enabled === true,
    'both direct and credits paid solo modes must be enabled');
    assert(modes?.match?.enabled === true
        && JSON.stringify(enabledEconomyIds(modes?.match?.economies))
            === JSON.stringify(['credits_prestige', 'free']),
    'match mode must expose only the reviewed free and credits-prestige economies');
    for (const mode of ['PAID_SINGLE', 'PAID_CREDITS']) {
        assert(Number(modes?.[mode]?.payoutMultiplier?.escape) === 2,
            `${mode} escape payout is not exactly 2x`);
        assert(Number(modes?.[mode]?.payoutMultiplier?.escapeWithTreasure) === 3,
            `${mode} treasure payout is not exactly 3x`);
    }
}

async function publicPreflight(config) {
    const ready = await jsonRequest(config.target, '/health/ready');
    assert(ready.response.status === 200 && ready.body?.ready === true,
        'dedicated canary is not ready');
    assert(ready.body?.chain?.network === 'stagenet'
        && ready.body?.chain?.source !== 'simulated',
    'dedicated canary is not using a real XMR stagenet daemon');
    assert(ready.body?.checks?.database === 'up'
        && ready.body?.checks?.chain === 'up'
        && ready.body?.checks?.wallet === 'up',
    'database, chain, or house wallet readiness failed');
    assert(ready.body?.money?.paymentsEnabled === true
        && ready.body?.money?.payoutsEnabled === true,
    'payment intake and payout dispatch must both be enabled');

    const modes = await jsonRequest(config.target, '/api/game-modes');
    assert(modes.response.status === 200, 'game-mode endpoint is not HTTP 200');
    assertPublicModeContract(modes.body);

    const stats = await jsonRequest(config.target, '/api/stats');
    assert(stats.response.status === 200
        && stats.body?.currencyLabel === 'sXMR'
        && stats.body?.payoutsEnabled === true,
    'public stats do not identify payout-enabled sXMR');

    const legal = await fetchCanonicalAcknowledgement(config);
    phase('localhost, stagenet, money-mode, and current-disclosure preflight passed');
    return legal;
}

function assertPrivateSecretFile(fileName, label) {
    const stat = fs.lstatSync(fileName);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
    assert((stat.mode & 0o077) === 0, `${label} must not be group/world accessible`);
}

function secretFromEnv(name, env = process.env) {
    const direct = String(env[name] || '').trim();
    const fileName = String(env[`${name}_FILE`] || '').trim();
    assert(!(direct && fileName), `${name} and ${name}_FILE are mutually exclusive`);
    if (!fileName) return direct;
    assertPrivateSecretFile(fileName, `${name}_FILE`);
    return fs.readFileSync(fileName, 'utf8').trim();
}

function loadAppModules() {
    const manifest = path.join(APP_ROOT, 'package.json');
    assert(fs.existsSync(manifest), 'repository package.json is missing');
    const appRequire = createRequire(manifest);
    return {
        io: appRequire('socket.io-client'),
        axios: appRequire('axios'),
        pg: appRequire('pg'),
        dotenv: appRequire('dotenv'),
        DigestAuthClient: appRequire('./payments/digestAuth').DigestAuthClient
    };
}

function createFundingRpc(modules, env = process.env) {
    let endpoint;
    try {
        endpoint = new URL(env.E2E_FUNDING_RPC_URL || '');
    } catch (_) {
        throw new Error('E2E_FUNDING_RPC_URL must be a valid localhost URL');
    }
    assertLocalUrl(endpoint, 'E2E_FUNDING_RPC_URL');
    assert(endpoint.pathname === '/' || endpoint.pathname === '',
        'E2E_FUNDING_RPC_URL must name the RPC origin only');

    const username = secretFromEnv('E2E_FUNDING_RPC_USER', env);
    const password = secretFromEnv('E2E_FUNDING_RPC_PASSWORD', env);
    const unauth = env.E2E_ALLOW_UNAUTH_FUNDING_RPC === 'I_ACCEPT_LOCAL_UNAUTH_RPC';
    assert((username && password) || unauth,
        'funding RPC needs digest credentials or the explicit localhost unauth guard');
    assert((username && password) || (!username && !password),
        'funding RPC digest credentials are incomplete');

    const base = modules.axios.create({ timeout: 15000 });
    const http = username && password
        ? new modules.DigestAuthClient(base, { username, password })
        : base;
    const rpcUrl = new URL('/json_rpc', endpoint).toString();

    async function raw(method, params = {}) {
        let response;
        try {
            response = await http.post(rpcUrl, {
                jsonrpc: '2.0', id: 'financial-canary', method, params
            }, { headers: { 'Content-Type': 'application/json' } });
        } catch (error) {
            throw new Error(`funding wallet RPC transport failed during ${method}: ${safeMessage(error.message)}`);
        }
        return response.data || {};
    }

    async function rpc(method, params = {}) {
        const data = await raw(method, params);
        if (data.error) {
            throw new Error(`funding wallet RPC rejected ${method}: ${safeMessage(data.error.message)}`);
        }
        return data.result || {};
    }

    return { raw, rpc };
}

async function fundingWalletPreflight(funding) {
    await funding.rpc('get_version');
    const height = await funding.rpc('get_height');
    assert(Number(height.height) > 0, 'funding wallet has no synchronized height');
    const addressResult = await funding.rpc('get_address', {
        account_index: 0, address_index: [0]
    });
    const address = String(addressResult.address || '');
    assert(/^[57][1-9A-HJ-NP-Za-km-z]{90,110}$/.test(address),
        'funding wallet primary address is not an XMR stagenet address');
    const validation = await funding.rpc('validate_address', { address, any_net_type: true });
    assert(validation.valid === true && validation.nettype === 'stagenet',
        'funding wallet did not validate its own address as stagenet');
    phase('separate funding wallet is synchronized and identifies as stagenet');
    return Object.freeze({ address });
}

function validateExpectedDatabaseName(name, scenario) {
    assert(/^[a-z0-9_]+$/i.test(name), 'E2E_EXPECT_DATABASE must be a simple database name');
    assert(/canary/i.test(name) && /e2e/i.test(name),
        'E2E_EXPECT_DATABASE must contain both canary and e2e');
    assert(scenario && name.toLowerCase().includes(scenario.databaseTag),
        'E2E_EXPECT_DATABASE must contain the selected scenario tag');
}

async function openReadOnlyDatabase(modules, config, env = process.env) {
    const connectionString = secretFromEnv('E2E_DATABASE_URL', env);
    const dbEnvFile = String(env.E2E_DATABASE_ENV_FILE || '').trim();
    const expected = String(env.E2E_EXPECT_DATABASE || '').trim();
    validateExpectedDatabaseName(expected, config.scenario);
    assert(Boolean(connectionString) !== Boolean(dbEnvFile),
        'set exactly one of E2E_DATABASE_URL[_FILE] or E2E_DATABASE_ENV_FILE');

    let clientConfig;
    if (connectionString) {
        let parsedUrl;
        try { parsedUrl = new URL(connectionString); } catch (_) {
            throw new Error('E2E_DATABASE_URL is not a valid PostgreSQL URL');
        }
        assert(['postgres:', 'postgresql:'].includes(parsedUrl.protocol),
            'E2E_DATABASE_URL must use PostgreSQL');
        assert(isLoopback(parsedUrl.hostname), 'E2E_DATABASE_URL must name localhost explicitly');
        assert(decodeURIComponent(parsedUrl.pathname.replace(/^\//, '')) === expected,
            'E2E_DATABASE_URL names a different database');
        clientConfig = { connectionString };
    } else {
        assertPrivateSecretFile(dbEnvFile, 'E2E_DATABASE_ENV_FILE');
        const parsed = modules.dotenv.parse(fs.readFileSync(dbEnvFile));
        assert(parsed.DB_NAME === expected,
            'protected database environment names a different database');
        assert(isLoopback(parsed.DB_HOST || 'localhost'),
            'protected database environment must name localhost explicitly');
        const dbPort = Number(parsed.DB_PORT || 5432);
        assert(Number.isInteger(dbPort) && dbPort > 0 && dbPort <= 65535,
            'protected database environment has an invalid DB_PORT');
        clientConfig = {
            host: parsed.DB_HOST || 'localhost',
            port: dbPort,
            database: parsed.DB_NAME,
            user: parsed.DB_USER,
            password: parsed.DB_PASSWORD
        };
    }

    const client = new modules.pg.Client(clientConfig);
    await client.connect();
    await client.query('SET default_transaction_read_only = on');
    const identity = await client.query(`
        SELECT current_database() AS name,
               current_setting('default_transaction_read_only') AS read_only
    `);
    assert(identity.rows[0]?.name === expected && identity.rows[0]?.read_only === 'on',
        'database identity or read-only guard failed');
    return client;
}

async function verifyCanaryDatabaseHandshake(config, db, env = process.env,
    request = jsonRequest) {
    assert(config.mode === 'live-stagenet',
        'database identity handshake applies only to live-stagenet mode');
    const expectedDatabase = String(env.E2E_EXPECT_DATABASE || '').trim();
    validateExpectedDatabaseName(expectedDatabase, config.scenario);
    const nonce = readNonceFile(config.databaseNonceFile, 'E2E_DATABASE_NONCE_FILE');
    const directIdentity = await readDatabaseIdentity(db);
    assert(directIdentity.databaseName === expectedDatabase,
        'read-only canary connection has the wrong database identity');

    const challenge = crypto.randomBytes(32).toString('hex');
    const result = await request(config.target, '/api/canary/database-identity', {
        headers: { 'X-Canary-Database-Challenge': challenge }
    });
    assert(result.response.status === 200,
        'canary database identity endpoint is unavailable');
    const cacheControl = String(result.response.headers.get('cache-control') || '').toLowerCase();
    assert(cacheControl.includes('no-store'),
        'canary database identity endpoint is not no-store');
    assert(result.body?.protocol === CANARY_HANDSHAKE_PROTOCOL
        && result.body?.challenge === challenge,
    'canary database identity protocol or challenge mismatch');

    const appIdentity = normalizeIdentity(result.body?.database);
    assert(appIdentity.clusterId === directIdentity.clusterId
        && appIdentity.databaseOid === directIdentity.databaseOid
        && appIdentity.databaseName === directIdentity.databaseName,
    'application and read-only harness are connected to different databases');
    const expectedProof = computeProof(nonce, directIdentity, challenge);
    assert(equalProof(result.body?.proof, expectedProof),
        'canary database identity proof is invalid');
    phase('application process and read-only harness share the exact canary database identity');
}

const EMPTY_FINANCIAL_KEYS = Object.freeze([
    'payments', 'games', 'payouts', 'receipts', 'refunds', 'late_reviews',
    'credit_transactions', 'entitlement_grants', 'pack_entitlements',
    'matches', 'match_entrants', 'match_events', 'match_queue_entries',
    'race_entry_transactions', 'race_entry_lots'
]);

async function assertEmptyFinancialDatabase(db) {
    const result = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM users
            WHERE socket_id = 'admin' AND username = 'admin' AND payout_address IS NULL) AS seed_admins,
          (SELECT COUNT(*)::int FROM payments) AS payments,
          (SELECT COUNT(*)::int FROM games) AS games,
          (SELECT COUNT(*)::int FROM payouts) AS payouts,
          (SELECT COUNT(*)::int FROM payment_receipts) AS receipts,
          (SELECT COUNT(*)::int FROM payment_refunds) AS refunds,
          (SELECT COUNT(*)::int FROM payment_late_reviews) AS late_reviews,
          (SELECT COUNT(*)::int FROM credit_transactions) AS credit_transactions,
          (SELECT COUNT(*)::int FROM payment_entitlement_grants) AS entitlement_grants,
          (SELECT COUNT(*)::int FROM user_pack_entitlements) AS pack_entitlements,
          (SELECT COUNT(*)::int FROM matches) AS matches,
          (SELECT COUNT(*)::int FROM match_entrants) AS match_entrants,
          (SELECT COUNT(*)::int FROM match_events) AS match_events,
          (SELECT COUNT(*)::int FROM match_queue_entries) AS match_queue_entries,
          (SELECT COUNT(*)::int FROM race_entry_transactions) AS race_entry_transactions,
          (SELECT COUNT(*)::int FROM race_entry_lots) AS race_entry_lots,
          (SELECT COUNT(*)::int FROM schema_migrations
            WHERE filename = ANY($1::text[])) AS required_migrations
    `, [REQUIRED_MIGRATIONS]);
    const row = result.rows[0] || {};
    assert(Number(row.users) === 1 && Number(row.seed_admins) === 1,
        'canary database does not contain exactly the migration-seeded admin');
    assert(Number(row.required_migrations) === REQUIRED_MIGRATIONS.length,
        'canary database is missing required financial migrations');
    for (const key of EMPTY_FINANCIAL_KEYS) {
        assert(Number(row[key]) === 0, `canary database is not financially empty (${key})`);
    }
    phase('fresh migrated scenario database has no prior gameplay or financial evidence');
}

class EventJournal {
    constructor(socket) {
        this.seq = 0;
        this.events = [];
        this.waiters = new Set();
        socket.onAny((name, ...args) => this.record(name, args[0]));
        socket.on('disconnect', reason => this.record('$disconnect', { reason }));
        socket.on('connect_error', error => this.record('$connect_error', {
            message: safeMessage(error.message)
        }));
    }

    record(name, data) {
        const item = { seq: ++this.seq, name, data };
        this.events.push(item);
        if (this.events.length > 6000) this.events.shift();
        for (const waiter of Array.from(this.waiters)) {
            if (waiter.after < item.seq
                && waiter.specs.some(spec => spec.name === name && spec.test(data))) {
                clearTimeout(waiter.timer);
                this.waiters.delete(waiter);
                waiter.resolve(item);
            }
        }
    }

    latest(name, test = () => true) {
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
            const item = this.events[index];
            if (item.name === name && test(item.data)) return item;
        }
        return null;
    }

    waitAny(specs, timeoutMs, after = 0) {
        const normalized = specs.map(spec => ({
            name: spec.name,
            test: spec.test || (() => true)
        }));
        const existing = this.events.find(item => item.seq > after
            && normalized.some(spec => spec.name === item.name && spec.test(item.data)));
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = { specs: normalized, after, resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(`timed out waiting for ${normalized.map(spec => spec.name).join(' or ')}`));
            }, timeoutMs);
            this.waiters.add(waiter);
        });
    }
}

function waitForConnect(socket) {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 15000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => {
            clearTimeout(timer);
            reject(new Error(`Socket.IO connection failed: ${safeMessage(error.message)}`));
        });
    });
}

function validFairnessOffer(data) {
    return Boolean(data)
        && typeof data.offerId === 'string'
        && /^[0-9a-f]{64}$/i.test(String(data.commitment || ''));
}

async function requestFreshFairness(socket, journal) {
    const after = journal.seq;
    socket.emit('fairness_offer_request');
    const event = await journal.waitAny([
        { name: 'fairness_offer', test: validFairnessOffer },
        { name: '$disconnect' }
    ], 10000, after);
    assert(event.name === 'fairness_offer', 'fresh fairness offer was not received');
    return Object.freeze({ ...event.data });
}

async function savePayoutAddress(socket, journal, payoutAddress) {
    const after = journal.seq;
    socket.emit('address:update', { address: payoutAddress });
    const outcome = await journal.waitAny([
        { name: 'address_confirmed', test: data => data?.cancelled !== true },
        { name: 'address_update_error' },
        { name: '$disconnect' }
    ], 30000, after);
    assert(outcome.name === 'address_confirmed',
        `payout address was not accepted (${outcome.name})`);
    assert(outcome.data?.address === payoutAddress,
        'server confirmed a different payout address');
    phase('anonymous canary identity saved the separate funding wallet as payout destination');
}

function parseInvoiceAmount(invoice, config) {
    const raw = String(invoice?.amount ?? '');
    assert(/^\d+$/.test(raw), 'invoice amount is not an atomic-unit integer');
    const amount = BigInt(raw);
    assert(amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER),
        'invoice amount is not a safe positive wallet-RPC value');
    assert(config.maxTransferAtomic !== null && amount <= config.maxTransferAtomic,
        'invoice exceeds E2E_MAX_TRANSFER_ATOMIC; no transfer was attempted');
    return amount;
}

function assertCommonInvoice(invoice, config, paymentType) {
    assert(invoice.paymentType === paymentType, 'server returned the wrong invoice type');
    assert(invoice.cryptoType === 'XMR' || invoice.currency === 'XMR',
        'invoice currency is not XMR');
    assert(/^[57][1-9A-HJ-NP-Za-km-z]{90,110}$/.test(String(invoice.address || '')),
        'invoice destination is not an XMR stagenet address');
    assert(Number.isSafeInteger(Number(invoice.paymentId)) && Number(invoice.paymentId) > 0,
        'invoice has no durable payment id');
    assert(invoice.reused !== true, 'fresh database unexpectedly reused an invoice');
    return parseInvoiceAmount(invoice, config);
}

async function createDirectInvoice(socket, journal, acknowledgement, config, modeInfo) {
    const offer = await requestFreshFairness(socket, journal);
    const clientSeed = crypto.randomBytes(32).toString('hex');
    const after = journal.seq;
    socket.emit('request_payment', {
        type: 'single_game',
        fairnessOfferId: offer.offerId,
        clientSeed,
        legalAcknowledgement: acknowledgement
    });
    const outcome = await journal.waitAny([
        { name: 'payment_created' },
        { name: 'payment_error' },
        { name: 'balance_critical' },
        { name: 'payment_review_required' },
        { name: '$disconnect' }
    ], 30000, after);
    assert(outcome.name === 'payment_created', `direct invoice creation failed (${outcome.name})`);
    const invoice = outcome.data || {};
    const amount = assertCommonInvoice(invoice, config, 'single_game');
    assert(amount === BigInt(String(modeInfo.singleGamePrice)),
        'direct invoice differs from advertised atomic entry price');
    assert(invoice.fairness?.offerId === offer.offerId
        && invoice.fairness?.commitment === offer.commitment
        && invoice.fairness?.clientSeed === clientSeed
        && Number(invoice.fairness?.proofVersion) === 2,
    'direct invoice did not persist the consumed fairness proof v2');
    phase('direct entry invoice is durably bound to a fresh fairness offer');
    return { invoice, amount, offer, clientSeed };
}

async function createCreditsInvoice(socket, journal, acknowledgement, config, packageInfo) {
    const after = journal.seq;
    socket.emit('request_payment', {
        type: 'credits_package',
        packageId: config.packageId,
        legalAcknowledgement: acknowledgement
    });
    const outcome = await journal.waitAny([
        { name: 'payment_created' },
        { name: 'payment_error' },
        { name: 'balance_critical' },
        { name: 'payment_review_required' },
        { name: '$disconnect' }
    ], 30000, after);
    assert(outcome.name === 'payment_created', `credits invoice creation failed (${outcome.name})`);
    const invoice = outcome.data || {};
    const amount = assertCommonInvoice(invoice, config, 'credits_package');
    assert(invoice.productId === config.packageId && invoice.package?.id === config.packageId,
        'credits invoice returned a different product');
    assert(amount === BigInt(String(packageInfo.price)),
        'credits invoice differs from advertised package price');
    assert(Number(invoice.grants?.credits) === packageInfo.grantedCredits,
        'credits invoice grant differs from advertised package grant');
    assert(invoice.fairness == null, 'credits purchase must not bind a game fairness offer');
    phase('pure credits package invoice matches its advertised product and grant');
    return {
        invoice,
        amount,
        grantedCredits: packageInfo.grantedCredits,
        creditsPerGame: packageInfo.creditsPerGame,
        payoutBase: packageInfo.payoutBase
    };
}

function assertInvoiceNotOwned(ownership) {
    assert(ownership && ownership.error,
        'invoice belongs to the funding wallet; self-payment is forbidden');
    const notOwned = /not.*belong|doesn.*belong|invalid.*address/i.test(
        String(ownership.error.message || '')
    );
    assert(notOwned, 'could not prove invoice and funding wallets are separate');
}

async function assertSeparateFundingWallet(funding, invoiceAddress) {
    const validation = await funding.rpc('validate_address', {
        address: invoiceAddress, any_net_type: true
    });
    assert(validation.valid === true && validation.nettype === 'stagenet',
        'funding wallet did not validate the invoice as stagenet');
    const ownership = await funding.raw('get_address_index', { address: invoiceAddress });
    assertInvoiceNotOwned(ownership);
    phase('invoice is valid stagenet and provably not owned by the funding wallet');
}

async function sendExactEntry(funding, invoiceAddress, amount, config, transferGate) {
    assert(transferGate && transferGate.attempted === false,
        'transfer retry is forbidden in one-shot canary execution');
    assert(amount <= config.maxTransferAtomic, 'transfer amount exceeds explicit ceiling');
    const balance = await funding.rpc('get_balance', { account_index: 0 });
    const unlocked = BigInt(String(balance.unlocked_balance || 0));
    assert(unlocked >= amount + config.feeCushionAtomic,
        'funding wallet lacks unlocked balance plus the configured fee cushion');

    // Mark the one-shot gate before the RPC call: an ambiguous transport failure must never retry.
    transferGate.attempted = true;
    const result = await funding.rpc('transfer', {
        destinations: [{ amount: Number(amount), address: invoiceAddress }],
        account_index: 0,
        priority: 1,
        get_tx_key: false,
        do_not_relay: false
    });
    const txHash = String(result.tx_hash || '');
    assert(/^[0-9a-f]{64}$/i.test(txHash),
        'funding transfer returned no valid transaction hash');
    phase('one exact, non-retriable XMR stagenet transfer was broadcast');
}

function pointKey(x, y) { return `${x},${y}`; }
function parsePointKey(value) { return value.split(',').map(Number); }

function addVisible(known, state) {
    for (const [yRaw, row] of Object.entries(state?.visibleTiles || {})) {
        for (const [xRaw, tile] of Object.entries(row || {})) {
            known.set(pointKey(Number(xRaw), Number(yRaw)), tile);
        }
    }
}

function blockedKeys(state, scenario) {
    const blocked = new Set();
    if (Number.isInteger(state?.monster?.x) && Number.isInteger(state?.monster?.y)) {
        blocked.add(pointKey(state.monster.x, state.monster.y));
    }
    const hasTreasure = state?.player?.hasTreasure === true;
    if (scenario.collectTreasure && !hasTreasure && Array.isArray(state?.exit)) {
        blocked.add(pointKey(Number(state.exit[0]), Number(state.exit[1])));
    }
    if (!scenario.collectTreasure && Array.isArray(state?.treasure)) {
        blocked.add(pointKey(Number(state.treasure[0]), Number(state.treasure[1])));
    }
    return blocked;
}

function bfs(known, state, scenario) {
    const start = pointKey(state.player.x, state.player.y);
    const blocked = blockedKeys(state, scenario);
    blocked.delete(start);
    const queue = [start];
    const parent = new Map([[start, null]]);
    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        const [x, y] = parsePointKey(current);
        for (const [dx, dy] of STEP_VECTORS) {
            const next = pointKey(x + dx, y + dy);
            if (parent.has(next) || blocked.has(next) || !FLOOR.has(known.get(next))) continue;
            parent.set(next, current);
            queue.push(next);
        }
    }
    return parent;
}

function pathTo(parent, target) {
    if (!parent.has(target)) return null;
    const result = [];
    for (let cursor = target; cursor !== null; cursor = parent.get(cursor)) result.push(cursor);
    result.reverse();
    return result;
}

function objectivePoint(state, scenario) {
    const wantsTreasure = scenario.collectTreasure && state?.player?.hasTreasure !== true;
    const point = wantsTreasure ? state?.treasure : state?.exit;
    assert(Array.isArray(point) && point.length === 2
        && Number.isInteger(Number(point[0])) && Number.isInteger(Number(point[1])),
    wantsTreasure ? 'treasure coordinate is unavailable' : 'exit coordinate is unavailable');
    return [Number(point[0]), Number(point[1])];
}

function chooseMove(known, state, bot, scenario) {
    assert(state?.player && Number.isInteger(state.player.x) && Number.isInteger(state.player.y),
        'bot received no valid player coordinate');
    const start = pointKey(state.player.x, state.player.y);
    const [targetX, targetY] = objectivePoint(state, scenario);
    const target = pointKey(targetX, targetY);
    if (bot.objective !== target) {
        bot.objective = target;
        bot.goal = null;
        bot.frontiersTried.clear();
    }

    const parent = bfs(known, state, scenario);
    let selectedPath = FLOOR.has(known.get(target)) ? pathTo(parent, target) : null;
    if (!selectedPath || selectedPath.length < 2) {
        if (bot.goal === start) {
            bot.frontiersTried.add(bot.goal);
            bot.goal = null;
        }
        if (bot.goal) {
            selectedPath = pathTo(parent, bot.goal);
            if (!selectedPath || selectedPath.length < 2) bot.goal = null;
        }
        if (!bot.goal) {
            const candidates = [];
            for (const candidate of parent.keys()) {
                if (candidate === start || bot.frontiersTried.has(candidate)) continue;
                const [x, y] = parsePointKey(candidate);
                const frontier = STEP_VECTORS.some(([dx, dy]) => !known.has(pointKey(x + dx, y + dy)));
                if (!frontier) continue;
                const candidatePath = pathTo(parent, candidate);
                candidates.push({
                    candidate,
                    path: candidatePath,
                    score: Math.abs(x - targetX) * 10
                        + Math.abs(y - targetY) * 10
                        + candidatePath.length
                });
            }
            candidates.sort((left, right) => left.score - right.score
                || left.candidate.localeCompare(right.candidate));
            assert(candidates.length > 0,
                'bounded bot exhausted safe exploration before reaching its objective');
            bot.goal = candidates[0].candidate;
            selectedPath = candidates[0].path;
        }
    }

    assert(selectedPath && selectedPath.length >= 2,
        'bounded bot could not choose a movement step');
    const [nextX, nextY] = parsePointKey(selectedPath[1]);
    const dx = nextX - state.player.x;
    const dy = nextY - state.player.y;
    if (dx === 1 && dy === 0) return 'right';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 0 && dy === 1) return 'down';
    if (dx === 0 && dy === -1) return 'up';
    throw new Error('bounded bot generated a non-adjacent movement');
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runBoundedBot(socket, journal, startEvent, scenario, config) {
    let state = startEvent.data;
    assert(Number(state?.maxDepth) === 1,
        'financial canary requires exactly one dungeon depth');
    assert(Array.isArray(state?.exit) && state.exit.length === 2,
        'game did not disclose an exit coordinate');
    if (scenario.collectTreasure) {
        assert(Array.isArray(state?.treasure) && state.treasure.length === 2,
            '3x scenario did not disclose a treasure coordinate');
    }
    const bot = {
        known: new Map(), frontiersTried: new Set(), goal: null, objective: null,
        depth: Number(state.depth || 1)
    };
    const deadline = Date.now() + config.botTimeoutMs;

    for (let moves = 0; moves < config.botMaxMoves && Date.now() < deadline; moves += 1) {
        if (state?.gameState && state.gameState !== 'active') {
            const terminal = await journal.waitAny([{ name: 'game_over' }, { name: '$disconnect' }],
                30000, startEvent.seq);
            assert(terminal.name === 'game_over', 'socket disconnected before game completion');
            return terminal.data;
        }
        assert(Number(state.depth || 1) === bot.depth, 'unexpected multi-depth transition');
        addVisible(bot.known, state);
        const direction = chooseMove(bot.known, state, bot, scenario);
        await delay(config.botMoveDelayMs);
        const after = journal.seq;
        socket.emit('player_move', { direction });
        const outcome = await journal.waitAny([
            { name: 'game_update' },
            { name: 'game_over' },
            { name: '$disconnect' }
        ], 8000, after);
        assert(outcome.name !== '$disconnect', 'socket disconnected during the canary game');
        if (outcome.name === 'game_over') return outcome.data;
        state = outcome.data;
    }
    throw new Error('bounded bot exceeded its move/time limit; no retry was attempted');
}

function verifyFairnessReveal(proof, startState, offer, clientSeed, treasureFound) {
    assert(proof?.gameId && proof.gameId === startState?.proof?.gameId,
        'game proof identity changed');
    assert(proof.offerId === offer.offerId
        && proof.commitment === offer.commitment
        && proof.clientSeed === clientSeed,
    'game reveal differs from the consumed fairness offer');
    assert(crypto.createHash('sha256').update(String(proof.serverSeed)).digest('hex')
        === proof.commitment,
    'revealed server seed does not match the pre-game commitment');
    const effective = crypto.createHmac('sha256', String(proof.serverSeed))
        .update(String(proof.clientSeed || '')).digest('hex');
    assert(effective === proof.effectiveSeed,
        'revealed effective seed does not include the client seed');
    assert(proof.gameResult?.won === true
        && proof.gameResult?.treasureFound === treasureFound,
    'fairness reveal carries incorrect outcome metadata');
}

function verifyGameOver(gameOver, context, startState) {
    const scenario = context.scenario;
    assert(gameOver?.status === 'won' && gameOver?.reason === 'escaped',
        'canary game did not end in an escape');
    assert(gameOver?.treasure === scenario.collectTreasure,
        'canary game has the wrong treasure outcome');
    const expected = context.payoutBase * BigInt(scenario.multiplier);
    const payout = gameOver?.payout?.payout;
    assert(gameOver?.payout?.success === true
        && gameOver?.payout?.mode === scenario.gameMode,
    'game completion did not commit the selected paid mode');
    assert(payout && ['queued', 'completed'].includes(payout.status),
        'game completion did not queue a payout');
    assert(BigInt(String(payout.amount)) === expected
        && Number(payout.multiplier) === scenario.multiplier,
    'committed payout does not match the exact scenario multiplier');
    verifyFairnessReveal(gameOver.proof, startState, context.offer,
        context.clientSeed, scenario.collectTreasure);
    phase('game outcome, fairness reveal, and exact payout liability verified');
    return {
        expected,
        payoutId: payout.payoutId,
        gameId: gameOver.proof.gameId
    };
}

async function ownedHistory(config, socketId, token, type) {
    const result = await jsonRequest(config.target,
        `/api/user/${encodeURIComponent(socketId)}/${type}?limit=20`, {
            headers: { 'X-Session-Token': token }
        });
    assert(result.response.status === 200, `${type} history is not HTTP 200`);
    return result.body;
}

async function waitForCompletedPayout(config, socketId, token, context) {
    const deadline = Date.now() + config.payoutTimeoutMs;
    while (Date.now() < deadline) {
        const history = await ownedHistory(config, socketId, token, 'payouts');
        assert(Number(history.total) <= 1, 'canary identity has more than one payout');
        const row = (history.payouts || []).find(item => String(item.id) === String(context.payoutId));
        if (row) {
            assert(BigInt(String(row.amount)) === context.expected
                && Number(row.multiplier) === config.scenario.multiplier,
            'payout history changed the committed payout identity');
            assert(row.reason === config.scenario.payoutReason && row.gameOutcome === 'escaped',
                'payout history has the wrong reason or game outcome');
            assert(row.status !== 'needs_review' && row.status !== 'permanently_failed',
                `payout entered terminal failure state ${row.status}`);
            if (row.status === 'completed') {
                assert(/^[0-9a-f]{64}$/i.test(String(row.txHash || '')),
                    'completed payout has no transaction evidence');
                assert(Number(history.total) === 1
                    && BigInt(String(history.totalReceived)) === context.expected,
                'completed payout aggregate is not exact');
                phase('application reports exactly one completed payout');
                return row;
            }
        }
        await delay(config.rpcPollMs);
    }
    throw new Error('payout did not reach completed before the bounded timeout');
}

async function waitForIncomingPayout(funding, txHash, expected, config) {
    const deadline = Date.now() + config.payoutTimeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await funding.rpc('get_transfer_by_txid', {
                txid: txHash, account_index: 0
            });
            const transfers = Array.isArray(result.transfers) && result.transfers.length
                ? result.transfers
                : (result.transfer ? [result.transfer] : []);
            const incoming = transfers.find(item => String(item.txid || item.tx_hash || '') === txHash
                && !['out', 'failed'].includes(String(item.type || '').toLowerCase()));
            if (incoming) {
                assert(BigInt(String(incoming.amount || 0)) === expected,
                    'funding wallet observed a different incoming payout amount');
                phase('separate funding wallet observed the exact incoming payout');
                return;
            }
        } catch (_) {
            // Wallet indexing can trail payout broadcast. The payout is never resent here.
        }
        await delay(config.rpcPollMs);
    }
    throw new Error('separate funding wallet did not observe the payout before timeout');
}

async function assertExactDatabaseCounts(db, scenario) {
    const result = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM payments) AS payments,
          (SELECT COUNT(*)::int FROM games) AS games,
          (SELECT COUNT(*)::int FROM payouts) AS payouts,
          (SELECT COUNT(*)::int FROM payment_receipts) AS receipts,
          (SELECT COUNT(*)::int FROM payment_refunds) AS refunds,
          (SELECT COUNT(*)::int FROM payment_late_reviews) AS late_reviews,
          (SELECT COUNT(*)::int FROM credit_transactions) AS credit_transactions,
          (SELECT COUNT(*)::int FROM payment_entitlement_grants) AS entitlement_grants,
          (SELECT COUNT(*)::int FROM user_pack_entitlements) AS pack_entitlements,
          (SELECT COUNT(*)::int FROM matches) AS matches,
          (SELECT COUNT(*)::int FROM match_entrants) AS match_entrants,
          (SELECT COUNT(*)::int FROM match_events) AS match_events,
          (SELECT COUNT(*)::int FROM match_queue_entries) AS match_queue_entries,
          (SELECT COUNT(*)::int FROM race_entry_transactions) AS race_entry_transactions,
          (SELECT COUNT(*)::int FROM race_entry_lots) AS race_entry_lots
    `);
    const row = result.rows[0] || {};
    const expected = {
        users: 2,
        payments: 1,
        games: 1,
        payouts: 1,
        receipts: 1,
        refunds: 0,
        late_reviews: 0,
        credit_transactions: 2,
        entitlement_grants: scenario.id === 'credits-3x' ? 1 : 0,
        pack_entitlements: 0,
        matches: 0,
        match_entrants: 0,
        match_events: 0,
        match_queue_entries: 0,
        race_entry_transactions: 0,
        race_entry_lots: 0
    };
    for (const [key, value] of Object.entries(expected)) {
        assert(Number(row[key]) === value, `unexpected durable row count for ${key}`);
    }
}

async function assertPaymentAndReceipt(db, context) {
    const payment = await db.query(`
        SELECT id, user_id, payment_type, expected_amount, received_amount, status,
               provider_id, product_id, product_grants, credits_purchased,
               address_index,
               (subaddress = $2) AS invoice_destination_matches,
               (provider_invoice_id = $2) AS provider_invoice_matches,
               fairness_proof_version, fairness_offer_id, fairness_commitment,
               fairness_client_seed,
               fairness_bound_at IS NOT NULL AS bound,
               fairness_consumed_at IS NOT NULL AS consumed,
               confirmed_at IS NOT NULL AS confirmed_at_set,
               confirmation_evidence_at IS NOT NULL AS evidence_at,
               (tx_hash ~ '^[0-9a-f]{64}$') AS valid_tx_hash
        FROM payments WHERE id = $1
    `, [context.paymentId, context.invoiceAddress]);
    const row = payment.rows[0];
    assert(row && row.payment_type === context.scenario.paymentType
        && row.status === 'confirmed' && row.provider_id === 'native-monero',
    'payment row has the wrong type, status, or provider');
    assert(BigInt(row.expected_amount) === context.entryAmount
        && BigInt(row.received_amount) === context.entryAmount,
    'payment row is not covered by the exact transferred amount');
    assert(row.confirmed_at_set && row.evidence_at && row.valid_tx_hash,
        'payment row lacks confirmation evidence');
    assert(row.invoice_destination_matches && row.provider_invoice_matches
        && Number.isInteger(Number(row.address_index)) && Number(row.address_index) >= 0,
    'payment row lacks its immutable invoice destination identity');

    if (context.scenario.id === 'direct-2x') {
        assert(row.product_id === 'single_game' && Number(row.credits_purchased) === 0
            && Number(row.product_grants?.credits || 0) === 0
            && Number(row.product_grants?.raceEntries || 0) === 0
            && Array.isArray(row.product_grants?.packs) && row.product_grants.packs.length === 0
            && row.product_grants?.premiumLevel == null,
            'direct payment product identity changed');
        assert(Number(row.fairness_proof_version) === 2 && row.bound && row.consumed,
            'direct payment fairness binding was not consumed exactly once');
        assert(row.fairness_offer_id === context.offer.offerId
            && row.fairness_commitment === context.offer.commitment
            && row.fairness_client_seed === context.clientSeed,
        'direct payment fairness identity changed');
    } else {
        assert(row.product_id === context.packageId
            && Number(row.credits_purchased) === context.grantedCredits
            && Number(row.product_grants?.credits) === context.grantedCredits
            && Number(row.product_grants?.raceEntries || 0) === 0
            && Array.isArray(row.product_grants?.packs) && row.product_grants.packs.length === 0
            && row.product_grants?.premiumLevel == null,
        'credits payment product or durable grant identity changed');
        assert(row.fairness_proof_version == null
            && row.fairness_offer_id == null
            && !row.bound && !row.consumed,
        'credits package was incorrectly bound to a game fairness offer');
    }

    const receipt = await db.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(r.amount), 0)::text AS amount,
               COUNT(DISTINCT r.provider_id || ':' || r.evidence_id)::int AS unique_count,
               BOOL_AND(r.confirmed) AS all_confirmed,
               BOOL_AND(r.evidence_type = 'chain_output') AS all_chain_outputs,
               BOOL_AND(r.provider_id = 'native-monero') AS all_native,
               BOOL_AND(r.tx_hash ~ '^[0-9a-f]{64}$') AS valid_hashes,
               BOOL_AND(r.output_id ~ '^[0-9a-f]{64}$' OR r.output_id ~ '^global:(0|[1-9][0-9]*)$')
                   AS valid_outputs,
               BOOL_AND(r.address_index >= 0 AND r.address_index = p.address_index)
                   AS valid_address_indexes,
               BOOL_AND(r.evidence_id = r.tx_hash || ':' || r.output_id) AS valid_evidence_ids
        FROM payment_receipts r
        JOIN payments p ON p.id = r.payment_id
        WHERE r.payment_id = $1
    `, [context.paymentId]);
    const evidence = receipt.rows[0];
    assert(Number(evidence.count) === 1 && Number(evidence.unique_count) === 1,
        'payment does not have exactly one unique receipt output');
    assert(BigInt(evidence.amount) === context.entryAmount
        && evidence.all_confirmed && evidence.all_chain_outputs && evidence.all_native
        && evidence.valid_hashes && evidence.valid_outputs
        && evidence.valid_address_indexes && evidence.valid_evidence_ids,
    'receipt evidence does not exactly authorize the invoice');
    return row.user_id;
}

async function assertGameAndPayout(db, context) {
    const result = await db.query(`
        SELECT g.user_id, g.dungeon_seed, g.game_mode,
               g.status AS game_status, g.outcome, g.treasure_found, g.payment_id,
               g.payout_eligible,
               g.completed_at IS NOT NULL AS game_completed,
               g.proof_revealed_at IS NOT NULL AS proof_revealed,
               g.moves_made,
               g.payout_committed_at IS NOT NULL AS committed,
               g.entry_consumed_at IS NOT NULL AS entry_consumed,
               g.entry_credits_spent,
               g.payout_escape_amount, g.payout_treasure_amount,
               g.payout_escape_mult, g.payout_treasure_mult,
               g.payout_terms->>'mode' AS terms_mode,
               g.payout_terms->>'escapeAmount' AS terms_escape_amount,
               g.payout_terms->>'treasureAmount' AS terms_treasure_amount,
               g.proof_version, g.fairness_offer_id, g.proof_commitment, g.client_seed,
               (g.payout_address = $2) AS game_address_matches,
               p.id AS payout_id, p.amount, p.multiplier, p.reason,
               p.status AS payout_status,
               p.processed_at IS NOT NULL AS payout_processed,
               (p.fee IS NULL OR p.fee >= 0) AS valid_payout_fee,
               (p.tx_hash ~ '^[0-9a-f]{64}$') AS valid_payout_tx_hash,
               (p.payout_address = $2) AS payout_address_matches
        FROM games g JOIN payouts p ON p.game_id = g.id
        WHERE g.dungeon_seed = $1
    `, [context.gameId, context.payoutAddress]);
    const row = result.rows[0];
    const escapeAmount = context.payoutBase * 2n;
    const treasureAmount = context.payoutBase * 3n;
    assert(row && row.game_mode === context.scenario.gameMode
        && row.game_status === 'won' && row.outcome === 'escaped'
        && row.treasure_found === context.scenario.collectTreasure,
    'durable game result does not match the selected scenario');
    assert(row.payout_eligible && row.game_completed && row.proof_revealed
        && Number(row.moves_made) > 0
        && row.committed && row.entry_consumed
        && row.game_address_matches,
    'game lacks committed entry/payout identity');
    assert(BigInt(row.payout_escape_amount) === escapeAmount
        && BigInt(row.payout_treasure_amount) === treasureAmount
        && Number(row.payout_escape_mult) === 2
        && Number(row.payout_treasure_mult) === 3,
    'game payout snapshot is not exact 2x/3x');
    assert(row.terms_mode === context.scenario.gameMode
        && BigInt(row.terms_escape_amount) === escapeAmount
        && BigInt(row.terms_treasure_amount) === treasureAmount,
    'immutable payout terms differ from snapshot columns');
    assert(Number(row.proof_version) === 2
        && row.fairness_offer_id === context.offer.offerId
        && row.proof_commitment === context.offer.commitment
        && row.client_seed === context.clientSeed,
    'durable game fairness identity changed');

    if (context.scenario.id === 'direct-2x') {
        assert(String(row.payment_id) === String(context.paymentId)
            && row.entry_credits_spent == null,
        'direct game did not consume exactly its bound payment');
    } else {
        assert(row.payment_id == null
            && Number(row.entry_credits_spent) === context.creditsPerGame,
        'credits game did not consume exactly its credit entry');
    }

    assert(String(row.payout_id) === String(context.payoutId)
        && BigInt(row.amount) === context.payoutAmount
        && Number(row.multiplier) === context.scenario.multiplier
        && row.reason === context.scenario.payoutReason,
    'durable payout identity differs from the committed scenario');
    assert(row.payout_status === 'completed' && row.payout_processed
        && row.valid_payout_fee && row.valid_payout_tx_hash
        && row.payout_address_matches,
    'durable payout is not completed with transaction evidence');
    return row.user_id;
}

async function assertCreditLedger(db, context, userId) {
    const userResult = await db.query(`
        SELECT credits, total_credits_purchased, total_games_played,
               (payout_address IS NOT NULL AND payout_address <> '') AS has_address,
               (socket_id = 'admin' OR username = 'admin') AS is_seed_admin
        FROM users WHERE id = $1
    `, [userId]);
    const user = userResult.rows[0];
    assert(user && user.has_address && !user.is_seed_admin
        && Number(user.total_games_played) === 1,
        'canary user identity or game counter is wrong');
    const ledger = await db.query(`
        SELECT amount, reason, balance_after, transaction_type, payment_id
        FROM credit_transactions WHERE user_id = $1 ORDER BY id
    `, [userId]);
    assert(ledger.rows.length === 2, 'canary user does not have exactly two credit-ledger rows');

    if (context.scenario.id === 'direct-2x') {
        assert(Number(user.credits) === 0 && Number(user.total_credits_purchased) === 1,
            'direct entry did not net to zero and advance purchase progress once');
        const [purchase, spend] = ledger.rows;
        assert(Number(purchase.amount) === 1 && purchase.reason === 'direct_entry'
            && purchase.transaction_type === 'purchase' && Number(purchase.balance_after) === 0
            && purchase.payment_id == null,
        'direct-entry purchase ledger row is not exact');
        assert(Number(spend.amount) === -1 && spend.reason === 'game_entry'
            && spend.transaction_type === 'spend' && Number(spend.balance_after) === 0
            && spend.payment_id == null,
        'direct-entry spend ledger row is not exact');
        return;
    }

    const finalBalance = context.grantedCredits - context.creditsPerGame;
    assert(Number(user.credits) === finalBalance
        && Number(user.total_credits_purchased) === context.grantedCredits,
    'credits package grant or post-entry balance is wrong');
    const [purchase, spend] = ledger.rows;
    assert(Number(purchase.amount) === context.grantedCredits
        && purchase.reason === 'package_purchase'
        && purchase.transaction_type === 'purchase'
        && Number(purchase.balance_after) === context.grantedCredits
        && String(purchase.payment_id) === String(context.paymentId),
    'package-purchase ledger row is not exact');
    assert(Number(spend.amount) === -context.creditsPerGame
        && spend.reason === 'game_entry'
        && spend.transaction_type === 'spend'
        && Number(spend.balance_after) === finalBalance
        && spend.payment_id == null,
    'credits game-entry ledger row is not exact');

    const grantResult = await db.query(`
        SELECT source, credits_granted, purchase_progress_granted,
               race_entries_granted, packs_granted, premium_level_granted,
               status, credits_reversed, purchase_progress_reversed,
               race_entries_reversed
        FROM payment_entitlement_grants WHERE payment_id = $1 AND user_id = $2
    `, [context.paymentId, userId]);
    const grant = grantResult.rows[0];
    assert(grantResult.rows.length === 1 && grant.source === 'product_confirmation'
        && grant.status === 'active'
        && Number(grant.credits_granted) === context.grantedCredits
        && Number(grant.purchase_progress_granted) === context.grantedCredits
        && Number(grant.race_entries_granted) === 0
        && Array.isArray(grant.packs_granted) && grant.packs_granted.length === 0
        && grant.premium_level_granted == null
        && Number(grant.credits_reversed) === 0
        && Number(grant.purchase_progress_reversed) === 0
        && Number(grant.race_entries_reversed) === 0,
    'payment-scoped credits entitlement marker is not exact');
}

async function assertDatabaseSettlement(db, context) {
    await assertExactDatabaseCounts(db, context.scenario);
    const paymentUserId = await assertPaymentAndReceipt(db, context);
    const gameUserId = await assertGameAndPayout(db, context);
    assert(String(paymentUserId) === String(gameUserId),
        'payment and game resolved to different stable users');
    await assertCreditLedger(db, context, paymentUserId);
    phase('exact receipt, entitlement, credit, game, liability, and payout rows verified');
}

function assertModeInfo(info, config) {
    assert(info?.operatedProductProfileId === OPERATED_PROFILE_ID
        && info?.cryptoType === 'XMR'
        && info.network === 'stagenet'
        && info.isTestNetwork === true
        && info.currencyLabel === 'sXMR'
        && info.gameName === 'Monerogue',
    'Socket.IO product identity is not Monerogue XMR stagenet');
    assert(info.paymentsEnabled && info.payoutsEnabled
        && info.directModeEnabled && info.creditsModeEnabled
        && info.directPayoutsEnabled && info.creditsPayoutsEnabled,
    'mixed direct/credits mode and both payout paths must be enabled');
    assert(info.smirkEnabled === false, 'Smirk must be disabled on stagenet');
    assert(info.modes?.solo === true
        && info.modes?.tavern === true
        && info.modes?.match?.enabled === true
        && JSON.stringify(enabledEconomyIds(info.modes?.match?.economies))
            === JSON.stringify(['credits_prestige', 'free']),
    'operated Tavern/match modes or crypto-PvP exclusion drifted');
    for (const key of ['direct', 'credits']) {
        assert(Number(info.payoutMultipliers?.[key]?.escape) === 2
            && Number(info.payoutMultipliers?.[key]?.escapeWithTreasure) === 3,
        `${key} Socket.IO payout multipliers are not exact 2x/3x`);
    }
    assert(/^\d+$/.test(String(info.singleGamePrice))
        && BigInt(String(info.singleGamePrice)) > 0n
        && BigInt(String(info.singleGamePrice)) * 3n <= BigInt(Number.MAX_SAFE_INTEGER),
    'Socket.IO direct price or its 3x result is not a safe positive atomic value');

    const selected = (info.creditPackages || []).find(item => item.id === config.packageId);
    assert(selected, 'selected credits package is not advertised');
    const grantedCredits = Number(selected.grants?.credits);
    const creditsPerGame = Number(info.creditsPerGame);
    assert(Number.isSafeInteger(grantedCredits) && Number.isSafeInteger(creditsPerGame)
        && grantedCredits >= creditsPerGame && creditsPerGame > 0,
    'selected package cannot fund exactly one credits game');
    assert(Number(selected.grants?.raceEntries || 0) === 0
        && Array.isArray(selected.grants?.packs) && selected.grants.packs.length === 0
        && selected.grants?.premiumLevel == null,
    'financial canary requires a pure credits-only package');
    assert(/^\d+$/.test(String(selected.price)) && BigInt(String(selected.price)) > 0n,
        'selected package has no positive atomic price');
    assert(/^\d+$/.test(String(info.creditsPayoutBaseValue))
        && BigInt(String(info.creditsPayoutBaseValue)) > 0n
        && BigInt(String(info.creditsPayoutBaseValue)) * 3n <= BigInt(Number.MAX_SAFE_INTEGER),
    'credits payout base or its 3x result is not a safe positive atomic value');
    return Object.freeze({
        ...selected,
        grantedCredits,
        creditsPerGame,
        payoutBase: BigInt(String(info.creditsPayoutBaseValue))
    });
}

async function waitForPaymentConfirmation(journal, paymentId, timeoutMs) {
    const outcome = await journal.waitAny([
        { name: 'payment_confirmed', test: data => String(data?.paymentId) === String(paymentId) },
        { name: 'payment_review_required' },
        { name: 'payment_underpaid' },
        { name: '$disconnect' }
    ], timeoutMs);
    assert(outcome.name === 'payment_confirmed', `payment was not confirmed (${outcome.name})`);
    phase('exact transfer became a receipt-backed confirmed payment');
    return outcome.data || {};
}

async function startCreditsGame(socket, journal, acknowledgement) {
    const offer = await requestFreshFairness(socket, journal);
    const clientSeed = crypto.randomBytes(32).toString('hex');
    const after = journal.seq;
    socket.emit('auto_start', {
        fairnessOfferId: offer.offerId,
        clientSeed,
        legalAcknowledgement: acknowledgement
    });
    const outcome = await journal.waitAny([
        { name: 'game_start' },
        { name: 'fairness_error' },
        { name: 'status_update', test: data => data?.type === 'error' || data?.status === 'error' },
        { name: '$disconnect' }
    ], 60000, after);
    assert(outcome.name === 'game_start', `credits game did not start (${outcome.name})`);
    assert(outcome.data?.proof?.offerId === offer.offerId
        && outcome.data?.proof?.commitment === offer.commitment
        && outcome.data?.proof?.clientSeed === clientSeed,
    'credits game did not consume the fresh fairness offer');
    return { gameStart: outcome, offer, clientSeed };
}

async function runLive(config, modules, db, legal, env = process.env) {
    assertLiveSafety(config, env);
    const funding = createFundingRpc(modules, env);
    const fundingIdentity = await fundingWalletPreflight(funding);
    const transferGate = { attempted: false };
    const socket = modules.io(config.target.origin, {
        autoConnect: false,
        transports: ['websocket', 'polling'],
        timeout: 12000,
        reconnection: false
    });
    const journal = new EventJournal(socket);

    try {
        socket.connect();
        await waitForConnect(socket);
        socket.emit('register_client', {
            clientId: socket.id,
            userAgent: 'monerogue-stagenet-financial-canary/1'
        });
        const sessionEvent = await journal.waitAny([{ name: 'session_token' }], 15000);
        const token = String(sessionEvent.data?.token || '');
        assert(token.length >= 32, 'anonymous canary session token was not issued');
        const modeEvent = await journal.waitAny([{ name: 'game_mode_info' }], 15000);
        const modeInfo = modeEvent.data || {};
        const packageInfo = assertModeInfo(modeInfo, config);

        // Refetch immediately before the value-bearing action so the echoed version is current.
        const currentLegal = await fetchCanonicalAcknowledgement(config);
        assert(currentLegal.disclosure.policyVersion === legal.disclosure.policyVersion,
            'commerce policy changed during preflight; no invoice was created');
        const acknowledgement = currentLegal.acknowledgement;
        await savePayoutAddress(socket, journal, fundingIdentity.address);

        let context;
        if (config.scenario.id === 'direct-2x') {
            const direct = await createDirectInvoice(socket, journal, acknowledgement, config, modeInfo);
            context = {
                scenario: config.scenario,
                paymentId: direct.invoice.paymentId,
                invoiceAddress: direct.invoice.address,
                payoutAddress: fundingIdentity.address,
                entryAmount: direct.amount,
                payoutBase: direct.amount,
                offer: direct.offer,
                clientSeed: direct.clientSeed
            };
            await assertSeparateFundingWallet(funding, direct.invoice.address);
            await sendExactEntry(funding, direct.invoice.address, direct.amount, config, transferGate);
            await waitForPaymentConfirmation(journal, direct.invoice.paymentId, config.paymentTimeoutMs);
            const gameStart = await journal.waitAny([
                { name: 'game_start' }, { name: '$disconnect' }
            ], 60000);
            assert(gameStart.name === 'game_start', 'direct paid game did not start');
            assert(gameStart.data?.proof?.offerId === direct.offer.offerId
                && gameStart.data?.proof?.commitment === direct.offer.commitment
                && gameStart.data?.proof?.clientSeed === direct.clientSeed,
            'started direct dungeon is not bound to its invoice fairness proof');
            context.gameStart = gameStart;
        } else {
            const purchase = await createCreditsInvoice(socket, journal, acknowledgement,
                config, packageInfo);
            context = {
                scenario: config.scenario,
                paymentId: purchase.invoice.paymentId,
                invoiceAddress: purchase.invoice.address,
                payoutAddress: fundingIdentity.address,
                entryAmount: purchase.amount,
                payoutBase: purchase.payoutBase,
                packageId: config.packageId,
                grantedCredits: purchase.grantedCredits,
                creditsPerGame: purchase.creditsPerGame
            };
            await assertSeparateFundingWallet(funding, purchase.invoice.address);
            await sendExactEntry(funding, purchase.invoice.address, purchase.amount, config, transferGate);
            const confirmation = await waitForPaymentConfirmation(journal,
                purchase.invoice.paymentId, config.paymentTimeoutMs);
            assert(Number(confirmation.creditsAdded) === purchase.grantedCredits
                && Number(confirmation.newBalance) === purchase.grantedCredits,
            'credits confirmation did not grant the exact advertised balance');
            const creditUpdate = journal.latest('credits_update', data =>
                Number(data?.balance) === purchase.grantedCredits);
            assert(creditUpdate, 'credits balance update was not observed after package confirmation');
            const started = await startCreditsGame(socket, journal, acknowledgement);
            context.offer = started.offer;
            context.clientSeed = started.clientSeed;
            context.gameStart = started.gameStart;
        }

        const gameOver = await runBoundedBot(socket, journal, context.gameStart,
            config.scenario, config);
        const completion = verifyGameOver(gameOver, context, context.gameStart.data);
        context.payoutId = completion.payoutId;
        context.payoutAmount = completion.expected;
        context.gameId = completion.gameId;

        const paymentHistory = await ownedHistory(config, socket.id, token, 'payments');
        assert(Number(paymentHistory.total) === 1 && paymentHistory.currency === 'XMR',
            'canary identity does not have exactly one XMR payment');
        const paymentRow = (paymentHistory.payments || []).find(row =>
            String(row.id) === String(context.paymentId));
        assert(paymentRow?.status === 'confirmed'
            && paymentRow.type === config.scenario.paymentType
            && BigInt(String(paymentRow.amount)) === context.entryAmount,
        'owned payment history differs from the confirmed invoice');
        if (config.scenario.id === 'credits-3x') {
            assert(Number(paymentRow.creditsReceived) === context.grantedCredits,
                'owned payment history has the wrong credit grant');
        }

        const payoutRow = await waitForCompletedPayout(config, socket.id, token, completion);
        await waitForIncomingPayout(funding, payoutRow.txHash, completion.expected, config);

        const credits = await jsonRequest(config.target,
            `/api/user/${encodeURIComponent(socket.id)}/credits`, {
                headers: { 'X-Session-Token': token }
            });
        assert(credits.response.status === 200, 'owned credits endpoint is not HTTP 200');
        const expectedCredits = config.scenario.id === 'direct-2x'
            ? 0
            : context.grantedCredits - context.creditsPerGame;
        const expectedProgress = config.scenario.id === 'direct-2x'
            ? 1
            : context.grantedCredits;
        assert(Number(credits.body?.credits) === expectedCredits
            && Number(credits.body?.totalCreditsPurchased) === expectedProgress,
        'owned credits endpoint differs from the exact scenario ledger');

        await assertDatabaseSettlement(db, context);
        phase(`PASS: ${config.scenario.id} completed with one payment, one game, and one payout`);
    } finally {
        try { socket.close(); } catch (_) { /* best effort */ }
    }
}

function printHelp() {
    process.stdout.write(`Monerogue XMR stagenet financial canary\n\n`
        + `Modes: preflight | database-preflight | live-stagenet\n`
        + `Scenarios: direct-2x | credits-3x\n\n`
        + `This harness is localhost-only, stagenet-only, fresh-database-only, and one-transfer-only.\n`
        + `Read ../docs/STAGENET_FINANCIAL_CANARY.md before live use.\n`);
}

async function main(env = process.env, argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp();
        return;
    }
    assert(argv.length === 0, 'only --help is accepted; configure the canary with E2E_* environment variables');
    const config = readConfiguration(env);
    if (config.mode === 'live-stagenet') assertLiveSafety(config, env);
    if (config.mode === 'database-preflight') {
        const modules = loadAppModules();
        const db = await openReadOnlyDatabase(modules, config, env);
        try {
            await assertEmptyFinancialDatabase(db);
            phase('database-preflight made no app session, invoice, or wallet RPC call');
        } finally {
            await db.end().catch(() => {});
        }
        return;
    }

    const legal = await publicPreflight(config);
    if (config.mode === 'preflight') {
        phase('preflight made no session, invoice, database mutation, or wallet RPC call');
        return;
    }

    const modules = loadAppModules();
    const db = await openReadOnlyDatabase(modules, config, env);
    try {
        await assertEmptyFinancialDatabase(db);
        // This is the final gate before runLive can touch the funding wallet, create an invoice,
        // or reach the harness's sole non-retriable transfer call.
        await verifyCanaryDatabaseHandshake(config, db, env);
        await runLive(config, modules, db, legal, env);
    } finally {
        await db.end().catch(() => {});
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`[stagenet-canary] FAIL: ${safeMessage(error.message)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    EMPTY_FINANCIAL_KEYS,
    LIVE_CONFIRM,
    OPERATED_PROFILE_ID,
    REQUIRED_MIGRATIONS,
    SAFE_PROFILE_CONFIRM,
    SCENARIOS,
    EventJournal,
    addVisible,
    assertEmptyFinancialDatabase,
    assertInvoiceNotOwned,
    assertLiveSafety,
    assertLocalUrl,
    assertPublicModeContract,
    blockedKeys,
    canonicalAcknowledgement,
    chooseMove,
    enabledEconomyIds,
    main,
    objectivePoint,
    readConfiguration,
    safeMessage,
    validateExpectedDatabaseName,
    verifyCanaryDatabaseHandshake,
    verifyGameOver
};
