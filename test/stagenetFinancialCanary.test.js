'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    LIVE_CONFIRM,
    SAFE_PROFILE_CONFIRM,
    SCENARIOS,
    addVisible,
    assertEmptyFinancialDatabase,
    assertInvoiceNotOwned,
    assertLiveSafety,
    canonicalAcknowledgement,
    chooseMove,
    readConfiguration,
    safeMessage,
    validateExpectedDatabaseName,
    verifyCanaryDatabaseHandshake,
    verifyGameOver
} = require('../src/scripts/stagenet-financial-canary');
const {
    CANARY_HANDSHAKE_PROTOCOL,
    computeProof
} = require('../src/services/canaryDatabaseIdentity');

const SCRIPT = path.join(__dirname, '../src/scripts/stagenet-financial-canary.js');

function configEnv(overrides = {}) {
    return {
        E2E_MODE: 'preflight',
        E2E_TARGET: 'http://127.0.0.1:3102',
        ...overrides
    };
}

function botState() {
    return {
        goal: null,
        objective: null,
        frontiersTried: new Set()
    };
}

function visibleState({ player, exit, treasure }) {
    return {
        player,
        exit,
        treasure,
        monster: null,
        visibleTiles: {
            0: { 0: "'1", 1: "'1", 2: "'1" },
            1: { 0: "'1", 1: "'1", 2: "'1" }
        }
    };
}

describe('XMR stagenet financial canary safety contract', () => {
    test('recognizes only the two explicit financial scenarios', () => {
        expect(Object.keys(SCENARIOS)).toEqual(['direct-2x', 'credits-3x']);
        expect(SCENARIOS['direct-2x']).toEqual(expect.objectContaining({
            paymentType: 'single_game',
            gameMode: 'PAID_SINGLE',
            multiplier: 2,
            collectTreasure: false
        }));
        expect(SCENARIOS['credits-3x']).toEqual(expect.objectContaining({
            paymentType: 'credits_package',
            gameMode: 'PAID_CREDITS',
            multiplier: 3,
            collectTreasure: true
        }));
        expect(() => readConfiguration(configEnv({ E2E_SCENARIO: 'anything-else' })))
            .toThrow(/direct-2x or credits-3x/);
    });

    test('refuses public targets, embedded credentials, paths, and the wrong port', () => {
        expect(() => readConfiguration(configEnv({ E2E_TARGET: 'https://example.test:3102' })))
            .toThrow(/localhost/);
        expect(() => readConfiguration(configEnv({ E2E_TARGET: 'http://user:pass@127.0.0.1:3102' })))
            .toThrow(/credentials/);
        expect(() => readConfiguration(configEnv({ E2E_TARGET: 'http://127.0.0.1:3000' })))
            .toThrow(/3102/);
        expect(() => readConfiguration(configEnv({ E2E_TARGET: 'http://127.0.0.1:3102/app' })))
            .toThrow(/path/);
    });

    test('requires a scenario outside public preflight and scenario-specific live intent', () => {
        expect(() => readConfiguration(configEnv({ E2E_MODE: 'database-preflight' })))
            .toThrow(/E2E_SCENARIO/);

        const env = configEnv({
            E2E_MODE: 'live-stagenet',
            E2E_SCENARIO: 'credits-3x',
            E2E_MAX_TRANSFER_ATOMIC: '500000000000',
            E2E_CONFIRM: LIVE_CONFIRM,
            E2E_SCENARIO_CONFIRM: SCENARIOS['credits-3x'].scenarioConfirm,
            E2E_CANARY_PROFILE: SAFE_PROFILE_CONFIRM,
            E2E_DATABASE_NONCE_FILE: '/run/credentials/canary/database-nonce'
        });
        const config = readConfiguration(env);
        expect(() => assertLiveSafety(config, env)).not.toThrow();
        expect(() => assertLiveSafety(config, { ...env, E2E_SCENARIO_CONFIRM: 'DIRECT_2X_ESCAPE' }))
            .toThrow(/CREDITS_PACKAGE_THEN_3X/);
        expect(() => assertLiveSafety(config, { ...env, E2E_CONFIRM: '' }))
            .toThrow(/E2E_CONFIRM/);
        const noNonceConfig = readConfiguration({ ...env, E2E_DATABASE_NONCE_FILE: '' });
        expect(() => assertLiveSafety(noNonceConfig, env)).toThrow(/DATABASE_NONCE_FILE/);
        expect(() => assertLiveSafety(
            readConfiguration({ ...env, E2E_MAX_TRANSFER_ATOMIC: '' }), env
        )).toThrow(/MAX_TRANSFER/);
    });

    test('builds exactly the current five-field stagenet acknowledgement', () => {
        const acknowledgement = canonicalAcknowledgement({
            policyVersion: '2026-07-21-v2',
            paidAcknowledgementRequired: true,
            service: {
                cryptoType: 'XMR',
                network: 'stagenet',
                isTestNetwork: true,
                paymentsEnabled: true,
                directPaidEntryEnabled: true,
                paidCreditsEnabled: true,
                soloPayoutsEnabled: true,
                anyPayoutsEnabled: true,
                paidPrestigeOnly: false
            }
        });
        expect(acknowledgement).toEqual({
            policyVersion: '2026-07-21-v2',
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: true
        });
        expect(Object.keys(acknowledgement)).toHaveLength(5);
        expect(Object.isFrozen(acknowledgement)).toBe(true);
        expect(() => canonicalAcknowledgement({
            policyVersion: 'v1',
            paidAcknowledgementRequired: true,
            service: {
                cryptoType: 'XMR',
                network: 'mainnet',
                isTestNetwork: false,
                paymentsEnabled: true,
                directPaidEntryEnabled: true,
                paidCreditsEnabled: true,
                soloPayoutsEnabled: true,
                anyPayoutsEnabled: true,
                paidPrestigeOnly: false
            }
        })).toThrow(/stagenet/);
    });

    test('requires a scenario-named dedicated canary E2E database', () => {
        expect(() => validateExpectedDatabaseName(
            'monerogue_canary_direct_e2e', SCENARIOS['direct-2x']
        )).not.toThrow();
        expect(() => validateExpectedDatabaseName(
            'monerogue_canary_credits_e2e', SCENARIOS['credits-3x']
        )).not.toThrow();
        expect(() => validateExpectedDatabaseName('monerogue', SCENARIOS['direct-2x']))
            .toThrow(/canary and e2e/);
        expect(() => validateExpectedDatabaseName(
            'monerogue_canary_credits_e2e', SCENARIOS['direct-2x']
        )).toThrow(/scenario tag/);
    });

    test('freshness guard covers all financial/game ledgers and current migrations', async () => {
        const row = {
            users: 1,
            seed_admins: 1,
            required_migrations: 5,
            payments: 0,
            games: 0,
            payouts: 0,
            receipts: 0,
            refunds: 0,
            late_reviews: 0,
            credit_transactions: 0,
            entitlement_grants: 0,
            pack_entitlements: 0,
            matches: 0,
            match_entrants: 0,
            match_events: 0,
            match_queue_entries: 0,
            race_entry_transactions: 0,
            race_entry_lots: 0
        };
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const db = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
            await expect(assertEmptyFinancialDatabase(db)).resolves.toBeUndefined();
            expect(db.query.mock.calls[0][0]).toContain('payment_receipts');
            expect(db.query.mock.calls[0][0]).toContain('payment_entitlement_grants');
            expect(db.query.mock.calls[0][0]).toContain('race_entry_lots');

            const dirty = { query: jest.fn().mockResolvedValue({
                rows: [{ ...row, receipts: 1 }]
            }) };
            await expect(assertEmptyFinancialDatabase(dirty)).rejects.toThrow(/receipts/);
        } finally {
            write.mockRestore();
        }
    });

    test('verifies the app and harness exact database identity before the live runner', async () => {
        const directory = fs.mkdtempSync('/tmp/wowngeon-canary-handshake-');
        const nonceFile = path.join(directory, 'nonce');
        const nonce = 'cd'.repeat(32);
        fs.writeFileSync(nonceFile, `${nonce}\n`, { mode: 0o600 });
        const config = readConfiguration(configEnv({
            E2E_MODE: 'live-stagenet',
            E2E_SCENARIO: 'direct-2x',
            E2E_MAX_TRANSFER_ATOMIC: '1000',
            E2E_DATABASE_NONCE_FILE: nonceFile
        }));
        const identity = {
            clusterId: '7612345678901234567',
            databaseOid: '24591',
            databaseName: 'monerogue_canary_direct_e2e'
        };
        const db = { query: jest.fn().mockResolvedValue({ rows: [{
            cluster_id: identity.clusterId,
            database_oid: identity.databaseOid,
            database_name: identity.databaseName
        }] }) };
        const request = jest.fn(async (_target, relative, options) => {
            const challenge = options.headers['X-Canary-Database-Challenge'];
            return {
                response: {
                    status: 200,
                    headers: { get: name => name === 'cache-control' ? 'no-store' : null }
                },
                body: {
                    protocol: CANARY_HANDSHAKE_PROTOCOL,
                    challenge,
                    database: identity,
                    proof: computeProof(nonce, identity, challenge)
                }
            };
        });
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await expect(verifyCanaryDatabaseHandshake(config, db, {
                E2E_EXPECT_DATABASE: identity.databaseName
            }, request)).resolves.toBeUndefined();
            expect(request).toHaveBeenCalledWith(config.target,
                '/api/canary/database-identity', expect.any(Object));
        } finally {
            write.mockRestore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('requires affirmative proof that invoice and funding wallets differ', () => {
        expect(() => assertInvoiceNotOwned({
            error: { message: "Address doesn't belong to the wallet" }
        })).not.toThrow();
        expect(() => assertInvoiceNotOwned({ result: { index: { major: 0, minor: 1 } } }))
            .toThrow(/self-payment/);
        expect(() => assertInvoiceNotOwned({ error: { message: 'daemon unavailable' } }))
            .toThrow(/could not prove/);
    });

    test('direct bot avoids treasure while credits bot gets treasure before exit', () => {
        const directState = visibleState({
            player: { x: 0, y: 0, hasTreasure: false },
            treasure: [1, 0],
            exit: [0, 1]
        });
        const directKnown = new Map();
        addVisible(directKnown, directState);
        expect(chooseMove(directKnown, directState, botState(), SCENARIOS['direct-2x']))
            .toBe('down');

        const creditsState = visibleState({
            player: { x: 0, y: 0, hasTreasure: false },
            treasure: [1, 0],
            exit: [2, 0]
        });
        const creditsKnown = new Map();
        addVisible(creditsKnown, creditsState);
        const creditsBot = botState();
        expect(chooseMove(creditsKnown, creditsState, creditsBot, SCENARIOS['credits-3x']))
            .toBe('right');
        const collected = {
            ...creditsState,
            player: { x: 1, y: 0, hasTreasure: true },
            treasure: null
        };
        expect(chooseMove(creditsKnown, collected, creditsBot, SCENARIOS['credits-3x']))
            .toBe('right');
    });

    test.each([
        ['direct-2x', 10n, false],
        ['credits-3x', 7n, true]
    ])('verifies exact game-over liability and two-party proof for %s', (scenarioName, base, treasure) => {
        const scenario = SCENARIOS[scenarioName];
        const serverSeed = '11'.repeat(32);
        const clientSeed = '22'.repeat(32);
        const commitment = crypto.createHash('sha256').update(serverSeed).digest('hex');
        const effectiveSeed = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
        const offer = { offerId: '33'.repeat(32), commitment };
        const gameId = 'game-proof-id';
        const expected = base * BigInt(scenario.multiplier);
        const gameOver = {
            status: 'won',
            reason: 'escaped',
            treasure,
            payout: {
                success: true,
                mode: scenario.gameMode,
                payout: {
                    status: 'queued',
                    payoutId: 9,
                    amount: expected.toString(),
                    multiplier: scenario.multiplier
                }
            },
            proof: {
                gameId,
                offerId: offer.offerId,
                commitment,
                clientSeed,
                serverSeed,
                effectiveSeed,
                gameResult: { won: true, treasureFound: treasure }
            }
        };
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            expect(verifyGameOver(gameOver, {
                scenario, payoutBase: base, offer, clientSeed
            }, { proof: { gameId } })).toEqual({
                expected,
                payoutId: 9,
                gameId
            });
        } finally {
            write.mockRestore();
        }
    });

    test('redacts addresses, hashes, tokens, credentials, and database URL passwords', () => {
        const address = '5'.repeat(95);
        const hash = 'a'.repeat(64);
        const raw = `${address} ${hash} token=secret {"authorization":"jsonsecret"} Bearer othersecret `
            + 'postgres://alice:password@example.invalid/db';
        const safe = safeMessage(raw);
        expect(safe).toContain('[redacted-address]');
        expect(safe).toContain('[redacted-64-byte-value]');
        expect(safe).not.toContain(address);
        expect(safe).not.toContain(hash);
        expect(safe).not.toContain('secret');
        expect(safe).not.toContain('password@example');
    });

    test('source has one non-retriable relay call, a guarded main, and both exact flows', () => {
        const source = fs.readFileSync(SCRIPT, 'utf8');
        expect((source.match(/funding\.rpc\('transfer'/g) || [])).toHaveLength(1);
        expect(source).toMatch(/transferGate\.attempted = true;[\s\S]*do_not_relay: false/);
        expect(source).toContain('if (require.main === module)');
        expect(source).toContain("type: 'single_game'");
        expect(source).toContain("type: 'credits_package'");
        expect(source).toContain("socket.emit('auto_start'");
        expect(source).toContain('legalAcknowledgement: acknowledgement');
        expect(source).not.toContain('console.log(');
        const mainBody = source.slice(source.indexOf('async function main('));
        expect(mainBody.indexOf('assertLiveSafety(config, env)'))
            .toBeLessThan(mainBody.indexOf('publicPreflight(config)'));
        expect(mainBody.indexOf('verifyCanaryDatabaseHandshake(config, db, env)'))
            .toBeLessThan(mainBody.indexOf('runLive(config, modules, db, legal, env)'));

        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/package.json'), 'utf8'));
        expect(manifest.scripts['canary:stagenet'])
            .toBe('node scripts/stagenet-financial-canary.js');
    });
});
