# Balance simulation & per-network calibration

Wownerogue is a **block-timed** roguelike: a run is bounded by the blockchain, and the house edge
comes from whether you can clear the dungeon before the block lands. That makes the balance
un-eyeball-able — the deadline is a *random* variable and every chain has a different block time —
so difficulty is **measured**, not guessed. This doc covers the simulator that measures it and the
per-network tuning it produces.

## The timing model (why this is subtle)

- **Single-player runs are bounded by one block.** You enter on block *N* and die if you haven't
  escaped before *N+1* (`queueManager.js`, `socketHandlers.js checkGamesTimeout`). Movement is
  real-time within that window (~100 ms/move floor).
- **Block arrival is a Poisson process**, so the run window is **exponentially distributed** with
  mean = the network's block time. Enter just after a block → a near-full interval; just before →
  seconds. High variance is the core mechanic, intended.
- Therefore, for a run that escapes at wall-clock time `T`:

  ```
  P(survive) = P(block lands after T) = exp(-T / meanBlockTime)
  house_win(run) = caught|stuck ? 1 : (1 - exp(-T / meanBlockTime))
  ```

  The random deadline is integrated out analytically — no Monte-Carlo over deadlines needed.

Block times (`src/chain/chainProfile.js`, `meanBlockTimeMs`): GRIN ~1 min · XMR ~2 · LTC ~2.5 ·
**WOW ~5 (measured on the live daemon)** · BTC ~10.

## The simulator (`src/sim/`)

Drives the **real engine** (`src/game/game.js` — same dungeon generator, monster AI, movement as
production) with headless bots to terminal outcomes, then reports the measured distribution. It
never reimplements game rules — it's a thin layer over `Game`.

| File | Role |
|------|------|
| `simulate.js` | Harness + CLI. Per preset: escape/treasure/caught/stuck rates, completion-move/-time percentiles, and **measured house-win per network** via the identity above. |
| `simBots.js`  | Bot policies. `omniscient-*` (knows the full map, beelines) and `explorer-*` (fog-of-war, realistic). Neither *evades* the monster, so both **over-count catches** → true house-win is likely below the reported band. Read them as an upper band, not a point estimate. |
| `pathfind.js` | Dependency-free BFS (keeps the sim auditable). |
| `calibrate.js`| Solves tuning per network to a target house-win. |

Run:

```bash
node src/sim/simulate.js --runs 200 --bot explorer-greedy --presets normal,casino
node src/sim/calibrate.js --target 0.70 --preset casino
```

`--cadence` (ms/move, default 320) is the moves→seconds assumption the block-time math hinges on —
sweep it when calibrating for real players. `test/sim_ultra.test.js` guards the harness structurally
(it is **not** a balance assertion — those numbers are meant to move).

## What the sim proved (and the design it forced)

1. **Presets undershot their declared targets**, and the edge swung ~15 pts across chains from
   *identical* dungeons — because `cryptoType` never sized anything.
2. **Dungeon size is not a clean edge lever.** A bigger map lengthens the run (timer edge ↑) but
   gives the player more room to dodge (monster edge ↓); house-win self-cancels around ~60% until
   the map becomes an unplayable slog.
3. **A fast monster is both distasteful and ineffective on slow chains** — WOW (5-min blocks) caps
   ~64% house-win even at a 2.2× monster, because a single dungeon clears in ~1 min ≪ the block, so
   the timer barely bites.

**Conclusion → multi-level depth.** The fair, on-theme lever is *run length*: descend N levels
(each preset-sized, fair monster) so the cumulative timer provides the edge. Levels ∝ block time.
See `docs/MULTI_LEVEL.md` (mechanic) and `NETWORK_TUNING` in `src/game/difficultyConfig.js`.

## Per-network tuning (`NETWORK_TUNING`)

`difficultyConfig.js` folds the tuning onto the resolved preset. Precedence:
**preset → network tuning → env → explicit overrides** (so operators keep `DUNGEON_*`/`MONSTER_*`;
`NETWORK_TUNING_DISABLED=true` is the kill switch). Currently it sets **`levels`** per network
(the pacing lever); size and monster stay at the fair preset.

```
GRIN 1 · XMR 2 · LTC 2 · WOW 4 · BTC 8
```

**Pending:** the level counts are sim starting points. The simulator's multi-level support (bots
reset fog-of-war on descent) is in; a full re-calibration run to lock the per-network level counts
against a target house-win is the open follow-up. The `monsterSpeed` lever was intentionally
**dropped** (see finding 3).
