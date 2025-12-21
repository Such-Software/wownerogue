# Wownerogue Development Todo

## High Priority
- [x] **Verify Server Startup**: Server starts cleanly with `npm run dev` ✅
- [ ] **Test Payment Flow**: Verify the full payment lifecycle (Request -> QR -> Payment -> Confirmation -> Game Start).
- [ ] **Test Payouts**: Confirm payouts are triggered correctly upon winning in paid modes.
- [x] **Address Persistence**: Verify that payout addresses persist across server restarts via session tokens. ✅
- [x] **Mixed Mode Logic**: Per-user mode determination based on credits balance ✅
- [x] **Credits Package Bug**: Credits correctly parsed from package info on confirmation ✅
- [x] **Stagenet Support**: Added MONERO_NETWORK config with UI warnings for non-mainnet ✅
- [x] **Difficulty Tuning**: Configurable presets (easy/normal/hard/casino) for house edge control ✅
- [x] **Provably Fair**: SHA-256 commitment scheme for verifiable game generation ✅

## Improvements / Refactoring
- [ ] **Error Handling**: Extend `normalizeError` usage to remaining network modules for consistent error reporting.
- [ ] **Configuration Persistence**: Implement persistence for payment configuration updates to support hot reloads.
- [ ] **Monitoring Dashboard**: Build a lightweight dashboard for live metrics (active games, queue length, rate limits).
- [ ] **Frontend Cleanup**: Remove any remaining dead code or unused assets from the `html/` directory.
- [ ] **Provably Fair UI**: Add frontend display of game hash commitment and post-game verification link.
- [ ] **Verification Endpoint**: Add `/verify/:gameId` REST endpoint for public game verification.

## Documentation
- [x] **API Documentation**: README updated with accurate API surface including health check and Socket.IO events ✅
- [x] **Session Persistence**: README documents session token behavior and localStorage requirements ✅
- [x] **Difficulty System**: README documents difficulty presets and house edge tuning ✅
- [x] **Provably Fair**: README documents cryptographic verification system ✅
- [ ] **Deployment Guide**: Create a detailed deployment guide including reverse proxy setup (Nginx/Caddy).

## Pre-Beta Checklist
- [x] All 38 tests pass (8 test suites) ✅
- [x] Health check endpoint available at `/health` ✅
- [x] REST endpoints implemented: `/api/user/:socketId/credits`, `/api/user/:socketId/mode`, `/api/user/:socketId/address` ✅
- [x] Payout eligibility shown per payment mode in UI ✅
- [x] Session persistence tooltip and localStorage warning added ✅
- [x] Stagenet/testnet warning banner for Monero non-mainnet ✅
- [ ] **TLS/HTTPS**: Configure reverse proxy (Nginx/Caddy) with SSL certificates before exposing to real users.
- [ ] **Database Backups**: Implement automated backup strategy for PostgreSQL.
- [ ] **Manual Integration Test**: Run full payment flow with real `wownero-wallet-rpc` (not mocked).
- [ ] **Rate Limit Tuning**: Review rate limits for production traffic patterns.
- [ ] **Log Rotation**: Ensure logs don't fill disk in production.
