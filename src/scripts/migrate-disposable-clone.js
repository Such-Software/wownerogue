#!/usr/bin/env node
'use strict';

/*
 * Apply the application's normal migrations to an already-created disposable database clone.
 *
 * This command intentionally cannot create, drop, restore, audit, or activate anything.  Its
 * target is supplied only through the inherited environment; accepting command-line options
 * would make it too easy to place database credentials in argv or shell history.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const DatabaseManager = require('../db/databaseManager');

const CONFIRM_PREFIX = 'MIGRATE_DISPOSABLE_CLONE:';
const MINIMUM_RELEASE_MIGRATION = 40;
const MIGRATIONS_PATH = path.join(__dirname, '..', 'migrations');
const DATABASE_NAME = /^[a-z][a-z0-9_]{2,62}$/;
const DATABASE_USER = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION_FILE = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;
const ALLOWED_PRODUCT_PREFIXES = new Set(['monerogue', 'wownerogue', 'wowngeon']);
const DISPOSABLE_TOKENS = new Set(['clone', 'restore', 'canary']);
const LIVE_TOKENS = new Set([
    'active', 'current', 'live', 'mainnet', 'master', 'primary', 'prd', 'prod', 'production'
]);
const LOCAL_TCP_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_SOCKET_DIRS = new Set(['/run/postgresql', '/var/run/postgresql']);

class CloneMigrationRefusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'CloneMigrationRefusal';
    }
}

class CloneMigrationVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CloneMigrationVerificationError';
    }
}

function invariant(condition, message, ErrorType = CloneMigrationRefusal) {
    if (!condition) throw new ErrorType(message);
}

function cloneMigrationConfirmation(databaseName) {
    return `${CONFIRM_PREFIX}${databaseName}`;
}

function isLocalDatabaseHost(host) {
    const value = String(host || '').trim();
    if (LOCAL_TCP_HOSTS.has(value.toLowerCase())) return true;
    return LOCAL_SOCKET_DIRS.has(value);
}

function isDisposableCloneDatabaseName(databaseName) {
    const name = String(databaseName || '');
    if (!DATABASE_NAME.test(name)) return false;

    const tokens = name.split('_');
    if (!ALLOWED_PRODUCT_PREFIXES.has(tokens[0])) return false;
    if (tokens.some(token => [...LIVE_TOKENS].some(live => token.startsWith(live)))) return false;
    return tokens.some(token => DISPOSABLE_TOKENS.has(token));
}

function validateCloneMigrationEnvironment(env = process.env, argv = []) {
    invariant(Array.isArray(argv) && argv.length === 0,
        'command-line arguments are forbidden; use a protected inherited environment');
    invariant(!String(env.DATABASE_URL || '').trim(),
        'DATABASE_URL is forbidden because it is ambiguous and may contain credentials');

    const database = String(env.DB_NAME || '').trim();
    const expectedDatabase = String(env.CLONE_MIGRATION_EXPECT_DATABASE || '').trim();
    invariant(isDisposableCloneDatabaseName(database),
        'DB_NAME must be a Wowngeon clone, restore, or canary name and must not look live');
    invariant(expectedDatabase === database,
        'CLONE_MIGRATION_EXPECT_DATABASE must exactly equal DB_NAME');
    invariant(env.CLONE_MIGRATION_CONFIRM === cloneMigrationConfirmation(database),
        `CLONE_MIGRATION_CONFIRM must exactly bind the disposable confirmation to ${database}`);

    const host = String(env.DB_HOST || '').trim();
    invariant(isLocalDatabaseHost(host),
        'DB_HOST must be loopback or a standard local PostgreSQL socket directory');

    const portText = String(env.DB_PORT || '').trim();
    const port = Number(portText);
    invariant(/^\d{1,5}$/.test(portText) && Number.isInteger(port) && port >= 1 && port <= 65535,
        'DB_PORT must be an explicit TCP port from 1 through 65535');

    const user = String(env.DB_USER || '').trim();
    invariant(DATABASE_USER.test(user), 'DB_USER must be an explicit simple PostgreSQL role name');

    return Object.freeze({ database, expectedDatabase, host, port, user });
}

function discoverMigrationManifest(migrationsPath = MIGRATIONS_PATH) {
    const entries = fs.readdirSync(migrationsPath, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.name.endsWith('.sql'))
        .map(entry => {
            invariant(entry.isFile(), `migration entry is not a regular file: ${entry.name}`,
                CloneMigrationVerificationError);
            const match = MIGRATION_FILE.exec(entry.name);
            invariant(match, `migration filename is not canonical: ${entry.name}`,
                CloneMigrationVerificationError);
            return { filename: entry.name, ordinal: Number(match[1]) };
        })
        .sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);

    invariant(files.length > 0, 'no repository migrations were found',
        CloneMigrationVerificationError);
    files.forEach((file, index) => {
        invariant(file.ordinal === index + 1,
            `repository migration sequence is not contiguous at ${file.filename}`,
            CloneMigrationVerificationError);
    });

    const latest = files[files.length - 1];
    invariant(latest.ordinal >= MINIMUM_RELEASE_MIGRATION,
        `repository schema is older than required migration ${MINIMUM_RELEASE_MIGRATION}`,
        CloneMigrationVerificationError);

    return Object.freeze({
        files: Object.freeze(files.map(file => file.filename)),
        latestFilename: latest.filename,
        latestOrdinal: latest.ordinal
    });
}

function verifyExactMigrationLedger(rows, manifest) {
    invariant(Array.isArray(rows), 'schema_migrations query did not return rows',
        CloneMigrationVerificationError);
    const actual = rows.map(row => String(row?.filename || ''));
    invariant(actual.length === manifest.files.length,
        `migration ledger count ${actual.length} does not match repository count ${manifest.files.length}`,
        CloneMigrationVerificationError);
    manifest.files.forEach((filename, index) => {
        invariant(actual[index] === filename,
            `migration ledger differs from the repository at ${filename}`,
            CloneMigrationVerificationError);
    });
    invariant(actual[actual.length - 1] === manifest.latestFilename,
        `migration ledger does not end at ${manifest.latestFilename}`,
        CloneMigrationVerificationError);
    return true;
}

function poolConfiguration(target, env) {
    const config = {
        host: target.host,
        port: target.port,
        database: target.database,
        user: target.user,
        max: 1,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 5000,
        application_name: 'wowngeon-disposable-clone-migrations'
    };
    // A protected PGPASSFILE/PGPASSWORD can be used without this application-specific variable.
    // If the protected service environment already supplies DB_PASSWORD, keep it in memory only.
    if (typeof env.DB_PASSWORD === 'string' && env.DB_PASSWORD.length > 0) {
        config.password = env.DB_PASSWORD;
    }
    return config;
}

async function readExactDatabaseName(pool) {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT current_database() AS database_name');
        invariant(result?.rows?.length === 1,
            'PostgreSQL returned an ambiguous database identity',
            CloneMigrationVerificationError);
        return String(result.rows[0].database_name || '');
    } finally {
        client.release();
    }
}

async function runCloneMigrations({
    env = process.env,
    argv = process.argv.slice(2),
    poolFactory = config => new Pool(config),
    DatabaseManagerClass = DatabaseManager,
    migrationsPath = MIGRATIONS_PATH,
    logger = console
} = {}) {
    // Every filesystem and connection action occurs after all static target gates pass.
    const target = validateCloneMigrationEnvironment(env, argv);
    const manifest = discoverMigrationManifest(migrationsPath);
    const pool = poolFactory(poolConfiguration(target, env));

    try {
        const actualDatabase = await readExactDatabaseName(pool);
        invariant(actualDatabase === target.expectedDatabase,
            'connected PostgreSQL database does not match the exact expected clone name',
            CloneMigrationVerificationError);

        // This is deliberately the same implementation used during normal application startup:
        // lexically ordered files, schema_migrations ledger, one transaction per new file.
        const manager = new DatabaseManagerClass();
        manager.pool = pool;
        await manager.runMigrations();

        const ledger = await pool.query(
            'SELECT filename FROM schema_migrations ORDER BY filename ASC'
        );
        verifyExactMigrationLedger(ledger?.rows, manifest);

        logger.info('clone_migration_status=ok');
        logger.info(`database=${target.database}`);
        logger.info(`migration_count=${manifest.files.length}`);
        logger.info(`latest_migration=${manifest.latestFilename}`);
        return Object.freeze({ ...target, ...manifest });
    } finally {
        await pool.end().catch(() => {});
    }
}

async function main() {
    try {
        await runCloneMigrations();
    } catch (error) {
        if (error instanceof CloneMigrationRefusal
            || error instanceof CloneMigrationVerificationError) {
            console.error(`REFUSED: ${error.message}`);
        } else {
            // Do not echo connection objects, URLs, environment values, or server diagnostics.
            console.error('FAILED: disposable clone migration did not complete; no credentials were printed');
        }
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    CloneMigrationRefusal,
    CloneMigrationVerificationError,
    MINIMUM_RELEASE_MIGRATION,
    cloneMigrationConfirmation,
    discoverMigrationManifest,
    isDisposableCloneDatabaseName,
    isLocalDatabaseHost,
    poolConfiguration,
    readExactDatabaseName,
    runCloneMigrations,
    validateCloneMigrationEnvironment,
    verifyExactMigrationLedger
};
