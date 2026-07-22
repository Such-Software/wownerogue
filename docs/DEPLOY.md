# Production Deployment Guide

This guide covers deploying Wownerogue to a production environment.

## Operated profiles versus independent deployments

Such Software (`apps@such.software`) operates only `play.wowne.ro` (Wownero mainnet
pay-for-credits leaderboard/prestige, no prize/payout/cash-out and not marketed as gambling) and `monerogue.app` (Monero
stagenet **NO REAL VALUE** 2×/3× solo test gambling mechanics, with crypto-match payouts off).
Classification of any product under applicable law requires jurisdiction-specific advice.
Their reviewed environment templates set `OPERATED_PRODUCT_PROFILE`, so preflight/startup rejects
scope drift. Independent MIT deployments must leave that variable unset and identify their actual
operator.

MIT rights are subject to retaining the copyright and permission notice. The software is provided
“AS IS”, without warranty, and the code/docs are not legal advice or compliance approval. Each
third-party operator is solely responsible for its deployment, legal obligations, funds, players,
claims, and support; Such Software neither endorses nor accepts responsibility for it.

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
- [ ] Run `npm run preflight` with the final environment
- [ ] Keep `PAYOUTS_ENABLED=false` on real-money prestige instances
- [ ] Complete a stagenet payment and payout before enabling a payout instance
- [ ] Firewall: allow Node 3000/3001 only from the reverse proxy; keep wallet/daemon RPC loopback-only
- [ ] Protect `/admin.html` with basic auth
- [ ] Set up database backups (see [LOGS_AND_BACKUP.md](./LOGS_AND_BACKUP.md))
- [ ] Configure log rotation
- [ ] Run database migrations

---

## Create Dedicated User

Create an isolated, non-login service identity. Release directories and the `current` link remain
root-owned; the service identity receives read/traverse access only and must never own its code:

```bash
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/www/wownerogue --no-create-home wownerogue
sudo install -d -m 0750 -o root -g wownerogue /var/www/wownerogue
sudo install -d -m 0750 -o root -g wownerogue /var/www/wownerogue/releases
sudo install -d -m 0750 -o root -g wownerogue /etc/wownerogue

# Create log directory
sudo install -d -m 0750 -o wownerogue -g wownerogue /var/log/wownerogue
```

---

## Stage reviewed artifacts, not a repository clone

Build the runtime artifact from a clean, reviewed commit as described in
[RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md). The production host needs no Git checkout, deploy key,
or write-capable source identity. The reviewed fleet
`playbooks/wowngeon-stage-candidate.yml` role transfers exactly one tarball to a newly selected
root-owned mode-0700 candidate inbox and compares its remote SHA-256 with the independently
recorded literal digest. Follow the fleet Wowngeon runbook; the role is a one-shot custody boundary,
not deployment.

The current fleet repository deliberately has no executable extraction/activation helper yet.
Until that helper exists, the safe host boundary is blob-only staging: do not manually
extract beneath `releases/`, install dependencies there, change `current`, restart an application,
or run migrations merely because the blob has arrived.

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

The eventual reviewed extraction/activation helper installs exactly the locked production graph in its private,
writable staging directory with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, verifies
it with `npm ls --omit=dev`, and seals the finished release root-owned and non-writable before it can
be selected. Never make a release tree writable by `wownerogue`. Online advisory lookup is a
separate explicitly authorized source-review operation; never run `npm audit fix` in staging or on
a live release.

---

## Set File Permissions

```bash
# Releases and selector are immutable to the service identity.
sudo chown root:wownerogue /var/www/wownerogue /var/www/wownerogue/releases
sudo chmod 0750 /var/www/wownerogue /var/www/wownerogue/releases
sudo chmod 0640 /etc/wownerogue/app.env
```

Do not use recursive ownership changes on `/var/www/wownerogue`; they can hand the service process
write access to immutable code or the rollback selector. The reviewed extraction/activation helper must verify
every individual release's ownership and modes before activation.

**Database ownership** - the application currently runs its own migrations at startup, so its
database role must own the database/schema (or otherwise retain DDL rights). Create it this way:

```sql
-- Create role with minimal privileges
CREATE USER wownerogue WITH PASSWORD 'secure-password-here';
CREATE DATABASE wownerogue OWNER wownerogue;
```

Do not revoke schema `CREATE` from this role while application startup owns migration execution;
that makes a fresh release fail partway through startup. A separate one-shot migrator role is the
follow-up path if runtime DDL privileges need to be removed.

## Database Setup

### Run Migrations

Database migrations run automatically, in filename order, inside one transaction per file and are
recorded in `schema_migrations`. Do not apply migration files directly with `psql`: bypassing the
ledger makes startup attempt them again. Before a release, take a restricted PostgreSQL backup and
test the complete migration set against a restored copy of each production database using the
fail-closed [disposable clone migration gate](CLONE_MIGRATIONS.md).

The migration ledger does not prove that rows predating a `NOT VALID` constraint are clean. Run
the read-only historical audit and the rollback-only native validation proof described in
[`FINANCIAL_CONSTRAINT_VALIDATION.md`](FINANCIAL_CONSTRAINT_VALIDATION.md) for each restored
database. The native `VALIDATE CONSTRAINT` gate deliberately refuses live database names.

If the Wownero mainnet service will export accounting events, review and configure the durable
[financial-event outbox](FINANCIAL_EVENT_EXPORT.md) before cutover. Monero stagenet export must
remain unset: those no-value test events are marked ignored locally.

Install the reviewed `wowngeon-db-backup.sh`, `.service`, and `.timer` through the hash-pinned fleet
operations change—not from the runtime artifact—and create
`/var/backups/wowngeon/daily` as `postgres:postgres` mode `0700`, then enable the timer. Each run
writes custom-format dumps atomically, verifies their catalogs with `pg_restore --list`, and records
a SHA-256 sidecar. Configure retention/remote replication according to the operator's recovery
policy; the supplied job deliberately does not delete backups.

### Database Reset (Development Only)

```bash
npm run db:drop    # Drop all tables
npm run db:create  # Recreate schema
```

---

## systemd Service

Install reviewed application, wallet, backup, and firewall artifacts only through the hash-pinned
fleet operations change; the runtime artifact intentionally has no service units. Application
units read secrets from `/etc/wownerogue/app.env` or `/etc/monerogue/app.env` plus the narrow
wallet-RPC environment, never from an immutable release directory. They run `npm run preflight`
before every start and use `/var/www/<instance>/current/src` so rollback is an atomic symlink
switch.

For the two Such Software services, do not replace this boundary with manual `install`, `systemctl`,
or symlink commands. Follow the default-closed wallet candidate/promotion, candidate validation,
and one-instance activation procedures in [DEPLOY_INSTANCES.md](DEPLOY_INSTANCES.md) and the
hash-pinned `~/src/such-fleet/RUNBOOK-wowngeon.md`. Independent MIT operators must design and review
their own equivalent control plane.

The systemd hardening options:
- `NoNewPrivileges` - prevents privilege escalation
- `ProtectSystem=strict` - mounts filesystem read-only except allowed paths
- `ProtectHome=yes` - hides /home, /root, /run/user
- `PrivateTmp=yes` - isolates /tmp
- `ReadWritePaths` - whitelists the wallet state directory in wallet-RPC units

---

## Reverse Proxy (Nginx Proxy Manager)

If using Nginx Proxy Manager:

1. **Add Proxy Host**
   - Domain Names: `yourdomain.com`
   - Scheme: `http`
   - Forward Hostname/IP: Your server's LAN IP (e.g., `192.168.1.100`)
   - Forward Port: `3000`
   - Enable "Websockets Support" toggle

Record the proxy's fixed source address in `/etc/wowngeon/firewall.env` as
`NPM_SOURCE_IPV4=<address>`. Direct access to 3000/3001 must be rejected; this also makes the
single-hop `TRUST_PROXY_HOPS=1` setting safe.

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

Run the full suite from the clean source commit, then build and verify the runtime artifact using
[RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md). Today, use the fleet blob-staging playbook and stop at
the independently hash-verified root-owned candidate blob because the reviewed extraction/activation
helper does not yet exist. When that helper implements the documented contract, it—not an application service identity or a
manual shell session—will build a new immutable `/var/www/<instance>/releases/<release-id>`, install
the locked graph, run the clone/preflight gates, seal ownership, and atomically select `current`.
Never run `git pull`, `npm install`, or `npm audit fix` inside the active release. Keep the previous
release and database backup until the new version has passed public health, WebSocket,
payment-intake, and (stagenet only) payout smoke tests.

---

## Multi-Instance Deployment

To run multiple instances (e.g., Wownero on port 3000 and Monero stagenet on port 3001):

### Directory Structure

```
/var/www/
├── wownerogue/        # releases/<id> + current symlink (port 3000)
└── monerogue/         # releases/<id> + current symlink (port 3001)
/etc/
├── wownerogue/app.env # root:wownerogue, 0640
└── monerogue/app.env  # root:monerogue, 0640
```

### Configuration Differences

| Setting | Wownero Instance | Monero Instance |
|---------|------------------|-----------------|
| `PORT` | 3000 | 3001 |
| `CRYPTO_TYPE` | WOW | XMR |
| `MONERO_NETWORK` | mainnet | stagenet |
| `DB_NAME` | wownerogue | monerogue |
| `PRIMARY_WALLET_ENDPOINT` | http://127.0.0.1:34570 | http://127.0.0.1:38083 |
| `PRIMARY_RPC_ENDPOINT` | http://127.0.0.1:34568 | http://127.0.0.1:38081 |

### Separate systemd Service

Install the hash-pinned fleet copy of `monerogue.service`; it is intentionally absent from the
runtime artifact. Do not hand-maintain a second, weaker unit. The reviewed template contains the
same preflight, graceful-stop, immutable-release path, and systemd sandbox as the mainnet service.

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
curl http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

`/health/live` checks the process. `/health/ready` returns 503 until PostgreSQL, the chain daemon,
and (for paid instances) wallet RPC are ready. Public probes do not expose wallet balances or RPC
endpoints; those remain in the authenticated admin dashboard.

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

# Validate the protected environment without printing it
cd /var/www/wownerogue/current/src
sudo -u wownerogue bash -c 'set -a; . /etc/wownerogue/app.env; set +a; npm run preflight'

# Test database connection
psql -h localhost -U wownerogue -d wownerogue -c "SELECT 1;"
```

### Wallet RPC Issues

```bash
# Test wallet RPC directly
curl --digest -u user:password -X POST http://127.0.0.1:34570/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_balance"}' \
  -H 'Content-Type: application/json'
```

### Database Migrations

If migrations fail, check the `schema_migrations` ledger:

```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;
```

Migrations are tracked by name to prevent duplicate execution.
