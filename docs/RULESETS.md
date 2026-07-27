# Rulesets

Gameplay is a data object. The match engine reads a `Ruleset` instead of hardcoding "first to the
exit wins," so additional modes (PvP last-alive, score attack, co-op escape) are configuration rather
than new subsystems.

## The Ruleset object

`src/game/rulesets/Ruleset.js` exposes `defineRuleset(spec)`, which normalizes a partial spec into a
complete, frozen, range-clamped ruleset. An empty spec yields the classic single-dungeon escape.

| Field | Meaning | Default | Clamp |
| --- | --- | --- | --- |
| `id`, `label` | Identity and display name | `custom` / `Custom` | |
| `mode` | Coarse family: `solo`, `race`, `pvp`, `coop` | `race` | |
| `world.difficultyPreset` | Key passed to `getDifficultyConfig` | `normal` | |
| `world.maps` | Reserved for multi-level matches; the match engine generates one map | `1` | 1..10 |
| `entities.monster` | Spawn the shared monster | `true` | |
| `entities.monsterCount` | Reserved count field | `1` (`0` when `monster` is false) | 0..8 |
| `entities.pvpCombat` | Stepping onto a living rival strikes them down | `false` | |
| `players.min` / `players.max` | Entrant bounds; `min` is lowered to `max` if it exceeds it | `1` / `4` | 1..32 |
| `winCondition.type` | `first-to-exit`, `last-alive`, `high-score`, `all-escape` | `first-to-exit` | |
| `timing.tickMs` | Engine tick interval | `250` | 50..5000 |
| `timing.minDurationMs` | Active-play floor before a block deadline may fire | `20000` | 0..600000 |
| `timing.hardCeilingMs` | Absolute match length ceiling | `240000` | 1000..3600000 |
| `timing.blockDeadline` | End on the first advancing canonical header | `true` | |
| `economy.model` | `free`, `credits_prestige`, `crypto_race` | `free` | |
| `economy.houseFeePercent` | House rake for pot modes | `0` | |
| `economy.payoutMultipliers` | `escape`, `escapeWithTreasure` | `2`, `3` | |
| `metadata` | Free-form descriptor bag (`description` is surfaced to clients) | `{}` | |

Unrecognized `winCondition.type` and `economy.model` values fall back to the defaults rather than
propagating, and every nested section is frozen.

## Built-in rulesets

`src/game/rulesets/registry.js` ships the catalog and the helpers `getRuleset(id, overrides)`,
`listRulesets()`, `listMatchRulesets()`, `resolveMatchRuleset(id)`, and `rulesetFromMatchOpts(opts)`.

| id | mode | players | win condition | notes |
| --- | --- | --- | --- | --- |
| `solo-classic` | `solo` | 1 | `first-to-exit` | Catalog descriptor for the single-player escape. Never selectable for a multiplayer queue. |
| `race` | `race` | 2..8 | `first-to-exit` | Classic escape race; `race` difficulty preset; `crypto_race` economy. |
| `last-alive` | `pvp` | 2..8 | `last-alive` | `pvpCombat` enabled, monster present, `normal` preset. |
| `score-attack` | `race` | 1..8 | `high-score` | Escaping does not end the match; score decides. |
| `coop-escape` | `coop` | 2..8 | `all-escape` | `pvpCombat` disabled; ends when every survivor escapes. |

`listMatchRulesets()` filters out `mode === 'solo'`, giving the server, scheduler, and clients one
stable multiplayer allowlist. `resolveMatchRuleset(id)` fails closed to `race` for unknown or
solo-only ids. `rulesetFromMatchOpts()` maps the legacy `MatchRoom` option bag
(`economy`, `difficultyPreset`, `maxPlayers`) onto a `race` ruleset; the legacy `variant` label does
not change the win condition.

## Win conditions as strategies

`src/game/rulesets/winConditions.js` implements each condition as a small strategy object that
`MatchRoom` consults at three decision points:

```
onExit(room, id)   a player reached the exit: end the match? set a winner?
onDeath(room)      a player died: is the match over?
rank(room)         final ordering (best-first) for placement; competitive modes also set winnerId
```

- **`FIRST_TO_EXIT`**: the first player out wins and the match ends immediately. Ranking orders
  winner, then finished, alive, Manhattan distance to the exit, treasure, fewer moves, id.
- **`LAST_ALIVE`** (PvP): reaching the exit means you survived, not that you won; the match ends when
  at most one contender remains in play and at least two started. Ranking orders last-standing,
  escaped survivor, then later deaths above earlier ones (`deathOrder`), then treasure, distance, id.
  With `entities.pvpCombat`, moving onto a living rival's tile strikes them down and the attacker
  holds position.
- **`HIGH_SCORE`**: no instant win. Score rewards escaping, carrying treasure, move efficiency, and
  proximity to the exit for players still inside when the match resolves.
- **`ALL_ESCAPE`** (co-op): ends when every player still alive has escaped (or all have died) and
  reuses the race ordering for placements.

`resolveWinCondition(type)` returns `FIRST_TO_EXIT` for any unknown type.

## Engine integration

`MatchRoom` (`src/multiplayer/MatchRoom.js`) resolves its ruleset with the precedence
`opts.ruleset` (an explicit spec), then `opts.rulesetId` plus optional `opts.rulesetOverrides`, then
`rulesetFromMatchOpts(opts)`. It then:

- spawns the shared monster only when `entities.monster` is set;
- takes `minDurationMs` and `hardCeilingMs` from `timing` (the manager and scheduler may override);
- clamps `maxPlayers` into 2..32 from `opts.maxPlayers` or `players.max`;
- delegates `_checkResolution` to `winCondition.onExit`, `_killPlayer` to `winCondition.onDeath`, and
  `finalize` to `winCondition.rank`;
- treats co-op modes (`mode === 'coop'` or `all-escape`) as collective, recording placements as
  progress metadata and leaving the individual `winnerId` null;
- exposes a client-safe summary (`id`, `label`, `mode`, `description`, `winCondition`, `pvpCombat`).

Terminal players stay in `occupants` so spectators and final results can render them, but corpses and
escaped heroes are pass-through: co-op and score attack require several players to cross the single
exit tile on different ticks. Living, in-play players remain solid, and an occupant with no match
state stays solid rather than failing open into an overlap.

Same-tick intents resolve in a committed order derived from `sha256(seed:tick:entrantSlot)`, never
packet arrival order. An entrant eliminated earlier in that order cannot move or attack afterwards;
the attempt emits `move_failed` with reason `eliminated_before_action`.

`MatchEngine` (`src/multiplayer/MatchEngine.js`) is a thin, transport-agnostic tick driver that calls
`room.resolveTick()` on an interval and reports results to its owner.

The single-player engine (`src/game/game.js`) does not consume rulesets; `solo-classic` is a catalog
descriptor for parity and display only.

## Selection and safety

Multiplayer rulesets are trusted server configuration, selected with `MATCH_RULESET_ID` (default
`race`). Clients receive the active ruleset and the safe catalog metadata for display, but cannot
select or author executable rules. Match mode as a whole is gated by `MATCH_ENABLED`, which must be
the literal string `true` to be active.

Crypto payout admission requires single-winner semantics. `matchEconomyPolicy` accepts a ruleset only
when its mode is neither `solo` nor `coop`, its win condition is one of `first-to-exit`,
`last-alive`, or `high-score`, and `players.max` is at least 2; otherwise admission is denied with
`unsupported_crypto_ruleset`. `environmentValidator` applies the same check at boot and additionally
requires `MATCH_MAX_PLAYERS` to fall inside the ruleset's player contract. Match persistence and
transport require at least two entrants, so the effective minimum is raised to 2 even for rulesets
that are also valid as a one-player challenge.

`src/migrations/029_match_ruleset_id.sql` persists the selected ruleset on each match
(`matches.ruleset_id`, default `race`) with a partial index on finished matches, keeping newer
built-ins auditable without widening the money and economy keys.

## Timing and block deadlines

`matchScheduler` resolves timing with the precedence: explicit constructor argument, then
`MATCH_TICK_MS` / `MATCH_MIN_DURATION_MS` / `MATCH_HARD_CEILING_MS`, then the ruleset's `timing`,
then the built-in defaults.

When `timing.blockDeadline` is true, each advancing canonical header is offered to `MatchManager`.
An active room expires with reason `block_deadline` only when the header is strictly later than the
room's start header and its active-play `minDurationMs` floor has elapsed. Strict height comparison
protects rooms created by the same header, and duplicate polls are idempotent. With
`blockDeadline: false`, the hard-ceiling watchdog owned by `MatchManager` is the only clock-based end.

For paid multiplayer, the ruleset id is part of the durable entrant freeze at the freeze header:
`buildPaidEntrantFreeze` commits version, freeze height, target height, delay, economy, ruleset id,
and the canonical queue entry ids into a single hash. `deriveFutureBlockMatchSeed` then accepts only
the exact committed future header, after its required confirmation wait, and mixes the freeze
commitment into the seed. Changing the active ruleset cannot reinterpret a pending entrant set or
trigger a server-random fallback.

## Economy per mode

A ruleset's `economy` block (`model`, `houseFeePercent`, `payoutMultipliers`) maps onto the existing
payout paths: `gameModeManager` for single player (multiplier on entry fee) and `matchPayoutService`
for pot modes (winner takes the pot minus the house fee). See [MONETIZATION.md](MONETIZATION.md) and
[MATCH_MODE.md](MATCH_MODE.md).

## World presets and per-chain tuning

`src/game/difficultyConfig.js` holds the world half of a ruleset. `getDifficultyPreset` selects a
preset from `DIFFICULTY_PRESET` or an explicit override; with neither set it returns `normal` for
free play (`GAME_MODE=FREE` and `PAYMENTS_ENABLED` not true) and `casino` otherwise. Presets tune
dungeon size and openness, monster start distance, speed, aggressiveness and vision, treasure
placement, and a target house win rate.

Block time enters through `NETWORK_TUNING`, which folds a per-chain level count onto the resolved
preset so a run's cumulative length scales with the chain's mean block time. Each level stays
base-sized with a fair monster; the house edge comes from racing the block across the whole descent
rather than from one oversized map or a faster-than-fair monster.

| Chain | Mean block time | Levels |
| --- | --- | --- |
| GRIN | ~1 min | 1 |
| XMR | ~2 min | 1 |
| LTC | ~2.5 min | 2 |
| WOW | ~5 min | 2 |
| BTC | ~10 min | 3 |

Precedence in `getDifficultyConfig` runs low to high: preset, per-chain tuning, environment variables
(`DUNGEON_LEVELS`, `DUNGEON_*`, `MONSTER_*`), then explicit overrides passed by the caller. Set
`NETWORK_TUNING_DISABLED=true` to skip the per-chain step. The level count drives multi-level solo
runs; `MatchRoom` consumes only the dungeon geometry from the resolved config and generates a single
shared map.

## Files

```
src/game/rulesets/Ruleset.js             defineRuleset + WIN / ECONOMY enums
src/game/rulesets/winConditions.js       FIRST_TO_EXIT / LAST_ALIVE / HIGH_SCORE / ALL_ESCAPE
src/game/rulesets/registry.js            built-ins + match resolver and catalog helpers
src/multiplayer/MatchRoom.js             consumes the ruleset; PvP combat; delegates win/lose/rank
src/multiplayer/MatchEngine.js           tick driver
src/network/matchScheduler.js            advancing-header deadline dispatch
src/network/matchManager.js              active-play floor + idempotent expiry
src/network/matchEconomyPolicy.js        crypto admission contract (player bounds, win semantics)
src/network/matchFairness.js             paid entrant freeze + future-block seed derivation
src/game/difficultyConfig.js             world presets and per-chain level tuning
src/migrations/029_match_ruleset_id.sql  persists the selected ruleset on each match
```
