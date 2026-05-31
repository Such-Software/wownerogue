/**
 * Admin routes extraction smoke test (Phase 4.1).
 *
 * Verifies the extracted admin route factory loads and registers all expected routes
 * with a stub ctx — catches load-time/reference errors from the index.js -> routes/admin.js
 * split without needing a live server.
 */

const createAdminRoutes = require('../src/routes/admin');

function stubCtx() {
  return {
    db: { query: jest.fn(), getClient: jest.fn() },
    gameModeManager: {},
    walletRPCService: {},
    socketHandlers: {},
    io: {},
    alertService: null
  };
}

describe('admin routes factory', () => {
  test('builds a router and registers the expected admin endpoints', () => {
    const router = createAdminRoutes(stubCtx());
    expect(typeof router).toBe('function'); // express router is a middleware function
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);

    const expected = [
      '/api/admin/refund/payment',
      '/api/admin/credits/adjust',
      '/api/admin/alerts/test-email',
      '/api/admin/queue',
      '/api/admin/queue/remove',
      '/api/admin/chat',
      '/api/admin/chat/:id',
      '/api/admin/users/:id/chat-ban',
      '/api/admin/users/search',
      '/api/admin/stats/overview',
      '/api/admin/stats/payouts',
      '/api/admin/stats/games',
      '/api/admin/users',
      '/api/admin/users/:id',
      '/api/admin/payouts/:id/retry'
    ];
    for (const p of expected) {
      expect(paths).toContain(p);
    }
    expect(paths.length).toBe(expected.length);
  });
});
