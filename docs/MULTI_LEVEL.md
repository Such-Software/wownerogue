# Multi-level dungeons

A run descends through `maxDepth` levels instead of a single map. This is the pacing lever that
makes the block-timer provide the house edge on slow chains without a giant dungeon or a cheating
monster (see [`BALANCE_SIM.md`](BALANCE_SIM.md) for why).

## Mechanic

- Each level is a normal preset-sized dungeon with its own entrance, exit, and a fair monster.
- Reaching a **non-final** exit takes the **stairs down** → a fresh level is generated, the player
  is placed at its entrance, a new monster spawns, and fog-of-war resets. This is **not** a win.
- Reaching the **final** level's exit **escapes** (win).
- **Treasure lives only in the vault** (the final level). Intermediate levels are a race to the
  stairs; the 2×/3× treasure payout requires descending all the way and getting back out.
- `maxDepth = 1` (single level) is byte-identical to the pre-multi-level game.

## Provably fair across the descent

The whole run regenerates from the one committed seed. Per-level seed
(`levelSeed(masterSeed, depth)` in `provablyFair.js`): **level 1 = the master seed verbatim**
(so single-level games are unchanged), deeper levels salt it (`<seed>:L<depth>`). Verify any level
with `DungeonGenerator.regenerateFromSeed(levelSeed(seed, depth), cryptoType)`.

## Configuration

`maxDepth` comes from `difficultyConfig.levels`, set by `NETWORK_TUNING` per chain
(GRIN 1 · XMR 2 · LTC 2 · WOW 4 · BTC 8, ∝ block time). Operator overrides: `DUNGEON_LEVELS=<n>`;
`NETWORK_TUNING_DISABLED=true` forces a single level.

## Where it lives

| Concern | Location |
|---|---|
| Level generation + descent | `src/game/game.js` — `_generateLevel(depth)`, `_descend()`, the exit branch in `movePlayer` (returns `event: 'descend'`), `depth`/`maxDepth` in `getState` |
| Per-level seed | `src/game/provablyFair.js` — `levelSeed()` |
| Level count (pacing) | `src/game/difficultyConfig.js` — `NETWORK_TUNING`, `DUNGEON_LEVELS` |
| Server wiring | `src/network/socketHandlers.js` — `afterPlayerMove` `'descend'` branch (no game-over, no monster move on arrival) |
| Client | `html/js/core/gameState.js` — clears accumulated map/explored/visible tiles on a `depth` change so the old level doesn't ghost through the new one |
| Sim | `src/sim/simBots.js` — explorer bot resets fog-of-war on descent |
| Tests | `test/multiLevel_ultra.test.js` |

## Open polish

- Client **"Level N / M" indicator** + a "descended" toast (the server sends `depth`/`maxDepth` and
  a `game_event: descend`; there is no client `game_event` handler yet).
- Per-network **level counts are sim starting points** — pending a full multi-level calibration run.
- **Escalating hazards per level** (level 1 tame → deep levels lava/poison) — the hazard-tile FX is
  already wired (`RENDER_PACKS.md`); it needs the generator to place hazards + gameplay stakes.
