'use strict';

/*
 * Database/process identity handshake for the isolated XMR stagenet canary.
 *
 * The endpoint is absent in every normal deployment.  When explicitly enabled, it reads the
 * PostgreSQL cluster id, database OID, and database name through the application's own pool and
 * signs that exact tuple plus a caller challenge with a one-run nonce.  The financial canary reads
 * the same tuple through its independent read-only connection and verifies the signature before it
 * is allowed to create an invoice or ask the funding wallet to broadcast.
 */

const crypto = require('crypto');
const fs = require('fs');

const CANARY_HANDSHAKE_CONFIRM = 'I_AM_AN_ISOLATED_XMR_STAGENET_CANARY';
const CANARY_HANDSHAKE_PROTOCOL = 'wowngeon-canary-database-identity-v1';
const HEX_256 = /^[0-9a-f]{64}$/;
const SIMPLE_DATABASE = /^[a-z0-9_]+$/i;

function invariant(condition, message) {
    if (!condition) throw new Error(message);
}

function isCanaryDatabaseName(name) {
    const value = String(name || '');
    return SIMPLE_DATABASE.test(value)
        && /canary/i.test(value)
        && /e2e/i.test(value)
        && (/(?:^|_)direct(?:_|$)/i.test(value) || /(?:^|_)credits(?:_|$)/i.test(value));
}

function isLoopbackAddress(address) {
    const value = String(address || '').toLowerCase();
    return value === '127.0.0.1'
        || value === '::1'
        || value === '::ffff:127.0.0.1';
}

function readNonceFile(fileName, label = 'canary database nonce file') {
    invariant(typeof fileName === 'string' && fileName.startsWith('/'),
        `${label} must be an absolute path`);
    const descriptor = fs.openSync(fileName, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(descriptor);
        invariant(stat.isFile(), `${label} must be a regular non-symlink file`);
        invariant((stat.mode & 0o077) === 0, `${label} must not be group/world accessible`);
        const nonce = fs.readFileSync(descriptor, 'utf8').trim();
        invariant(HEX_256.test(nonce), `${label} must contain exactly 256 bits of lowercase hex`);
        return nonce;
    } finally {
        fs.closeSync(descriptor);
    }
}

function normalizeIdentity(value) {
    const identity = {
        clusterId: String(value?.cluster_id ?? value?.clusterId ?? ''),
        databaseOid: String(value?.database_oid ?? value?.databaseOid ?? ''),
        databaseName: String(value?.database_name ?? value?.databaseName ?? '')
    };
    invariant(/^\d+$/.test(identity.clusterId), 'database cluster identity is unavailable');
    invariant(/^\d+$/.test(identity.databaseOid), 'database OID is unavailable');
    invariant(SIMPLE_DATABASE.test(identity.databaseName), 'database name is invalid');
    return Object.freeze(identity);
}

async function readDatabaseIdentity(db) {
    invariant(db && typeof db.query === 'function', 'database query interface is unavailable');
    const result = await db.query(`
        SELECT controls.system_identifier::text AS cluster_id,
               databases.oid::text AS database_oid,
               current_database() AS database_name
          FROM pg_catalog.pg_database AS databases
          CROSS JOIN pg_catalog.pg_control_system() AS controls
         WHERE databases.datname = current_database()
    `);
    invariant(result?.rows?.length === 1, 'database identity query returned an ambiguous result');
    return normalizeIdentity(result.rows[0]);
}

function proofPayload(identity, challenge) {
    const normalized = normalizeIdentity(identity);
    invariant(HEX_256.test(String(challenge || '')), 'canary challenge must be 256-bit lowercase hex');
    return [
        CANARY_HANDSHAKE_PROTOCOL,
        normalized.clusterId,
        normalized.databaseOid,
        normalized.databaseName,
        challenge
    ].join('\0');
}

function computeProof(nonce, identity, challenge) {
    invariant(HEX_256.test(String(nonce || '')), 'canary nonce is invalid');
    return crypto.createHmac('sha256', Buffer.from(nonce, 'hex'))
        .update(proofPayload(identity, challenge), 'utf8')
        .digest('hex');
}

function equalProof(actual, expected) {
    if (!HEX_256.test(String(actual || '')) || !HEX_256.test(String(expected || ''))) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function configuredCanaryHandshake(db, env = process.env) {
    const relevant = [
        env.CANARY_DATABASE_HANDSHAKE,
        env.CANARY_DATABASE_NONCE_FILE,
        env.CANARY_EXPECT_DATABASE
    ].some(value => String(value || '').trim() !== '');
    if (!relevant) return null;

    invariant(env.CANARY_DATABASE_HANDSHAKE === CANARY_HANDSHAKE_CONFIRM,
        `CANARY_DATABASE_HANDSHAKE must equal ${CANARY_HANDSHAKE_CONFIRM}`);
    invariant(String(env.NODE_ENV || '').toLowerCase() === 'production',
        'canary database handshake requires NODE_ENV=production');
    invariant(String(env.CRYPTO_TYPE || '').toUpperCase() === 'XMR'
        && String(env.MONERO_NETWORK || '').toLowerCase() === 'stagenet',
    'canary database handshake requires XMR stagenet');
    invariant(String(env.PORT || '') === '3102',
        'canary database handshake requires the dedicated application port 3102');

    const expectedDatabase = String(env.CANARY_EXPECT_DATABASE || '').trim();
    invariant(isCanaryDatabaseName(expectedDatabase),
        'CANARY_EXPECT_DATABASE must be a scenario-named canary E2E database');
    invariant(String(env.DB_NAME || '').trim() === expectedDatabase,
        'application DB_NAME differs from CANARY_EXPECT_DATABASE');
    const nonce = readNonceFile(String(env.CANARY_DATABASE_NONCE_FILE || '').trim());

    return Object.freeze({ db, expectedDatabase, nonce });
}

function createCanaryDatabaseIdentityHandler({ db, env = process.env } = {}) {
    const configured = configuredCanaryHandshake(db, env);
    if (!configured) return null;

    return async function canaryDatabaseIdentity(req, res) {
        // Use the TCP peer, never proxy-derived req.ip. Even an accidentally routed canary must
        // not disclose its PostgreSQL identity to a non-loopback caller.
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
            return res.status(404).json({ error: 'Not found.' });
        }
        const challenge = String(req.get('X-Canary-Database-Challenge') || '');
        if (!HEX_256.test(challenge)) {
            return res.status(400).json({ error: 'A valid canary database challenge is required.' });
        }

        const identity = await readDatabaseIdentity(configured.db);
        if (identity.databaseName !== configured.expectedDatabase) {
            return res.status(503).json({ error: 'Canary database identity mismatch.' });
        }

        res.json({
            protocol: CANARY_HANDSHAKE_PROTOCOL,
            challenge,
            database: identity,
            proof: computeProof(configured.nonce, identity, challenge)
        });
    };
}

module.exports = {
    CANARY_HANDSHAKE_CONFIRM,
    CANARY_HANDSHAKE_PROTOCOL,
    computeProof,
    configuredCanaryHandshake,
    createCanaryDatabaseIdentityHandler,
    equalProof,
    isCanaryDatabaseName,
    isLoopbackAddress,
    normalizeIdentity,
    readDatabaseIdentity,
    readNonceFile
};
