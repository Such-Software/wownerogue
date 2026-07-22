# Architecture

Wowngeon is a provably-fair, block-timed roguelike that doubles as a **multi-chain on-ramp for the
Smirk wallet**. This is the index for the architecture docs; each subsystem below has its own page.

## The map

```
             ┌──────────── players (browser) ────────────┐
             │  index.html · tavern.html · render kit     │
             └───────────────┬───────────────┬────────────┘
                    Socket.IO │               │ REST (auth, status)
             ┌────────────────▼───────────────▼────────────┐
             │  src/network/*  (socket handlers, chat,     │
             │                  tavern, match, payments)   │
             ├──────────────────────────────────────────────┤
  game core  │  src/game/*      dungeon · rulesets · modes  │  → RULESETS.md
  money      │  src/payments/*  providers · wallet-rpc      │  → PAYMENTS.md
  cosmetics  │  src/multiplayer/entitlements + catalog      │  → MONETIZATION.md
  chains     │  src/chain/chainProfile.js                   │  → chain profiles (below)
  chat       │  src/network/chat/*  local + nostr           │  → CHAT_AND_NOSTR.md
             └──────────────────────────────────────────────┘
                    │                         │
              PostgreSQL              Wownero/Monero wallet-RPC + BTCPay/checkout relays
```

## The five pillars (2026-07 "10x" build)

| Pillar | What | Doc |
|--------|------|-----|
| **P1 — Credits & catalog** | Operator-owned cosmetic catalog + tiered unlock rule (free / grant / spend-threshold / tier) | [MONETIZATION.md](MONETIZATION.md) |
| **P2 — Chain profiles** | One registry for the 5 Smirk chains (decimals, block time, adapter family, URI scheme) | see *Chain profiles* below |
| **P3 — Modular payments** | Pluggable payment providers: BTCPay + xmr/wowcheckout (Greenfield) + native Monero, behind one registry | [PAYMENTS.md](PAYMENTS.md) |
| **P4 — Ruleset / PvP** | Gameplay as a data object; race / last-alive / score / co-op are rulesets on the match engine | [RULESETS.md](RULESETS.md) |
| **P5 — Nostr chat** | Global cross-server chat over `relay.smirk.cash`; bridge → per-player Smirk-npub identity | [CHAT_AND_NOSTR.md](CHAT_AND_NOSTR.md) |

All five are **behavior-preserving and env-gated** — each stays dormant (native/local defaults) until
its config is set, so `main` is always deployable.

## Chain profiles (P2)

`src/chain/chainProfile.js` is the single source of truth for per-chain constants across BTC, LTC,
XMR, WOW, GRIN: `decimalsFor`, `meanBlockTimeMsFor`, `familyFor` (monero / utxo / mimblewimble),
`uriSchemeFor`, `atomicDivisor` (BigInt). Unknown chains fall back to a WOW-shaped default. Money math
stays exact via `src/money/atomic.js` (BigInt, decimals-parameterized) — never floats.

> **Resolved (2026-07):** `cryptoType` now keys difficulty off block time via `NETWORK_TUNING` in
> `difficultyConfig.js` — the pacing lever is **multi-level depth** (levels ∝ block time), measured
> and calibrated with a headless balance simulator. Also corrected: **WOW is ~5 min/block**, not 2
> (measured on the live daemon). See [BALANCE_SIM.md](BALANCE_SIM.md) and [MULTI_LEVEL.md](MULTI_LEVEL.md).

## Client render kit

`html/js/render/` (`RK`) draws the shared `Scene` in multiple techniques (Tiled / ASCII / Iso / 3D)
and interchangeable art **packs**, with a shared pure-canvas FX layer (torch/hearth fire, hazard
tiles), zoom, and an operator-gated cosmetic catalog. See [RENDER_PACKS.md](RENDER_PACKS.md).

## Game balance & pacing

Difficulty is **measured, not guessed**: single-player runs are bounded by a random (exponential)
block deadline, so the house edge is a simulation problem. `src/sim/` drives the real engine with
headless bots; `NETWORK_TUNING` + multi-level depth are the calibrated levers. See
[BALANCE_SIM.md](BALANCE_SIM.md) and [MULTI_LEVEL.md](MULTI_LEVEL.md).

The code is heavily JSDoc-commented, while the hand-authored pages here explain subsystem seams and
operator intent. A docs-only generator is intentionally not part of the production dependency lock;
add one in a dedicated documentation toolchain if generated API pages become a release artifact.

## Conventions worth knowing

- **Game id** is a UUID stored in `games.dungeon_seed`; `games.id` is a serial int. Match game objects
  with `WHERE dungeon_seed = $N`, never `WHERE id = $N`.
- **Socket ids are volatile** (change on refresh). For stable identity use the DB `user_id` / session,
  never `socket_id`.
- **WOW has 11 decimals** (atomic divisor 1e11), not Monero's 12.
- **Tests**: `cd src && npm test` (jest, `--runInBand`). Migrations live in `src/migrations/NNN_*.sql`.
