## Match Mode (Complete)

All milestones implemented. See `docs/MATCH_MODE.md` for architecture and configuration.

- [x] Design review: economy models, block-cadence lifecycle, ticket system, premium integration
- [x] Database schema: `matches`, `match_entrants`, `match_events`, `match_queue_entries`, `race_entry_transactions`, `users.race_entries`, `payouts.match_id`
- [x] Engine scaffold: `MatchRoom`, `MatchEngine`, `MatchState` with unit tests
- [x] Per-economy queues and block-cadence `MatchScheduler`
- [x] Socket.IO `MatchManager` and free races
- [x] Credits/prestige races and separate Prestige leaderboard
- [x] Crypto race-entry tickets and winner-take-pot payout
- [x] Client (`match.html`, `matchClient.js`) and Tavern spectator integration
- [x] Reconnect/AFK tests
- [x] Final doc pass and operator deployment notes
- [x] Unit tests: 40 passing across 7 suites

# Wownerogue Development Todo

## Rendering, Balance & Multi-level (2026-07)

Done:
- [x] **Render packs**: modes (technique) vs packs (style) split; "Fancy" retired to a topdown pack; multi-pack registry; Kenney iso dungeon set + orientation-aware walls; per-projection pack picker. See `RENDER_PACKS.md`.
- [x] **FX layer (`RK.fx`)**: shared canvas fire/hazard/glow; tavern braziers + hearth; dungeon hazard tiles wired. Zoom (`zoomControl.js`); animated cat.
- [x] **Balance sim** (`src/sim/`): headless harness over the real engine; measured house-win per network. See `BALANCE_SIM.md`.
- [x] **Per-network tuning**: `cryptoType` now shapes difficulty via `NETWORK_TUNING` (was a dead param).
- [x] **WOW block-time fix**: 2 min → **5 min** (measured on the live daemon); `chainProfile.js`.
- [x] **Multi-level dungeons**: descend N levels ∝ block time; provably-fair per level; treasure in the vault. See `MULTI_LEVEL.md`.

Pending:
- [ ] **Multi-level calibration run**: lock per-network level counts against a target house-win (sim multi-level support is in; counts are currently starting points).
- [ ] **Block-bounded pot race** (flagship): consume `Ruleset.timing.blockDeadline`; add pot+rake economy (house = zero-risk rake-taker). Decisions pending: empty-pot rule, prize split.
- [ ] **PvP wiring**: connect the already-built `last-alive`/`score-attack` rulesets to a real queue.
- [ ] **Hazard gameplay**: generator places lava/poison/spikes (FX already renders them) + damage stakes; escalate per level.
- [ ] **Client polish**: "Level N/M" indicator + "descended" toast (server sends `depth`/`maxDepth` + `game_event: descend`).

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

## Security Audit Fixes (Jan 2026)
- [x] **XSS Vulnerability**: Complete HTML entity escaping in chat handler (`&`, `<`, `>`, `"`, `'`)
- [x] **tx_hash Idempotency**: UNIQUE partial indexes on payments/payouts tables (migration 008)
- [x] **Timing-Safe Auth**: Admin API uses `crypto.timingSafeEqual()` for key comparison
- [x] **Transactional Payouts**: Payout flow creates pending record first, updates atomically
- [x] **Payout Retry Service**: Auto-retries failed payouts (max 3 attempts, 5-min interval)
- [x] **Address Validation**: `validateAddress()` called before every payout attempt
- [x] **Transaction Status Check**: `checkTransactionStatus()` verifies blockchain before retry

## Smirk Wallet Integration (Jan-Feb 2026)
- [x] **Database Schema**: `smirk_public_key` column, `smirk_challenges` table (migration 009)
- [x] **Auth Endpoints**: `/api/auth/smirk/challenge`, `/verify`, `/status`
- [x] **Frontend Module**: `smirkAuth.js` with extension detection and login flow
- [x] **Address Modal**: Shows Smirk connect button or install link
- [x] **Native Payments**: `requestPayment()` integration — Smirk-connected users get auto-prompted via extension instead of manual address/QR. Falls back to normal flow on rejection.

## Admin Dashboard (Jan 2026)
- [x] **Alert Service**: Email alerts via Resend for low balance, disconnects, failed payouts
- [x] **Stats Endpoints**: `/api/admin/stats/overview`, `/payouts`, `/games`, `/users`
- [x] **Admin UI**: Full dashboard at `/admin.html` with charts and tables
- [x] **Payout Retry**: Manual retry button in admin dashboard

## Scoring & Leaderboard (Feb 2026)
- [x] **Scoring System**: New formula (max 800 pts) — base escape + treasure bonus + speed bonus + efficiency bonus
- [x] **Score Persistence**: `score` column on games table, `high_score` on users (migration 014)
- [x] **Leaderboard API**: `GET /api/leaderboard?period=all|week|month` with display name support
- [x] **Leaderboard UI**: Modal with rank, name, best score, wins, games. Period tabs (All/Week/Month)
- [x] **Display Names**: `/nick` chat command stores `display_name` on users table
- [x] **Real-time Updates**: `leaderboard_update` broadcast on game wins, auto-refreshes open modal
- [x] **Difficulty Tuning**: Casino preset hardened — 70x35 dungeon, 1.5x monster speed, 97% chase, 22-tile vision

## Payout Reliability (Feb 2026)
- [x] **Fire-and-Forget INSERT Fix**: `_insertGameRecord` now awaited, prevents race conditions ✅
- [x] **Double Game-Over Prevention**: `activeGames.delete()` moved before any `await` in `handleGameOver` ✅
- [x] **DB-Level Duplicate Payout Prevention**: Unique partial index on `payouts(game_id)` (migration 012) ✅
- [x] **Payout Address Locking**: Address captured at game start, stored in `games.payout_address` ✅
- [x] **Dead Code Removal**: Deleted unused `processGameCompletion()` method ✅
- [x] **Same-Block Payout Batching**: Payouts within 5-second window batched into one `transfer_split` call ✅
- [x] **Output Splitting Script**: `scripts/splitOutputs.js` for wallet output management ✅
- [x] **transfer_split**: Switched from `transfer` to `transfer_split` for output resilience ✅

## Pre-Production Testing Checklist

### Security Verification
- [ ] Chat XSS: `<script>` and `"onclick=` render as plain text
- [ ] Duplicate tx_hash insertion fails with constraint error
- [ ] Payout creates pending record before RPC call
- [ ] Failed payouts have records for retry
- [ ] Retry service processes failed payouts (check logs)

### Smirk Integration Verification
- [ ] "Connect Smirk" button appears when extension installed
- [ ] "Get Smirk Wallet" link appears when extension NOT installed
- [ ] Challenge generated and stored in DB
- [ ] Signature verification links public key to user
- [ ] Payout address auto-populated from wallet
- [ ] Anonymous sessions still work (backwards compatible)

### End-to-End Testing
- [ ] Play full game with Smirk login
- [ ] Win and receive payout to Smirk address
- [ ] Verify payout recorded in transaction history
- [ ] Manual integration test with real wallet-rpc

---

## Known Issues / Future Improvements

### Backend
- [x] **Database Transactions**: `withTransaction()` helper for atomic financial operations ✅
- [ ] **Payment Idempotency**: Replace in-memory Set with database-backed idempotency keys for payment confirmation
- [x] **Payout Retry Queue**: Automatic retry mechanism via `payoutRetryService.js` ✅
- [x] **Address Validation**: Wallet RPC `validate_address` method ✅
- [ ] **Redis Rate Limiting**: Replace in-memory rate limiter with Redis for persistence across restarts
- [ ] **Full Payout Batching**: Implement configurable batch intervals beyond same-block 5-second window
- [ ] **Wallet Health Monitoring**: Track spendable output count, alert when outputs are low

### Frontend
- [ ] **Socket Reconnection**: Add `reconnect` and `disconnect` handlers to restore state after connection loss
- [ ] **Payment Timeout UI**: Show countdown timer for payment expiration, auto-clean expired payment UI
- [ ] **Event Cleanup**: Add proper cleanup for event listeners when modules are re-initialized
- [ ] **Connection Status Indicator**: Show real-time socket connection state in UI
