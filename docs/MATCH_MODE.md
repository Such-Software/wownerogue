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
the same block event and drains per-economy queues:

- If a queue has ≥2 players at block H, all queued players are placed into a new `MatchRoom` and the
  race starts immediately.
- If a queue has 1 player, they carry over to block H+1 and may leave at any time.
- If a queue is empty, nothing happens.

A race ends when:
1. The first player reaches the exit.
2. The next block is detected (with a `MATCH_MIN_DURATION_MS` floor to prevent degenerate short
   races).
3. The `MATCH_HARD_CEILING_MS` absolute ceiling expires.

If no one escaped, living players are ranked by proximity to the exit; dead players are ranked after
them by progress, treasure, and moves.

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

- `matches` — one race, provably-fair seed, economy, pot/fee, winner.
- `match_entrants` — per-player state, placement, score, payment link.
- `match_events` — replay / spectator / audit feed.
- `match_queue_entries` — persisted queue for restart safety.
- `race_entry_transactions` — race-entry ticket ledger.
- `users.race_entries` — hot-read ticket balance.
- `payouts.match_id` — links winner payout to match.

### Provably fair

Each match commits to a SHA-256 `seed_hash` at creation. The `seed` is revealed on finish so anyone
can regenerate the exact dungeon and verify the hash. This mirrors the existing solo
`games.dungeon_seed` / `games.seed` pattern.

## Configuration

Add to `src/.env` (documented in `src/.env.example`):

```bash
# Enable match mode (default false)
MATCH_ENABLED=false

# Max players per race (2–32)
MATCH_MAX_PLAYERS=4

# Server tick interval in ms
MATCH_TICK_MS=250

# Minimum race duration before the next block can end it
MATCH_MIN_DURATION_MS=20000

# Hard ceiling after which a race is force-ended
MATCH_HARD_CEILING_MS=240000

# Credits cost for prestige-only races
MATCH_CREDITS_COST=1

# Crypto race house fee percent (default 5)
MATCH_HOUSE_FEE_PERCENT=5

# Optional: override per-player entry fee atomic amount.
# If unset, uses the existing per-game price (singleGamePrice / DIRECT_GAME_PRICE).
# MATCH_ENTRY_FEE_ATOMIC=5000000000

# Enable the crypto race-entry ticket economy
MATCH_CRYPTO_RACE_ENABLED=false
```

Crypto races also require:
- A paid instance (`GAME_MODE=PAID_SINGLE` / `PAID_CREDITS` or equivalent `PAYMENT_MODES`).
- Race-entry ticket products in the credit/cosmetic catalog with `grants.race_entries: N`.

## Client surfaces

- `/match.html` — dedicated race queue / race view with economy selector and race HUD.
- `/tavern.html` — **Queue for Race** panel and **Active Races** list with Watch buttons. Tavern
  spectators receive `tavern_match_tick` / `tavern_match_end` events and render races through the
  existing render kit.

## Socket events

Server emits:
- `game_mode_info` — now includes `modes.match { enabled, economies, maxPlayers }`.
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

- **Free races** create synthetic `games` rows with `game_mode = 'FREE'` for the Pleb board.
- **Credits/prestige races** populate the `prestige_leaderboard` view and are served by
  `GET /api/leaderboard?board=prestige`.
- **Crypto races** create synthetic `games` rows with `game_mode = 'PAID_CREDITS'` for the Hall of
  Champions board.

## Tests

Run the match-mode test suites in isolation:

```bash
cd src
npx jest ../test/match
```

Current result: **40 passing** across 7 suites:

- `matchRoom.test.js`
- `matchQueue.test.js`
- `matchScheduler.test.js`
- `matchLeaderboard.test.js`
- `matchPayoutService.test.js`
- `tavernMatchBridge.test.js`
- `matchReconnect.test.js`

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
- Crypto race payouts reuse the existing `payouts` table, batch processor, and retry service.
- The unique partial index `idx_payouts_one_per_match` prevents double payouts.
- Race-entry tickets are held in escrow on queue join and consumed only when a match starts.
- Players who disconnect during a race have a 30-second grace period to reconnect.
