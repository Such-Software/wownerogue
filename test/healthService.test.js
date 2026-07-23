const { buildPublicHealth } = require('../src/services/healthService');

describe('public health payload', () => {
    test('is ready only when required production dependencies are up', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            paymentsEnabled: true,
            walletHealthy: true,
            payoutsEnabled: false,
            now: 1,
            uptime: 10
        });

        expect(health).toMatchObject({
            status: 'ok',
            ready: true,
            checks: { database: 'up', chain: 'up', wallet: 'up' },
            money: { paymentsEnabled: true, payoutsEnabled: false },
            release: { verified: false, id: null, commit: null }
        });
    });

    test('publishes only a self-consistent immutable release identity', () => {
        const commit = 'a'.repeat(40);
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            releaseIdentity: {
                verified: true,
                id: `git-${commit.slice(0, 12)}`,
                commit
            }
        });
        expect(health.release).toEqual({
            verified: true,
            id: `git-${commit.slice(0, 12)}`,
            commit
        });

        const mismatched = buildPublicHealth({
            releaseIdentity: {
                verified: true,
                id: `git-${'b'.repeat(12)}`,
                commit
            }
        });
        expect(mismatched.release).toEqual({
            verified: false,
            id: null,
            commit: null
        });
    });

    test('free-only instances do not require a wallet', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            paymentsEnabled: false,
            walletHealthy: false
        });

        expect(health.ready).toBe(true);
        expect(health.checks.wallet).toBe('not_required');
    });

    test('payout-only settlement requires a wallet without claiming intake is enabled', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            paymentsEnabled: false,
            payoutsEnabled: true,
            walletHealthy: false
        });

        expect(health.ready).toBe(false);
        expect(health.checks.wallet).toBe('down');
        expect(health.money).toEqual({ paymentsEnabled: false, payoutsEnabled: true });
        expect(health.paymentsEnabled).toBe(false);
    });

    test('reports degraded readiness when the daemon or required wallet is down', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 0,
            paymentsEnabled: true,
            walletHealthy: false
        });

        expect(health.status).toBe('degraded');
        expect(health.ready).toBe(false);
        expect(health.checks).toMatchObject({ chain: 'down', wallet: 'down' });
    });

    test('keeps readiness closed while startup financial recovery is pending', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            paymentsEnabled: true,
            walletHealthy: true,
            financialRecoveryReady: false
        });

        expect(health.ready).toBe(false);
        expect(health.checks.financialRecovery).toBe('pending');
    });

    test('does not treat a stale cached block height as a healthy daemon', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            chainHealthy: false,
            paymentsEnabled: false
        });

        expect(health.ready).toBe(false);
        expect(health.checks.chain).toBe('down');
    });

    test('never includes sensitive operational detail', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 1,
            paymentsEnabled: true,
            walletHealthy: true
        });

        expect(JSON.stringify(health)).not.toMatch(/balance|endpoint|password|memory|rateLimiter/i);
    });

    test('requires verified daemon and wallet identities for production money mode', () => {
        const identity = {
            verified: true,
            expected: { cryptoType: 'XMR', network: 'stagenet', genesisHash: 'secret-internal' },
            actual: { cryptoType: 'XMR', network: 'stagenet', genesisHash: 'secret-internal' },
            reason: 'internal-reason',
            endpoint: 'http://user:password@wallet.test'
        };
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            chainHealthy: true,
            paymentsEnabled: true,
            walletHealthy: true,
            identityRequired: true,
            daemonIdentity: identity,
            walletIdentity: identity
        });

        expect(health).toMatchObject({
            ready: true,
            checks: { daemonIdentity: 'verified', walletIdentity: 'verified' },
            chain: { network: 'stagenet' },
            identities: {
                daemon: { required: true, verified: true },
                wallet: { required: true, verified: true }
            }
        });
        expect(JSON.stringify(health)).not.toMatch(/secret-internal|internal-reason|endpoint|password/);
    });

    test('fails readiness on a daemon identity mismatch', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            chainHealthy: true,
            paymentsEnabled: false,
            identityRequired: true,
            daemonIdentity: { verified: false }
        });

        expect(health.ready).toBe(false);
        expect(health.checks).toMatchObject({ chain: 'down', daemonIdentity: 'unverified' });
    });

    test('fails payout-only readiness on a wallet identity mismatch', () => {
        const health = buildPublicHealth({
            databaseReady: true,
            blockHeight: 123,
            chainHealthy: true,
            paymentsEnabled: false,
            payoutsEnabled: true,
            walletHealthy: true,
            identityRequired: true,
            daemonIdentity: { verified: true },
            walletIdentity: { verified: false }
        });

        expect(health.ready).toBe(false);
        expect(health.checks).toMatchObject({ wallet: 'down', walletIdentity: 'unverified' });
    });
});
