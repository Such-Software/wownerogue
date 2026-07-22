/**
 * Reconnect-proof rate limiting tests (Phase 2.2).
 */

const RateLimiter = require('../src/network/rateLimiter');
const { clientIp, stableId } = require('../src/network/rateLimitContext');
const SocketHandlers = require('../src/network/socketHandlers');
const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');

function legalAcknowledgement(gameModeManager = null) {
  const disclosure = buildCommerceDisclosure(gameModeManager, process.env);
  return {
    policyVersion: disclosure.policyVersion,
    ageEligible: true,
    termsRead: true,
    riskAccepted: true,
    testnetUnderstood: disclosure.service.isTestNetwork === true
  };
}

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

describe('payment creation limit is enforced at the socket boundary', () => {
  test('blocks the fourth request before wallet or database work', async () => {
    const rateLimiter = new RateLimiter({
      limits: { 'payment:create': { window: 60000, max: 3 } }
    });
    const downstream = jest.fn().mockResolvedValue(undefined);
    const socket = {
      id: 'payment-socket',
      handshake: { address: '192.0.2.20', headers: {} },
      emit: jest.fn()
    };
    const context = {
      rateLimiter,
      sessionManager: { sessions: new Map([[socket.id, { id: 91 }]]) },
      paymentHandlers: { handlePaymentRequest: downstream }
    };

    for (let i = 0; i < 4; i += 1) {
      await SocketHandlers.prototype.handlePaymentRequest.call(
        context,
        socket,
        {
          type: 'credits_package',
          packageId: 'small',
          legalAcknowledgement: legalAcknowledgement()
        }
      );
    }

    expect(downstream).toHaveBeenCalledTimes(3);
    expect(socket.emit).toHaveBeenCalledWith('payment_error', expect.objectContaining({
      code: 'RATE_LIMITED'
    }));
    rateLimiter.shutdown();
  });
});

describe('match queue join throttling', () => {
  test('bounds joins but never blocks an escrow-releasing leave', async () => {
    const rateLimiter = new RateLimiter({
      limits: { 'game:queue': { window: 60000, max: 1 } }
    });
    const socket = {
      id: 'match-socket',
      handshake: { address: '192.0.2.30', headers: {} },
      emit: jest.fn()
    };
    const enqueue = jest.fn().mockResolvedValue({ success: true });
    const leave = jest.fn().mockResolvedValue({ success: true });
    const context = {
      rateLimiter,
      sessionManager: { sessions: new Map([[socket.id, { id: 92 }]]) },
      matchQueue: { isEnabled: () => true, enqueue, leave },
      _resolveMatchSession: jest.fn().mockResolvedValue({
        userId: 92,
        socketId: socket.id,
        sessionToken: 'test-token'
      }),
      debugManager: { CONSOLE_LOGGING: false }
    };

    await SocketHandlers.prototype._handleMatchQueue.call(context, socket, {
      action: 'join', economy: 'free'
    });
    await SocketHandlers.prototype._handleMatchQueue.call(context, socket, {
      action: 'join', economy: 'free'
    });
    await SocketHandlers.prototype._handleMatchQueue.call(context, socket, {
      action: 'leave', economy: 'free'
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('match_error', expect.objectContaining({
      code: 'RATE_LIMITED'
    }));
    rateLimiter.shutdown();
  });
});
