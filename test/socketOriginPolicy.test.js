const {
    createSocketOriginAllowRequest,
    normalizedConfiguredOrigin,
    normalizedRequestOrigin
} = require('../src/network/socketOriginPolicy');

function allowed(env, headers) {
    const allowRequest = createSocketOriginAllowRequest(env);
    return new Promise((resolve, reject) => {
        allowRequest({ headers }, (error, accepted) => {
            if (error) reject(error);
            else resolve(accepted);
        });
    });
}

describe('Socket.IO production Origin policy', () => {
    test('development preserves permissive behavior', async () => {
        await expect(allowed({ NODE_ENV: 'development' }, { origin: 'not a URL' }))
            .resolves.toBe(true);
        await expect(allowed({}, { origin: 'https://cross-origin.example' }))
            .resolves.toBe(true);
    });

    test('production allows an absent Origin only after HOSTED_BY validates', async () => {
        const env = { NODE_ENV: 'production', HOSTED_BY: 'https://play.example.test' };
        await expect(allowed(env, {})).resolves.toBe(true);
        await expect(allowed(env, undefined)).resolves.toBe(true);
    });

    test('allows only the exact normalized scheme and host', async () => {
        const env = {
            NODE_ENV: 'production',
            HOSTED_BY: 'HTTPS://Play.Example.Test:443/public/path?ignored=yes'
        };

        await expect(allowed(env, { origin: 'https://play.example.test' })).resolves.toBe(true);
        await expect(allowed(env, { origin: 'https://PLAY.EXAMPLE.TEST:443/' })).resolves.toBe(true);
        await expect(allowed(env, { origin: 'http://play.example.test' })).resolves.toBe(false);
        await expect(allowed(env, { origin: 'https://other.example.test' })).resolves.toBe(false);
        await expect(allowed(env, { origin: 'https://play.example.test:444' })).resolves.toBe(false);
    });

    test.each([
        'null',
        'not a URL',
        'ftp://play.example.test',
        'https://user:password@play.example.test',
        'https://play.example.test/socket/path',
        'https://play.example.test/./',
        'https://play.example.test?query=yes',
        'https://play.example.test#fragment',
        ''
    ])('rejects malformed browser Origin %p', async (origin) => {
        await expect(allowed({
            NODE_ENV: 'production',
            HOSTED_BY: 'https://play.example.test'
        }, { origin })).resolves.toBe(false);
    });

    test('rejects a non-string or multi-value Origin header', async () => {
        const env = { NODE_ENV: 'production', HOSTED_BY: 'https://play.example.test' };
        await expect(allowed(env, { origin: ['https://play.example.test'] })).resolves.toBe(false);
        await expect(allowed(env, { origin: null })).resolves.toBe(false);
    });

    test.each([
        undefined,
        '',
        'not a URL',
        'ftp://play.example.test',
        'https://user:password@play.example.test'
    ])('fails closed for invalid production HOSTED_BY %p', async (hostedBy) => {
        const env = { NODE_ENV: 'production', HOSTED_BY: hostedBy };
        await expect(allowed(env, {})).resolves.toBe(false);
        await expect(allowed(env, { origin: 'https://play.example.test' })).resolves.toBe(false);
    });

    test('normalizers preserve default-port normalization and reject request paths', () => {
        expect(normalizedConfiguredOrigin('https://EXAMPLE.test:443/path')).toBe('https://example.test');
        expect(normalizedRequestOrigin('https://EXAMPLE.test:443/')).toBe('https://example.test');
        expect(normalizedRequestOrigin('https://example.test/path')).toBeNull();
    });
});
