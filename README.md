# Wownerogue

Wownerogue is a browser-based roguelike that synchronizes dungeon runs with Monero (XMR) and Wownero (WOW) block timing. The backend is a Node.js/Express server with Socket.IO for realtime play, optional payment enforcement, and automated payouts.

## Overview

- Multiplayer dungeon crawler rendered in the browser
- Three game modes with configurable pricing and payouts
- Optional crypto payments with automatic subaddress management
- **Provably fair** gaming with pre-game hash commitments
- **Live spectator mode** - watch any active game in real-time
- **Persistent chat** with 30-day history for new users
- Configurable difficulty with house edge tuning
- Centralized error handling, rate limiting, and memory management
- Jest coverage for wallet RPC interactions, payment flow, security checks, and game helpers

## Difficulty System

Dungeon difficulty is configurable via presets that control dungeon size, monster behavior, and placement:

| Preset | Dungeon Size | Monster Aggression | Target House Win Rate |
|--------|--------------|--------------------|-----------------------|
| `easy` | 30×15 | Low (60%) | 30% |
| `normal` | 45×22 | Medium (80%) | 55% |
| `hard` | 55×28 | High (90%) | 65% |
| `casino` | 60×30 | Very High (95%) | 70% |

Set `DIFFICULTY_PRESET=casino` in `.env` for paid games. The default automatically selects `casino` for paid modes and `normal` for free play.

## Provably Fair Gaming

Every game uses cryptographic verification to prove fairness:

1. **Pre-game**: Server generates a random seed and shows its SHA-256 hash to the player
2. **During game**: The seed deterministically generates dungeon layout, positions, etc.
3. **Post-game**: Server reveals the seed so players can verify hash(seed) = pre-game commitment
4. **Verification**: Players can regenerate the dungeon using the seed to confirm fairness

This prevents the server from generating unfair dungeons or changing outcomes after seeing payments.

## Spectator Mode

Watch any active game in real-time without joining the queue or paying:

1. Click the **"👁️ Watch Games"** button to see a list of active games
2. Each game shows: player ID, duration, move count, treasure status, and spectator count
3. Click **"Watch Game"** to start spectating
4. Press **ESC** or click **"Leave Spectate"** to exit

**Technical details:**
- Games list auto-refreshes every 3 seconds
- Spectators receive real-time game state updates via Socket.IO rooms
- Pagination supports 100+ simultaneous games
- Spectators cannot interact with the game (input is disabled)
- Game over events are broadcast to spectators with final status

## Chat System

Persistent chat with history for community engagement:

- **30-day message retention** in PostgreSQL with automatic cleanup
- **New users receive last 50 messages** on connect for context
- **Rate limiting** prevents spam (12 messages per 10 seconds)
- **Address detection** recognizes XMR/WOW addresses pasted in chat
- **Commands**: `hello`, `enter`, `cancel`, `confirm`, `address`, `pay`, `stats`

Chat messages are stored in the `chat_messages` table and cached in memory for fast retrieval.

## Game Modes

The unified payment config exposes two monetized modes. They map to the legacy identifiers still exposed over the socket and REST APIs.

| Legacy Identifier | Unified Key | Description | Default Cost¹ | Default Payout |
| --- | --- | --- | --- | --- |
| `FREE` | n/a | Payments disabled. Runs never require a wallet or address. | n/a | n/a |
| `PAID_SINGLE` | `direct` | Per-run charge. Requires a confirmed payout address unless `DIRECT_REQUIRES_ADDRESS=false`. | 1 WOW (1e11 atomic) | 2× escape, 3× escape+treasure |
| `PAID_CREDITS` | `credits` | Credit bundles; each run consumes one credit. Mixed mode allowed when `ALLOW_MIXED_MODE=true`. | 10 credits for 5 WOW (small bundle) | Credits only (payouts disabled) |

¹ Atomic amounts use 11 decimal places (Monero/Wownero standard). Update `DIRECT_GAME_PRICE` or `CREDITS_PACKAGES` to change pricing. Config changes take effect when the snapshot refreshes or the process restarts.

## Payment System

- **Wallet RPC service** (`walletRPCService.js`): Handles subaddress creation, monitors payments, and batches payouts. Errors are wrapped in typed exceptions for consistent handling.
- **Game Mode manager** (`gameModeManager.js`): Applies payment configuration, validates player state, and coordinates payouts.
- **Payment handlers** (`paymentHandlers.js`): Manages request lifecycle, socket notifications, and queue integration.
- **Environment validator** (`config/environmentValidator.js`): Rejects unsafe payment configs and falls back to `FREE` mode when necessary.
- **Address detection** (`network/addressManager.js`): Parses XMR/WOW addresses shared in chat and requests confirmation before storing them.

If the wallet RPC service or configuration is unavailable the backend automatically downgrades to `FREE` mode so players can still start games.

## Backend Components

- `src/index.js`: Express entry point, REST routes, Socket.IO server, payout scheduler.
- `src/network/`: Socket handlers, connection/session management, chat commands, queue logic, rate limiting.
- `src/game/`: Dungeon generation, game state, movement, mode management, lighting/FOV helpers.
- `src/payments/`: Wallet RPC integration and QR code support.
- `src/db/`: PostgreSQL access layer and migration utilities.
- `src/utils/`: Shared utilities including memory management and custom error classes.
- `src/middleware/`: Express async wrapper and error middleware.

## API Surface

### Health & Status

- `GET /health` – Server health check with uptime, memory usage, game counts, and wallet status.
- `GET /api/game-modes` – Current game modes and pricing configuration.

### User Endpoints

- `GET /api/user/:socketId/credits` – Remaining credit balance for a user.
- `GET /api/user/:socketId/mode` – User payment mode preferences and enabled features.
- `POST /api/user/:socketId/address` – Store payout address (body: `{ "address": "<XMR/WOW address>" }`).

### Payment Endpoints (Socket.IO Preferred)

The following REST endpoints exist but return `501 Not Implemented`. Payment flows are handled via Socket.IO events for real-time feedback:

- `POST /api/payment/create` – Use socket event `request_payment` instead.
- `GET /api/payment/status/:paymentId` – Use socket event `payment_status` instead.
- `POST /api/payment/callback` – Reserved for future webhook integration.

### Socket.IO Events (Primary Payment Flow)

| Client → Server | Description |
|-----------------|-------------|
| `request_payment` | Request a payment address for game entry |
| `confirm_address` | Confirm a detected payout address |
| `cancel_address` | Cancel pending address confirmation |
| `join_queue` | Join the game queue after payment |

| Server → Client | Description |
|-----------------|-------------|
| `payment_created` | Payment address and QR code ready |
| `payment_confirmed` | Payment received and confirmed |
| `address_detected` | Payout address detected in chat |
| `address_confirmed` | Payout address saved |
| `game_start` | Game session beginning |
| `credits_update` | Credit balance changed |

All gameplay functions work without wallet RPC access; only paid modes require it.

## Installation

### Prerequisites

- Node.js 16 or newer
- npm
- PostgreSQL 12+
- Optional: Monero/Wownero Wallet RPC endpoints

### Steps

1. Clone and enter the server directory.
   ```bash
   git clone <repository-url>
   cd wownerogue/src
   ```
2. Install dependencies.
   ```bash
   npm install
   ```
3. Configure the environment file.
   ```bash
   cp .env.example .env
   # edit .env to match your database and wallet settings
   ```
4. Provision the database.
   ```bash
   # Create database and user
   npm run db:create
   
   # (Optional) To reset the database later:
   # npm run db:reset
   ```
5. Start the development server.
   ```bash
   npm run dev
   ```

The default Socket.IO client served from `/html` listens on port 3000. Configure a reverse proxy if you need TLS or path routing.

## Production Deployment

### Building for Production

There is no build step required—the Node.js server runs directly. However, ensure you configure the environment correctly:

```bash
# Set production environment
export NODE_ENV=production

# Start the production server
npm start
# Or with explicit environment:
NODE_ENV=production node index.js
```

### Production vs Development

| Feature | Development (`npm run dev`) | Production (`npm start`) |
|---------|----------------------------|-------------------------|
| `NODE_ENV` | development | production |
| Console logging | Verbose | Minimal |
| Error details | Full stack traces | Safe messages only |
| Debug hotkeys | Available | Disabled |
| Simulated blocks | Auto-enabled if no RPC | Requires real daemon |

### Reverse Proxy Setup (Nginx)

For TLS termination and serving the static frontend:

```nginx
upstream wownerogue_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name play.yoursite.com;

    ssl_certificate /etc/letsencrypt/live/play.yoursite.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/play.yoursite.com/privkey.pem;

    # Static files (game client)
    location / {
        root /var/www/wownerogue/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
    
    # Admin dashboard (restrict access!)
    location /admin.html {
        # Basic auth or IP whitelist recommended
        # auth_basic "Admin";
        # auth_basic_user_file /etc/nginx/.htpasswd;
        root /var/www/wownerogue/html;
    }

    # API and Socket.IO
    location /socket.io/ {
        proxy_pass http://wownerogue_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location ~ ^/(health|api|verify) {
        proxy_pass http://wownerogue_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP redirect
server {
    listen 80;
    server_name play.yoursite.com;
    return 301 https://$server_name$request_uri;
}
```

### Reverse Proxy Setup (Caddy)

Caddy auto-provisions TLS certificates:

```caddyfile
play.yoursite.com {
    root * /var/www/wownerogue/html
    file_server

    # Admin dashboard - consider adding basicauth
    # basicauth /admin.html {
    #     admin $2a$14$hashedpassword
    # }

    # WebSocket and API proxy
    @backend {
        path /socket.io/* /health /api/* /verify/*
    }
    reverse_proxy @backend localhost:3000
}
```

### Process Management (systemd)

Create `/etc/systemd/system/wownerogue.service`:

```ini
[Unit]
Description=Wownerogue Game Server
After=network.target postgresql.service

[Service]
Type=simple
User=wownerogue
WorkingDirectory=/var/www/wownerogue/src
EnvironmentFile=/var/www/wownerogue/src/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/www/wownerogue/src

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable wownerogue
sudo systemctl start wownerogue
sudo systemctl status wownerogue
```

### Production Checklist

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Configure TLS via reverse proxy (Nginx/Caddy)
- [ ] Set up PostgreSQL with proper credentials (not default)
- [ ] Configure Wownero/Monero wallet-rpc with authentication
- [ ] Enable firewall rules (only expose 80/443, not 3000)
- [ ] Set up log rotation for application logs
- [ ] Configure automated database backups
- [ ] Test the full payment flow with real funds
- [ ] Protect `/admin.html` with authentication
- [ ] Review and tune rate limits for expected traffic

## Configuration

Key environment variables (see `.env.example` for the full list):

```bash
# Network selection (Monero only - Wownero only has mainnet)
MONERO_NETWORK=mainnet        # mainnet, stagenet, or testnet
# ⚠️ STAGENET: Stagenet XMR has no value! UI shows warning when not mainnet.

# Difficulty preset
DIFFICULTY_PRESET=casino      # easy, normal, hard, casino (auto-selects for paid modes)

# Unified payments
PAYMENTS_ENABLED=true
PAYMENT_MODES=direct,credits

# Direct (per-run) mode
DIRECT_PAYMENT_ENABLED=true
DIRECT_GAME_PRICE=100000000000       # 1 WOW (atomic units)
DIRECT_REQUIRES_ADDRESS=true
DIRECT_ALLOW_GUEST_PLAY=false
DIRECT_PAYOUTS_ENABLED=true
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# Credits mode
CREDITS_ENABLED=true
CREDITS_PER_GAME=1
CREDITS_REQUIRES_ADDRESS=true
ALLOW_MIXED_MODE=true
PREFER_CREDITS_FIRST=true
CREDITS_PACKAGES='[{"id":"small","credits":10,"price":"500000000000","bonus":0}]'
CREDITS_PAYOUTS_ENABLED=false
CREDITS_PAYOUT_BASE=50000000000
CREDITS_PAYOUT_ESCAPE=1.5
CREDITS_PAYOUT_TREASURE=2.0

# Payout processing
PAYOUTS_ENABLED=true
PAYOUT_MIN_AMOUNT=10000000000
PAYOUT_MAX_PER_GAME=10000000000000
PAYOUT_BATCH_INTERVAL=300
PAYOUT_MAX_RETRIES=3
MAX_PAYOUT_BATCH_SIZE=50

# Limits
MAX_GAMES_PER_HOUR=60
MAX_PAYOUTS_PER_DAY=100
MAX_CREDIT_PURCHASE_PER_DAY=100000000000000
GAME_COOLDOWN_SECONDS=5

# Legacy override (optional)
GAME_MODE=
SINGLE_GAME_PRICE=100000000000
CREDITS_PACKAGE_PRICE=500000000000

# Wallet RPC
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:34570
# WALLET_RPC_USER=<rpc-user>
# WALLET_RPC_PASSWORD=<rpc-password>

# Blockchain RPC
PRIMARY_RPC_ENDPOINT=http://127.0.0.1:34568
FALLBACK_RPC_ENDPOINT=http://127.0.0.1:34568
RPC_POLL_INTERVAL=2000

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=wownerogue
DB_USER=jw
DB_PASSWORD=jw

# Server
PORT=3000
NODE_ENV=development

# Block timing overrides
BLOCK_SOURCE=daemon
# SIMULATED_BLOCKS=false
# FORCE_SIMULATED_BLOCKS=false
```

- Amounts are specified in atomic units (1 WOW = 1e11) unless otherwise noted.
- Leave wallet credentials unset to enforce `FREE` mode; payments require RPC access.
- `CREDITS_PACKAGES` must be valid JSON encoded as a single-line string. Adjust the bundle list to match your pricing model.
- The legacy `GAME_MODE`, `SINGLE_GAME_PRICE`, and `CREDITS_PACKAGE_PRICE` variables remain for compatibility but are ignored when `PAYMENT_MODES` is set.

## Payment Flow Summary

**`PAID_SINGLE`**
1. Player requests a paid run.
2. Server creates a subaddress and returns the payment details.
3. Wallet RPC monitors the subaddress and signals confirmation.
4. Game starts; payouts run after successful completion.

**`PAID_CREDITS`**
1. Player buys a ten-run bundle.
2. Credits are recorded in the database on confirmation.
3. Each game consumes one credit; no automatic payouts occur.

**Address confirmation**
1. Player pastes an address in chat.
2. Regex detection flags the message and issues a warning.
3. Player confirms; the address is persisted for payouts.

## Session Persistence

Player sessions are tied to an anonymous token stored in the browser's localStorage. This token persists:

- ✅ **Across page refreshes** – Reconnecting reloads your credits and payout address.
- ✅ **After closing the browser** – The token survives normal browser sessions.
- ✅ **Server restarts** – Session data is stored in PostgreSQL, not memory.

Sessions are **lost** when:

- ⚠️ Clearing cookies or localStorage
- ⚠️ Using private/incognito browsing mode (localStorage may be disabled or ephemeral)
- ⚠️ Switching browsers or devices

**Important notes for players:**

1. Your payout address and credit balance are tied to your session token.
2. If localStorage is unavailable (private browsing), a warning appears next to the "Manage Payout Address" button.
3. There is no account system—your session token *is* your identity. Treat it carefully.

**For deployment:**

- Ensure your reverse proxy preserves WebSocket connections for token handshake.
- The `wownerogue_token` key in localStorage contains the resume token.
- Session data (credits, address) is stored in the `users` table with the token in `anon_token`.

## Testing

Run the Jest suite from `src`:

```bash
npm test
```

Tests cover payment handlers, wallet RPC error propagation, security rules, movement logic, and integration flows. Additional manual scripts live under `test/` for browser debugging and lighting verification.

## Monitoring and Operations

- Rate limiting metrics and in-memory cleanup stats are exposed through server logs and debug views.
- Optional health endpoints provide game counts, queue length, and rate limiter state.
- Structured error handling ensures failed wallet or RPC calls return consistent payloads and are logged with context.

## Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `chat` | `{ id, message }` | Send chat message or command |
| `new game` | – | Request to join queue / start game |
| `cancel queue` | – | Leave the waiting queue |
| `movement` | `{ direction }` | Player movement (0–3 for N/E/S/W) |
| `get_active_games` | `{ page?, limit? }` | Request paginated list of active games |
| `spectate_game` | `{ gameId }` | Start spectating a specific game |
| `leave_spectate` | – | Stop spectating current game |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `chat message` | `{ id, message, timestamp }` | Broadcast chat message |
| `chat_history` | `{ messages: [...] }` | Last 50 messages on connect |
| `queue update` | `{ position, total }` | Queue position notification |
| `game started` | `{ gameState }` | Game initialization data |
| `game update` | `{ tiles, player, monsters, ... }` | Game state after movement |
| `game over` | `{ reason, stats }` | Game ended (death/escape/treasure) |
| `active_games` | `{ games, total, page, limit }` | Paginated active games list |
| `spectate_start` | `{ gameId, state }` | Initial state when spectating begins |
| `spectator_update` | `{ gameId, state }` | Real-time game state for spectators |
| `spectate_ended` | `{ gameId, reason }` | Game ended while spectating |

## Repository Layout

```
src/
├── index.js              # Entry point, server setup
├── config/
│   ├── environmentValidator.js
│   └── paymentConfig.js
├── db/
│   ├── databaseManager.js
│   ├── dbcalls.js
│   └── user.js
├── game/
│   ├── dungeon.js
│   ├── game.js
│   ├── gameManager.js
│   ├── gameModeManager.js
│   ├── lightingAndFov.js
│   ├── monster.js
│   ├── movementManager.js
│   └── player.js
├── network/
│   ├── addressManager.js
│   ├── broadcastManager.js
│   ├── chatHandler.js
│   ├── chatHistoryManager.js  # NEW: Persistent chat storage
│   ├── connectionHandler.js
│   ├── paymentHandlers.js
│   ├── queueHandler.js
│   ├── queueManager.js
│   ├── rateLimiter.js
│   ├── sessionManager.js
│   ├── socketHandlers.js
│   └── spectatorManager.js    # NEW: Live game spectating
├── payments/
│   ├── moneroPayService.js
│   ├── qrService.js
│   └── walletRPCService.js
├── rpc/
│   └── rpcService.js
└── utils/
    ├── errors.js
    └── memoryManager.js
html/
├── index.html
├── admin.html
└── js/
    ├── core/
    ├── display/
    ├── input/
    ├── network/
    └── ui/
test/
└── *.test.js
```

Refer to `REFACTORING_SUMMARY.md` for module-by-module details and migration history.

## Architecture Highlights

**Spectator System:**
- Uses Socket.IO rooms (`spectate:{gameId}`, `lobby`) for efficient broadcasting
- Game list cached for 2 seconds to handle 100+ concurrent games
- State broadcasts every 3 seconds plus on every move
- Spectators receive `game update` events identical to players

**Chat History:**
- PostgreSQL `chat_messages` table with 30-day retention
- In-memory cache for fast retrieval
- Automatic cleanup of old messages on startup

**Rate Limiting:**
- Per-IP sliding window for chat (12 messages/10s)
- Connection rate limits with configurable thresholds
- Queue position spam prevention

## Next Steps

- ✅ Implement spectator mode for live game watching
- ✅ Add persistent chat history for new users
- Run full payment integration test with real wallet-rpc
- Configure automated PostgreSQL backups
- Set up log rotation and monitoring alerts
- Load test rate limiting under production traffic patterns
