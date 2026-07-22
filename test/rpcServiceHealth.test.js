const RpcService = require('../src/rpc/rpcService');

describe('RPCService production health', () => {
    const previous = {};

    beforeAll(() => {
        previous.PRIMARY_RPC_ENDPOINT = process.env.PRIMARY_RPC_ENDPOINT;
        previous.FALLBACK_RPC_ENDPOINT = process.env.FALLBACK_RPC_ENDPOINT;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.PRIMARY_RPC_ENDPOINT = 'http://127.0.0.1:18081';
        process.env.FALLBACK_RPC_ENDPOINT = 'http://127.0.0.1:28081';
    });

    afterAll(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('reports ready when the primary daemon responds', async () => {
        const http = { post: jest.fn().mockResolvedValue({ data: { result: { count: 123 } } }) };

        const health = await new RpcService({ http }).healthCheck();

        expect(health).toMatchObject({
            healthy: true,
            primary: { status: 'healthy' }
        });
    });

    test('reports ready when only the fallback daemon responds', async () => {
        const http = { post: jest.fn()
            .mockRejectedValueOnce(new Error('primary offline'))
            .mockResolvedValueOnce({ data: { result: { count: 123 } } }) };

        const health = await new RpcService({ http }).healthCheck();

        expect(health).toMatchObject({
            healthy: true,
            primary: { status: 'unhealthy' },
            fallback: { status: 'healthy' }
        });
    });

    test('reports not ready when every daemon endpoint is offline', async () => {
        const http = { post: jest.fn().mockRejectedValue(new Error('offline')) };

        const health = await new RpcService({ http }).healthCheck();

        expect(health.healthy).toBe(false);
    });

    test('redacts credentials from endpoint labels', () => {
        expect(RpcService.endpointLabel('https://rpc-user:rpc-secret@example.test/json_rpc'))
            .toBe('https://example.test/json_rpc');
    });

    test('strict block count never substitutes the cached UI height', async () => {
        const service = new RpcService({
            http: { post: jest.fn().mockRejectedValue(new Error('offline')) }
        });
        service.lastBlockHeight = 777;

        await expect(service.getBlockCountStrict()).rejects.toThrow();
        await expect(service.getBlockHeight()).resolves.toBe(777);
    });
});
