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

## New Features (Just Added)
- [x] **Chat History Persistence**: `ChatHistoryManager` stores messages in PostgreSQL with 30-day retention ✅
- [x] **Chat History on Connect**: New users receive last 50 messages on connect via `chat_history` event ✅
- [x] **Spectator System**: Full spectator mode with `SpectatorManager` for watching live games ✅
- [x] **Active Games List**: Real-time game list with pagination, sorting, and auto-refresh ✅
- [x] **Spectate UI**: "Watch Games" button, live game panel, and spectator controls ✅
- [x] **Spectator Broadcasts**: Game updates broadcast to spectators via Socket.IO rooms ✅

## Improvements / Refactoring
- [x] **Error Handling**: Extended `normalizeError` to queueHandler, queueManager, sessionManager ✅
- [x] **Configuration Persistence**: Added `configPersistence.js` for hot-reloadable DB-backed config ✅
- [x] **Monitoring Dashboard**: Created `/admin.html` with live metrics (games, queue, memory, wallet) ✅
- [x] **Frontend Cleanup**: Removed rot.js (using minified), game1.mid (unused), .DS_Store, moved tiles.xcf ✅
- [x] **Provably Fair UI**: Hash commitment shown at game start, seed revealed with verification link at game end ✅
- [x] **Verification Endpoint**: `/verify/:gameId` HTML page + `/api/verify` JSON endpoint for public verification ✅

## Documentation
- [x] **API Documentation**: README updated with accurate API surface including health check and Socket.IO events ✅
- [x] **Session Persistence**: README documents session token behavior and localStorage requirements ✅
- [x] **Difficulty System**: README documents difficulty presets and house edge tuning ✅
- [x] **Provably Fair**: README documents cryptographic verification system ✅
- [x] **Deployment Guide**: README includes production deployment with Nginx/Caddy configs and systemd ✅

## Pre-Beta Checklist
- [x] All 38 tests pass (8 test suites) ✅
- [x] Health check endpoint available at `/health` ✅
- [x] REST endpoints implemented: `/api/user/:socketId/credits`, `/api/user/:socketId/mode`, `/api/user/:socketId/address` ✅
- [x] Payout eligibility shown per payment mode in UI ✅
- [x] Session persistence tooltip and localStorage warning added ✅
- [x] Stagenet/testnet warning banner for Monero non-mainnet ✅
- [x] Chat history persisted and sent to new users ✅
- [x] Spectator system functional with live game viewing ✅
- [ ] **TLS/HTTPS**: Configure reverse proxy (Nginx/Caddy) with SSL certificates before exposing to real users.
- [ ] **Database Backups**: Implement automated backup strategy for PostgreSQL.
- [ ] **Manual Integration Test**: Run full payment flow with real `wownero-wallet-rpc` (not mocked).
- [ ] **Rate Limit Tuning**: Review rate limits for production traffic patterns.
- [ ] **Log Rotation**: Ensure logs don't fill disk in production.
