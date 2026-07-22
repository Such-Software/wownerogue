'use strict';

const {
    CloneMigrationVerificationError,
    MINIMUM_RELEASE_MIGRATION,
    cloneMigrationConfirmation,
    discoverMigrationManifest,
    isDisposableCloneDatabaseName,
    runCloneMigrations,
    validateCloneMigrationEnvironment,
    verifyExactMigrationLedger
} = require('../src/scripts/migrate-disposable-clone');

function safeEnvironment(overrides = {}) {
    const database = overrides.DB_NAME || 'monerogue_restore_release_20260721';
    return {
        DB_HOST: '127.0.0.1',
        DB_PORT: '5432',
        DB_NAME: database,
        DB_USER: 'monerogue_migrator',
        CLONE_MIGRATION_EXPECT_DATABASE: database,
        CLONE_MIGRATION_CONFIRM: cloneMigrationConfirmation(database),
        ...overrides
    };
}

class FakePool {
    constructor(config, { actualDatabase = config.database, hideLatest = false } = {}) {
        this.config = config;
        this.actualDatabase = actualDatabase;
        this.hideLatest = hideLatest;
        this.ledger = new Set();
        this.transactions = [];
        this.ended = false;
    }

    async connect() {
        const pool = this;
        let pending = null;
        return {
            async query(sql, params = []) {
                if (/current_database\(\)/.test(sql)) {
                    return { rows: [{ database_name: pool.actualDatabase }], rowCount: 1 };
                }
                if (sql === 'BEGIN') {
                    pending = null;
                    return { rows: [], rowCount: null };
                }
                if (/INSERT INTO schema_migrations/.test(sql)) {
                    pending = params[0];
                    return { rows: [], rowCount: 1 };
                }
                if (sql === 'COMMIT') {
                    if (pending) pool.ledger.add(pending);
                    pool.transactions.push(pending);
                    pending = null;
                    return { rows: [], rowCount: null };
                }
                if (sql === 'ROLLBACK') {
                    pending = null;
                    return { rows: [], rowCount: null };
                }
                return { rows: [], rowCount: null };
            },
            release() {}
        };
    }

    async query(sql, params = []) {
        if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) {
            return { rows: [], rowCount: null };
        }
        if (/SELECT 1 FROM schema_migrations/.test(sql)) {
            return { rows: [], rowCount: this.ledger.has(params[0]) ? 1 : 0 };
        }
        if (/SELECT filename FROM schema_migrations/.test(sql)) {
            let filenames = [...this.ledger].sort();
            if (this.hideLatest) filenames = filenames.slice(0, -1);
            return { rows: filenames.map(filename => ({ filename })), rowCount: filenames.length };
        }
        throw new Error(`unexpected fake pool query: ${sql}`);
    }

    async end() {
        this.ended = true;
    }
}

describe('disposable clone migration target guard', () => {
    test.each([
        'monerogue_clone_release_a1',
        'wownerogue_restore_20260721',
        'wowngeon_canary_direct_e2e'
    ])('accepts an explicitly disposable application database: %s', database => {
        expect(isDisposableCloneDatabaseName(database)).toBe(true);
        expect(validateCloneMigrationEnvironment(safeEnvironment({ DB_NAME: database }), []))
            .toEqual(expect.objectContaining({ database, expectedDatabase: database }));
    });

    test.each([
        'monerogue',
        'wownerogue',
        'wowngeon',
        'monerogue_prod_clone',
        'monerogue_clone_prd',
        'monerogue_clone_production2026',
        'monerogue_master_restore',
        'wownerogue_clone_live',
        'wownerogue_clone_live1',
        'monerogue_mainnet_restore',
        'postgres_restore_20260721',
        'monerogue_staging_20260721',
        'monerogue-clone-release'
    ])('refuses a live-looking, unscoped, or malformed name: %s', database => {
        expect(isDisposableCloneDatabaseName(database)).toBe(false);
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({ DB_NAME: database }), []))
            .toThrow(/clone, restore, or canary/);
    });

    test('requires an exact expected database, database-bound confirmation, and local host', () => {
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({
            CLONE_MIGRATION_EXPECT_DATABASE: 'monerogue_restore_other'
        }), [])).toThrow(/exactly equal/);
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({
            CLONE_MIGRATION_CONFIRM: 'yes'
        }), [])).toThrow(/exactly bind/);
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({
            DB_HOST: 'database.internal'
        }), [])).toThrow(/loopback/);
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({
            DB_HOST: '/tmp/untrusted-postgresql-socket'
        }), [])).toThrow(/loopback/);
        expect(validateCloneMigrationEnvironment(safeEnvironment({
            DB_HOST: '/var/run/postgresql'
        }), [])).toEqual(expect.objectContaining({ host: '/var/run/postgresql' }));
    });

    test('forbids argv and credential-bearing DATABASE_URL before constructing a pool', async () => {
        expect(() => validateCloneMigrationEnvironment(safeEnvironment(), ['--database', 'x']))
            .toThrow(/command-line/);
        expect(() => validateCloneMigrationEnvironment(safeEnvironment({
            DATABASE_URL: 'postgres://user:secret@127.0.0.1/db'
        }), [])).toThrow(/DATABASE_URL/);

        const poolFactory = jest.fn();
        await expect(runCloneMigrations({
            env: safeEnvironment(), argv: ['--password', 'secret'], poolFactory
        })).rejects.toThrow(/command-line/);
        expect(poolFactory).not.toHaveBeenCalled();
    });
});

describe('disposable clone migration execution', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    test('discovers the contiguous repository manifest through migration 43 dynamically', () => {
        const manifest = discoverMigrationManifest();
        expect(manifest.latestOrdinal).toBeGreaterThanOrEqual(MINIMUM_RELEASE_MIGRATION);
        expect(manifest.latestFilename).toBe('043_durable_solo_restart_snapshots.sql');
        expect(manifest.files).toHaveLength(43);
    });

    test('runs the normal ordered migration implementation and proves the exact ledger', async () => {
        const secret = 'do-not-print-this-database-password';
        const env = safeEnvironment({ DB_PASSWORD: secret });
        let pool;
        const output = [];

        const result = await runCloneMigrations({
            env,
            argv: [],
            poolFactory: config => {
                pool = new FakePool(config);
                return pool;
            },
            logger: { info: line => output.push(line) }
        });

        expect(pool.transactions).toEqual(result.files);
        expect(result.latestFilename).toBe('043_durable_solo_restart_snapshots.sql');
        expect(output).toContain('clone_migration_status=ok');
        expect(output).toContain('latest_migration=043_durable_solo_restart_snapshots.sql');
        expect(output.join('\n')).not.toContain(secret);
        expect(pool.config).toEqual(expect.objectContaining({
            database: env.DB_NAME,
            host: '127.0.0.1',
            max: 1,
            application_name: 'wowngeon-disposable-clone-migrations'
        }));
        expect(pool.ended).toBe(true);
    });

    test('checks server database identity before applying a migration', async () => {
        let pool;
        await expect(runCloneMigrations({
            env: safeEnvironment(),
            argv: [],
            poolFactory: config => {
                pool = new FakePool(config, { actualDatabase: 'monerogue_restore_wrong' });
                return pool;
            },
            logger: { info: jest.fn() }
        })).rejects.toThrow(/exact expected clone name/);
        expect(pool.transactions).toEqual([]);
        expect(pool.ended).toBe(true);
    });

    test('fails closed if the post-run ledger is not exactly the repository manifest', async () => {
        await expect(runCloneMigrations({
            env: safeEnvironment(),
            argv: [],
            poolFactory: config => new FakePool(config, { hideLatest: true }),
            logger: { info: jest.fn() }
        })).rejects.toBeInstanceOf(CloneMigrationVerificationError);
    });

    test('rejects missing, extra, or reordered ledger entries', () => {
        const manifest = discoverMigrationManifest();
        const rows = manifest.files.map(filename => ({ filename }));
        expect(verifyExactMigrationLedger(rows, manifest)).toBe(true);
        expect(() => verifyExactMigrationLedger(rows.slice(1), manifest)).toThrow(/count/);
        expect(() => verifyExactMigrationLedger([...rows].reverse(), manifest)).toThrow(/differs/);
        expect(() => verifyExactMigrationLedger([...rows, { filename: '999_unknown.sql' }], manifest))
            .toThrow(/count/);
    });
});
