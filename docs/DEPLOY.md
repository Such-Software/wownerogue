# Production Deployment Guide

This guide covers deploying Wownerogue to a production environment.

---

## Prerequisites

- Node.js 22.x LTS or later
- PostgreSQL 12+
- Wownero or Monero wallet-rpc running and synced
- A domain with SSL certificate (via reverse proxy)

---

## Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure TLS via reverse proxy (Nginx/Caddy)
- [ ] Set secure database credentials
- [ ] Configure wallet-rpc with authentication
- [ ] Set `ADMIN_API_KEY` for admin endpoints
- [ ] Firewall: expose only 80/443
- [ ] Protect `/admin.html` with basic auth
- [ ] Set up database backups (see [LOGS_AND_BACKUP.md](./LOGS_AND_BACKUP.md))
- [ ] Configure log rotation
- [ ] Run database migrations

---

## Create Dedicated User

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

---

## Setup Deploy Key and Clone Repository

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

---

## Install Node.js

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

---

## Set File Permissions

```bash
# Set ownership of application files
sudo chown -R wownerogue:wownerogue /var/www/wownerogue

# Restrict permissions (owner only, no world access)
sudo chmod 750 /var/www/wownerogue
sudo chmod 640 /var/www/wownerogue/app/src/.env
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

---

## Database Setup

### Run Migrations

Database migrations run automatically on server start (via `databaseManager.runMigrations()`), but you can also run them manually:

```bash
cd /var/www/wownerogue/app/src

# Source environment variables
source .env

# Run migrations manually if needed
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f migrations/001_initial_schema.sql
# ... repeat for each migration file in order
```

### Database Reset (Development Only)

```bash
npm run db:drop    # Drop all tables
npm run db:create  # Recreate schema
```

---

## systemd Service

Save to `/etc/systemd/system/wownerogue.service`:

```ini
[Unit]
Description=Wownerogue Game Server
After=network.target postgresql.service

[Service]
Type=simple
User=wownerogue
Group=wownerogue
# Adjust paths if you cloned to a different location
WorkingDirectory=/var/www/wownerogue/app/src
EnvironmentFile=/var/www/wownerogue/app/src/.env
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

Enable and start:

```bash
# Create .env from example first!
sudo -u wownerogue cp /var/www/wownerogue/app/src/.env.example /var/www/wownerogue/app/src/.env
sudo vim /var/www/wownerogue/app/src/.env  # Edit with your settings

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable wownerogue
sudo systemctl start wownerogue
sudo systemctl status wownerogue
```

The systemd hardening options:
- `NoNewPrivileges` - prevents privilege escalation
- `ProtectSystem=strict` - mounts filesystem read-only except allowed paths
- `ProtectHome=yes` - hides /home, /root, /run/user
- `PrivateTmp=yes` - isolates /tmp
- `ReadWritePaths` - whitelists writable directories

---

## Reverse Proxy (Nginx Proxy Manager)

If using Nginx Proxy Manager:

1. **Add Proxy Host**
   - Domain Names: `yourdomain.com`
   - Scheme: `http`
   - Forward Hostname/IP: Your server's LAN IP (e.g., `192.168.1.100`)
   - Forward Port: `3000`
   - Enable "Websockets Support" toggle

2. **SSL Tab**
   - Request a new SSL certificate
   - Enable "Force SSL"

3. **Advanced Tab** - Paste this config for WebSocket support:

```nginx
location /socket.io/ {
    proxy_pass http://192.168.1.100:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

---

## Updating the Deployment

```bash
cd /var/www/wownerogue/app
sudo -u wownerogue git pull
cd src && sudo -u wownerogue npm install
sudo -u wownerogue npm audit fix
sudo systemctl restart wownerogue
```

---

## Multi-Instance Deployment

To run multiple instances (e.g., Wownero on port 3000 and Monero stagenet on port 3001):

### Directory Structure

```
/var/www/
├── wownerogue/        # Wownero instance (port 3000)
│   └── app/src/.env
└── monerogue/         # Monero instance (port 3001)
    └── app/src/.env
```

### Configuration Differences

| Setting | Wownero Instance | Monero Instance |
|---------|------------------|-----------------|
| `PORT` | 3000 | 3001 |
| `CRYPTO_TYPE` | WOW | XMR |
| `MONERO_NETWORK` | mainnet | stagenet |
| `DB_NAME` | wownerogue | monerogue_stagenet |
| `PRIMARY_WALLET_ENDPOINT` | http://127.0.0.1:34570 | http://127.0.0.1:38070 |
| `PRIMARY_RPC_ENDPOINT` | http://127.0.0.1:34568 | http://127.0.0.1:38081 |

### Separate systemd Service

Create `/etc/systemd/system/monerogue.service`:

```ini
[Unit]
Description=Monerogue Game Server (Stagenet)
After=network.target postgresql.service

[Service]
Type=simple
User=monerogue
WorkingDirectory=/var/www/monerogue/app/src
EnvironmentFile=/var/www/monerogue/app/src/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## Wallet Output Management

Wownero (and Monero) lock change outputs for several blocks after spending. If the wallet has only one large output and multiple payouts fire in quick succession, the second payout will fail because the change output from the first is still locked.

**Solution**: Pre-split wallet outputs into many smaller ones. The game server includes a CLI tool for this:

```bash
# Preview what would happen (no transaction sent)
node scripts/splitOutputs.js --amount 10 --count 30 --dry-run

# Split into 30 outputs of 10 WOW each (requires ~300 WOW + fees)
node scripts/splitOutputs.js --amount 10 --count 30
```

This creates 30 independently-spendable outputs, allowing up to 30 concurrent payouts before any output locking becomes an issue.

**When to re-split**: As payouts go out, outputs get consumed and consolidated via change. Periodically check the wallet and re-split when the number of spendable outputs drops low. The server also batches payouts that happen within 5 seconds of each other into a single transaction to conserve outputs.

**Recommended setup**: After initial wallet funding, run the split script. For a game with typical traffic, 20-30 outputs of 10 WOW each provides good concurrency headroom.

---

## Monitoring

### Check Service Status

```bash
systemctl status wownerogue
journalctl -u wownerogue -f  # Follow logs
```

### Health Endpoint

```bash
curl http://localhost:3000/health
```

Returns server uptime, memory usage, wallet status, and balance.

### Admin Dashboard

Access `/admin.html` with your `ADMIN_API_KEY` for:
- Wallet balance and connection status
- Pending/failed payouts
- Game statistics
- User search

---

## Troubleshooting

### Server Won't Start

```bash
# Check logs for errors
journalctl -u wownerogue -n 50

# Verify environment file
sudo -u wownerogue cat /var/www/wownerogue/app/src/.env

# Test database connection
psql -h localhost -U wownerogue -d wownerogue -c "SELECT 1;"
```

### Wallet RPC Issues

```bash
# Test wallet RPC directly
curl -u user:password -X POST http://127.0.0.1:34570/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_balance"}' \
  -H 'Content-Type: application/json'
```

### Database Migrations

If migrations fail, check the `migrations` table:

```sql
SELECT * FROM migrations ORDER BY id;
```

Migrations are tracked by name to prevent duplicate execution.
