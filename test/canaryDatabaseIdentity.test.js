'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    CANARY_HANDSHAKE_CONFIRM,
    CANARY_HANDSHAKE_PROTOCOL,
    computeProof,
    createCanaryDatabaseIdentityHandler,
    equalProof,
    readDatabaseIdentity
} = require('../src/services/canaryDatabaseIdentity');

function protectedNonceFile(nonce = 'ab'.repeat(32)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wowngeon-canary-nonce-'));
    const fileName = path.join(directory, 'nonce');
    fs.writeFileSync(fileName, `${nonce}\n`, { mode: 0o600 });
    return { directory, fileName, nonce };
}

function enabledEnv(fileName, overrides = {}) {
    return {
        NODE_ENV: 'production',
        CRYPTO_TYPE: 'XMR',
        MONERO_NETWORK: 'stagenet',
        PORT: '3102',
        DB_NAME: 'monerogue_canary_direct_e2e',
        CANARY_EXPECT_DATABASE: 'monerogue_canary_direct_e2e',
        CANARY_DATABASE_HANDSHAKE: CANARY_HANDSHAKE_CONFIRM,
        CANARY_DATABASE_NONCE_FILE: fileName,
        ...overrides
    };
}

function responseRecorder() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

describe('isolated canary database identity endpoint', () => {
    test('is absent by default and fails closed on partial or non-stagenet configuration', () => {
        expect(createCanaryDatabaseIdentityHandler({ db: {}, env: {} })).toBeNull();
        expect(() => createCanaryDatabaseIdentityHandler({
            db: {}, env: { CANARY_EXPECT_DATABASE: 'monerogue_canary_direct_e2e' }
        })).toThrow(/CANARY_DATABASE_HANDSHAKE/);

        const fixture = protectedNonceFile();
        try {
            expect(() => createCanaryDatabaseIdentityHandler({
                db: {}, env: enabledEnv(fixture.fileName, { MONERO_NETWORK: 'mainnet' })
            })).toThrow(/XMR stagenet/);
            expect(() => createCanaryDatabaseIdentityHandler({
                db: {}, env: enabledEnv(fixture.fileName, { PORT: '3000' })
            })).toThrow(/3102/);
            expect(() => createCanaryDatabaseIdentityHandler({
                db: {}, env: enabledEnv(fixture.fileName, { DB_NAME: 'monerogue' })
            })).toThrow(/DB_NAME/);

            fs.chmodSync(fixture.fileName, 0o644);
            expect(() => createCanaryDatabaseIdentityHandler({
                db: {}, env: enabledEnv(fixture.fileName)
            })).toThrow(/group\/world/);
            fs.chmodSync(fixture.fileName, 0o600);
            const link = path.join(fixture.directory, 'nonce-link');
            fs.symlinkSync(fixture.fileName, link);
            expect(() => createCanaryDatabaseIdentityHandler({
                db: {}, env: enabledEnv(link)
            })).toThrow();
        } finally {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    });

    test('signs the application pool exact cluster, OID, database, and caller challenge', async () => {
        const fixture = protectedNonceFile();
        const identity = {
            cluster_id: '7612345678901234567',
            database_oid: '24591',
            database_name: 'monerogue_canary_direct_e2e'
        };
        const db = { query: jest.fn().mockResolvedValue({ rows: [identity] }) };
        try {
            const handler = createCanaryDatabaseIdentityHandler({
                db, env: enabledEnv(fixture.fileName)
            });
            const challenge = '12'.repeat(32);
            const response = responseRecorder();
            await handler({
                get: () => challenge,
                socket: { remoteAddress: '::ffff:127.0.0.1' }
            }, response);

            expect(response.statusCode).toBe(200);
            expect(response.body).toEqual(expect.objectContaining({
                protocol: CANARY_HANDSHAKE_PROTOCOL,
                challenge,
                database: {
                    clusterId: identity.cluster_id,
                    databaseOid: identity.database_oid,
                    databaseName: identity.database_name
                }
            }));
            const expected = computeProof(fixture.nonce, response.body.database, challenge);
            expect(equalProof(response.body.proof, expected)).toBe(true);
            expect(JSON.stringify(response.body)).not.toContain(fixture.nonce);
            expect(db.query.mock.calls[0][0]).toContain('pg_control_system()');
        } finally {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    });

    test('rejects malformed challenges and refuses an application pool on another database', async () => {
        const fixture = protectedNonceFile();
        try {
            const wrongDb = { query: jest.fn().mockResolvedValue({ rows: [{
                cluster_id: '7612345678901234567',
                database_oid: '24592',
                database_name: 'monerogue_canary_credits_e2e'
            }] }) };
            const handler = createCanaryDatabaseIdentityHandler({
                db: wrongDb, env: enabledEnv(fixture.fileName)
            });
            const malformed = responseRecorder();
            const remote = responseRecorder();
            await handler({
                get: () => '34'.repeat(32), socket: { remoteAddress: '192.0.2.10' }
            }, remote);
            expect(remote.statusCode).toBe(404);
            expect(wrongDb.query).not.toHaveBeenCalled();

            await handler({
                get: () => 'not-a-challenge', socket: { remoteAddress: '127.0.0.1' }
            }, malformed);
            expect(malformed.statusCode).toBe(400);
            expect(wrongDb.query).not.toHaveBeenCalled();

            const mismatch = responseRecorder();
            await handler({
                get: () => '34'.repeat(32), socket: { remoteAddress: '::1' }
            }, mismatch);
            expect(mismatch.statusCode).toBe(503);
            expect(mismatch.body).toEqual({ error: 'Canary database identity mismatch.' });
        } finally {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    });

    test('requires one unambiguous row from PostgreSQL identity functions', async () => {
        await expect(readDatabaseIdentity({
            query: jest.fn().mockResolvedValue({ rows: [] })
        })).rejects.toThrow(/ambiguous/);
        await expect(readDatabaseIdentity({
            query: jest.fn().mockResolvedValue({ rows: [{
                cluster_id: '', database_oid: '1', database_name: 'db'
            }] })
        })).rejects.toThrow(/cluster identity/);
    });
});
