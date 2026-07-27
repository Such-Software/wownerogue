const WalletRPCService = require('../src/payments/walletRPCService');

describe('WalletRPCService HTTP authentication', () => {
    const originalUser = process.env.WALLET_RPC_USER;
    const originalPassword = process.env.WALLET_RPC_PASSWORD;

    beforeEach(() => {
        delete process.env.WALLET_RPC_USER;
        delete process.env.WALLET_RPC_PASSWORD;
    });

    afterAll(() => {
        if (originalUser === undefined) delete process.env.WALLET_RPC_USER;
        else process.env.WALLET_RPC_USER = originalUser;
        if (originalPassword === undefined) delete process.env.WALLET_RPC_PASSWORD;
        else process.env.WALLET_RPC_PASSWORD = originalPassword;
    });

    test('answers a wallet RPC Digest challenge with the configured credential', async () => {
        process.env.WALLET_RPC_USER = 'rpc-user';
        process.env.WALLET_RPC_PASSWORD = 'rpc-password';
        const unauthorized = new Error('unauthorized');
        unauthorized.response = {
            status: 401,
            headers: {
                'www-authenticate': 'Digest realm="monero-rpc", nonce="abc123", qop="auth", opaque="opaque1", algorithm=MD5'
            }
        };
        const http = { post: jest.fn()
            .mockRejectedValueOnce(unauthorized)
            .mockResolvedValueOnce({ data: { result: { height: 1 } } }) };
        const service = new WalletRPCService({ CONSOLE_LOGGING: false }, { http });

        await service.rpcCall('get_height');

        expect(http.post).toHaveBeenNthCalledWith(2,
            expect.stringContaining('/json_rpc'),
            expect.objectContaining({ method: 'get_height' }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: expect.stringMatching(/^Digest .*username="rpc-user".*realm="monero-rpc".*nonce="abc123".*qop=auth/)
                })
            })
        );
    });

    test('omits authentication for a loopback no-login service', async () => {
        const http = { post: jest.fn().mockResolvedValue({ data: { result: { height: 1 } } }) };
        const service = new WalletRPCService({ CONSOLE_LOGGING: false }, { http });

        await service.rpcCall('get_height');

        expect(http.post).toHaveBeenCalledTimes(1);
        expect(http.post.mock.calls[0][2].headers).not.toHaveProperty('Authorization');
    });

    test('production refuses a wallet that accepts the unauthenticated probe', async () => {
        const http = { post: jest.fn().mockResolvedValue({ data: { result: { version: 1 } } }) };
        const service = new WalletRPCService({ CONSOLE_LOGGING: false }, {
            http,
            rpcUser: 'rpc-user',
            rpcPassword: 'rpc-password',
            authRequired: true
        });

        await expect(service.ensureAuthentication({ force: true }))
            .rejects.toMatchObject({ code: 'WALLET_RPC_AUTH_NOT_ENFORCED', statusCode: 503 });
        expect(service.getHealthStatus()).toMatchObject({
            healthy: false,
            authentication: { required: true, verified: false, reason: 'not_enforced' }
        });
    });

    test('production proves both the unauthenticated challenge and an authenticated response', async () => {
        const challenge = () => {
            const error = new Error('unauthorized');
            error.response = {
                status: 401,
                headers: {
                    'www-authenticate': 'Digest realm="monero-rpc", nonce="abc123", qop="auth", algorithm=MD5'
                }
            };
            return error;
        };
        const http = { post: jest.fn(async (_url, _body, config) => {
            if (!config?.headers?.Authorization) throw challenge();
            return { data: { result: { version: 1 } } };
        }) };
        const service = new WalletRPCService({ CONSOLE_LOGGING: false }, {
            http,
            rpcUser: 'rpc-user',
            rpcPassword: 'rpc-password',
            authRequired: true
        });

        await expect(service.ensureAuthentication({ force: true })).resolves.toMatchObject({
            verified: true,
            reason: null
        });
        expect(http.post).toHaveBeenCalledTimes(2);
        expect(http.post.mock.calls[1][2].headers.Authorization).toMatch(/^Digest /);
        expect(JSON.stringify(service.getHealthStatus())).not.toMatch(/rpc-user|rpc-password/);
    });

    test('production refuses missing wallet credentials without contacting RPC', async () => {
        const http = { post: jest.fn() };
        const service = new WalletRPCService({ CONSOLE_LOGGING: false }, {
            http,
            authRequired: true
        });

        await expect(service.ensureAuthentication({ force: true }))
            .rejects.toMatchObject({ code: 'WALLET_RPC_AUTH_UNVERIFIED', statusCode: 503 });
        expect(http.post).not.toHaveBeenCalled();
    });
});
