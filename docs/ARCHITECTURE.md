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

> **Gotcha (open):** `difficultyConfig` threads `cryptoType` everywhere but doesn't yet key difficulty
> off mean block time — it keys off payment mode. Wiring block-time → dungeon size is a pending
> game-balance change (see RULESETS.md), and it bites when Grin (~1 min) / BTC (~10 min) ship.

## Regenerating the API reference (autodocs)

The code is heavily JSDoc-commented. To regenerate a Markdown API reference from those comments:

```bash
cd src && npm install   # first time, pulls jsdoc-to-markdown (devDependency)
npm run docs:api        # writes docs/API/*.md
```

Autodocs cover the **reference** layer (what each function/param is). The **why** — the seams and
flows in the pages above — is hand-authored and lives here in `docs/`. Keep both.

## Conventions worth knowing

- **Game id** is a UUID stored in `games.dungeon_seed`; `games.id` is a serial int. Match game objects
  with `WHERE dungeon_seed = $N`, never `WHERE id = $N`.
- **Socket ids are volatile** (change on refresh). For stable identity use the DB `user_id` / session,
  never `socket_id`.
- **WOW has 11 decimals** (atomic divisor 1e11), not Monero's 12.
- **Tests**: `cd src && npm test` (jest, `--runInBand`). Migrations live in `src/migrations/NNN_*.sql`.
