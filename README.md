# Wownerogue

A browser-based roguelike synchronized with Monero (XMR) and Wownero (WOW) block timing. Built with Node.js/Express and Socket.IO for real-time play, optional crypto payments, and automated payouts.

## Features

- **Provably fair** gaming with pre-game hash commitments
- **Live spectator mode** - watch active games in real-time
- **Persistent chat** with 30-day history
- **Transaction history** - view payment and payout records
- **Multiple game modes**: Free play, per-game payments, or credit bundles
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

| Mode | Cost | Payout | Description |
|------|------|--------|-------------|
| **FREE** | None | None | No payments required |
| **PAID_SINGLE** | 1 WOW/game | 2× escape, 3× with treasure | Per-run payment |
| **PAID_CREDITS** | 10 credits/5 WOW | Optional | Buy credit bundles |

When both modes are enabled (`ALLOW_MIXED_MODE=true`), players with credits can start games instantly without the payment modal.

## Difficulty Presets

| Preset | Dungeon Size | Monster Aggression | House Win Rate |
|--------|--------------|--------------------|----|
| `easy` | 30×15 | Low | ~30% |
| `normal` | 45×22 | Medium | ~55% |
| `hard` | 55×28 | High | ~65% |
| `casino` | 60×30 | Very High | ~70% |

Set via `DIFFICULTY_PRESET` in `.env`. Defaults to `casino` for paid modes.

---

## Key Features

### Provably Fair Gaming

1. Server generates a random seed and shows its SHA-256 hash before the game
2. The seed deterministically generates the dungeon layout and positions
3. After the game, the seed is revealed for verification
4. Players can verify `hash(seed) = commitment` to prove no manipulation

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
| `GET /health` | Server health, uptime, memory, wallet status |
| `GET /api/game-modes` | Current modes and pricing |
| `GET /api/user/:socketId/credits` | User credit balance |
| `GET /api/user/:socketId/payments` | Payment history (paginated) |
| `GET /api/user/:socketId/payouts` | Payout history (paginated) |
| `POST /api/user/:socketId/address` | Set payout address |
| `GET /verify/:gameId` | Provably fair verification page |

### Admin Endpoints

Require `X-Admin-Key` header matching `ADMIN_API_KEY` env variable.

| Endpoint | Description |
|----------|-------------|
| `POST /api/admin/refund/payment` | Refund a payment, deduct credits if applicable |
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
| `game_update` | State after movement |
| `game_over` | Game ended |
| `payment_created` | Payment address ready |
| `credits_update` | Credit balance changed |
| `spectator_update` | Spectated game state |

---

## Configuration

Key environment variables (see `.env.example` for full list):

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
WALLET_RPC_PASSWORD=password

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

See LICENSE file for details.
