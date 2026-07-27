# Wownerogue

A browser-based roguelike synchronized with crypto block timing. A run is a race against the next
block: reach the exit before the block lands, or the house wins. The same codebase runs the solo
dungeon, the social Tavern, and operator-selected PvP/race rulesets, with separate free and paid
leaderboards.

## Such Software-operated products

Such Software (`apps@such.software`) operates only these two public products:

| Service | Operated scope |
|---|---|
| `play.wowne.ro` | Wownero mainnet free play and pay-for-credits leaderboard/prestige play. Credits are non-redeemable; there are no prizes, cash-out, or payouts, and the service is not offered or marketed as gambling. Legal classification depends on applicable law. |
| `monerogue.app` | Monero **stagenet only**, with direct solo entry only. Single-player 2×/3× outcomes are test gambling mechanics using test coins with **NO REAL VALUE**. Purchased-credit entry and crypto-match payouts are off. Never send mainnet XMR. |

The repository is self-hostable under the MIT License. A third-party operator is solely responsible
for its deployment, product, legal compliance, funds, players, claims, and support. Such Software
does not operate, supervise, endorse, or accept responsibility for a third-party deployment.

## Features

- **Provably fair solo runs** with two-party, pre-entry seed commitments and per-depth layout
  fingerprints
- **Multi-level descent** whose depth scales with the chain's block time
- **Live spectator mode**: watch active games in real time
- **Persistent chat** with a rolling 7-day server-side history
- **Transaction history**: payment and payout records per session
- **Multiple entry economies**: free play, per-run chain payment, or purchased credit bundles
- **Anonymous social Tavern** (no account required) with chat, live solo spectating, and in-place
  race queues
- **Shared render kit** with Tiled, ASCII, Iso, and 3D techniques across the dungeon and Tavern,
  driven by an operator-owned cosmetic catalog
- **Real-time multiplayer races** (optional): free, prestige-credit, or crypto winner-take-pot
  races on a per-block cadence
- **Wallet RPC integration** for payment address issuance, payment detection, and batched payouts

## Requirements

- Node.js >= 22, npm >= 10
- PostgreSQL
- A Wownero or Monero wallet RPC endpoint (only required for paid modes)

## Quick Start

```bash
git clone https://github.com/Such-Software/wownerogue.git
cd wownerogue/src
npm install
cp .env.example .env  # Edit with your database/wallet settings
npm run db:create     # Initialize PostgreSQL
npm run dev           # Start development server
```

Open http://localhost:3000 to play. `src/.env.example` is the full, annotated environment
template; the file at the repository root is a two-flag stub, not a starting point.

---

## Game Modes

`GAME_MODE` selects the solo entry economy for an instance.

| Mode | Cost | Payout | Leaderboard |
|------|------|--------|-------------|
| `FREE` | None | None | Pleb |
| `PAID_SINGLE` | Per-run chain payment | Profile-controlled | Paid prestige |
| `PAID_CREDITS` | Purchased credit | Profile-controlled | Paid prestige |

The Such Software production profiles are `src/.env.mainnet.example` (credits only, every payout
path off) and `src/.env.stagenet.example` (direct-entry-only stagenet 2×/3× solo test payouts,
purchased credits and crypto-match payouts off). Each opts into a startup contract with
`OPERATED_PRODUCT_PROFILE`; preflight refuses network, operator-identity, or economic-scope drift.
Generic self-hosts leave that variable unset and are not constrained by those product decisions.

## Match Mode (Multiplayer Races)

Real-time multiplayer races run when `MATCH_ENABLED=true`. A new race starts every crypto block as
long as at least two players are queued. Supported economies:

| Economy | Entry | Payout | Leaderboard |
|---|---|---|---|
| Free | None | None | Pleb |
| Prestige Credits | Credits | None | Prestige |
| Crypto Race | Race-entry ticket | Winner-take-pot minus house fee | Hall of Champions |

`MATCH_ENABLED` gates the creation of new rooms only; settlement reconciliation for existing rooms
runs regardless, so disabling it cannot strand an in-flight match. The Tavern's in-place race queue
additionally requires `TAVERN_ENABLED=true`.

See [`docs/MATCH_MODE.md`](docs/MATCH_MODE.md) for architecture, configuration, and API details, and
[`docs/RULESETS.md`](docs/RULESETS.md) for the Escape Race, Last Alive, Score Attack, and Co-op
Escape rulesets.

For deterministic multi-bot playtesting and 16:9/9:16 ad footage, use the loopback-only, free-only
capture harness documented in [`docs/PVP_CAPTURE.md`](docs/PVP_CAPTURE.md). It drives the real match
engine over Socket.IO but cannot connect to a deployment, database, wallet, or payout path.

## Difficulty and Pacing

Difficulty has two levers, both keyed to the crypto network, so `cryptoType` shapes the game.

**Presets** (`DIFFICULTY_PRESET`) set the per-level shape:

| Preset | Dungeon Size | Monster | Target House Win |
|--------|--------------|---------|------------------|
| `easy`   | 30×15 | low       | ~30% |
| `normal` | 45×22 | medium    | ~55% |
| `hard`   | 55×28 | high      | ~65% |
| `casino` | 70×35 | very high | ~70% |

An instance with `GAME_MODE=FREE` and payments off defaults to `normal`; paid modes default to
`casino`. Every knob is env-overridable (`DUNGEON_WIDTH`, `DUNGEON_HEIGHT`, `MONSTER_SPEED`, and so
on).

**Multi-level depth (`levels`)** is the pacing lever and scales with block time. A run descends N
levels, each a preset-sized dungeon with a fair monster. A non-final exit takes the stairs down;
only the final exit escapes, and the treasure sits in the vault on the final level. Because total
run length scales with the chain's block time, the block timer supplies the house edge without a
giant map or a monster that moves faster than the player.

| Chain | Mean block time | Levels |
|-------|-----------------|--------|
| GRIN | ~1 min | 1 |
| XMR  | ~2 min | 1 |
| LTC  | ~2.5 min | 2 |
| WOW  | ~5 min | 2 |
| BTC  | ~10 min | 3 |

Level counts live in `NETWORK_TUNING` (`src/game/difficultyConfig.js`). Precedence, low to high:
preset, per-network tuning, env vars, explicit call-site overrides. Override the count with
`DUNGEON_LEVELS`; disable per-network tuning entirely with `NETWORK_TUNING_DISABLED=true`.

Wownero's mean block time is ~5 minutes measured against the live daemon, which places it closer to
Bitcoin than to Monero for calibration purposes. Mean block times per chain are declared once in
`src/chain/chainProfile.js`. See [`docs/BALANCE_SIM.md`](docs/BALANCE_SIM.md) for how balance is
measured and calibrated, and [`docs/MULTI_LEVEL.md`](docs/MULTI_LEVEL.md) for the descent mechanic.

---

## Chain Profiles

`src/chain/chainProfile.js` is the single source for everything chain-specific that is not an RPC
call: decimals and atomic divisor, mean block time, adapter family, and payment URI scheme.

| Chain | Decimals | Mean block time | Family | URI scheme |
|-------|----------|-----------------|--------|------------|
| WOW  | 11 | 300000 ms | monero | `wownero` |
| XMR  | 12 | 120000 ms | monero | `monero` |
| BTC  | 8  | 600000 ms | utxo | `bitcoin` |
| LTC  | 8  | 150000 ms | utxo | `litecoin` |
| GRIN | 9  | 60000 ms  | mimblewimble | `grin` |

An unrecognized `CRYPTO_TYPE` resolves to a fallback profile shaped like XMR (12 decimals, 120000 ms
mean block time, monero family) so callers never crash on a mis-set value. Adding a chain means one
entry here plus a family adapter.

Note that WOW uses 11 decimals, not Monero's 12: 1 WOW = 10^11 atomic units.

---

## Provably Fair Gaming

1. The server publishes a one-use, socket-bound SHA-256 commitment to a secret server seed before
   the client chooses its contribution. Issuance is separate from consumption, so the server cannot
   grind its seed after seeing the player's.
2. The browser adds an independent WebCrypto client seed. Neither side alone selects the final
   seed.
3. The effective seed is `HMAC-SHA256(serverSeed, clientSeed)` and deterministically generates each
   dungeon depth along with its audit fingerprint.
4. After completion, the server seed and the per-depth layout manifest are revealed at
   `/verify/:gameId` and `/api/verify/:gameId`. Server seeds for active games stay private.

The proof covers layout generation. Outcome execution is a separate server-authoritative concern:
without a signed input/event transcript, the proof does not independently replay block timing,
player moves, monster turns, the declared result, or payout delivery.

## Spectator Mode

The **WATCH GAMES** control lists active games. Spectators receive real-time updates via Socket.IO
rooms. Press ESC to exit.

## Transaction History

The **History** control shows the session's payment and payout records: total received from payouts,
payment history with status and credits received, and payout history with multipliers and
transaction hashes.

## Session Persistence

Sessions, including anonymous Tavern entry, use an anonymous token stored in `localStorage`:

- Persists across refreshes, browser closes, and server restarts.
- Lost when clearing cookies or `localStorage`, using incognito mode, or switching browsers or
  devices.

A warning appears if `localStorage` is unavailable.

## Rendering and Cosmetics

The shared render kit provides four techniques: Tiled, ASCII, Iso, and 3D. Three.js is served from
the application's own origin under a versioned, immutable `/vendor/three/<version>` path, which
keeps it inside the production CSP. Setting `RENDERER_CDN_ENABLED=true` opts into third-party CDN
delivery instead and logs a warning in production.

Cosmetic packs are gated per pack, not by a blanket "has paid" flag. Each catalog entry carries a
tier and an optional lifetime-credits-purchased threshold, and a pack unlocks when either the user's
subscription tier reaches the pack's tier or their cumulative purchased credits reach its threshold.
Purchased credits are not deducted by unlocking. The default ladder is `original` (free), then
thresholds at 1, 5, 10, 20, 40, and 50 lifetime credits. In production the catalog is owned by the
`cosmetic_catalog` database table; the object in `src/multiplayer/entitlements.js` is the fallback
used when that table is unavailable.

See [`docs/RENDER_PACKS.md`](docs/RENDER_PACKS.md) and
[`docs/MONETIZATION.md`](docs/MONETIZATION.md).

---

## API Reference

### Public Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Redacted dependency/readiness summary |
| `GET /health/live` | Process liveness probe |
| `GET /health/ready` | Dependency readiness probe (503 while degraded) |
| `GET /api/game-modes` | Current modes and pricing |
| `GET /api/stats` | Public activity counters (short-lived cache, live online count) |
| `GET /api/disclosures` | Active commerce disclosure text for the running profile |
| `GET /api/leaderboard?board=pleb\|champions\|prestige&period=all\|week\|month` | One explicitly separated score board. An omitted `board` means `pleb`; legacy `all`, blank, and unknown board values return 400. An unknown `period` falls back to `all`. |
| `GET /api/user/:socketId/credits` | Credit balance |
| `GET /api/user/:socketId/mode` | Resolved entry mode for the user |
| `GET /api/user/:socketId/payment-options` | Available entry/payment options |
| `GET /api/user/:socketId/payments` | Payment history (paginated) |
| `GET /api/user/:socketId/payouts` | Payout history (paginated) |
| `POST /api/user/:socketId/address` | Set payout address |
| `POST /api/payment/create` | Create a payment request |
| `GET /api/payment/status/:paymentId` | Payment status |
| `GET /verify/:gameId` | Human-readable fairness verification page |
| `GET /api/verify/:gameId` | Machine-readable fairness proof |
| `GET /api/verify?serverSeed=&clientSeed=&effectiveSeed=&commitment=` | Stateless proof check for values you already hold |

`/`, `/tavern`, `/admin`, `/terms`, `/privacy`, and `/responsible-play` serve pages rather than JSON.

### Admin Endpoints

Require an `X-Admin-Key` header matching the `ADMIN_API_KEY` environment variable.

| Endpoint | Description |
|----------|-------------|
| `POST /api/admin/refund/payment` | Request an idempotent refund; consumed grants require review |
| `POST /api/admin/credits/adjust` | Add or remove credits from a user |
| `POST /api/admin/payouts/:id/retry` | Retry a failed payout |
| `GET /api/admin/users` | List users |
| `GET /api/admin/users/search` | Search users by socket ID or address |
| `GET /api/admin/users/:id` | User detail |
| `POST /api/admin/users/:id/chat-ban` | Apply or lift a chat ban |
| `GET /api/admin/chat` | Recent chat messages |
| `DELETE /api/admin/chat/:id` | Remove a chat message |
| `GET /api/admin/queue` | Inspect the entry queue |
| `POST /api/admin/queue/remove` | Remove an entry from the queue |
| `GET /api/admin/stats/overview` | Aggregate service stats |
| `GET /api/admin/stats/games` | Game stats |
| `GET /api/admin/stats/payouts` | Payout stats |
| `GET /api/admin/stats/refunds` | Refund stats |
| `POST /api/admin/alerts/test-email` | Send a test alert email |

**Example: refund a payment**

```bash
curl -X POST http://localhost:3000/api/admin/refund/payment \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"paymentId": 123, "reason": "Customer request", "sendFunds": true}'
```

**Example: adjust credits**

```bash
curl -X POST http://localhost:3000/api/admin/credits/adjust \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"socketId": "abc123", "amount": 5, "reason": "Compensation"}'
```

`amount` must be a non-zero safe integer in [-1000000, 1000000]; negative adjustments are applied
atomically and cannot drive a balance below zero.

### Socket.IO Events

**Client to server**

| Event | Description |
|-------|-------------|
| `register_client` | Bind the socket to a session token and receive identity/state |
| `fairness_offer_request` | Request a fresh server-seed commitment |
| `auto_start` | Start a run, using credits when available |
| `play_free` | Start a free run |
| `join_queue` | Join the next-block entry queue |
| `early_entry` | Enter the current block instead of waiting for the next |
| `player_move` | Move the player (direction 0-3) |
| `request_payment` | Request a payment address |
| `check_payment_status` | Poll a pending payment |
| `get_user_credits` | Request the current credit balance |
| `get_active_games` | List games available for spectating |
| `spectate_game` / `leave_spectate` | Enter and leave spectator mode |
| `chat_signed` / `chat_game_queue` | Send a signed chat message; queue chat-driven entry |
| `tavern_join` / `tavern_leave` / `tavern_move` / `tavern_chat` / `tavern_match_list` | Tavern presence, movement, chat, and race listing |
| `match_queue` / `match_move` / `match_leave` / `match_reconnect` | Multiplayer race queue and play |

**Server to client**

| Event | Description |
|-------|-------------|
| `socket_registered` / `session_token` / `session_resumed` | Session lifecycle |
| `fairness_offer` / `fairness_error` | Seed commitment issuance |
| `game_start` | Game initialized with dungeon state |
| `game_update` | State after movement, including `depth` and `maxDepth` for multi-level descent |
| `game_event` | Discrete in-run event: `descend`, `treasure_found`, `escaped`, `monster_caught` |
| `game_over` | Run ended |
| `game_settlement_pending` | Result recorded, settlement still in flight |
| `payment_created` / `payment_detected` / `payment_confirmed` / `payment_underpaid` / `payment_error` | Payment lifecycle |
| `credits_update` | Credit balance changed |
| `spectate_start` / `spectator_update` / `spectate_ended` | Spectator lifecycle |
| `chat_history` / `message` | Chat backlog and live messages |
| `leaderboard_update` / `win_feed` | Leaderboard and win ticker |
| `tavern_joined` / `tavern_update` / `tavern_match_tick` / `tavern_match_end` | Tavern state |
| `match_joined` / `match_end` / `match_settlement_pending` / `match_error` | Race lifecycle |

The client handles `descend` and `treasure_found` from `game_event` with an on-screen banner;
`escaped` and `monster_caught` are conveyed through `game_over`.

---

## Chat

Chat messages are persisted to the `chat_messages` table. A cleanup pass runs once per day and
deletes messages older than 7 days. Clients receive the most recent 50 messages on join. When no
database is available, chat falls back to a bounded in-memory buffer.

The Tavern prefers a shared global chat provider when one is injected. In that configuration a
Tavern message reaches every connected client, not just the Tavern room, and it is persisted along
with the rest of global chat. Only when no global provider is present does the Tavern fall back to
room-scoped, non-persisted chat.

See [`docs/CHAT_AND_NOSTR.md`](docs/CHAT_AND_NOSTR.md) for message signing and the optional nostr
relay path.

---

## Configuration

Key environment variables for a generic self-host. `src/.env.example` is the complete annotated
list.

```bash
# Core
NODE_ENV=production
PORT=3000
CRYPTO_TYPE=WOW
DIFFICULTY_PRESET=casino

# Payments
PAYMENTS_ENABLED=true
PAYMENT_MODES=direct,credits
DIRECT_GAME_PRICE=100000000000    # 1 WOW in atomic units
CREDITS_PACKAGES='[{"id":"small","credits":10,"price":"900000000000","bonus":0}]'

# Payouts
PAYOUTS_ENABLED=false
DIRECT_PAYOUTS_ENABLED=false
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# Wallet RPC (required for paid modes)
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:34570
WALLET_RPC_USER=user
WALLET_RPC_PASSWORD=use-a-distinct-strong-rpc-secret

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=wownerogue
DB_USER=your_user
DB_PASSWORD=your_password

# Admin API (generate with: openssl rand -hex 32)
ADMIN_API_KEY=your-secure-key

# Optional modes
TAVERN_ENABLED=true
MATCH_ENABLED=false

# Network selection (Monero only; Wownero has mainnet only)
MONERO_NETWORK=mainnet
```

Amounts are always atomic units for the configured chain. See the chain profile table above for
per-chain decimals.

`npm run preflight` validates the environment against the configured product profile without
starting the service.

---

## Production Deployment

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for production deployment, including:

- systemd service configuration
- Nginx or other reverse proxy setup with WebSocket support
- Database permissions and security hardening

[`docs/DEPLOY_INSTANCES.md`](docs/DEPLOY_INSTANCES.md) covers running multiple instances, such as
Wownero and Monero, on one server.

---

## Operations

See [`docs/LOGS_AND_BACKUP.md`](docs/LOGS_AND_BACKUP.md) for log management with systemd/journald,
automated PostgreSQL backups, and backup verification.

`scripts/deploy/wowngeon-db-backup.sh` writes a dump and then prunes dumps older than
`BACKUP_RETENTION_DAYS` (default 14), plus interrupted temporary files older than one day. It
rejects a non-positive or non-numeric retention value rather than defaulting silently.

Financial operations are documented in
[`docs/FINANCIAL_RECONCILIATION.md`](docs/FINANCIAL_RECONCILIATION.md),
[`docs/FINANCIAL_CONSTRAINT_VALIDATION.md`](docs/FINANCIAL_CONSTRAINT_VALIDATION.md),
[`docs/FINANCIAL_EVENT_EXPORT.md`](docs/FINANCIAL_EVENT_EXPORT.md), and
[`docs/STAGENET_FINANCIAL_CANARY.md`](docs/STAGENET_FINANCIAL_CANARY.md).

---

## Testing

```bash
cd src
npm test
```

Tests cover payment handlers, wallet RPC, security rules, movement logic, fairness verification, and
integration flows.

---

## Project Structure

```
src/
├── index.js         # Entry point, HTTP routes, static and vendor asset serving
├── auth/            # Session and wallet-based authentication
├── chain/           # Chain profile registry
├── config/          # Payment config, environment validation, product profiles
├── db/              # PostgreSQL layer
├── game/            # Dungeon generation, player, monster, fairness, mode resolution
├── middleware/      # Express middleware
├── migrations/      # Numbered SQL migrations
├── money/           # Atomic-unit arithmetic
├── multiplayer/     # Entitlements, appearance, cosmetic catalog
├── network/         # Socket handlers, chat, queue, spectator, match, Tavern
├── payments/        # Wallet RPC, QR codes
├── routes/          # Admin, auth, and leaderboard routers
├── rpc/             # Daemon and wallet clients
├── services/        # Health, alerts, refunds, payouts, subscriptions, exports
├── sim/             # Balance simulation harness
├── utils/           # Errors, memory management, nostr helpers
└── views/           # Server-rendered legal and verification pages
html/
├── index.html       # Game client
├── tavern.html      # Tavern client
├── match.html       # Match client
├── admin.html       # Admin dashboard
├── assets/          # Render packs and images
└── js/              # Frontend modules (core, render, network, ui, input)
test/
└── *.test.js        # Jest tests
docs/                # Architecture, deployment, payments, and design references
scripts/             # Deployment units, backup, asset build, wallet maintenance
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes how these pieces fit together.

---

## License

The source is available under the [MIT License](LICENSE). MIT permission to use, copy, modify,
merge, publish, distribute, sublicense, and sell copies is subject to including the copyright and
permission notice in all copies or substantial portions. The software is provided "AS IS", without
warranty of any kind, as stated in the License.

The MIT License governs rights in the source. Documentation, examples, and product disclosures are
informational only; they are not legal advice or a determination that a deployment complies with
applicable law. Such Software operates only the two products and scopes listed above. The MIT
License does not make an independent deployment a Such Software service or authorize it to claim
Such Software sponsorship or endorsement; its operator remains solely responsible for the service.
