# Wownerogue Development Todo

## High Priority
- [x] **Verify Server Startup**: Server starts cleanly with `npm run dev` ✅
- [ ] **Test Payment Flow**: Verify the full payment lifecycle (Request -> QR -> Payment -> Confirmation -> Game Start).
- [ ] **Test Payouts**: Confirm payouts are triggered correctly upon winning in paid modes.
- [ ] **Address Persistence**: Verify that payout addresses persist across server restarts via session tokens.

## Improvements / Refactoring
- [ ] **Error Handling**: Extend `normalizeError` usage to remaining network modules for consistent error reporting.
- [ ] **Configuration Persistence**: Implement persistence for payment configuration updates to support hot reloads.
- [ ] **Monitoring Dashboard**: Build a lightweight dashboard for live metrics (active games, queue length, rate limits).
- [ ] **Frontend Cleanup**: Remove any remaining dead code or unused assets from the `html/` directory.

## Documentation
- [x] **API Documentation**: README updated with accurate API surface including health check and Socket.IO events ✅
- [ ] **Deployment Guide**: Create a detailed deployment guide including reverse proxy setup (Nginx/Caddy).

## Pre-Beta Checklist
- [x] All 21 tests pass ✅
- [x] Health check endpoint available at `/health` ✅
- [x] REST endpoints implemented: `/api/user/:socketId/credits`, `/api/user/:socketId/mode`, `/api/user/:socketId/address` ✅
- [ ] **TLS/HTTPS**: Configure reverse proxy (Nginx/Caddy) with SSL certificates before exposing to real users.
- [ ] **Database Backups**: Implement automated backup strategy for PostgreSQL.
- [ ] **Manual Integration Test**: Run full payment flow with real `wownero-wallet-rpc` (not mocked).
- [ ] **Rate Limit Tuning**: Review rate limits for production traffic patterns.
- [ ] **Log Rotation**: Ensure logs don't fill disk in production.
