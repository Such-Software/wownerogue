/**
 * Rate-limiter storage-key resolution.
 *
 * Keys are `${id}:${action}`, and the id itself contains colons: `u:<userId>` / `s:<socketId>` from
 * rateLimitContext.stableId, plus raw IPv6 addresses in ipStorage. The old key parser stripped only
 * the first `:`-delimited segment, so `u:123:chat:message` resolved to the action `123:chat:message`
 * and matched nothing. Both consequences were silent:
 *
 *   - `cleanup()` skips entries whose limit it cannot resolve, so the ONLY registered memory
 *     reclamation freed nothing and both Maps grew for the lifetime of the process;
 *   - `_recordSingleAttempt` never reset an expired window, so counts accumulated forever.
 */

const RateLimiter = require('../src/network/rateLimiter');

describe('rate limiter key resolution', () => {
    let limiter;
    beforeEach(() => { limiter = new RateLimiter(); });
    afterEach(() => { if (limiter.shutdown) limiter.shutdown(); });

    test.each([
        ['stable user id', 'u:123:chat:message', 'chat:message'],
        ['socket-scoped id', 's:AbCdEf123456:game:queue', 'game:queue'],
        ['bare IPv4', '203.0.113.9:chat:message', 'chat:message'],
        ['IPv6 (colon-dense)', '2001:db8:85a3::8a2e:370:7334:chat:message', 'chat:message']
    ])('resolves the configured limit for a %s key', (_label, key, action) => {
        expect(limiter._getLimitFromKey(key)).toBe(limiter.limits[action]);
    });

    test('returns undefined for a key with no configured action', () => {
        expect(limiter._getLimitFromKey('u:123:not:a:real:action')).toBeUndefined();
    });

    test('cleanup() actually frees expired entries for realistic keys', () => {
        const key = 'u:456:chat:message';
        const window = limiter.limits['chat:message'].window;
        limiter.storage.set(key, { count: 9, firstAttempt: Date.now() - window - 1000 });
        limiter.ipStorage.set('2001:db8::1:chat:message', {
            count: 4, firstAttempt: Date.now() - window - 1000
        });

        limiter.cleanup();

        expect(limiter.storage.has(key)).toBe(false);
        expect(limiter.ipStorage.size).toBe(0);
    });

    test('cleanup() leaves entries whose window is still open', () => {
        const key = 'u:789:chat:message';
        limiter.storage.set(key, { count: 1, firstAttempt: Date.now() });
        limiter.cleanup();
        expect(limiter.storage.has(key)).toBe(true);
    });

    test('an expired window resets the count instead of accumulating forever', () => {
        const action = 'chat:message';
        const key = `u:321:${action}`;
        const window = limiter.limits[action].window;
        limiter.storage.set(key, { count: 999, firstAttempt: Date.now() - window - 1000 });

        limiter._recordSingleAttempt(key, Date.now());

        expect(limiter.storage.get(key).count).toBe(1);
    });
});
