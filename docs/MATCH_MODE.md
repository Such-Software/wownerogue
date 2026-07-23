# Match Mode — Race/PvP Multiplayer

> Status: **Implemented** — all five milestones complete. Single-player and Tavern modes are untouched.

Match mode adds real-time multiplayer races to Wownerogue. It reuses the existing shared-world
engine (`Room`/`Occupant`), the render kit, the payment/payout systems, and provably-fair seeding.

## Supported economies

| Economy | Entry cost | Payout | Leaderboard |
|---|---|---|---|
| `free` | None | None | Pleb board |
| `credits_prestige` | Credits | None (prestige only) | Prestige board |
| `crypto_race` | Race-entry ticket | Winner-take-pot (minus house fee) | Hall of Champions |

Unredeemable credits are the same `users.credits` balance running with `CREDITS_PAYOUTS_ENABLED=false`;
there is no separate "fake credit" system. Crypto races use non-refundable **race-entry tickets**
(`users.race_entries`) so players never need an on-chain refund when leaving a queue before a match
starts.

## Lifecycle: a race every block

The existing solo `queueHandler` already reacts to new crypto blocks. `MatchScheduler` subscribes to
the same block-count event. Free and value-bearing queues intentionally have different starts:

- A free queue with ≥2 players drains into a `MatchRoom` immediately on the current block event.
- A paid queue with ≥2 players at canonical header H atomically creates a `pending` match and links
  the exact FIFO queue rows and entrants. That transaction records a deterministic entrant-freeze
  commitment and fixes canonical header H+the configured entropy delay as its target; it does not
  read a block hash or create a playable seed. A fresh post-commit count is persisted while the
  target is still in the future.
- Only a later, sufficiently confirmed block-count event can resolve that pending match. The
  scheduler twice requests the canonical hash for the exact target, verifies the frozen IDs again,
  derives the seed, and changes the match from `pending` to `starting` before collection/countdown.
  It immediately checks the hash again. Another height and server randomness are not substitutes.
- If a queue has 1 player, they carry over and may leave until a freeze claims their row.
- If a queue is empty, nothing happens.

A match ends when:
1. Its selected ruleset resolves (for example, first exit, last alive, or all players resolved).
2. If `ruleset.timing.blockDeadline` is enabled, the first advancing canonical header after both
   the match's start header and `MATCH_MIN_DURATION_MS` of active play is observed. A duplicate
   block poll, the start header itself, or a block arriving before the floor cannot end the match;
   after an early block, the match waits for the next advancing header.
3. The `MATCH_HARD_CEILING_MS` absolute ceiling expires.

Final placement and `winnerId` come from the selected ruleset's deterministic rank strategy. The
classic race uses exit/proximity ranking; last-alive and score-attack use their own competitive
rankings.

## Architecture

### Engine layer (`src/multiplayer/`)

- `MatchRoom.js` — extends `Room`. Owns a shared deterministic dungeon, shared monster, player
  life/death/finish state, treasure, and the block/timer deadline. Serves as the synchronous tick
  resolver.
- `MatchEngine.js` — server tick driver. Wraps a `MatchRoom` with a `setInterval` timer, calls
  `resolveTick()`, and fires `onFinish` when the match ends.
- `MatchState.js` — serialization helpers that produce broadcast/persistence shapes, including the
  renderer-agnostic `gameState` consumed by `html/js/render/sceneModel.js`.

### Transport / lifecycle layer (`src/network/`)

- `matchQueue.js` — persisted per-economy queues (`free`, `credits_prestige`, `crypto_race`),
  join/leave, atomic credit/ticket escrow.
- `matchScheduler.js` — block-cadence scheduler that drains queues into matches.
- `matchManager.js` — Socket.IO rooms, match lifecycle, broadcasts, reconnect grace, persistence.
- `matchPayoutService.js` — crypto-race pot accounting, house-fee split, winner payout record.
- `matchLeaderboard.js` — posts match scores to the correct leaderboard.
- `tavernMatchBridge.js` — forwards public match state to the tavern room for spectators.

### Persistence

See migration `src/migrations/022_match_mode.sql`:

- `matches` — one race, including the durable `pending` entrant-freeze envelope and later
  verifiable seed commitment, economy, pot/fee, winner.
- `match_entrants` — per-player state, placement, score, payment link.
- `match_events` — replay / spectator / audit feed.
- `match_queue_entries` — persisted queue for restart safety.
- `race_entry_transactions` — race-entry ticket ledger.
- `users.race_entries` — hot-read ticket balance.
- `payouts.match_id` — links winner payout to match.

### Match seed verification

Paid matches use `future-block-freeze-v2` / `future-chain-block-v2`. At canonical header H the
server commits the exact economy, ruleset, sorted durable FIFO queue-entry IDs, configured delay,
and target `H + MATCH_PAID_ENTROPY_DELAY_BLOCKS` in a `pending` row before requesting any hash.
After that transaction commits, a fresh strict daemon count must prove that the target does not yet
exist; the witnessed tip and verification timestamp are durable and immutable. A delayed commit
that reaches the target is cancelled and every exact escrow anchor is refunded without reading the
target hash. Legacy v1 or otherwise unverified pending freezes are also refunded at startup.

Activation waits until the target itself has the configured confirmation depth (the target counts
as confirmation one). The scheduler reads count/header/count/header and requires both exact-height
headers to have the same canonical hash. It re-reads that target immediately after the activation
transaction and before ticket collection, gameplay, or client notification; an unavailable or
changed hash aborts and refunds the match. The playable seed is SHA-256-derived only from the v2
freeze commitment and exact target hash. The persisted/public proof records the delay, required
confirmations, minimum activation tip, and post-commit witness. Confirmation settings are safety
metadata rather than extra seed material.

Monero-family `getblockcount` is a count, while `get_block(height)` uses zero-based header heights.
The scheduler normalizes the event exactly once (`observedHeaderHeight = blockCount - 1`). Every
persisted/disclosed `blockHeight` is the actual header height passed unchanged to `get_block`, so the
published height resolves to the published hash without an off-by-one translation.

This proves the documented seed derivation and deterministic dungeon; it does not prove honest
input handling, block-source independence, payout delivery, or resistance to a malicious chain
producer/operator. Free development matches may use a server-random commitment and are labelled
`server commitment only`. Do not describe match mode as equivalent to the solo two-party fairness
protocol without an independent review.

## Configuration

Add to `src/.env` (documented in `src/.env.example`):

```bash
# Enable match mode (default false)
MATCH_ENABLED=false

# Max players per match (also bounded by the selected ruleset; built-ins max at 8)
MATCH_MAX_PLAYERS=4

# Server tick interval in ms
MATCH_TICK_MS=250

# Server-selected gameplay ruleset; clients cannot override it
# race | last-alive | score-attack | coop-escape
MATCH_RULESET_ID=race

# Paid freeze target distance and activation confirmation depth.
# Production requires explicit safe integers from 2 through 100.
MATCH_PAID_ENTROPY_DELAY_BLOCKS=2
MATCH_PAID_ENTROPY_CONFIRMATIONS=2

# Minimum race duration before the next block can end it
MATCH_MIN_DURATION_MS=20000

# Hard ceiling after which a race is force-ended
MATCH_HARD_CEILING_MS=240000

# Credits cost for prestige-only races
MATCH_CREDITS_COST=1

# Crypto race house fee percent (required; 0 <= fee < 100)
MATCH_HOUSE_FEE_PERCENT=5

# Required per-player funded ticket value in atomic units.
MATCH_ENTRY_FEE_ATOMIC=5000000000

# Crypto admission requires both explicit match gates and an outer atomic-unit payout cap
MATCH_CRYPTO_RACE_ENABLED=false
MATCH_PAYOUTS_ENABLED=false
MATCH_PAYOUT_MAX=50000000000
```

Crypto races also require:
- A paid instance (`GAME_MODE=PAID_SINGLE` / `PAID_CREDITS` or equivalent `PAYMENT_MODES`).
- At least one race-entry product with `grants.race_entries: N` and
  `grants.race_entry_value_atomic` exactly equal to `MATCH_ENTRY_FEE_ATOMIC`. The product price
  must cover `N * MATCH_ENTRY_FEE_ATOMIC`; confirmation records a durable lot per payment.
- A competitive single-winner ruleset. `coop-escape` is rejected until split-payout semantics are
  implemented.

## Client surfaces

- `/match.html` — dedicated race queue / race view with economy selector and race HUD.
- `/tavern.html` — **Queue for Race** panel and **Active Races** list with Watch buttons. Tavern
  spectators receive `tavern_match_tick` / `tavern_match_end` events and render races through the
  existing render kit.

## Socket events

Server emits:
- `game_mode_info` — includes `modes.match { enabled, economies, maxPlayers, activeRuleset, rulesets }`.
- `match_queue_joined` / `match_queue_left` — queue responses.
- `match_joined` / `match_start` / `match_tick` / `match_end` — race lifecycle for players.
- `tavern_match_list` / `tavern_match_tick` / `tavern_match_end` — public race feed for tavern
  spectators.

Client sends:
- `match_queue` `{ economy, action: 'join' | 'leave' }`
- `match_move` `{ dx, dy }`
- `match_leave` — forfeit an active race.
- `tavern_match_list` — request active races.

## Leaderboards

- **Free competitive matches** create synthetic `games` rows with `game_mode = 'FREE'` for the
  Pleb board.
- **Credits/prestige competitive matches** are served from authoritative `matches` and
  `match_entrants` rows by `GET /api/leaderboard?board=prestige`.
- **Crypto competitive matches** create synthetic `games` rows with `game_mode = 'PAID_CREDITS'`
  for the generic self-hosted Hall of Champions board. Such Software's two operated profiles keep
  this economy disabled and exclude all match-generated rows from Champions.

The public leaderboard endpoint requires `board=pleb|champions|prestige`; omitting `board` safely
defaults to `pleb`. The removed mixed `board=all` behavior and unknown or blank values return 400
instead of silently combining or translating economies.

An individual win requires the durable match winner and placement #1 to agree; reaching the exit
alone is never treated as a win in last-alive or score-attack. `coop-escape` is collective, records
no individual `winnerId`, and keeps its results in `matches` / `match_entrants`; it is intentionally
excluded from individual boards until a dedicated team leaderboard exists.

## Tests

Run the match-mode test suites in isolation:

```bash
cd src
npx jest ../test/match
```

The suite includes block-deadline, authoritative leaderboard-result, co-op exclusion, durable
finish, and finished-room reconnect regressions in addition to the core room/queue/payout tests.

## Files added / modified

New:
- `src/migrations/022_match_mode.sql`
- `src/multiplayer/MatchRoom.js`, `MatchEngine.js`, `MatchState.js`
- `src/network/matchQueue.js`, `matchScheduler.js`, `matchManager.js`, `matchPayoutService.js`,
  `matchLeaderboard.js`, `tavernMatchBridge.js`
- `html/match.html`, `html/js/matchClient.js`
- `docs/MATCH_MODE.md`, `src/.env.match.example`
- 7 test files

Modified:
- `src/network/socketHandlers.js` — initializes match services and wires socket events.
- `src/network/identityService.js` — adds `userForId()`.
- `src/game/gameModeManager.js` — advertises `modes.match`; grants race-entry tickets on product
  payment.
- `src/payments/productGrants.js` — recognizes `grants.race_entries`.
- `src/index.js` — `/api/leaderboard?board=prestige`.
- `html/tavern.html` — race queue / spectator UI.
- `src/.env.example`, `docs/TAVERN_AND_MULTIPLAYER.md`, `docs/TODO.md`, `README.md`.

## Operational notes

- Match mode is **opt-in** and inert unless `MATCH_ENABLED=true`.
- `MATCH_RULESET_ID` is trusted server configuration; unknown/solo-only values fall back to `race`.
- Crypto race payouts reuse the existing `payouts` table, batch processor, and retry service.
- `MATCH_PAYOUTS_ENABLED=false` stops new admission and refunds queued ticket escrow. Matches whose
  pot/liability was already accepted still create their durable payout; the global payout master
  switch may pause dispatch without erasing it.
- The unconditional unique index `idx_payouts_one_per_match` prevents a replacement payout in every
  status, including `failed` and `needs_review`.
- Only confirmed-payment ticket lots with the current exact entry value can enter a crypto race;
  legacy/admin-granted aggregate tickets cannot create a payout liability. The exact lot is held
  on queue join and consumed in the same transaction that accepts the immutable match liability.
- Players who disconnect during a race have a 30-second grace period to reconnect.
- Paid freeze/start block events are serialized. A crash before activation leaves a resumable
  `pending` freeze; a crash after activation is handled by abandoned-match recovery. Orderly
  shutdown stops the scheduler, waits for its block task, and transactionally cancels/refunds every
  still-pending freeze before shutting down match transport.
