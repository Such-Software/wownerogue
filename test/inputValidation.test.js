/**
 * Input validation / hardening tests (Phase 2.3).
 *
 * register_client must validate the client-supplied id before it goes into clientSocketMap
 * (as both key and value), or a client could poison the map / impersonate mappings.
 */

const ConnectionHandler = require('../src/network/connectionHandler');

function buildHandler() {
  const ch = new ConnectionHandler({
    io: { sockets: { sockets: new Map() } },
    broadcastManager: { broadcastUserCount: () => {} },
    debugManager: { CONSOLE_LOGGING: false },
    sessionManager: null,
    rateLimiter: null
  });
  return ch;
}

function fakeSocket(id) {
  const emitted = [];
  return { id, emit: (event, data) => emitted.push({ event, data }), _emitted: emitted };
}

describe('handleRegisterClient validation', () => {
  let ch;
  afterEach(() => ch && ch.shutdown && ch.shutdown());

  test('accepts a valid clientId and records the mapping', () => {
    ch = buildHandler();
    const sock = fakeSocket('sock1');
    ch.handleRegisterClient(sock, { clientId: 'client-abc_123' });

    expect(ch.clientSocketMap.get('client-abc_123')).toBe('sock1');
    expect(ch.clientSocketMap.get('sock1')).toBe('client-abc_123');
    expect(sock._emitted.find(e => e.event === 'socket_registered').data.success).toBe(true);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'x'.repeat(65)],
    ['bad chars', 'evil<script>'],
    ['non-string', 12345]
  ])('rejects %s clientId and does not poison the map', (_label, badId) => {
    ch = buildHandler();
    const sock = fakeSocket('sock2');
    ch.handleRegisterClient(sock, { clientId: badId });

    expect(ch.clientSocketMap.size).toBe(0);
    const reg = sock._emitted.find(e => e.event === 'socket_registered');
    expect(reg.data.success).toBe(false);
  });
});

describe('session resume credential transport', () => {
  let ch;
  afterEach(() => ch && ch.shutdown && ch.shutdown());

  test('accepts auth payload token and ignores URL query token', () => {
    ch = buildHandler();
    expect(ch._getResumeToken({
      handshake: { auth: { resumeToken: 'auth-secret' }, query: { resumeToken: 'url-secret' } }
    })).toBe('auth-secret');
    expect(ch._getResumeToken({
      handshake: { auth: {}, query: { resumeToken: 'url-secret' } }
    })).toBeNull();
  });
});
