# Match Mode: Real-Time Multiplayer Races

Match mode adds real-time multiplayer races. It reuses the shared-world engine (`Room` / `Occupant`),
the render kit, the payment and payout systems, and provably-fair seeding. Single-player and Tavern
modes are unaffected by it.

Match mode is opt-in. Nothing in this document is active unless `MATCH_ENABLED=true`.

## Supported economies

| Economy | Entry cost | Payout | Leaderboard |
|---|---|---|---|
| `free` | None | None | Pleb board |
| `credits_prestige` | Credits | None (prestige only) | Prestige board |
| `crypto_race` | Race-entry ticket | Winner-take-pot minus house fee | Hall of Champions |

`credits_prestige` spends the same `users.credits` balance used everywhere else; there is no separate
"fake credit" system. On an instance running `CREDITS_PAYOUTS_ENABLED=false` those credits are
unredeemable, so the economy is prestige-only.

Crypto races spend non-refundable race-entry tickets (`users.race_entries`, backed by rows in
`race_entry_lots`), so leaving a queue before a match starts never requires an on-chain refund.

## Lifecycle

`MatchScheduler` subscribes to the same block-count event as the solo `queueHandler`. Free and
value-bearing queues start differently on purpose.

- A free queue with at least the ruleset minimum of players drains into a `MatchRoom` immediately on
  the current block event.
- A paid queue at canonical header H atomically creates a `pending` match and links the exact FIFO
  queue rows and entrants. That transaction records a deterministic entrant-freeze commitment and
  fixes canonical header `H + MATCH_PAID_ENTROPY_DELAY_BLOCKS` as its target; it does not read a
  block hash or create a playable seed. A fresh post-commit daemon count is persisted while the
  target is still in the future.
- Only a later, sufficiently confirmed block-count event can resolve that pending match. The
  scheduler requests the canonical hash for the exact target twice, verifies the frozen IDs again,
  derives the seed, and moves the match from `pending` to `starting` before ticket collection and
  countdown. It re-reads the hash immediately after activation. Another height and server randomness
  are not substitutes.
- If a queue is below the minimum player count, its members carry over and may leave until a freeze
  claims their row.
- If a queue is empty, nothing happens.

A match ends when:

1. Its selected ruleset resolves (for example first exit, last alive, or all players resolved).
2. `ruleset.timing.blockDeadline` is enabled and the first advancing canonical header is observed
   after both the match's start header and `MATCH_MIN_DURATION_MS` of active play. A duplicate block
   poll, the start header itself, or a block arriving before the floor cannot end the match; after an
   early block the match waits for the next advancing header.
3. The `MATCH_HARD_CEILING_MS` absolute ceiling expires.

Final placement and `winnerId` come from the selected ruleset's deterministic rank strategy. The
classic race uses exit/proximity ranking; last-alive and score-attack use their own competitive
rankings.

## Architecture

### Engine layer (`src/multiplayer/`)

- `MatchRoom.js` extends `Room`. Owns the shared deterministic dungeon, the shared monster when the
  ruleset includes one, player life/death/finish state, treasure, and the block/timer deadline. Acts
  as the synchronous tick resolver.
- `MatchEngine.js` is the server tick driver. It wraps a `MatchRoom` with an interval timer, calls
  `resolveTick()`, and fires `onFinish` when the match ends.
- `MatchState.js` holds serialization helpers that produce broadcast and persistence shapes,
  including the renderer-agnostic `gameState` consumed by `html/js/render/sceneModel.js`.

### Transport and lifecycle layer (`src/network/`)

- `matchQueue.js` persists per-economy queues (`free`, `credits_prestige`, `crypto_race`), handles
  join and leave, and performs atomic credit and ticket-lot escrow.
- `matchScheduler.js` is the block-cadence scheduler that freezes, activates, and drains queues into
  matches.
- `matchFairness.js` builds and verifies the paid entrant-freeze commitment and derives match seeds.
- `matchEconomyPolicy.js` is the single fail-closed admission contract for crypto matches, shared by
  the queue, scheduler, mode advertisement, and environment validator.
- `matchManager.js` owns Socket.IO rooms, match lifecycle, broadcasts, reconnect grace, and
  persistence.
- `matchPayoutService.js` handles crypto-race pot accounting, house-fee split, and the winner payout
  record.
- `matchLeaderboard.js` posts match scores to the correct leaderboard.
- `tavernMatchBridge.js` forwards public match state to the tavern room for spectators.

### Rulesets (`src/game/rulesets/`)

Built-in match rulesets are `race`, `last-alive`, `score-attack`, and `coop-escape`; `solo-classic`
is solo-only. `resolveMatchRuleset()` fails closed to `race` for an unknown or solo-only id. See
[RULESETS.md](RULESETS.md).

### Persistence

Schema lives in `src/migrations/`:

- `022_match_mode.sql` creates `matches`, `match_entrants`, `match_events`, `match_queue_entries`,
  and `race_entry_transactions`, adds `users.race_entries` and `payouts.match_id`.
- `029_match_ruleset_id.sql` records the ruleset that produced each match.
- `033_match_payout_liability.sql` adds `race_entry_lots` (per-payment funded ticket lots), links
  queue entries and entrants to their exact lot, and makes the accepted match liability immutable.
- `040_paid_match_entropy_precommit.sql` adds `entropy_precommit_tip_height` and
  `entropy_precommit_verified_at`, with a check constraint requiring the witnessed tip to be below
  the target height for paid economies.

`032_solo_liability_invariants.sql` defines the unconditional unique index
`idx_payouts_one_per_match`.

Tables:

- `matches` is one race, including the `pending` entrant-freeze envelope, the verifiable seed
  commitment, economy, pot and fee, and winner.
- `match_entrants` is per-player state, placement, score, and payment link.
- `match_events` is the replay, spectator, and audit feed.
- `match_queue_entries` is the persisted queue, for restart safety.
- `race_entry_transactions` is the race-entry ticket ledger.

### Match seed verification

Paid matches use the `future-block-freeze-v2` freeze and `future-chain-block-v2` seed versions. At
canonical header H the server commits the exact economy, ruleset, sorted durable FIFO queue-entry
IDs, configured delay, and target `H + MATCH_PAID_ENTROPY_DELAY_BLOCKS` into a `pending` row before
requesting any hash. After that transaction commits, a fresh strict daemon count must prove the
target does not yet exist; the witnessed tip and verification timestamp are durable and immutable. A
delayed commit that reaches the target is cancelled and every exact escrow anchor is refunded without
reading the target hash. Legacy v1 and otherwise unverified pending freezes are refunded at startup.

Activation waits until the target itself has the configured confirmation depth, where the target
counts as confirmation one. The scheduler reads count, header, count, header, and requires both
exact-height headers to carry the same canonical hash. It re-reads that target immediately after the
activation transaction and before ticket collection, gameplay, or client notification; an unavailable
or changed hash aborts and refunds the match. The playable seed is SHA-256 derived only from the v2
freeze commitment and the exact target hash. The persisted public proof records the delay, required
confirmations, minimum activation tip, and post-commit witness. Confirmation settings are safety
metadata, not extra seed material.

Monero-family `getblockcount` returns a count while `get_block(height)` uses zero-based header
heights. The scheduler normalizes the event exactly once (`observedHeaderHeight = blockCount - 1`).
Every persisted or disclosed `blockHeight` is the actual header height passed unchanged to
`get_block`, so a published height resolves to the published hash with no off-by-one translation.

Free matches derive their seed from the current block hash when one is available. When it is not,
they fall back to a server-random seed recorded as derivation version `server-random-v1`. Paid
economies have no such fallback: a paid match without a `future-chain-block-v2` proof is retained
rather than started.

This construction proves the documented seed derivation and the deterministic dungeon. It does not
prove honest input handling, block-source independence, payout delivery, or resistance to a malicious
chain producer or operator. Do not describe match mode as equivalent to the solo two-party fairness
protocol without an independent review.

## Configuration

Set these in `src/.env`. The full annotated template is `src/.env.example`; a match-only excerpt is
`src/.env.match.example`.

```bash
# Enable match mode (default false)
MATCH_ENABLED=false

# Max players per match, also bounded by the selected ruleset (built-ins max at 8)
MATCH_MAX_PLAYERS=4

# Server tick interval in ms
MATCH_TICK_MS=250

# Server-selected gameplay ruleset; clients cannot override it.
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

# Required per-player funded ticket value in atomic units
MATCH_ENTRY_FEE_ATOMIC=5000000000

# Crypto admission requires both explicit match gates and an outer atomic-unit payout cap
MATCH_CRYPTO_RACE_ENABLED=false
MATCH_PAYOUTS_ENABLED=false
MATCH_PAYOUT_MAX=50000000000
```

Crypto races additionally require:

- A paid instance (`GAME_MODE=PAID_SINGLE` or `PAID_CREDITS`, or the equivalent `PAYMENT_MODES`).
- At least one race-entry product with `grants.race_entries: N` and `grants.race_entry_value_atomic`
  exactly equal to `MATCH_ENTRY_FEE_ATOMIC`. The product price must cover `N * MATCH_ENTRY_FEE_ATOMIC`;
  confirmation records a durable lot per payment.
- A competitive single-winner ruleset. `coop-escape` is rejected because it has no
  winner-takes-pot split contract.

## Client surfaces

- `/match.html` with `html/js/matchClient.js` is the dedicated race page: entry-mode selector,
  ruleset catalog, race HUD, render-style picker, and touch d-pad.
- `/tavern.html` adds a Multiplayer Arena panel with the entry-mode selector and an active-match list
  with Watch buttons. Tavern spectators receive `tavern_match_tick` and `tavern_match_end` and render
  races through the render kit. A tavern viewer who is a player in the match keeps movement controls
  instead of a spectator camera.

## Socket events

Server emits:

- `game_mode_info` includes `modes.match { enabled, economies, maxPlayers, activeRuleset, rulesets }`.
- `match_queue_joined` and `match_queue_left` are queue responses.
- `match_joined`, `match_start`, `match_tick`, `match_end` are the race lifecycle for players.
- `match_rejoined` restores a reconnecting player; `match_settlement_pending` reports a result whose
  payout is still settling.
- `player_forfeit` and `player_death` are in-match participant updates.
- `match_error` is the benign catch-all failure response for any match request.
- `tavern_match_list`, `tavern_match_tick`, `tavern_match_end` are the public race feed for tavern
  spectators.

Client sends:

- `match_queue` `{ economy, action: 'join' | 'leave' }`
- `match_move` `{ dx, dy }`
- `match_reconnect` to rejoin an active or just-finished match after a reconnect.
- `match_leave` to forfeit an active race.
- `tavern_match_list` to request active races.

Identity for every match request is resolved from the connection, never from the payload.

## Leaderboards

- Free competitive matches create synthetic `games` rows with `game_mode = 'FREE'` for the Pleb
  board.
- Credits/prestige competitive matches are served from the authoritative `matches` and
  `match_entrants` rows by `GET /api/leaderboard?board=prestige`.
- Crypto competitive matches create synthetic `games` rows with `game_mode = 'PAID_CREDITS'` for the
  generic self-hosted Hall of Champions board. The operated product profiles
  (`such-play-wow-prestige`, `such-monerogue-stagenet`) keep this economy disabled and exclude all
  match-generated rows from Champions.

The public leaderboard endpoint accepts `board=pleb|champions|prestige`. Omitting `board` defaults to
`pleb`; unknown or blank values return 400 rather than silently combining or translating economies.

An individual win requires the durable match winner and placement #1 to agree; reaching the exit
alone is never treated as a win in last-alive or score-attack. `coop-escape` is collective, records
no individual `winnerId`, and keeps its results in `matches` and `match_entrants`. It is excluded
from individual boards.

## Tests

```bash
cd src
npx jest test/match
```

The suites cover the room, queue, scheduler, payout service, and leaderboard, plus block-deadline,
authoritative leaderboard-result, co-op exclusion, durable finish, crash recovery, client
settlement, and finished-room reconnect regressions.

## Operational notes

- `MATCH_RULESET_ID` is trusted server configuration. Unknown or solo-only values fall back to
  `race`.
- Crypto race payouts reuse the existing `payouts` table, batch processor, and retry service.
- `MATCH_PAYOUTS_ENABLED=false` blocks new crypto admission. Queue entries persisted for a
  now-unavailable economy are cancelled and refunded transactionally during queue initialization.
  Matches whose pot and liability were already accepted still create their durable payout from the
  immutable admission snapshot; the global payout master switch may pause dispatch without erasing
  it.
- The unconditional unique index `idx_payouts_one_per_match` prevents a replacement payout in every
  status, including `failed` and `needs_review`.
- Only confirmed-payment ticket lots with the current exact entry value can enter a crypto race, so
  legacy or admin-granted aggregate tickets cannot create a payout liability. The exact lot is held
  on queue join and consumed in the same transaction that accepts the immutable match liability.
- Players who disconnect during a race have a 30-second grace period to reconnect before an AFK kill.
  Match mappings are retained for a further 30 seconds after a finish so late reconnects still
  resolve the result.
- Paid freeze and start block events are serialized. A crash before activation leaves a resumable
  `pending` freeze; a crash after activation is handled by abandoned-match recovery. Orderly shutdown
  stops the scheduler, waits for its block task, and transactionally cancels and refunds every
  still-pending freeze before shutting down match transport.

## See also

- [TAVERN_AND_MULTIPLAYER.md](TAVERN_AND_MULTIPLAYER.md)
- [RULESETS.md](RULESETS.md)
- [PRODUCTION_DISCLOSURES.md](PRODUCTION_DISCLOSURES.md)
