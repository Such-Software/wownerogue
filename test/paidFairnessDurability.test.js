const GameModeManager = require('../src/game/gameModeManager');
const { hashSeed } = require('../src/game/provablyFair');

const ENV_KEYS = [
    'NODE_ENV', 'REQUIRE_PAID_FAIRNESS_V2', 'GAME_MODE', 'SINGLE_GAME_PRICE',
    'CREDITS_PACKAGE_PRICE', 'CREDITS_PER_GAME', 'CREDITS_PAYOUT_ENABLED',
    'CREDITS_PAYOUTS_ENABLED'
];

function configManager() {
    return {
        getConfig: () => ({
            paymentsEnabled: true,
            currency: { symbol: 'XMR', decimals: 12 },
            modes: {
                direct: { enabled: true, price: 1000n },
                credits: { enabled: false, creditsPerGame: 1, packages: [] }
            },
            payouts: {
                enabled: false,
                rules: {
                    direct: { enabled: false, multipliers: { escape: 2, escapeWithTreasure: 3 } },
                    credits: { enabled: false, multipliers: { escape: 2, escapeWithTreasure: 3 } }
                }
            },
            preferences: { preferCreditsFirst: false }
        }),
        getLegacyGameMode: () => 'PAID_SINGLE',
        eventBus: { on: jest.fn() }
    };
}

function makeManager(db, provider = null) {
    const providers = provider ? { getProvider: jest.fn(() => provider) } : { getProvider: jest.fn(() => null) };
    return new GameModeManager(
        db,
        { createPaymentRequest: jest.fn() },
        { CONSOLE_LOGGING: false },
        configManager(),
        providers
    );
}

describe('paid fairness invoice durability', () => {
    let previousEnv;
    let logSpy;

    beforeEach(() => {
        previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
        process.env.NODE_ENV = 'production';
        process.env.REQUIRE_PAID_FAIRNESS_V2 = 'false';
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        for (const key of ENV_KEYS) {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        }
    });

    test('production cannot disable v2 and a new manager restores the invoice-bound proof', async () => {
        const serverSeed = '12'.repeat(32);
        const proof = {
            proofVersion: 2,
            offerId: 'offer-before-payment',
            offerIssuedAt: 1700000000123,
            serverSeed,
            commitment: hashSeed(serverSeed),
            clientSeed: '34'.repeat(32)
        };
        let insertParams;
        let insertSql;
        const expiresAt = new Date('2030-01-01T00:00:00.000Z');
        const db = {
            query: jest.fn(async (sql, params = []) => {
                if (/SELECT \* FROM users WHERE id/i.test(sql)) return { rows: [{ id: 7 }] };
                if (/UPDATE payments SET status = 'expired'/i.test(sql)) return { rows: [] };
                if (/INSERT INTO payments/i.test(sql)) {
                    insertSql = sql;
                    insertParams = params;
                    return { rows: [{ id: 55, expires_at: expiresAt }] };
                }
                return { rows: [] };
            })
        };
        const provider = {
            createInvoice: jest.fn(async () => ({
                address: 'stagenet-address',
                addressIndex: 9,
                invoiceId: 'invoice-55',
                expiresAt
            }))
        };
        const firstProcess = makeManager(db, provider);

        expect(firstProcess._requiresPaidFairnessV2()).toBe(true);
        const request = await firstProcess.createPaymentRequest('old-socket', 'single_game', {
            userId: 7,
            reuseExisting: false,
            fairnessProof: proof
        });
        expect(request.fairnessProof).toEqual(proof);
        // PostgreSQL's extended protocol rejects one placeholder when it is inferred as both
        // VARCHAR (the destination column) and TEXT (a CASE expression). Keep both uses explicit
        // and identical; this is exercised end-to-end by the stagenet invoice canary.
        expect(insertSql).toMatch(/\$12::varchar\(64\)/i);
        expect(insertSql).toMatch(/CASE WHEN \$12::varchar\(64\) IS NULL/i);
        expect(insertParams.slice(10, 16)).toEqual([
            2,
            proof.offerId,
            new Date(proof.offerIssuedAt),
            proof.commitment,
            proof.serverSeed,
            proof.clientSeed
        ]);

        // Simulate a process restart: only fields reconstructed from the payment row remain.
        const durableRow = {
            id: 55,
            subaddress: 'stagenet-address',
            expected_amount: '1000',
            payment_type: 'single_game',
            status: 'pending',
            expires_at: expiresAt,
            fairness_proof_version: insertParams[10],
            fairness_offer_id: insertParams[11],
            fairness_offer_issued_at: insertParams[12],
            fairness_commitment: insertParams[13],
            fairness_server_seed: insertParams[14],
            fairness_client_seed: insertParams[15],
            fairness_bound_at: new Date(),
            fairness_consumed_at: null
        };
        const restarted = makeManager({ query: jest.fn() });
        expect(restarted._mapPaymentRowToRequest(durableRow, 'single_game', null).fairnessProof)
            .toEqual(proof);
    });

    test('entry claim atomically verifies and consumes the exact invoice proof', async () => {
        const serverSeed = 'ab'.repeat(32);
        const offerIssuedAt = 1700000000999;
        const payment = {
            id: 90,
            user_id: 7,
            fairness_proof_version: 2,
            fairness_offer_id: 'restart-proof',
            fairness_offer_issued_at: new Date(offerIssuedAt),
            fairness_commitment: hashSeed(serverSeed),
            fairness_server_seed: serverSeed,
            fairness_client_seed: 'cd'.repeat(32),
            fairness_bound_at: new Date(),
            fairness_consumed_at: null
        };
        const calls = [];
        const client = {
            query: jest.fn(async (sql, params = []) => {
                calls.push({ sql, params });
                if (/SELECT \* FROM payments/i.test(sql)) return { rows: [payment] };
                if (/SELECT proof_version/i.test(sql)) {
                    return { rows: [{
                        proof_version: 2,
                        fairness_offer_id: payment.fairness_offer_id,
                        fairness_offer_issued_at: payment.fairness_offer_issued_at,
                        proof_commitment: payment.fairness_commitment,
                        server_seed: payment.fairness_server_seed,
                        client_seed: payment.fairness_client_seed
                    }] };
                }
                if (/UPDATE games/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
                if (/UPDATE payments[\s\S]*fairness_consumed_at/i.test(sql)) {
                    return { rows: [{ id: payment.id }], rowCount: 1 };
                }
                if (/UPDATE users/i.test(sql)) return { rows: [], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            })
        };
        const db = { withTransaction: jest.fn(async callback => callback(client)) };
        const manager = makeManager(db);

        await expect(manager._processGameStartWithPayment(
            { id: 7, payout_address: null },
            { id: payment.id },
            'game-proof-seed'
        )).resolves.toEqual(expect.objectContaining({ success: true, paymentId: payment.id }));

        const gameUpdate = calls.find(call => /UPDATE games/i.test(call.sql));
        const paymentConsume = calls.find(call => /UPDATE payments[\s\S]*fairness_consumed_at/i.test(call.sql));
        expect(gameUpdate.sql).toContain('entry_consumed_at = NOW()');
        expect(paymentConsume.sql).toContain('fairness_consumed_at IS NULL');
    });

    test('tampering with the persisted game proof aborts before entry consumption', async () => {
        const serverSeed = 'ef'.repeat(32);
        const payment = {
            id: 91,
            user_id: 7,
            fairness_proof_version: 2,
            fairness_offer_id: 'tamper-proof',
            fairness_offer_issued_at: new Date(1700000001234),
            fairness_commitment: hashSeed(serverSeed),
            fairness_server_seed: serverSeed,
            fairness_client_seed: '01'.repeat(32),
            fairness_bound_at: new Date(),
            fairness_consumed_at: null
        };
        const client = {
            query: jest.fn(async sql => {
                if (/SELECT \* FROM payments/i.test(sql)) return { rows: [payment] };
                if (/SELECT proof_version/i.test(sql)) {
                    return { rows: [{
                        proof_version: 2,
                        fairness_offer_id: payment.fairness_offer_id,
                        fairness_offer_issued_at: payment.fairness_offer_issued_at,
                        proof_commitment: payment.fairness_commitment,
                        server_seed: payment.fairness_server_seed,
                        client_seed: 'ff'.repeat(32)
                    }] };
                }
                return { rows: [], rowCount: 0 };
            })
        };
        const manager = makeManager({ withTransaction: jest.fn(async callback => callback(client)) });

        await expect(manager._processGameStartWithPayment(
            { id: 7, payout_address: null },
            { id: payment.id },
            'tampered-game'
        )).rejects.toMatchObject({ code: 'PAYMENT_FAIRNESS_MISMATCH' });
        expect(client.query.mock.calls.some(([sql]) => /UPDATE games/i.test(sql))).toBe(false);
    });
});
