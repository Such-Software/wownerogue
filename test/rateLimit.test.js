/**
 * Reconnect-proof rate limiting tests (Phase 2.2).
 */

const RateLimiter = require('../src/network/rateLimiter');
const { clientIp, stableId } = require('../src/network/rateLimitContext');

describe('rateLimitContext.stableId', () => {
  test('prefers the session stable user id over the socket id', () => {
    const sm = { sessions: new Map([['sockA', { id: 42 }]]) };
    expect(stableId({ id: 'sockA' }, sm)).toBe('u:42');
  });
  test('falls back to socket id when no session', () => {
    const sm = { sessions: new Map() };
    expect(stableId({ id: 'sockZ' }, sm)).toBe('s:sockZ');
    expect(stableId({ id: 'sockZ' }, undefined)).toBe('s:sockZ');
  });
});

describe('rateLimitContext.clientIp', () => {
  afterEach(() => { delete process.env.TRUST_PROXY; });

  test('uses handshake address by default (ignores XFF when proxy not trusted)', () => {
    expect(clientIp({ handshake: { headers: { 'x-forwarded-for': '9.9.9.9' }, address: '10.0.0.1' } })).toBe('10.0.0.1');
  });
  test('uses the rightmost (proxy-appended) X-Forwarded-For hop when TRUST_PROXY=true', () => {
    process.env.TRUST_PROXY = 'true';
    // A single trusted nginx APPENDS the real client IP as the last hop; the leftmost entries
    // are client-spoofable, so the rightmost is the only trustworthy one for rate limiting.
    expect(clientIp({ handshake: { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, address: '7.7.7.7' } })).toBe('10.0.0.1');
  });
});

describe('reconnect cannot bypass the limit (stable-id keyed)', () => {
  test('two sockets for the same user share the limit', async () => {
    const rl = new RateLimiter({ limits: { 'game:start': { window: 60000, max: 2 } } });
    const sm = { sessions: new Map([['sockA', { id: 7 }], ['sockB', { id: 7 }]]) };
    const idA = stableId({ id: 'sockA' }, sm); // u:7
    const idB = stableId({ id: 'sockB' }, sm); // u:7 (reconnected, new socket)
    expect(idA).toBe(idB);

    await rl.recordAttempt(idA, 'game:start', '1.2.3.4');
    await rl.recordAttempt(idA, 'game:start', '1.2.3.4'); // at max
    const afterReconnect = await rl.checkLimit(idB, 'game:start', '1.2.3.4');
    expect(afterReconnect.allowed).toBe(false); // blocked despite the new socket id
    rl.shutdown();
  });

  test('chat:message is now IP-limited', () => {
    const rl = new RateLimiter();
    expect(rl._shouldApplyIpLimit('chat:message')).toBe(true);
    rl.shutdown();
  });

  test('IP limit blocks a fresh anonymous identity from the same IP', async () => {
    const rl = new RateLimiter({ limits: { 'game:start': { window: 60000, max: 1 } } });
    // Two different "users" (e.g. cleared token) but same IP.
    await rl.recordAttempt('u:1', 'game:start', '5.5.5.5');
    const other = await rl.checkLimit('u:2', 'game:start', '5.5.5.5');
    expect(other.allowed).toBe(false); // IP bucket already exhausted
    rl.shutdown();
  });
});
