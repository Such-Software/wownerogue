/**
 * Multi-node daemon failover and graceful degradation.
 *
 * Two defects motivated this:
 *   - the stock configuration pointed PRIMARY and FALLBACK at the SAME host, so what looked like
 *     redundancy was none, and only two endpoints were ever supported;
 *   - `failoverActive` was a one-way latch — once the process moved to a backup it stayed there
 *     until restart, even after the preferred node recovered.
 *
 * The contract now: one logical call tries every configured node before failing, the preferred node
 * is periodically re-tested, and when nothing answers the service reports UNHEALTHY and throws
 * rather than silently serving a stale cached height.
 */

const RpcService = require('../src/rpc/rpcService');

const A = 'http://node-a.test';
const B = 'http://node-b.test';
const C = 'http://node-c.test';

/** http.post stub that succeeds only for endpoints listed in `up`. */
function httpFor(up) {
    return {
        post: jest.fn(async (url) => {
            const endpoint = up.find((e) => url.startsWith(e));
            if (!endpoint) throw new Error(`unreachable ${url}`);
            return { data: { result: { count: 4242 } } };
        })
    };
}

function service(http, extra = {}) {
    return new RpcService({
        http,
        endpoints: [A, B, C],
        identityRequired: false,
        ...extra
    });
}

describe('daemon endpoint failover', () => {
    test('accepts an ordered list of endpoints and prefers the first', () => {
        const svc = service(httpFor([A, B, C]));
        expect(svc.endpoints).toEqual([A, B, C]);
        expect(svc.currentEndpoint).toBe(A);
        expect(svc.failoverActive).toBe(false);
    });

    test('deduplicates endpoints — the stock PRIMARY == FALLBACK config is one node, not two', () => {
        const same = 'http://127.0.0.1:34568';
        const svc = new RpcService({
            http: httpFor([same]),
            primaryEndpoint: same,
            fallbackEndpoint: same,
            identityRequired: false
        });
        expect(svc.endpoints).toEqual([same]);
    });

    test('parses a comma-separated RPC_ENDPOINTS list and keeps PRIMARY/FALLBACK', () => {
        const svc = new RpcService({
            http: httpFor([A]),
            env: {
                RPC_ENDPOINTS: `${A}, ${B}`,
                PRIMARY_RPC_ENDPOINT: C,
                FALLBACK_RPC_ENDPOINT: C,
                NODE_ENV: 'test'
            },
            identityRequired: false
        });
        expect(svc.endpoints).toEqual([A, B, C]);
    });

    test('walks past dead nodes to a live one within a SINGLE call', async () => {
        const svc = service(httpFor([C]));           // A and B are down
        await expect(svc.makeRPCCall('getblockcount')).resolves.toMatchObject({ count: 4242 });
        expect(svc.currentEndpoint).toBe(C);
        expect(svc.failoverActive).toBe(true);
        expect(svc.healthy).toBe(true);
    });

    test('sticks to the working node on subsequent calls', async () => {
        const http = httpFor([B, C]);
        const svc = service(http, { preferredRetryMs: 10 * 60 * 1000 });
        await svc.makeRPCCall('getblockcount');
        expect(svc.currentEndpoint).toBe(B);

        http.post.mockClear();
        await svc.makeRPCCall('getblockcount');
        expect(http.post).toHaveBeenCalledTimes(1);            // no re-probing of the dead primary
        expect(http.post.mock.calls[0][0]).toContain('node-b');
    });

    test('returns to the preferred node once it recovers', async () => {
        const up = [B];
        const http = {
            post: jest.fn(async (url) => {
                if (!up.some((e) => url.startsWith(e))) throw new Error('unreachable');
                return { data: { result: { count: 4242 } } };
            })
        };
        const svc = service(http, { preferredRetryMs: 1000 }); // floor is 1s; see the constructor
        await svc.makeRPCCall('getblockcount');
        expect(svc.currentEndpoint).toBe(B);

        up.push(A);                                          // primary comes back
        svc._preferredProbedAt -= 5000;                      // ...and the re-test interval elapses
        await svc.makeRPCCall('getblockcount');

        expect(svc.currentEndpoint).toBe(A);
        expect(svc.failoverActive).toBe(false);
    });

    test('throws and reports unhealthy when NO node answers', async () => {
        const svc = service(httpFor([]));
        await expect(svc.makeRPCCall('getblockcount')).rejects.toThrow();
        expect(svc.healthy).toBe(false);
    });

    test('getBlockHeight degrades to the last known height without claiming health', async () => {
        const http = httpFor([A]);
        const svc = service(http);
        expect(await svc.getBlockHeight()).toBe(4242);

        http.post.mockRejectedValue(new Error('all nodes offline'));
        expect(await svc.getBlockHeight()).toBe(4242);  // cached value for non-financial UI
        expect(svc.healthy).toBe(false);                // ...but never reported as live
    });

    test('getBlockCountStrict refuses to substitute the cached height', async () => {
        const http = httpFor([A]);
        const svc = service(http);
        await svc.getBlockCountStrict();
        http.post.mockRejectedValue(new Error('all nodes offline'));
        await expect(svc.getBlockCountStrict()).rejects.toThrow();
    });

    test('healthCheck probes every node and adopts the first healthy one', async () => {
        const svc = service(httpFor([C]));
        const health = await svc.healthCheck();
        expect(health.endpoints).toHaveLength(3);
        expect(health.healthy).toBe(true);
        expect(health.healthyCount).toBe(1);
        expect(svc.currentEndpoint).toBe(C);
    });

    test('healthCheck reports unhealthy when every node is down', async () => {
        const health = await service(httpFor([])).healthCheck();
        expect(health.healthy).toBe(false);
        expect(health.healthyCount).toBe(0);
    });
});
