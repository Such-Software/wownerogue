# Rulesets & PvP (P4)

Gameplay is a **data object**. Instead of hardcoding "first to the exit wins," the match engine reads a
`Ruleset`, so new modes (PvP last-alive, score attack, co-op) are data — not new subsystems.

## The Ruleset

`src/game/rulesets/Ruleset.js` — `defineRuleset(spec)` normalizes a partial spec to a frozen, clamped
object:

```
id, label, mode
world      { difficultyPreset, maps }
entities   { monster, monsterCount, pvpCombat }
players    { min, max }
winCondition { type }        first-to-exit | last-alive | high-score | all-escape
timing     { tickMs, minDurationMs, hardCeilingMs, blockDeadline }
economy    { model, houseFeePercent, payoutMultipliers }
```

`registry.js` ships the built-ins — `solo-classic` (descriptor for the live single-player mode),
`race`, `last-alive`, `score-attack`, `coop-escape` — plus `getRuleset(id)`, `listRulesets()`, and
`rulesetFromMatchOpts()` (maps the legacy MatchRoom option bag to a `race` ruleset, preserving old
behavior).

## Win conditions as strategies

`src/game/rulesets/winConditions.js` — each condition is a small strategy the `MatchRoom` consults at
three decision points:

```
onExit(room, id)   a player reached the exit — end the match? set a winner?
onDeath(room)      a player died — is the match over?
rank(room)         final ordering (best-first) for placement + winnerId
```

- **`FIRST_TO_EXIT`** is a *verbatim port* of the original race logic, so existing matches are
  byte-identical.
- **`LAST_ALIVE`** (PvP): reaching the exit means you *survived* (safe, not an instant win); the match
  ends when ≤1 contender remains; `rank` orders last-standing → escaped → died-later. Combined with
  `entities.pvpCombat`, stepping onto a living rival **strikes them down** (attacker holds position).
- **`HIGH_SCORE`**: no instant win; rank by score at the end.
- **`ALL_ESCAPE`** (co-op): ends when everyone alive has escaped.

## Where it plugs in

`MatchRoom` (`src/multiplayer/MatchRoom.js`) resolves a ruleset from `opts.ruleset` / `opts.rulesetId` /
legacy opts, then delegates: `_checkResolution` → `winCondition.onExit`, `_killPlayer` →
`winCondition.onDeath`, `finalize` → `winCondition.rank`. It honors `entities.monster` (optional monster)
and `entities.pvpCombat`, and takes timing from the ruleset. `MatchEngine` is a thin tick driver
(`room.resolveTick()` on an interval).

**Scope note:** the *live single-player* engine (`src/game/game.js`) is intentionally **not** refactored to
consume rulesets (too risky to touch the deployed path) — `solo-classic` is a catalog descriptor only. PvP
modes are opt-in via `rulesetId`; the match scheduler still builds `race`, and match mode is gated by
`MATCH_ENABLED` (inert by default), so nothing changes until wired.

## Economy per mode

A ruleset's `economy` field (`model`, `houseFeePercent`, `payoutMultipliers`) maps onto the existing
`gameModeManager` fields (single-player: multiplier-on-entry-fee) and `matchPayoutService` (PvP:
winner-takes-pot-minus-house). See [MONETIZATION.md](MONETIZATION.md).

## Pending: block-time-aware difficulty

`difficultyConfig` presets (easy/normal/hard/casino) tune dungeon size, monster behavior, treasure, and a
target house-win-rate — but currently key off payment mode, **not** mean block time. Coupling difficulty
to `ChainProfile.meanBlockTimeMsFor(chain)` (so Grin ~1 min stays fair vs BTC ~10 min) is a pending
game-balance change, not just wiring.

## Files

```
src/game/rulesets/Ruleset.js         defineRuleset + WIN/ECONOMY enums
src/game/rulesets/winConditions.js   FIRST_TO_EXIT (race) / LAST_ALIVE / HIGH_SCORE / ALL_ESCAPE
src/game/rulesets/registry.js        built-ins + getRuleset/listRulesets/rulesetFromMatchOpts
src/multiplayer/MatchRoom.js         consumes the ruleset; PvP combat; delegates win/lose/rank
src/multiplayer/MatchEngine.js       tick driver
src/game/difficultyConfig.js         world presets (the ruleset's `world` half)
```
