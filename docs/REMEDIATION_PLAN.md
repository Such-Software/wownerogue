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
- [x] **0.5 🟠 S — Single-game disconnect recovery.** ✅ `recoverPendingPayments` now also recovers confirmed-but-unconsumed `single_game` payments (no `games.payment_id` link) by granting the equivalent credits, idempotently (per-payment reason key, row-locked). Disconnect preservation made deterministic: the stable `dbUserId` is **stamped on the game at creation**, so suspend/restore never needs a fragile disconnect-time DB lookup — every game (paid or free) is reconnectable whenever a session exists; the drop-branch is now only the genuine no-session edge. New `singleGameRecovery.test.js` (grant / consumed / idempotent).
- [x] **0.6 🟠 S — Client + admin XSS and CSP.** ✅ Single shared `escapeHtml` helper (`html/js/core/escapeHtml.js`, escapes all five chars incl. both quotes); leaderboard delegates to it. Chat sinks (`onChatBroadcast`/`onChatHistory`) now escape username + message. Admin panel escapes user-controlled fields (payout address, socket id, player name, status) and its local `escapeHtml` now escapes quotes (safe in `title="…"`). CSP + `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` headers added via middleware in `index.js` (`connect-src 'self'` keeps Socket.IO working; nonce-based tightening tracked as Phase 4.4).

## Phase 1 — Money correctness hardening (🟠)
- [x] **1.1 M — `src/money/atomic.js` BigInt module.** ✅ Exact integer money math (`toBig`/`toSafe`/`sum`/`add`/`mulByDecimal`/`format`). `calculatePayout` now computes `base * multiplier` via BigInt (half-up rounding, narrows to number only when exact). `walletRPCService` batch total + fee sum use `money.sum` instead of float `reduce`. Property tests (`moneyAtomic.test.js`) prove exactness on amounts above 2^53 where the old float path drifted.
- [x] **1.2 S — Snapshot payout config at game start.** ✅ Migration 016 adds `payout_escape_amount`/`payout_treasure_amount` (BIGINT) + multipliers to `games`. Both start paths stamp the resolved payout amounts (via `_computePayoutSnapshot`); `completeGame` pays from the snapshot (falls back to live calc only for pre-snapshot games). New `payoutSnapshot.test.js` proves a mid-game config change can't alter an in-flight payout.
- [x] **1.3 S — Close payout uniqueness holes.** ✅ `processing` covered in the unique index (migration 015) and in the in-code existing-payout guard. Migration 017 adds idempotent `NOT VALID` CHECK constraints on `payments.status`, `payments.payment_type`, and `payouts.status` so a typo'd status can't silently orphan a money row (enforces new writes, won't choke on legacy rows). _(games.status/game_mode CHECKs deferred — transient states, lower money-impact.)_
- [x] **1.4 S — Fix retry stat guard + non-atomic tx_hash write.** ✅ The "already on-chain" path used a `NOT EXISTS` guard against the row it had just marked completed (always skipped → never counted); replaced with a conditional `UPDATE … WHERE status <> 'completed' RETURNING` so stats count exactly once. Successful retries now store `tx_hash` + mark completed + count stats in ONE transaction (no stranded-tx_hash window). New `payoutRetry.test.js` covers count-once, no-double-count, and atomic completion.
- [x] **1.5 S — Fix dead refund send-path.** ✅ The admin refund called a nonexistent `walletRPCService.sendPayment()` (guarded by a `typeof` check), so refunds were silently never sent while still reporting success. Now uses the real `processPayout()` (validates address + transfers, returns `{success, txHash}`) and refunds the **actually received** amount (`received_amount`, falling back to expected).
- [x] **1.6 S — `credits` → BIGINT; idempotent 010; atomic migration runner.** ✅ Migration 018 widens `users.credits` + `credit_transactions.amount/balance_after` to BIGINT. Migration 010 rewritten with conname-guarded `DO` blocks (re-runnable, no startup wedge). Runner now applies each migration **and** records the ledger row in one transaction (no applied-but-unrecorded state). Verified end-to-end: all 18 migrations applied cleanly to a throwaway Postgres DB, re-run skipped via the ledger, `credits` confirmed `bigint`, all CHECKs present.

## Phase 2 — Identity, abuse & concurrency (🟠)
- [x] **2.1 L — Unify identity resolution on stable `user_id`.** ✅ `getOrCreateUser` now resolves through SessionManager's stable `anon_token`→`id` identity first (re-selecting a fresh row by stable id), falling back to the legacy `socket_id` lookup only when no session exists — eliminating the duplicate "orphan" user row that caused credit/payout desync. `gameModeManager.sessionManager` wired in SocketHandlers. `anon_token` is already `UNIQUE` (migration 003), so the stable-identity constraint exists. New `identityResolution.test.js` proves no duplicate row is created when a session exists. _Deferred: re-keying the in-memory `activeGames` map by `user_id` (invasive; already mitigated in 0.5 by stamping `dbUserId` on the game) — tracked as a follow-up._
- [x] **2.2 M — Reconnect-proof rate limiting.** ✅ New `rateLimitContext` helper resolves a STABLE id (`anon_token`→`id`, falling back to socket id) + the real client IP. All socket-event limiters (game:start, address:set, chat:message) now pass both — previously they passed `socket.id` and **no IP at all**, so reconnecting reset every limit and the "IP-limited" prefixes never actually applied. `chat:` added to IP-limited prefixes; `connection:new` uses the real IP. Express `trust proxy` + XFF honored only when `TRUST_PROXY=true` (documented in `.env.example`). Contradictory default limit values aligned. New `rateLimit.test.js` (reconnect can't bypass, IP backstop, XFF gating).
- [x] **2.3 M — Input validation + leak fixes.** ✅ `register_client` validates `clientId` (type/length/charset) before it enters `clientSocketMap` — closes the map-poisoning vector. `mempoolNotified` is now a Map with real TTL eviction in PaymentHandlers (the dead duplicate Set + its random-10% eviction removed from SocketHandlers). `sessions` cache evicted on disconnect (`removeSocket`, called after suspend reads it). `sessionManager.dispose()` / `suspendedGameManager.cleanup()` / `paymentHandlers.dispose()` wired into `shutdown()`. `checkGamesTimeout` snapshots before iterating + awaits sequentially (was mutate-during-`forEach` + fire-and-forget). New `inputValidation.test.js`.

## Phase 3 — Game integrity (🟠)
- [x] **3.1 S — Anti-instant-death grace only (NO fairness floor).** ✅ Random block timing is the game's core mechanic and is deliberately preserved — early entry is a knowingly-risky bet, not a bug. The only change is a tiny configurable grace (`GAME_START_GRACE_MS`, default 2000ms, 0 to disable) so a block landing the instant a game starts can't kill the player before the dungeon renders / before their first move is possible. _(Rejected the originally-planned uniform time budget — it would gut the random-timing mechanic.)_
- [x] **3.2 S — Reachability guarantee.** ✅ `DungeonGenerator.generate` now BFS-checks entrance→exit reachability and regenerates if unreachable (paid-but-unwinnable guard). Retries are **deterministic** (per-attempt ROT seed = `seedInt+attempt`, seeded rng stream advances), so verify-regeneration replays the same attempts and reproduces the exact dungeon — provably-fair determinism preserved. New `isReachable` + tests (25 seeds all reachable; walled-off target rejected).
- [x] **3.3 S — Multi-step monster collision fix.** ✅ Collision is now checked after **each** monster sub-step, not just after the loop. With `movesPerPlayerMove > 1` (casino's 1.5× speed) the monster could previously step onto the player's tile and off again between checks, phasing through and missing the catch (player-favorable, eroded the house edge). New `monsterCollision.test.js`.

## Phase 4 — De-spaghetti / structural cleanup (🟡)
- [x] **4.1 L — Break up `index.js` (substantially).** ✅ Extracted the verify HTML → `views/verifyPage.js` (now HTML-escaped), all 15 admin endpoints → `routes/admin.js`, and the 3 smirk endpoints → `routes/auth.js`, each as DI factories with smoke tests. **index.js: 2029 → 882 lines (-57%).** _Remaining user/public routes left inline — they're interleaved with bootstrap and have no route tests, so further slicing is diminishing-return/higher-risk; the structure + pattern are established for later._
- [~] **4.2 M — Kill duplicates (partial).** ✅ Deleted the dead `handlePlayerMove` handler (a footgun that double-stepped the monster + bypassed escape/collision detection) and its orphaned `playerMoveTimestamps` map/cleanup — the live path is `MovementManager`. _Remaining (lower-value/higher-effort): merge `rpcService`+`rpccalls`, unify `payout_address` column widths, address the `QueryValidator` false-positive — deferred._
- [⏸] **4.3 M — Config snapshots — DEFERRED (risk > value).** The `process.env` config write-back is ugly but **load-bearing**: it's how DB-persisted hot-reload config reaches the env-based readers — `difficultyConfig` selects the difficulty preset from `process.env.GAME_MODE`, and `debugManager`'s simulated-blocks **safety gate** reads it. A proper `ConfigService` means rewiring those sensitive readers; with no config-reload tests and zero correctness/safety upside, the risk isn't justified right now. Documented rather than rewritten.
- [~] **4.4 M — Frontend de-spaghetti (safe wins done).** ✅ Shared `escapeHtml` already added in 0.6. Removed the duplicate `_gameMode` declaration (the later `null` silently shadowed the earlier `'free'`). Removed the dead `SocketHandlers._appendMessage` calls in `smirkAuth.js` (the method never existed; always fell through to the working `.text()` append). Gated `broadcastManager`'s high-volume per-event logs (user-count, chat-message-with-PII, game-update, game-start) behind debug mode. _Deferred: jQuery 3.4.1 upgrade and the nested-`setTimeout` init-ordering rewrite (larger, no frontend tests, higher risk)._
- [x] **4.5 S — Delete stale `test/` scratch files.** ✅ Removed 14 non-jest leftovers (5 `.js` scratch scripts + 9 `.html` debug pages) — confirmed they contained no jest constructs and were referenced nowhere. `test/` is now exclusively the 21 real jest suites.

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
