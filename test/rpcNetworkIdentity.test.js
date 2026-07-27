const RpcService = require('../src/rpc/rpcService');

const { GENESIS_HASHES } = RpcService;

function daemonFixture({ cryptoType, network, height = 123, overrides = {} }) {
    const target = cryptoType === 'WOW' ? 300 : 120;
    return {
        count: { count: height },
        info: {
            status: 'OK',
            height,
            target,
            nettype: network,
            offline: false,
            untrusted: false,
            synchronized: true,
            ...overrides
        },
        header: {
            status: 'OK',
            untrusted: false,
            block_header: { hash: GENESIS_HASHES[`${cryptoType}:${network}`] }
        }
    };
}

function fixtureHttp(fixtures) {
    return {
        post: jest.fn(async (url, body) => {
            const endpoint = url.replace(/\/json_rpc$/, '');
            const fixture = fixtures[endpoint];
            if (fixture instanceof Error) throw fixture;
            if (!fixture) throw new Error('unknown endpoint');
            if (body.method === 'getblockcount') return { data: { result: fixture.count } };
            if (body.method === 'get_info') return { data: { result: fixture.info } };
            if (body.method === 'get_block_header_by_height') {
                return { data: { result: fixture.header } };
            }
            throw new Error(`unexpected method: ${body.method}`);
        })
    };
}

describe('RPCService pinned production identity', () => {
    test.each([
        ['XMR', 'mainnet'],
        ['XMR', 'stagenet'],
        ['XMR', 'testnet'],
        ['WOW', 'mainnet']
    ])('accepts only the pinned %s %s genesis', async (cryptoType, network) => {
        const endpoint = 'http://daemon.test';
        const service = new RpcService({
            http: fixtureHttp({ [endpoint]: daemonFixture({ cryptoType, network }) }),
            primaryEndpoint: endpoint,
            fallbackEndpoint: endpoint,
            cryptoType,
            network,
            identityRequired: true
        });

        const health = await service.healthCheck();

        expect(health.healthy).toBe(true);
        expect(health.identity).toMatchObject({
            required: true,
            verified: true,
            expected: { cryptoType, network },
            actual: { cryptoType, network }
        });
        expect(JSON.stringify(health.identity)).not.toContain(GENESIS_HASHES[`${cryptoType}:${network}`]);
    });

    test('cannot pass WOW identity with an XMR mainnet daemon', async () => {
        const endpoint = 'http://daemon.test';
        const service = new RpcService({
            http: fixtureHttp({ [endpoint]: daemonFixture({ cryptoType: 'XMR', network: 'mainnet' }) }),
            primaryEndpoint: endpoint,
            fallbackEndpoint: endpoint,
            cryptoType: 'WOW',
            network: 'mainnet',
            identityRequired: true
        });

        const health = await service.healthCheck();

        expect(health.healthy).toBe(false);
        expect(health.identity.verified).toBe(false);
        expect(health.primary.identityVerified).toBe(false);
    });

    test('selects a correctly identified fallback when the primary is the wrong network', async () => {
        const primary = 'http://primary.test';
        const fallback = 'http://fallback.test';
        const http = fixtureHttp({
            [primary]: daemonFixture({ cryptoType: 'XMR', network: 'mainnet' }),
            [fallback]: daemonFixture({ cryptoType: 'XMR', network: 'stagenet' })
        });
        const service = new RpcService({
            http,
            primaryEndpoint: primary,
            fallbackEndpoint: fallback,
            cryptoType: 'XMR',
            network: 'stagenet',
            identityRequired: true
        });

        const height = await service.getBlockHeight();

        expect(height).toBe(123);
        expect(service.currentEndpoint).toBe(fallback);
        expect(service.getIdentityStatus()).toMatchObject({
            verified: true,
            actual: { cryptoType: 'XMR', network: 'stagenet' }
        });
    });

    test.each([
        ['zero height', { height: 0 }],
        ['offline daemon', { offline: true }],
        ['untrusted response', { untrusted: true }],
        ['unsynchronized daemon', { synchronized: false }],
        ['non-OK status', { status: 'BUSY' }]
    ])('fails closed for %s', async (_label, overrides) => {
        const endpoint = 'http://daemon.test';
        const fixture = daemonFixture({ cryptoType: 'XMR', network: 'stagenet', overrides });
        if (overrides.height !== undefined) fixture.count.count = overrides.height;
        const service = new RpcService({
            http: fixtureHttp({ [endpoint]: fixture }),
            primaryEndpoint: endpoint,
            fallbackEndpoint: endpoint,
            cryptoType: 'XMR',
            network: 'stagenet',
            identityRequired: true
        });

        await expect(service.healthCheck()).resolves.toMatchObject({ healthy: false });
    });

    test('treats an HTTP 200 JSON-RPC error as unhealthy', async () => {
        const endpoint = 'http://daemon.test';
        const http = { post: jest.fn().mockResolvedValue({
            data: { error: { code: -1, message: 'daemon error' } }
        }) };
        const service = new RpcService({
            http,
            primaryEndpoint: endpoint,
            fallbackEndpoint: endpoint,
            cryptoType: 'XMR',
            network: 'stagenet',
            identityRequired: true
        });

        await expect(service.healthCheck()).resolves.toMatchObject({ healthy: false });
    });
});
