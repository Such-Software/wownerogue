const DebugManager = require('../src/debug/debugManager');

describe('DebugManager daemon freshness', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalSource = process.env.BLOCK_SOURCE;

    beforeEach(() => {
        process.env.NODE_ENV = 'production';
        process.env.BLOCK_SOURCE = 'daemon';
    });

    afterAll(() => {
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
        if (originalSource === undefined) delete process.env.BLOCK_SOURCE;
        else process.env.BLOCK_SOURCE = originalSource;
    });

    test('rejects a stale cached height until a recent RPC poll succeeds', () => {
        const manager = new DebugManager({ broadcastBlockHeight: jest.fn() });
        manager.lastProductionBlockHeight = 123;
        manager.lastSuccessfulRpcAt = 0;

        expect(manager.isChainHealthy()).toBe(false);

        manager.lastSuccessfulRpcAt = Date.now();
        expect(manager.isChainHealthy(1000)).toBe(true);

        manager.lastSuccessfulRpcAt = Date.now() - 2000;
        expect(manager.isChainHealthy(1000)).toBe(false);
    });
});
