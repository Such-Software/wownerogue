# Architecture

Wowngeon is a provably fair, block-timed roguelike with crypto entry and payouts. A solo run is a
race against a random block deadline; multiplayer matches run the same engine under a ruleset. The
game also acts as a multi-chain on-ramp for the Smirk wallet.

This page is the index for the architecture docs. Each subsystem has its own page.

## System map

```
             ┌──────────── players (browser) ─────────────┐
             │  index.html · tavern.html · match.html     │
             │  html/js/render (render kit)               │
             └───────────────┬───────────────┬────────────┘
                    Socket.IO │               │ REST (auth, payments, status)
             ┌────────────────▼───────────────▼────────────┐
             │  src/network/*  socket handlers, chat,      │
             │                 tavern, match, payments     │
             ├─────────────────────────────────────────────┤
  game core  │  src/game/*      dungeon · rulesets · modes │  → RULESETS.md
  money      │  src/payments/*  providers · wallet-rpc     │  → PAYMENTS.md
  cosmetics  │  src/multiplayer/entitlements + catalog     │  → MONETIZATION.md
  chains     │  src/chain/chainProfile.js                  │  → chain profiles, below
  chat       │  src/network/chat/*  local + nostr          │  → CHAT_AND_NOSTR.md
             └─────────────────────────────────────────────┘
                    │                         │
              PostgreSQL              Wownero/Monero wallet-RPC, BTCPay/checkout gateways
```

`src/index.js` is the composition root: it builds the Express app and Socket.IO server, wires the
database manager, wallet RPC service, payment config, game mode manager and socket handlers, and
mounts the REST routes in `src/routes/`.

## Subsystem guide

| Area | Where | Doc |
|------|-------|-----|
| Credits, cosmetic catalog, entitlements | `src/multiplayer/entitlements.js`, `src/services/catalogService.js` | [MONETIZATION.md](MONETIZATION.md) |
| Chain constants for the five Smirk chains | `src/chain/chainProfile.js` | below |
| Payment providers and payouts | `src/payments/` | [PAYMENTS.md](PAYMENTS.md) |
| Rulesets and match engine | `src/game/rulesets/`, `src/multiplayer/MatchEngine.js` | [RULESETS.md](RULESETS.md), [MATCH_MODE.md](MATCH_MODE.md) |
| Tavern lobby and spectating | `src/network/tavernManager.js`, `src/multiplayer/Room.js` | [TAVERN_AND_MULTIPLAYER.md](TAVERN_AND_MULTIPLAYER.md) |
| Chat, local and nostr | `src/network/chat/` | [CHAT_AND_NOSTR.md](CHAT_AND_NOSTR.md) |
| Client render kit and art packs | `html/js/render/` | [RENDER_PACKS.md](RENDER_PACKS.md) |
| Balance and pacing | `src/sim/`, `src/game/difficultyConfig.js` | [BALANCE_SIM.md](BALANCE_SIM.md), [MULTI_LEVEL.md](MULTI_LEVEL.md) |
| Deployment and operations | `scripts/deploy/` | [DEPLOY.md](DEPLOY.md), [DEPLOY_INSTANCES.md](DEPLOY_INSTANCES.md), [LOGS_AND_BACKUP.md](LOGS_AND_BACKUP.md) |
| Financial reconciliation and exports | `src/services/` | [FINANCIAL_RECONCILIATION.md](FINANCIAL_RECONCILIATION.md), [FINANCIAL_EVENT_EXPORT.md](FINANCIAL_EVENT_EXPORT.md) |

Optional subsystems are environment-gated and dormant by default: payment gateways register only
when their `*_URL` / `*_STORE_ID` / `*_API_KEY` trio is set, global nostr chat requires
`NOSTR_CHAT_ENABLED=true`, and match rooms require `MATCH_ENABLED=true`. With none of those set the
server runs the native wallet-RPC payment path, local socket chat, and solo play only. The full
environment template is [`src/.env.example`](../src/.env.example).

## Chain profiles

`src/chain/chainProfile.js` is the single source of truth for per-chain constants across BTC, LTC,
XMR, WOW and GRIN: `decimalsFor`, `meanBlockTimeMsFor`, `familyFor` (`monero` / `utxo` /
`mimblewimble`), `uriSchemeFor` and `atomicDivisor` (BigInt).

| Chain | Decimals | Mean block time | Family | URI scheme |
|-------|----------|-----------------|--------|------------|
| WOW | 11 | 5 min | monero | `wownero` |
| XMR | 12 | 2 min | monero | `monero` |
| BTC | 8 | 10 min | utxo | `bitcoin` |
| LTC | 8 | 2.5 min | utxo | `litecoin` |
| GRIN | 9 | 1 min | mimblewimble | `grin` |

An unrecognized chain id resolves to a default profile shaped like XMR: 12 decimals, 120000 ms mean
block time, `monero` family, `monero` URI scheme. Callers therefore never crash on a mis-set
`CRYPTO_TYPE`. Adding a chain is one entry in the registry plus a family adapter.

Money math is exact: `src/money/atomic.js` operates on BigInt atomic units parameterized by
decimals, never floats.

## Game balance and pacing

A solo run is bounded by a random deadline drawn from an exponential distribution with mean equal to
the chain's block time, so the house edge is a convolution of the run-completion distribution with
block cadence rather than a number that can be set by hand. `src/sim/` drives the real engine with
headless bots and integrates the deadline out analytically, reporting a measured house win rate per
preset and per network.

`NETWORK_TUNING` in `src/game/difficultyConfig.js` scales dungeon depth to block time. Dungeon size
and monster behaviour come from the difficulty preset; the per-network entry overrides only the
level count:

| Chain | Levels |
|-------|--------|
| GRIN | 1 |
| XMR | 1 |
| LTC | 2 |
| WOW | 2 |
| BTC | 3 |

`NETWORK_TUNING_DISABLED=true` bypasses the override and leaves the preset's own level count in
place. Descending emits a `game_event`, which the client handles in
`html/js/network/socketHandlers.js` to surface level progress. See [BALANCE_SIM.md](BALANCE_SIM.md)
and [MULTI_LEVEL.md](MULTI_LEVEL.md).

## Client render kit

`html/js/render/` (exposed as `RK`) draws a shared `Scene` model in four techniques: Tiled, ASCII,
Iso and 3D. Art packs are interchangeable data, a pure-canvas FX layer supplies torch and hazard
effects, and the pack and technique available to a player come from the operator-owned cosmetic
catalog. Tiled and ASCII are free; Iso and 3D are premium. See [RENDER_PACKS.md](RENDER_PACKS.md).

## Provable fairness

`src/game/provablyFair.js` derives each dungeon from a committed seed, `src/game/fairnessVerifier.js`
exposes verification endpoints, and `src/views/verifyPage.js` renders the public verification page so
a player can reproduce a dungeon from its published proof.

## Conventions

- **Game id** is a UUID stored in `games.dungeon_seed`; `games.id` is a serial integer. Match game
  objects with `WHERE dungeon_seed = $N`, never `WHERE id = $N`.
- **Socket ids are volatile** and change on refresh. Stable identity is the database `user_id` or the
  session, never `socket_id`.
- **WOW has 11 decimals** (atomic divisor 1e11), unlike Monero's 12.
- **Cosmetic entitlements are per-pack**, resolved by tier and by lifetime credits purchased in
  `src/multiplayer/entitlements.js`. Buying credits does not by itself unlock premium packs.
- **Migrations** live in `src/migrations/NNN_*.sql` and run in numeric order.
- **Tests**: `cd src && npm test` (Jest, `--runInBand`).

Source files carry JSDoc for API-level detail; these pages cover the seams between subsystems and
the operator-facing intent behind them.
