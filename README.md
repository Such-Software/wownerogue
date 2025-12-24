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

### Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure TLS via reverse proxy (Nginx/Caddy)
- [ ] Set secure database credentials
- [ ] Configure wallet-rpc with authentication
- [ ] Set `ADMIN_API_KEY` for admin endpoints
- [ ] Firewall: expose only 80/443
- [ ] Protect `/admin.html` with basic auth
- [ ] Set up database backups
- [ ] Configure log rotation

### Create Dedicated User

Create an isolated system user for security:

```bash
# Create system user with no login shell and dedicated home
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/www/wownerogue --create-home wownerogue

# Create .ssh directory for deploy key
sudo mkdir -p /var/www/wownerogue/.ssh
sudo chmod 700 /var/www/wownerogue/.ssh
sudo chown wownerogue:wownerogue /var/www/wownerogue/.ssh

# Create log directory
sudo mkdir -p /var/log/wownerogue
sudo chown wownerogue:wownerogue /var/log/wownerogue
```

### Setup Deploy Key and Clone Repository

Generate an SSH deploy key for the wownerogue user:

```bash
# Generate deploy key (as root, since user has no shell)
sudo ssh-keygen -t ed25519 -C "wownerogue-deploy" -f /var/www/wownerogue/.ssh/id_ed25519 -N ""

# Set correct ownership and permissions
sudo chown wownerogue:wownerogue /var/www/wownerogue/.ssh/id_ed25519*
sudo chmod 600 /var/www/wownerogue/.ssh/id_ed25519
sudo chmod 644 /var/www/wownerogue/.ssh/id_ed25519.pub

# Display the public key
sudo cat /var/www/wownerogue/.ssh/id_ed25519.pub
```

Add the deploy key to GitHub:
1. Go to your repository → **Settings** → **Deploy keys**
2. Click **Add deploy key**
3. Paste the public key from the command above
4. Leave "Allow write access" unchecked (read-only is sufficient)
5. Click **Add key**

Configure SSH for GitHub:

```bash
# Create SSH config for the wownerogue user
sudo tee /var/www/wownerogue/.ssh/config << 'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF

sudo chown wownerogue:wownerogue /var/www/wownerogue/.ssh/config
sudo chmod 600 /var/www/wownerogue/.ssh/config
```

Clone the repository:

```bash
# Clone as the wownerogue user (replace YOUR_USERNAME with your GitHub username)
sudo -u wownerogue git clone git@github.com:YOUR_USERNAME/wownerogue.git /var/www/wownerogue/app
```

### Install Node.js

Install Node.js LTS using NodeSource (run as root):

```bash
# Install Node.js 22.x LTS (or check https://nodejs.org for current LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

Install dependencies and audit for vulnerabilities:

```bash
cd /var/www/wownerogue/app/src
sudo -u wownerogue npm install

# Check for known vulnerabilities
sudo -u wownerogue npm audit

# Auto-fix vulnerabilities where possible
sudo -u wownerogue npm audit fix
```

To update the deployment later:

```bash
cd /var/www/wownerogue/app
sudo -u wownerogue git pull
cd src && sudo -u wownerogue npm install
sudo -u wownerogue npm audit fix
sudo systemctl restart wownerogue
```

### Set File Permissions

```bash
# Set ownership of application files
sudo chown -R wownerogue:wownerogue /var/www/wownerogue

# Restrict permissions (owner only, no world access)
sudo chmod 750 /var/www/wownerogue
sudo chmod 640 /var/www/wownerogue/src/.env
```

**Database permissions** - create a restricted PostgreSQL role:

```sql
-- Create role with minimal privileges
CREATE USER wownerogue WITH PASSWORD 'secure-password-here';
CREATE DATABASE wownerogue OWNER wownerogue;

-- Revoke dangerous permissions
REVOKE CREATE ON SCHEMA public FROM wownerogue;

-- Grant only what's needed
GRANT CONNECT ON DATABASE wownerogue TO wownerogue;
GRANT USAGE ON SCHEMA public TO wownerogue;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wownerogue;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wownerogue;
```

**Filesystem isolation** (optional, for extra hardening):

```bash
# Prevent the user from accessing other users' home directories
sudo chmod 700 /home/*

# Mount application directory with noexec for uploads (if applicable)
# Add to /etc/fstab if using separate partition
```

### systemd Service

```ini
[Unit]
Description=Wownerogue Game Server
After=network.target postgresql.service

[Service]
Type=simple
User=wownerogue
Group=wownerogue
WorkingDirectory=/var/www/wownerogue/src
EnvironmentFile=/var/www/wownerogue/src/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/www/wownerogue /var/log/wownerogue

[Install]
WantedBy=multi-user.target
```

The systemd hardening options:
- `NoNewPrivileges` - prevents privilege escalation
- `ProtectSystem=strict` - mounts filesystem read-only except allowed paths
- `ProtectHome=yes` - hides /home, /root, /run/user
- `PrivateTmp=yes` - isolates /tmp
- `ReadWritePaths` - whitelists writable directories

### Reverse Proxy

Use your existing reverse proxy (Nginx Proxy Manager, Caddy, Traefik, etc.) to forward traffic to port 3000. Key settings for WebSocket support:

- Enable WebSocket proxying
- Set timeout to at least 86400s for long-lived connections
- Forward `/socket.io/` path to the backend
- Optionally protect `/admin.html` with authentication

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
