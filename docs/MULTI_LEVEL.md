# Multi-level dungeons

A run descends through `maxDepth` levels instead of playing a single map. Depth is the pacing lever
that lets the block timer supply the house edge on slow chains without an oversized dungeon or a
monster that moves faster than the player. See [`BALANCE_SIM.md`](BALANCE_SIM.md) for the balance
model behind that choice.

## Mechanic

- Each level is a normal preset-sized dungeon with its own entrance, exit, and a freshly placed
  monster.
- Reaching a **non-final** exit takes the **stairs down**: a new level is generated, the player is
  placed at its entrance, a new monster spawns, and fog of war resets. Descending is not a win.
- Reaching the **final** level's exit **escapes** the dungeon and wins the run.
- **Treasure exists only on the final level.** Intermediate levels are a pure race to the stairs, so
  the treasure payout multiplier requires descending all the way and getting back out.
- `maxDepth = 1` is the single-level case: `levelSeed` returns the master seed unchanged at depth 1,
  so a one-level run's layout is exactly what the master seed alone produces.
- The monster does not take its turn on the arrival move of a descent. `afterPlayerMove` returns
  early on a `descend` result, so the player is never caught by a monster they have not yet seen.

## Provable fairness across the descent

Every level in a run regenerates from the one committed seed. `levelSeed(masterSeed, depth)` in
`provablyFair.js` returns the master seed verbatim for level 1 and salts it as `<seed>:L<depth>` for
deeper levels. Any level can be reproduced with:

```js
DungeonGenerator.regenerateFromSeed(levelSeed(seed, depth), cryptoType, generationOptions);
```

The `Game` constructor commits a layout fingerprint for **every** level of the run up front, before
play, in `gameProof.layoutFingerprints` (one entry per depth, each carrying `depth`,
`fingerprintVersion`, `generatorVersion`, and the SHA-256 `fingerprint`). `gameProof.layoutFingerprint`
remains as a level-1 alias for older verification clients. Because the manifest is complete at
creation time, a run that ends early still exposes a full, immutable record of the advertised
descent.

Each level is re-fingerprinted as it is actually generated during play, and a mismatch against the
committed manifest throws. Generator drift inside a live process becomes a hard failure rather than
an unverifiable served layout.

`src/game/fairnessVerifier.js` replays the whole manifest: it rejects a manifest whose depths are
incomplete or out of order, regenerates each level from its per-depth seed, nulls the treasure on
every non-final level to match play, and reports per-level fingerprint matches alongside entrance,
exit, treasure, and dimensions.

## Configuration

`maxDepth` comes from `difficultyConfig.levels`, set per chain by `NETWORK_TUNING` in
`src/game/difficultyConfig.js`. Depth scales with block time so that a slower chain gives a longer
run before the block lands:

| Chain | Approx. block time | Levels |
|---|---|---|
| GRIN | ~1 min | 1 |
| XMR | ~2 min | 1 |
| LTC | ~2.5 min | 2 |
| WOW | ~5 min | 2 |
| BTC | ~10 min | 3 |

Resolution order for the level count, lowest precedence first: preset (no `levels` key, so the
effective floor is 1) → `NETWORK_TUNING` for the chain → `customOverrides.levels` → the
`DUNGEON_LEVELS` environment variable, which always wins and is clamped to a minimum of 1.

`NETWORK_TUNING_DISABLED=true` skips per-network tuning entirely, which leaves the run at a single
level unless `DUNGEON_LEVELS` or an explicit override supplies a count. An unknown `cryptoType` is
also left untuned and therefore single-level.

Dungeon size and monster behaviour are not varied by depth: `applyNetworkTuning` folds only the
level count onto the resolved difficulty preset, and every level uses the same preset dimensions and
the same fair monster settings.

## Where it lives

| Concern | Location |
|---|---|
| Level generation and descent | `src/game/game.js`: `_generateLevel(depth)`, `_descend()`, the exit branch in `movePlayer` returning `event: 'descend'`, and `depth`/`maxDepth` in `getState` |
| All-level fingerprint manifest | `src/game/game.js`: `_buildLayoutFingerprintManifest()`, `getProofContext()` |
| Per-level seed | `src/game/provablyFair.js`: `levelSeed()` |
| Level count | `src/game/difficultyConfig.js`: `NETWORK_TUNING`, `applyNetworkTuning()`, `DUNGEON_LEVELS` |
| Verification | `src/game/fairnessVerifier.js` |
| Server wiring | `src/network/socketHandlers.js`: the `'descend'` branch in `afterPlayerMove` (no game over, no monster move on arrival) |
| Event emission | `src/game/movementManager.js`: emits `game_event` with `event`, `depth`, `maxDepth` after the `game_update` |
| Client state | `html/js/core/gameState.js`: clears accumulated map, explored, and visible tiles on a `depth` change so the previous level does not ghost through the new one |
| Client feedback | `html/js/network/socketHandlers.js`: the `game_event` handler renders the descend message and on-screen banner with `Level N / M` |
| Sim | `src/sim/simBots.js`: the explorer bot clears its known-tile set and remembered objectives on a depth change |
| Tests | `test/multiLevel_ultra.test.js`, `test/networkTuning_ultra.test.js` |
