/**
 * Per-IP concurrent-socket cap (anti-abuse / resource hoarding).
 *
 * The rate limiter caps NEW connections and game starts per minute, but nothing capped how
 * many sockets a single IP could hold OPEN at once. ConnectionHandler now tracks live sockets
 * per IP and refuses new ones past the cap; these tests exercise that bookkeeping directly.
 */

const ConnectionHandler = require('../src/network/connectionHandler');

function makeHandler(maxPerIp) {
    if (maxPerIp != null) process.env.MAX_SOCKETS_PER_IP = String(maxPerIp);
    else delete process.env.MAX_SOCKETS_PER_IP;
    return new ConnectionHandler({
        io: { sockets: { sockets: new Map() } },
        broadcastManager: { broadcastUserCount() {}, sendStatusUpdate() {} },
        debugManager: { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 },
        sessionManager: null,
        rateLimiter: { getStats: () => ({}) }
    });
}

describe('per-IP concurrent socket cap', () => {
    let h;
    afterEach(() => { if (h) h.shutdown(); h = null; delete process.env.MAX_SOCKETS_PER_IP; });

    test('allows up to the cap, then rejects further sockets from the same IP', () => {
        h = makeHandler(3);
        expect(h._trackIpSocket('1.2.3.4', 's1')).toBe(true);
        expect(h._trackIpSocket('1.2.3.4', 's2')).toBe(true);
        expect(h._trackIpSocket('1.2.3.4', 's3')).toBe(true);
        expect(h._trackIpSocket('1.2.3.4', 's4')).toBe(false); // over cap
    });

    test('a freed slot lets a new socket in', () => {
        h = makeHandler(2);
        expect(h._trackIpSocket('5.5.5.5', 'a')).toBe(true);
        expect(h._trackIpSocket('5.5.5.5', 'b')).toBe(true);
        expect(h._trackIpSocket('5.5.5.5', 'c')).toBe(false);
        h._untrackIpSocket('a');
        expect(h._trackIpSocket('5.5.5.5', 'c')).toBe(true);
    });

    test('different IPs have independent budgets', () => {
        h = makeHandler(1);
        expect(h._trackIpSocket('1.1.1.1', 'x')).toBe(true);
        expect(h._trackIpSocket('2.2.2.2', 'y')).toBe(true); // different IP, fine
        expect(h._trackIpSocket('1.1.1.1', 'z')).toBe(false);
    });

    test('re-tracking the same socket id is idempotent (reconnect within same id)', () => {
        h = makeHandler(1);
        expect(h._trackIpSocket('9.9.9.9', 'same')).toBe(true);
        expect(h._trackIpSocket('9.9.9.9', 'same')).toBe(true); // not double-counted
    });

    test('missing IP is never blocked (cannot attribute)', () => {
        h = makeHandler(1);
        expect(h._trackIpSocket(null, 's1')).toBe(true);
        expect(h._trackIpSocket(undefined, 's2')).toBe(true);
    });

    test('defaults to 10 when MAX_SOCKETS_PER_IP unset', () => {
        h = makeHandler(null);
        expect(h.maxSocketsPerIp).toBe(10);
    });
});
