# Wownerogue

A browser-based roguelike synchronized with Monero (XMR) and Wownero (WOW) block timing. The same codebase runs the original solo dungeon, the social Tavern, and operator-selected PvP/race rulesets, with separate free and paid leaderboards.

## Such Software-operated products

Such Software (`apps@such.software`) operates only these two public products:

| Service | Operated scope |
|---|---|
| `play.wowne.ro` | Wownero mainnet free play and pay-for-credits leaderboard/prestige play. Credits are non-redeemable; there are no prizes, cash-out, or payouts, and the service is not offered or marketed as gambling. Legal classification depends on applicable law. |
| `monerogue.app` | Monero **stagenet only**. Single-player 2×/3× outcomes are test gambling mechanics using test coins with **NO REAL VALUE**. Never send mainnet XMR. Crypto-match payouts remain off. |

The repository remains generally self-hostable under the MIT License. A third-party operator is
solely responsible for its deployment, product, legal compliance, funds, players, claims, and
support. Such Software does not operate, supervise, endorse, or accept responsibility for a
third-party deployment.

## Features

- **Provably fair** solo runs with two-party, pre-entry commitments and per-depth fingerprints
- **Live spectator mode** - watch active games in real-time
- **Persistent chat** with 30-day history
- **Transaction history** - view payment and payout records
- **Multiple game modes**: Free play, per-game payments, or credit bundles
- **Social Tavern** with chat, live solo spectating, and in-place race queues
- **Real-time multiplayer races**: free, prestige-credit, or crypto winner-take-pot races every block
- Configurable difficulty with house edge tuning
- Automatic wallet RPC integration for payments and payouts

## Quick Start

```bash
git clone <repository-url>
cd wownerogue/src
npm install
cp .env.example .env  # Edit with your database/wallet settings
npm run db:create     # Initialize PostgreSQL
npm run dev           # Start development server
```

Open http://localhost:3000 to play.

---

## Game Modes

| Mode | Cost | Payout | Leaderboard |
|------|------|--------|-------------|
| **FREE** | None | None | Pleb |
| **PAID_SINGLE** | Per-run chain payment | Profile-controlled | Paid prestige |
| **PAID_CREDITS** | Purchased credit | Profile-controlled | Paid prestige |

The exact Such Software production profiles are `src/.env.mainnet.example` (credits only, every
payout path off) and `src/.env.stagenet.example` (stagenet 2×/3× solo test payouts, crypto-match
payouts off). Each opts into a startup contract with `OPERATED_PRODUCT_PROFILE`; preflight refuses
network, operator-identity, or economic-scope drift. Generic self-hosts leave that variable unset.

## Match Mode (Multiplayer Races)

Optional real-time multiplayer races are available when `MATCH_ENABLED=true`. A new race starts every
crypto block as long as at least two players are queued. Supported economies:

| Economy | Entry | Payout | Leaderboard |
|---|---|---|---|
| **Free** | None | None | Pleb |
| **Prestige Credits** | Credits | None | Prestige |
| **Crypto Race** | Race-entry ticket | Winner-take-pot minus house fee | Hall of Champions |

See `docs/MATCH_MODE.md` for full architecture, configuration, and API details.

For deterministic multi-bot playtesting and 16:9/9:16 ad footage, use the loopback-only,
free-only capture harness documented in [`docs/PVP_CAPTURE.md`](docs/PVP_CAPTURE.md). It drives the
real match engine over Socket.IO but cannot connect to a deployment, database, wallet, or payout path.

## Difficulty & Pacing

Difficulty has two levers, both keyed to the crypto network so `cryptoType` actually shapes the
game (it used to be a dead parameter).

**Presets** (`DIFFICULTY_PRESET`) — the per-level shape:

| Preset | Dungeon Size | Monster | Target House Win |
|--------|--------------|---------|------------------|
| `easy`   | 30×15 | low       | ~30% |
| `normal` | 45×22 | medium    | ~55% |
| `hard`   | 55×28 | high      | ~65% |
| `casino` | 70×35 | very high | ~70% |

Defaults to `normal` for free play, `casino` for paid. Every knob is `env`-overridable
(`DUNGEON_WIDTH`, `MONSTER_SPEED`, …).

**Multi-level depth (`levels`) — the pacing lever, ∝ block time.** A run *descends* N levels (each a
preset-sized dungeon with a fair monster). Reaching a non-final exit takes the stairs down; only the
final exit escapes; the treasure sits in the vault (final level). Because total run length scales
with the chain's block time, the "race the block" **timer** provides the house edge — no giant map,
no cheating-fast monster.

| Chain | Block time | Levels |
|-------|-----------|--------|
| GRIN | ~1 min | 1 |
| XMR  | ~2 min | 2 |
| LTC  | ~2.5 min | 2 |
| WOW  | ~5 min (measured) | 4 |
| BTC  | ~10 min | 8 |

Levels live in `NETWORK_TUNING` (`src/game/difficultyConfig.js`); override with `DUNGEON_LEVELS`,
disable with `NETWORK_TUNING_DISABLED=true`. The counts are sim-derived starting points — see
[`docs/BALANCE_SIM.md`](docs/BALANCE_SIM.md) for how the balance is measured and calibrated.

> **Note:** Wownero's block time is **~5 min** (measured on the live daemon), not 2 min as older
> docs/comments claimed.

---

## Key Features

### Provably Fair Gaming

1. The server publishes a one-use, socket-bound SHA-256 commitment before paid entry.
2. The browser adds an independent WebCrypto client seed; neither side alone selects the final seed.
3. The effective seed deterministically generates each dungeon depth and its audit fingerprint.
4. After completion, the server seed and depth manifest are revealed at `/verify/:gameId` and
   `/api/verify/:gameId`; active-game server seeds remain private.

### Spectator Mode

Click **"👁️ Watch Games"** to see active games. Spectators receive real-time updates via Socket.IO rooms. Press ESC to exit.

### Transaction History

Click **"📜 History"** to view your payment and payout records. Shows:
- Total received from payouts
- Payment history with status and credits received
- Payout history with multipliers and transaction hashes

### Session Persistence

Sessions use an anonymous token stored in localStorage:
- ✅ Persists across refreshes, browser closes, server restarts
- ⚠️ Lost when clearing cookies/localStorage, using incognito mode, or switching browsers/devices

A warning appears if localStorage is unavailable.

---

## API Reference

### Public Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Redacted dependency/readiness summary |
| `GET /health/live` | Process liveness probe |
| `GET /health/ready` | Dependency readiness probe (503 while degraded) |
| `GET /api/game-modes` | Current modes and pricing |
| `GET /api/user/:socketId/credits` | User credit balance |
| `GET /api/user/:socketId/payments` | Payment history (paginated) |
| `GET /api/user/:socketId/payouts` | Payout history (paginated) |
| `POST /api/user/:socketId/address` | Set payout address |
| `GET /verify/:gameId` | Human-readable fairness verification page |
| `GET /api/verify/:gameId` | Machine-readable fairness proof |

### Admin Endpoints

Require `X-Admin-Key` header matching `ADMIN_API_KEY` env variable.

| Endpoint | Description |
|----------|-------------|
| `POST /api/admin/refund/payment` | Request an idempotent refund; consumed grants require review |
| `POST /api/admin/credits/adjust` | Add or remove credits from a user |
| `GET /api/admin/users/search` | Search users by socket ID or address |

**Example: Refund a payment**
```bash
curl -X POST http://localhost:3000/api/admin/refund/payment \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"paymentId": 123, "reason": "Customer request", "sendFunds": true}'
```

**Example: Adjust credits**
```bash
curl -X POST http://localhost:3000/api/admin/credits/adjust \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"socketId": "abc123", "amount": 5, "reason": "Compensation"}'
```

### Socket.IO Events

**Client → Server**
| Event | Description |
|-------|-------------|
| `auto_start` | Start game (uses credits if available) |
| `player_move` | Move player (direction: 0-3) |
| `request_payment` | Request payment address |
| `get_active_games` | List games for spectating |
| `spectate_game` | Start spectating a game |

**Server → Client**
| Event | Description |
|-------|-------------|
| `game_start` | Game initialized with dungeon state |
| `game_update` | State after movement (incl. `depth`/`maxDepth` for multi-level descent) |
| `game_event` | Discrete event: `treasure_found`, `descend` (took the stairs down), `escaped` |
| `game_over` | Game ended |
| `payment_created` | Payment address ready |
| `credits_update` | Credit balance changed |
| `spectator_update` | Spectated game state |

---

## Configuration

Key environment variables for a generic self-host (not an operated production profile; see
`.env.example` for the full list):

```bash
# Core
NODE_ENV=production
PORT=3000
DIFFICULTY_PRESET=casino

# Payments
PAYMENTS_ENABLED=true
PAYMENT_MODES=direct,credits
DIRECT_GAME_PRICE=100000000000    # 1 WOW in atomic units
CREDITS_PACKAGES='[{"id":"small","credits":10,"price":"500000000000","bonus":0}]'

# Payouts
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# Wallet RPC (required for paid modes)
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:34570
WALLET_RPC_USER=user
WALLET_RPC_PASSWORD=use-a-distinct-strong-rpc-secret

# Database
DB_HOST=localhost
DB_NAME=wownerogue
DB_USER=your_user
DB_PASSWORD=your_password

# Admin API (generate with: openssl rand -hex 32)
ADMIN_API_KEY=your-secure-key

# Network (Monero only - Wownero only has mainnet)
MONERO_NETWORK=mainnet
```

Amounts use atomic units: 1 WOW = 10^11 atomic units.

---

## Production Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md) for detailed production deployment instructions including:
- systemd service configuration
- Nginx/reverse proxy setup with WebSocket support
- Database permissions and security hardening
- Multi-instance deployment (running Wownero and Monero on the same server)

---

## Operations

See [docs/LOGS_AND_BACKUP.md](docs/LOGS_AND_BACKUP.md) for:
- Log management with systemd/journald
- PostgreSQL automated backups
- Backup verification procedures

---

## Testing

```bash
cd src
npm test
```

Tests cover payment handlers, wallet RPC, security rules, movement logic, and integration flows.

---

## Project Structure

```
src/
├── index.js                 # Entry point
├── config/                  # Payment config, validation
├── db/                      # PostgreSQL layer
├── game/                    # Dungeon, player, monster logic
├── network/                 # Socket handlers, chat, queue, spectator
├── payments/                # Wallet RPC, QR codes
└── utils/                   # Errors, memory management
html/
├── index.html               # Game client
├── admin.html               # Admin dashboard
└── js/                      # Frontend modules
test/
└── *.test.js                # Jest tests
```

---

## License

The source is available under the [MIT License](LICENSE). MIT permission to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies is subject to including the copyright
and permission notice in all copies or substantial portions. The software is provided “AS IS”,
without warranty of any kind as stated in the License.

The MIT License governs rights in the source. Documentation, examples, and product disclosures are
informational only; they are not legal advice or a determination that a deployment complies with
applicable law. Such Software operates only the two products and scopes listed above. The MIT
License does not make an independent deployment a Such Software service or authorize it to claim
Such Software sponsorship or endorsement; its operator remains solely responsible for the service.
