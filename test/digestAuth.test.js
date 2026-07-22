const { DigestAuthClient, parseDigestChallenge } = require('../src/payments/digestAuth');

describe('wallet RPC Digest authentication', () => {
    test('parses quoted qop lists and required fields', () => {
        expect(parseDigestChallenge('Digest realm="wallet", nonce="n1", qop="auth,auth-int", algorithm=MD5'))
            .toMatchObject({ realm: 'wallet', nonce: 'n1', qop: 'auth,auth-int', algorithm: 'MD5' });
    });

    test('caches the challenge and increments nonce-count without another unauthenticated probe', async () => {
        const unauthorized = new Error('unauthorized');
        unauthorized.response = {
            status: 401,
            headers: { 'www-authenticate': 'Digest realm="wallet", nonce="nonce", qop="auth"' }
        };
        const http = { post: jest.fn()
            .mockRejectedValueOnce(unauthorized)
            .mockResolvedValue({ data: { result: {} } }) };
        const client = new DigestAuthClient(http, {
            username: 'user',
            password: 'pass',
            randomBytes: () => Buffer.alloc(16, 1)
        });

        await client.post('http://127.0.0.1:38083/json_rpc', { id: '1' });
        await client.post('http://127.0.0.1:38083/json_rpc', { id: '2' });

        expect(http.post).toHaveBeenCalledTimes(3);
        expect(http.post.mock.calls[1][2].headers.Authorization).toContain('nc=00000001');
        expect(http.post.mock.calls[2][2].headers.Authorization).toContain('nc=00000002');
    });
});
