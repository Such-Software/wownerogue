'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
    armed, healthAllowed, browserObserver, allowOnlyPublicOrigin, BROWSER_LAUNCH,
    leaveQueue, forfeitOwnedRound, cleanupClient
} = require('../src/scripts/public-free-acceptance');

const COMMIT = '6fca51695b941f3ef495912cc77b73790b490888';
const RELEASE = 'git-' + COMMIT.slice(0, 12);

function healthy() {
    return {
        ready: true,
        release: { verified: true, id: RELEASE, commit: COMMIT },
        games: { mode: 'FREE' },
        money: { paymentsEnabled: false, payoutsEnabled: false },
        checks: { database: 'up', chain: 'up', financialRecovery: 'reconciled',
            wallet: 'not_required', daemonIdentity: 'verified' },
        chain: { network: 'mainnet', source: 'daemon', height: 1 }
    };
}

function freeMode() {
    return {
        release: { verified: true, id: RELEASE, commit: COMMIT },
        operatedProductProfileId: 'such-play-wow-prestige', isTestNetwork: false,
        mode: 'FREE', freePlayEnabled: true, cryptoType: 'WOW', network: 'mainnet',
        paymentsEnabled: false, payoutsEnabled: false,
        directModeEnabled: false, creditsModeEnabled: false,
        directPayoutsEnabled: false, creditsPayoutsEnabled: false,
        features: { paymentRequired: false, creditsSystem: false, payouts: false },
        creditPackages: [], cosmeticProducts: [],
        modes: { tavern: true, match: { enabled: true, activeRuleset: { id: 'race' },
            economies: { free: true } } }
    };
}

function socketFixture() {
    const priorWindow = global.window;
    const events = new Map();
    const socket = { id: 'owned-a', on(name, listener) { events.set(name, listener); } };
    global.window = {};
    browserObserver({ commit: COMMIT, release: RELEASE });
    global.window.io = () => socket;
    global.window.io();
    return {
        facts: global.window.__publicFreeAcceptance,
        emit(name, payload) { events.get(name)(payload); },
        restore() { global.window = priorWindow; }
    };
}

function pageFixture(facts, onClick = null) {
    const clicks = [];
    const page = {
        evaluate(fn) { return Promise.resolve(fn()); },
        waitForFunction(fn) { if (!fn()) throw new Error('unacknowledged'); return Promise.resolve(); },
        locator(selector) {
            return {
                async click() {
                    clicks.push(selector);
                    if (onClick) onClick(selector, facts);
                    else {
                        if (selector === '#leaveMatchQueueBtn') facts.left = true;
                        if (selector === '#leaveSpectateBtn') facts.forfeitAck = true;
                    }
                }
            };
        },
        once() {}
    };
    return { page, clicks };
}

describe('fixed public free acceptance lane', () => {
    test('entrypoint refuses by default before health or browser work', () => {
        const script = path.resolve(__dirname, '../src/scripts/public-free-acceptance.js');
        const refused = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 2000 });
        expect(refused.status).toBe(2);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toMatch(/closed/i);
        expect(armed(['--run-public-free-acceptance'])).toBe(true);
        expect(armed(['--run-public-free-acceptance', '--origin=https://other.invalid'])).toBe(false);
        expect(armed(['--expected-commit=other'])).toBe(false);
        expect(BROWSER_LAUNCH.handleSIGINT).toBe(false);
        expect(BROWSER_LAUNCH.handleSIGTERM).toBe(false);
    });

    test('health requires exact verified release, real chain and closed money', () => {
        expect(healthAllowed(200, healthy())).toBe(true);
        const variants = [
            value => { value.release.commit = 'a'.repeat(40); },
            value => { value.release.verified = false; },
            value => { value.money.paymentsEnabled = true; },
            value => { value.money.payoutsEnabled = true; },
            value => { value.chain.source = 'simulated'; },
            value => { value.chain.network = 'stagenet'; },
            value => { value.checks.financialRecovery = 'pending'; },
            value => { value.checks.daemonIdentity = 'unverified'; }
        ];
        for (const mutate of variants) {
            const value = healthy();
            mutate(value);
            expect(healthAllowed(200, value)).toBe(false);
        }
        expect(healthAllowed(503, healthy())).toBe(false);
    });

    test('browser routes admit only the fixed public origin', async () => {
        const handlers = {};
        await allowOnlyPublicOrigin({
            route(_pattern, handler) { handlers.http = handler; },
            routeWebSocket(_pattern, handler) { handlers.socket = handler; }
        });
        const http = async address => {
            let decision = null;
            await handlers.http({ request: () => ({ url: () => address }),
                continue: () => { decision = 'allowed'; },
                abort: () => { decision = 'blocked'; } });
            return decision;
        };
        const socket = address => {
            let decision = null;
            handlers.socket({ url: () => address,
                connectToServer: () => { decision = 'allowed'; },
                close: () => { decision = 'blocked'; } });
            return decision;
        };
        expect(await http('https://play.wowne.ro/tavern')).toBe('allowed');
        expect(await http('https://other.invalid/tavern')).toBe('blocked');
        expect(await http('http://play.wowne.ro/tavern')).toBe('blocked');
        expect(socket('wss://play.wowne.ro/socket.io/')).toBe('allowed');
        expect(socket('wss://other.invalid/socket.io/')).toBe('blocked');
        expect(socket('ws://play.wowne.ro/socket.io/')).toBe('blocked');
    });

    test('browser event observer retains derived facts and rejects paid mode or outside entrants', () => {
        const fixture = socketFixture();
        try {
            fixture.emit('connect');
            fixture.emit('game_mode_info', freeMode());
            expect(fixture.facts.connected && fixture.facts.policy).toBe(true);
            fixture.emit('game_mode_info', { ...freeMode(), payoutsEnabled: true });
            expect(fixture.facts.policy).toBe(false);
            expect(fixture.facts.unsafe).toBe(true);
            fixture.emit('game_mode_info', freeMode());
            expect(fixture.facts.policy).toBe(true);
            expect(fixture.facts.unsafe).toBe(true);
            fixture.emit('game_mode_info', { ...freeMode(), modes: {
                tavern: true, match: { enabled: true, activeRuleset: { id: 'race' },
                    economies: { free: true, crypto_race: true } }
            } });
            expect(fixture.facts.policy).toBe(false);
            fixture.facts.ownedIds = ['owned-a', 'owned-b'];
            fixture.emit('match_queue_joined', { success: true, economy: 'free', position: 1,
                token: 'private-field-must-not-be-stored' });
            expect(fixture.facts.queue).toEqual({ success: true, free: true, position: 1 });
            fixture.emit('match_joined', { matchId: 'private-match', economy: 'free',
                ruleset: { id: 'race' }, countdownMs: 3000,
                players: [{ id: 'owned-a' }, { id: 'outside' }] });
            expect(fixture.facts.onlyOwned).toBe(false);
            expect(fixture.facts.unsafe).toBe(true);
            fixture.emit('match_joined', { matchId: 'private-match', economy: 'free',
                ruleset: { id: 'race' }, countdownMs: 3000,
                players: [{ id: 'owned-a' }, { id: 'owned-b' }] });
            expect(fixture.facts.onlyOwned).toBe(false);
            fixture.emit('match_tick', { matchId: 'private-match', state: { secret: 'not-stored' } });
            expect(JSON.stringify(fixture.facts)).not.toContain('not-stored');
        } finally { fixture.restore(); }
    });

    test('matched own entrants need countdown, start and durable result', () => {
        const fixture = socketFixture();
        try {
            fixture.facts.ownedIds = ['owned-a', 'owned-b'];
            fixture.emit('match_joined', { matchId: 'match', economy: 'free',
                ruleset: { id: 'race' }, countdownMs: 3000,
                players: [{ id: 'owned-a' }, { id: 'owned-b' }] });
            expect(fixture.facts.onlyOwned && fixture.facts.countdown).toBe(true);
            fixture.emit('match_joined', { matchId: 'different-match', economy: 'free',
                ruleset: { id: 'race' }, countdownMs: 3000,
                players: [{ id: 'owned-a' }, { id: 'owned-b' }] });
            expect(fixture.facts.unsafe).toBe(true);
        } finally { fixture.restore(); }
    });

    test('owned race derives movement and treats settlement pending as nonterminal', () => {
        const fixture = socketFixture();
        try {
            fixture.facts.ownedIds = ['owned-a', 'owned-b'];
            fixture.emit('match_joined', { matchId: 'match', economy: 'free',
                ruleset: { id: 'race' }, countdownMs: 3000,
                players: [{ id: 'owned-a' }, { id: 'owned-b' }] });
            fixture.emit('match_start', { matchId: 'match', ruleset: { id: 'race' } });
            fixture.emit('match_tick', { matchId: 'match', state: {
                players: [{ id: 'owned-a', x: 4, y: 7 }] } });
            fixture.emit('match_tick', { matchId: 'match', state: {
                players: [{ id: 'owned-a', x: 5, y: 7 }] } });
            fixture.emit('match_settlement_pending', { matchId: 'match' });
            expect(fixture.facts.started && fixture.facts.ticks === 2 && fixture.facts.moved).toBe(true);
            expect(fixture.facts.ended).toBe(false);
            expect(fixture.facts.settlementPending).toBe(true);
            fixture.emit('match_end', { matchId: 'match', players: [{ id: 'owned-a' }] });
            expect(fixture.facts.ended && fixture.facts.ownResult).toBe(true);
            expect(fixture.facts.settlementPending).toBe(false);
        } finally { fixture.restore(); }
    });

    test('queue cleanup requires own leave acknowledgement; outsider match blocks forfeit', async () => {
        const priorWindow = global.window;
        const facts = { queue: { success: true }, left: false, joined: false, started: false,
            ended: false, onlyOwned: false, settlementPending: false };
        global.window = { __publicFreeAcceptance: facts };
        try {
            const { page, clicks } = pageFixture(facts);
            expect(await leaveQueue(page)).toBe(true);
            expect(facts.left).toBe(true);
            expect(clicks).toEqual(['#leaveMatchQueueBtn']);
            facts.joined = facts.started = true;
            expect(await forfeitOwnedRound(page)).toBe(false);
            expect(clicks).toEqual(['#leaveMatchQueueBtn']);
            facts.onlyOwned = true;
            facts.settlementPending = true;
            expect(await forfeitOwnedRound(page)).toBe(false);
            facts.settlementPending = false;
            expect(await forfeitOwnedRound(page)).toBe(true);
            expect(facts.forfeitAck).toBe(true);
        } finally { global.window = priorWindow; }
    });

    test('missing queue acknowledgment is unknown, and a block-race transition reclassifies cleanup', async () => {
        const priorWindow = global.window;
        const facts = { joinIntent: true, queue: null, left: false, joined: false,
            started: false, ended: false, onlyOwned: false, settlementPending: false };
        global.window = { __publicFreeAcceptance: facts };
        try {
            const missing = pageFixture(facts);
            expect(await cleanupClient(missing.page)).toEqual({ clean: false, forfeited: false });
            expect(missing.clicks).toEqual([]);

            facts.queue = { success: true, free: true, position: 1 };
            const blockRace = pageFixture(facts, (selector, state) => {
                if (selector === '#leaveMatchQueueBtn') {
                    state.joined = state.started = state.onlyOwned = true;
                }
                if (selector === '#leaveSpectateBtn') state.forfeitAck = true;
            });
            expect(await cleanupClient(blockRace.page)).toEqual({ clean: true, forfeited: true });
            expect(blockRace.clicks).toEqual(['#leaveMatchQueueBtn', '#leaveSpectateBtn']);

            facts.joined = facts.started = facts.forfeitAck = false;
            facts.onlyOwned = false;
            const outside = pageFixture(facts, (selector, state) => {
                if (selector === '#leaveMatchQueueBtn') state.joined = state.started = true;
            });
            expect(await cleanupClient(outside.page)).toEqual({ clean: false, forfeited: false });
            expect(outside.clicks).toEqual(['#leaveMatchQueueBtn']);
        } finally { global.window = priorWindow; }
    });
});
