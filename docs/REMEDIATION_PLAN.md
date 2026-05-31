# Wownerogue Remediation & Cleanup Plan

> Derived from the deep code review (May 2026). Goal: fix every BAD/UGLY finding, remove
> the spaghetti, and reach a **real-funds launch gate**. Phases are ordered so launch-blockers
> get surgical fixes first, then correctness hardening, then structural cleanup, then a
> test/ops overhaul to lock it in.

## Guiding principles
1. **Stabilize before restructuring.** Fix exploitable money bugs as minimal patches, ship, *then* refactor.
2. **Single source of truth** for the three things that bite: money (one BigInt module), identity (one `user_id`), randomness (one per-game seeded RNG).
3. **Defense in depth.** Every check at the DB *and* app level; every render escapes *and* the server escapes.
4. **Every change ships with a test that fails before and passes after.**

Key: `S` ≤ half day · `M` ~1–3 days · `L` ~1 week+ · 🔴 launch-blocker · 🟠 pre-launch · 🟡 post-launch

---

## Phase 0 — Stop the bleeding (launch-blockers)

- [x] **0.1 🔴 S — Verify amount received ≥ expected before confirming.** ✅ Gate on `status.complete` in `paymentHandlers.js`; underpaid → stay pending + `payment_underpaid` warning (once). `received_amount` now recorded for single-game + credits. Regression test added (`payment_flow.integration.test.js`). _113 tests green._
- [x] **0.2 🔴 M — Make provably-fair real.** ✅ Per-game seeded RNG (`seedToInt`) threaded through `dungeon.js` (Digger reseed + all `Math.random()` → `rng`), `monster.js` (`seededShuffle`), `game.js` (chase + generation). `DungeonGenerator.regenerateFromSeed` + `layoutFingerprint`; `/api/verify` regenerates & returns fingerprint. Determinism test suite added (`provablyFair.test.js`). _Verifier can now reproduce the exact dungeon from the seed._
- [x] **0.3 🔴 M — Fix batch-payout `tx_hash` collision + double-pay.** ✅ Migration 015 drops the payouts `tx_hash` unique index (batches legitimately share a tx_hash) and extends the one-per-game guard to cover `processing`. Batch completion now happens in ONE transaction via `id = ANY` (no row stranded mid-batch); BIGINT stat math (no float). Ambiguous batch failures → `needs_review` (retry service won't re-send) + operator alert. New `batchPayout.test.js` covers both paths.
- [x] **0.4 🔴 S — Harden identity transport.** ✅ Client sends `anon_token` in handshake `auth` (not the URL query → no proxy/referer/access-log leakage); server reads `auth` first with a query-string fallback for older clients. Token is now **rotated on every resume** (`rotateToken`), so a leaked token is invalidated when the real owner reconnects; client already persists the returned token. Rotation + old-token-replay-rejection test added to `security.test.js`.
- [ ] **0.5 🟠 S — Single-game disconnect recovery.** Extend `recoverPendingPayments` (`src/network/sessionManager.js:158`) to handle `single_game`; stop silently deleting in-progress paid games (`src/network/socketHandlers.js:787`).
- [ ] **0.6 🟠 S — Client + admin XSS and CSP.** Escape chat/admin fields (`html/js/network/socketHandlers.js:291,323`; `html/admin.html`); add CSP headers.

## Phase 1 — Money correctness hardening (🟠)
- [ ] **1.1 M — `src/money/atomic.js` BigInt module** as the only money type; remove `Number()` casts in `gameModeManager.js` and float `reduce` in `walletRPCService.js:314`.
- [ ] **1.2 S — Snapshot payout config at game start** (`gameModeManager.js:237`); pay from recorded multiplier/base.
- [ ] **1.3 S — Close payout uniqueness holes.** Cover `processing` in the unique index; guard INSERT (`gameModeManager.js:1161`); add status/outcome/mode enum CHECKs.
- [ ] **1.4 S — Fix retry stat guard + non-atomic tx_hash write** (`src/payments/payoutRetryService.js:121,174`).
- [ ] **1.5 S — Remove dead refund send-path** (`src/index.js:795`).
- [ ] **1.6 S — `credits` → BIGINT; make migration 010 idempotent** (`src/migrations/010_security_constraints.sql`); per-migration transactions in runner (`src/db/databaseManager.js:146`).

## Phase 2 — Identity, abuse & concurrency (🟠)
- [ ] **2.1 L — Unify identity on `user_id`.** One `IdentityService.resolve(socket)`; kill `getOrCreateUser(socketId)` keying (`gameModeManager.js:926`); key `activeGames` by `user_id`.
- [ ] **2.2 M — Reconnect-proof rate limiting.** Key on `user_id`/IP; IP-limit chat; set `trust proxy`; de-dup limit configs (`src/network/rateLimiter.js:80`).
- [ ] **2.3 M — Input validation + leak fixes.** Validate socket payloads (`connectionHandler.js:90`); TTL-evict `mempoolNotified` (`socketHandlers.js:223`); evict `sessions` on disconnect; wire all `dispose()` into `shutdown()`; snapshot in `checkGamesTimeout` (`socketHandlers.js:1012`).

## Phase 3 — Game integrity (🟠)
- [ ] **3.1 S — Uniform time budget** (elapsed/fixed-block, not "next block"); fix early-entry (`src/network/queueHandler.js:241`).
- [ ] **3.2 S — Reachability guarantee** entrance→treasure→exit (`src/game/dungeon.js`).
- [ ] **3.3 S — Swap/passthrough collision fix** (`src/game/game.js:181`).

## Phase 4 — De-spaghetti / structural cleanup (🟡)
- [ ] **4.1 L — Break up `index.js`** into `app.js`, `routes/{public,user,admin,auth}.js`, `views/verify.js`, `server.js`.
- [ ] **4.2 M — Kill duplicates.** Merge `rpcService`+`rpccalls`; delete dead `handlePlayerMove` (`socketHandlers.js:244`); unify `payout_address` widths; remove `QueryValidator` theater (`databaseManager.js:21`).
- [ ] **4.3 M — Config as immutable snapshots;** stop mutating `process.env` (`gameModeManager.js:189`).
- [ ] **4.4 M — Frontend de-spaghetti.** Shared `escapeHtml`/`dom.js`; kill double-declares + dead `_appendMessage`; explicit init ordering; upgrade/drop jQuery; gate broadcast logging (`broadcastManager.js:33`).
- [ ] **4.5 S — Delete stale `test/` scratch files.**

## Phase 5 — Test & ops overhaul (🟠 — the launch gate)
- [ ] **5.1 L — Real money-path tests** against Postgres (no stubbed `withTransaction`): under/overpay, double-confirm, batch dispatch, credit race, retry idempotency; property-test `money/atomic.js`.
- [ ] **5.2 S — Run real `wownero-wallet-rpc` integration test** (open in TODO since day one).
- [ ] **5.3 S — `environmentValidator` hard-stop** (`process.exit(1)`); add admin-key/mainnet/simulated-block checks (`src/index.js:33`).
- [ ] **5.4 S — Reconcile docs** (README vs `.env.example` house odds); document real provably-fair.
- [ ] **5.5 M — Durability:** DB/Redis-backed idempotency + rate limiter.
- [ ] **5.6 S — TLS** via reverse proxy.

---

## Sequencing
Build `money/atomic.js` (1.1) and per-game RNG (0.2) **early** — Phases 1/3/4 depend on them.
```
Phase 0 (days) → freeze features, ship → Phase 1 (+5.1/5.2 in parallel)
→ Phase 2 → Phase 3 → Phase 4 (safe now) → finish Phase 5 → LAUNCH GATE
```

## Launch gate (real funds)
- [ ] Under/overpayment correct + reconciled (0.1)
- [ ] Provably-fair reproduces dungeon, or claim removed (0.2)
- [ ] No double-payout under batch+retry, test-proven (0.3, 1.3, 1.4, 5.1)
- [ ] All money math BigInt, property-tested (1.1)
- [ ] One identity, impersonation closed (0.4, 2.1)
- [ ] XSS closed + CSP (0.6)
- [ ] Real wallet-rpc integration test executed (5.2)
- [ ] Validator hard-stops on misconfig (5.3)
- [ ] TLS in front (5.6)

_Estimate: ~3–4 weeks to launch gate; Phase 0 in days._
