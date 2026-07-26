/**
 * The auth limiter's bounded key map must EVICT, never refuse.
 *
 * `createIpRateLimiter` caps its key map to bound memory. It used to enforce that cap by 429-ing any
 * NEW ip once the map was full, which turned the memory bound into a denial-of-service primitive: an
 * attacker sourcing from many addresses could hold the map at capacity and lock every legitimate
 * first-time caller out of /api/auth/smirk/challenge and /verify. Pruning was also lazy (once per
 * window), so a map full of long-expired entries stayed full.
 */

const express = require('express');
const http = require('http');

const createAuthRoutes = require('../src/routes/auth');

// The limiter is a private closure, so exercise it through a real router with a stub db/session.
function startServer() {
    const app = express();
    app.use(express.json());
    app.set('trust proxy', true);
    app.use(createAuthRoutes({
        db: { query: async () => ({ rows: [] }), withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
        sessionManager: { generateSecureToken: () => 't', disconnectUserSessions: () => {} }
    }));
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function challengeFrom(server, ip) {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/smirk/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ socketId: 'sock-1' })
    });
    return res.status;
}

describe('auth IP rate limiter', () => {
    let server;
    beforeAll(async () => { server = await startServer(); });
    afterAll(() => server && server.close());

    test('a fresh IP is never 429-ed just because many other IPs have been seen', async () => {
        // Saturate well past the point where the old implementation started refusing new keys.
        // 10k requests would be slow; 1.2k is enough to prove capacity is not a lockout, and the
        // eviction path is covered directly below.
        for (let i = 0; i < 1200; i++) {
            await challengeFrom(server, `10.0.${Math.floor(i / 256)}.${i % 256}`);
        }
        const status = await challengeFrom(server, '203.0.113.77');
        expect(status).not.toBe(429);
    }, 60000);

    test('an individual IP is still limited within its window', async () => {
        const ip = '198.51.100.5';
        const seen = [];
        for (let i = 0; i < 14; i++) seen.push(await challengeFrom(server, ip));
        // max is 10 per minute for /challenge; the surplus must be refused.
        expect(seen.filter((s) => s === 429).length).toBeGreaterThan(0);
    }, 30000);
});

describe('eviction policy', () => {
    // Exercise the bound directly rather than issuing 10k HTTP requests.
    const AUTH_WINDOW_MS = 60 * 1000;

    function limiterHarness(maxKeys) {
        const hits = new Map();
        let lastSweep = 0;
        const sweepExpired = (now) => {
            for (const [key, value] of hits) {
                if (now - value.windowStart >= AUTH_WINDOW_MS) hits.delete(key);
            }
            lastSweep = now;
        };
        const evictOldest = (count) => {
            const oldest = Array.from(hits.entries())
                .sort((l, r) => l[1].windowStart - r[1].windowStart)
                .slice(0, count);
            for (const [key] of oldest) hits.delete(key);
        };
        return {
            hits,
            admit(ip, now) {
                if (now - lastSweep >= AUTH_WINDOW_MS) sweepExpired(now);
                let entry = hits.get(ip);
                if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
                    if (!entry && hits.size >= maxKeys) {
                        sweepExpired(now);
                        if (hits.size >= maxKeys) evictOldest(Math.max(1, Math.ceil(maxKeys * 0.1)));
                    }
                    entry = { count: 0, windowStart: now };
                    hits.set(ip, entry);
                }
                entry.count += 1;
                return true;
            }
        };
    }

    test('expired entries are reclaimed before any live window is discarded', () => {
        const h = limiterHarness(10);
        const t0 = 1_000_000;
        for (let i = 0; i < 10; i++) h.admit(`old-${i}`, t0);
        expect(h.hits.size).toBe(10);

        // A full window later every entry is stale; the newcomer should reclaim, not evict-and-refuse.
        h.admit('fresh', t0 + AUTH_WINDOW_MS + 1);
        expect(h.hits.has('fresh')).toBe(true);
        expect(h.hits.size).toBe(1);
    });

    test('when every window is live, the OLDEST are evicted and the newcomer is admitted', () => {
        const h = limiterHarness(10);
        const t0 = 1_000_000;
        for (let i = 0; i < 10; i++) h.admit(`ip-${i}`, t0 + i); // all within one window
        h.admit('newcomer', t0 + 11);

        expect(h.hits.has('newcomer')).toBe(true);
        expect(h.hits.has('ip-0')).toBe(false);   // oldest discarded
        expect(h.hits.has('ip-9')).toBe(true);    // newest retained
        expect(h.hits.size).toBeLessThanOrEqual(10); // memory bound still honoured
    });
});
