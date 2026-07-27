# Balance simulation and per-network calibration

Wownerogue is a block-timed roguelike: a single-player run is bounded by the blockchain, and the
house edge comes from whether the player clears the dungeon before the next block lands. The
deadline is a random variable and every supported chain has a different block time, so difficulty is
measured rather than estimated. This document covers the simulator that measures it and the
per-network tuning it feeds.

## Timing model

A run starts on block *N* and ends as a loss if the player has not escaped by the time block *N+1*
arrives (`src/network/socketHandlers.js`, `checkGamesTimeout`). Movement is real time within that
window, with a 100 ms per-move cooldown (`src/game/movementManager.js`). A grace period,
`GAME_START_GRACE_MS` (default 2000 ms, `0` disables), suppresses only the degenerate case where a
block lands in the same instant the game starts; random block timing is otherwise preserved intact.

Block arrival is a Poisson process, so the run window is exponentially distributed with mean equal
to the network's block time. Entering just after a block yields a near-full interval; entering just
before yields seconds. That variance is the core mechanic.

For a run that escapes at wall-clock time `T`:

```
P(survive)     = P(block lands after T) = exp(-T / meanBlockTime)
house_win(run) = caught or stuck ? 1 : (1 - exp(-T / meanBlockTime))
```

The random deadline is integrated out analytically, so no Monte Carlo over deadlines is required.

Mean block times come from `src/chain/chainProfile.js` (`meanBlockTimeMs`):

| Chain | Mean block time |
|-------|-----------------|
| GRIN  | 1 min |
| XMR   | 2 min |
| LTC   | 2.5 min |
| WOW   | 5 min |
| BTC   | 10 min |

Unknown or unset chain ids resolve to a fallback profile of 12 decimals and a 120000 ms block time,
so a mis-set `CRYPTO_TYPE` degrades to XMR-shaped timing instead of crashing.

## The simulator (`src/sim/`)

The harness drives the real engine (`src/game/game.js`: same dungeon generator, monster AI and
movement as production) with headless bots until each run reaches a terminal outcome, then reports
the measured distribution. It never reimplements game rules; it is a thin layer over `Game`.

| File | Role |
|------|------|
| `simulate.js` | Harness and CLI. Per preset: escape, treasure, caught and stuck rates; completion-move and completion-time percentiles; measured house-win per network via the identity above. |
| `simBots.js`  | Bot policies. `omniscient-*` know the full map and take BFS-optimal paths; `explorer-*` play under fog of war and reset their knowledge on descent. Neither policy evades the monster. |
| `pathfind.js` | Dependency-free 4-connected BFS distance field and downhill step, so navigation stays auditable and separate from game rules. |
| `calibrate.js`| Per-network solver: scales dungeon size by `√(blockTime / 120000)` for pacing, then binary-searches monster speed to a target house-win. |

Run:

```bash
node src/sim/simulate.js --runs 200 --bot explorer-greedy --presets normal,casino
node src/sim/calibrate.js --target 0.70 --preset casino
```

`simulate.js` accepts `--runs`, `--bot`, `--presets`, `--nets`, `--cadence`, `--movecap` and
`--json`. Bots are `omniscient-escape`, `omniscient-greedy`, `explorer-escape` and
`explorer-greedy` (default).

`--cadence` (ms per move, default 320) is the moves-to-seconds assumption the block-time math rests
on; sweep it when calibrating against real player pacing.

Two properties of the harness matter when reading its output:

- Because neither bot evades the monster, both over-count catches, so reported house-win is an upper
  band rather than a point estimate. A skilled human wins more often.
- One simulated dungeon configuration is scored against every network in `--nets`. The dungeon
  itself is built from `DIFFICULTY_PRESET` and the process `CRYPTO_TYPE` (default `WOW`), so the
  per-network columns differ only in block time, not in level count. Set `CRYPTO_TYPE` explicitly to
  simulate a specific chain's level count.

`test/sim_ultra.test.js` guards the harness structurally: it asserts that bots reach terminal
outcomes and that rates are well formed and partition the runs. It asserts nothing about balance
values, which are expected to move.

## Findings

1. Presets declare a `targetHouseWinRate` but measured rates land below it, and the edge varies by
   roughly 15 points across chains for an identical dungeon purely from block time.
2. Dungeon size is not a clean edge lever. A larger map lengthens the run (timer edge up) but gives
   the player more room to dodge (monster edge down), so house-win self-cancels near 60% until the
   map becomes an unplayable slog. Size is useful as a pacing knob, not an edge knob.
3. A fast monster is both unpleasant and ineffective on slow chains. On WOW's 5-minute blocks a
   single dungeon clears in about a minute, so even a 2.2x monster caps house-win near 64% because
   the timer barely bites.

The lever that follows from this is run length: descend N preset-sized levels, each with a fair
monster, so cumulative run time supplies the edge and levels scale with block time. `monsterSpeed`
is deliberately not used as a per-network lever. See `docs/MULTI_LEVEL.md` for the mechanic.

## Per-network tuning (`NETWORK_TUNING`)

`src/game/difficultyConfig.js` folds per-network tuning onto the resolved preset. Precedence, low to
high: preset, network tuning, environment variables, explicit overrides. Operator settings such as
`DUNGEON_*`, `MONSTER_*` and `DUNGEON_LEVELS` therefore win over the tuning, and
`NETWORK_TUNING_DISABLED=true` removes it entirely.

The tuning sets only `levels`. Dungeon size and monster parameters stay at the preset values.

| Chain | Levels |
|-------|--------|
| GRIN  | 1 |
| XMR   | 1 |
| LTC   | 2 |
| WOW   | 2 |
| BTC   | 3 |

Level counts are conservative relative to the raw pacing formula (block time divided by roughly 75
seconds per level), because a deep descent inside one block deadline is rarely completable and makes
reach-the-exit-to-win unintuitive.

`Game` reads the resolved count as `maxDepth`. Reaching a non-final exit descends to a fresh level
and emits a `descend` event; only the final level's exit ends the run as a win, and treasure is
placed only on the final level. The client handles `game_event` (including `descend`) in
`html/js/network/socketHandlers.js` and surfaces depth progress to the player.
