# Wownerogue Development Todo

## High Priority
- [x] **Verify Server Startup**: Server starts cleanly with `npm run dev` ✅
- [x] **Test Payment Flow**: Fixed critical bug where payment confirmation wasn't updating DB status ✅
- [x] **Test Payouts**: Payout flow verified with duplicate prevention and proper mode tracking ✅
- [x] **Address Persistence**: Verify that payout addresses persist across server restarts via session tokens. ✅
- [x] **Mixed Mode Logic**: Per-user mode determination based on credits balance ✅
- [x] **Credits Package Bug**: Credits correctly parsed from package info on confirmation ✅
- [x] **Stagenet Support**: Added MONERO_NETWORK config with UI warnings for non-mainnet ✅
- [x] **Difficulty Tuning**: Configurable presets (easy/normal/hard/casino) for house edge control ✅
- [x] **Provably Fair**: SHA-256 commitment scheme for verifiable game generation ✅

## Recent Fixes (Jan 2026)
- [x] **Payment DB Status Bug**: Fixed critical issue where single_game payments weren't marked 'confirmed' in DB, causing game start to fail ✅
- [x] **TileMap Character Error**: Fixed '●' character not in tileMap causing tile mode rendering failures ✅
- [x] **Test Suite Fixes**: All 106 tests now pass (10 test suites) ✅
- [x] **Credit Deduction Bug**: Fixed race condition where credits could go negative - now uses `WHERE credits >= $1` ✅
- [x] **Payout Mode Bug**: Fixed `completeGame` using global `gameMode` instead of recorded `payment_mode` from game record ✅
- [x] **Duplicate Payout Prevention**: Added check for existing payout before processing to prevent double-payouts ✅
- [x] **Dead Code Cleanup**: Removed unused MoneroPayService (was never used, WalletRPCService is the actual service) ✅
- [x] **Game Reconnection/Resume**: Added `SuspendedGameManager` to preserve and restore games when users disconnect and reconnect. Users in dungeon or awaiting payment can now resume seamlessly ✅

## New Features (Just Added)
- [x] **Chat History Persistence**: `ChatHistoryManager` stores messages in PostgreSQL with 30-day retention ✅
- [x] **Chat History on Connect**: New users receive last 50 messages on connect via `chat_history` event ✅
- [x] **Spectator System**: Full spectator mode with `SpectatorManager` for watching live games ✅
- [x] **Active Games List**: Real-time game list with pagination, sorting, and auto-refresh ✅
- [x] **Spectate UI**: "Watch Games" button, live game panel, and spectator controls ✅
- [x] **Spectator Broadcasts**: Game updates broadcast to spectators via Socket.IO rooms ✅
- [x] **Help Modal**: Added instructions modal with game rules, controls, and payment mode info ✅
- [x] **Dynamic Treasure Icon**: Treasure tile now shows $W (Wownero) or $M (Monero) based on crypto type ✅
- [x] **Address Status Indicator**: Payout address button shows warning when no address is set ✅

## User Feedback (Beta Tester - Dec 2025)
- [ ] **History Panel Bug**: User reported payout not showing in History after winning with treasure (needs investigation - may be timing/status issue with "confirmed" vs "pending" payouts)
- [x] **Early Dungeon Entry**: Allow credits/free mode users to enter dungeon immediately without waiting for next block (risky - they die if block found before escape). Toggleable via config. ✅

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
- [x] All 106 tests pass (10 test suites) ✅
- [x] Health check endpoint available at `/health` ✅
- [x] REST endpoints implemented: `/api/user/:socketId/credits`, `/api/user/:socketId/mode`, `/api/user/:socketId/address` ✅
- [x] Payout eligibility shown per payment mode in UI ✅
- [x] Session persistence tooltip and localStorage warning added ✅
- [x] Stagenet/testnet warning banner for Monero non-mainnet ✅
- [x] Chat history persisted and sent to new users ✅
- [x] Spectator system functional with live game viewing ✅
- [ ] **TLS/HTTPS**: Configure reverse proxy (Nginx/Caddy) with SSL certificates before exposing to real users.
- [x] **Database Backups**: `scripts/backup_db.sh` + systemd timer for daily backups with 30-day retention (see `LOGS_AND_BACKUP.md`) ✅
- [ ] **Manual Integration Test**: Run full payment flow with real `wownero-wallet-rpc` (not mocked).
- [x] **Rate Limit Tuning**: Current defaults (60 games/hour, 100 payouts/day) suitable for launch ✅
- [x] **Log Rotation**: Using systemd journald with configurable retention (see `LOGS_AND_BACKUP.md`) ✅

## Known Issues / Future Improvements

### Backend
- [ ] **Database Transactions**: Wrap multi-step financial operations in transactions (credit deductions, payout processing)
- [ ] **Payment Idempotency**: Replace in-memory Set with database-backed idempotency keys for payment confirmation
- [ ] **Payout Retry Queue**: Implement automatic retry mechanism for failed payouts
- [ ] **Address Checksum Validation**: Add cryptographic checksum validation for XMR/WOW addresses
- [ ] **Redis Rate Limiting**: Replace in-memory rate limiter with Redis for persistence across restarts

### Frontend
- [ ] **Socket Reconnection**: Add `reconnect` and `disconnect` handlers to restore state after connection loss
- [ ] **Payment Timeout UI**: Show countdown timer for payment expiration, auto-clean expired payment UI
- [ ] **Event Cleanup**: Add proper cleanup for event listeners when modules are re-initialized
- [ ] **Connection Status Indicator**: Show real-time socket connection state in UI
