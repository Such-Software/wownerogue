const WalletRPCService = require('../src/payments/walletRPCService');

const ADDRESSES = Object.freeze({
    'XMR:mainnet': `4${'1'.repeat(94)}`,
    'XMR:stagenet': `5${'1'.repeat(94)}`,
    'XMR:testnet': `9${'1'.repeat(94)}`,
    'WOW:mainnet': `Wo${'1'.repeat(95)}`
});

function walletHttp({ address, network, height = 123, valid = true }) {
    return {
        post: jest.fn(async (_url, body) => {
            if (body.method === 'get_version') return { data: { result: { version: 1 } } };
            if (body.method === 'get_height') return { data: { result: { height } } };
            if (body.method === 'get_address') return { data: { result: { address } } };
            if (body.method === 'validate_address') {
                return { data: { result: { valid, nettype: network } } };
            }
            if (body.method === 'create_address') {
                return { data: { result: { address, address_index: 1 } } };
            }
            throw new Error(`unexpected method: ${body.method}`);
        })
    };
}

describe('WalletRPCService production identity', () => {
    const debugManager = { CONSOLE_LOGGING: false };

    test.each([
        ['XMR', 'mainnet'],
        ['XMR', 'stagenet'],
        ['XMR', 'testnet'],
        ['WOW', 'mainnet']
    ])('accepts a validated %s %s primary address', async (cryptoType, network) => {
        const address = ADDRESSES[`${cryptoType}:${network}`];
        const service = new WalletRPCService(debugManager, {
            http: walletHttp({ address, network }),
            walletEndpoint: 'http://wallet.test',
            cryptoType,
            network,
            identityRequired: true
        });

        await expect(service.initialize()).resolves.toBe(true);
        expect(service.getIdentityStatus()).toMatchObject({
            required: true,
            verified: true,
            expected: { cryptoType, network },
            actual: { cryptoType, network }
        });
        expect(JSON.stringify(service.getHealthStatus())).not.toContain(address);
    });

    test.each([
        ['wrong chain', 'WOW', 'mainnet', ADDRESSES['XMR:mainnet'], 'mainnet'],
        ['wrong network', 'XMR', 'mainnet', ADDRESSES['XMR:stagenet'], 'stagenet']
    ])('fails initialization for the %s without logging the address', async (
        _label, cryptoType, expectedNetwork, address, actualNetwork
    ) => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const service = new WalletRPCService(debugManager, {
            http: walletHttp({ address, network: actualNetwork }),
            walletEndpoint: 'http://wallet.test',
            cryptoType,
            network: expectedNetwork,
            identityRequired: true
        });

        await expect(service.initialize()).resolves.toBe(false);
        expect(service.getIdentityStatus().verified).toBe(false);
        expect(error.mock.calls.flat().join(' ')).not.toContain(address);
        error.mockRestore();
    });

    test('blocks money-changing calls when the configured identity does not match', async () => {
        const http = walletHttp({
            address: ADDRESSES['XMR:mainnet'],
            network: 'mainnet'
        });
        const service = new WalletRPCService(debugManager, {
            http,
            walletEndpoint: 'http://wallet.test',
            cryptoType: 'WOW',
            network: 'mainnet',
            identityRequired: true
        });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(service.createPaymentRequest(1, 'entry', 'user', 'socket'))
            .rejects.toMatchObject({ code: 'WALLET_IDENTITY_MISMATCH' });
        expect(http.post.mock.calls.map(([, body]) => body.method)).not.toContain('create_address');
        expect(error.mock.calls.flat().join(' ')).not.toContain(ADDRESSES['XMR:mainnet']);
        error.mockRestore();
    });

    test('development may connect for diagnostics but remains explicitly unverified', async () => {
        const service = new WalletRPCService(debugManager, {
            http: walletHttp({ address: ADDRESSES['XMR:stagenet'], network: 'stagenet' }),
            walletEndpoint: 'http://wallet.test',
            cryptoType: 'XMR',
            network: 'mainnet',
            identityRequired: false
        });

        await expect(service.initialize()).resolves.toBe(true);
        expect(service.getIdentityStatus()).toMatchObject({ required: false, verified: false });
    });

    test('a transport-only liveness response cannot revive stale production identity', async () => {
        const service = new WalletRPCService(debugManager, {
            http: walletHttp({ address: ADDRESSES['XMR:stagenet'], network: 'stagenet' }),
            walletEndpoint: 'http://wallet.test',
            cryptoType: 'XMR',
            network: 'stagenet',
            identityRequired: true,
            identityMaxAgeMs: 1000
        });
        await expect(service.initialize()).resolves.toBe(true);
        service.networkIdentity.checkedAt = Date.now() - 2000;
        service.isHealthy = false;

        await expect(service.rpcCall('get_version')).resolves.toBeDefined();

        expect(service.isHealthy).toBe(false);
        expect(service.getHealthStatus().healthy).toBe(false);
        expect(service.getIdentityStatus().verified).toBe(false);
    });

    test('rejects a zero-height wallet and redacts URL credentials from health', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const service = new WalletRPCService(debugManager, {
            http: walletHttp({ address: ADDRESSES['XMR:stagenet'], network: 'stagenet', height: 0 }),
            walletEndpoint: 'http://rpc-user:rpc-password@wallet.test',
            cryptoType: 'XMR',
            network: 'stagenet',
            identityRequired: true
        });

        await expect(service.initialize()).resolves.toBe(false);
        expect(service.getHealthStatus().endpoint).toBe('http://wallet.test');
        expect(JSON.stringify(service.getHealthStatus())).not.toMatch(/rpc-user|rpc-password/);
        error.mockRestore();
    });
});
