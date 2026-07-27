# Production Deployment Guide

This guide covers deploying Wownerogue to a production environment.

## Operated profiles versus independent deployments

Such Software (`apps@such.software`) operates only `play.wowne.ro` (Wownero mainnet free play plus
pay-for-credits leaderboard/prestige, with no prize, payout, or cash-out, and not marketed as
gambling) and `monerogue.app` (Monero stagenet direct entry only, **NO REAL VALUE** test coins, with
single-player 2x/3x test gambling mechanics, purchased-credit entry disabled, and crypto match
payouts off). Both profiles are defined in `src/config/operatedProductProfiles.js` and selected by
`OPERATED_PRODUCT_PROFILE`; preflight and normal startup reject any network, identity, or
economic-scope drift from the selected profile. Classification of any product under applicable law
requires jurisdiction-specific advice.

Independent MIT deployments leave `OPERATED_PRODUCT_PROFILE` unset and identify their actual
operator. MIT rights are subject to retaining the copyright and permission notice. The software is
provided "AS IS", without warranty, and the code and documentation are not legal advice or
compliance approval. Each third-party operator is solely responsible for its deployment, legal
obligations, funds, players, claims, and support. Such Software neither endorses nor accepts
responsibility for it.

---

## Prerequisites

- Node.js 22.x LTS or later (`src/package.json` requires `node >=22`, `npm >=10`)
- PostgreSQL 12 or later
- Wownero or Monero wallet-rpc running and synced
- A domain with a TLS certificate, terminated by a reverse proxy

The full environment template is `src/.env.example`. Operated profile templates are
`src/.env.mainnet.example` and `src/.env.stagenet.example`; `src/.env.match.example` covers race
mode. The five-line `.env.example` at the repository root is not a configuration reference.

---

## Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure TLS via reverse proxy (Nginx/Caddy)
- [ ] Set secure database credentials
- [ ] Configure wallet-rpc with authentication
- [ ] Set `ADMIN_API_KEY` (production requires a non-placeholder secret of at least 32 characters)
- [ ] Run `npm run preflight` with the final environment
- [ ] Keep `PAYOUTS_ENABLED=false` on real-money prestige instances
- [ ] Complete a stagenet payment and payout before enabling a payout instance
- [ ] Firewall: allow Node 3000/3001 only from the reverse proxy; keep wallet and daemon RPC
      loopback-only
- [ ] Protect the admin page (served at both `/admin` and `/admin.html`) with basic auth
- [ ] Set up database backups (see [LOGS_AND_BACKUP.md](./LOGS_AND_BACKUP.md))
- [ ] Configure log rotation
- [ ] Run database migrations
- [ ] If 3D is offered, provision the gitignored runtime GLBs and verify library and model requests
      stay same-origin

---

## Create Dedicated User

Create an isolated, non-login service identity. Release directories and the `current` link remain
root-owned; the service identity receives read and traverse access only and never owns its code:

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
or write-capable source identity.

The artifact contains exactly `LICENSE`, `html`, and `src`, minus environment files, tests, the
balance simulator, and the operator-only scripts under `src/scripts`. Documentation, service units,
firewall and backup scripts, and root-level operator tooling are deliberately excluded: operational
artifacts keep their own pinned provenance in the source and fleet repositories rather than becoming
part of the application runtime because they share a Git commit.

The fleet `playbooks/wowngeon-stage-candidate.yml` role transfers exactly one tarball to a newly
selected root-owned mode-0700 candidate inbox and compares its remote SHA-256 with the
independently recorded literal digest. It is a one-shot custody boundary, not deployment.

The executable extraction and activation boundary lives only in the separately reviewed fleet
repository as the default-closed `wowngeon_release_activate` role. This application checkout cannot
attest which fleet revision is installed or authorize its execution. Follow the hash-pinned fleet
runbook and literal receipt contract. Do not manually extract beneath `releases/`, install
dependencies there, change `current`, restart an application, or run migrations merely because a
blob has arrived.

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

The fleet extraction and activation role installs exactly the locked production graph in its
private, writable staging directory with
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, verifies it with
`npm ls --omit=dev`, and seals the finished release root-owned and non-writable before it can be
selected. Never make a release tree writable by `wownerogue`. Online advisory lookup is a separate,
explicitly authorized source-review operation; never run `npm audit fix` in staging or on a live
release.

---

## Set File Permissions

```bash
# Releases and selector are immutable to the service identity.
sudo chown root:wownerogue /var/www/wownerogue /var/www/wownerogue/releases
sudo chmod 0750 /var/www/wownerogue /var/www/wownerogue/releases
sudo chmod 0640 /etc/wownerogue/app.env
```

Do not use recursive ownership changes on `/var/www/wownerogue`; they can hand the service process
write access to immutable code or the rollback selector. The fleet activation role verifies every
individual release's ownership and modes before activation.

**Database ownership.** The application runs its own migrations at startup, so its database role
must own the database and schema, or otherwise retain DDL rights. Create it this way:

```sql
-- Create role with minimal privileges
CREATE USER wownerogue WITH PASSWORD 'secure-password-here';
CREATE DATABASE wownerogue OWNER wownerogue;
```

Do not revoke schema `CREATE` from this role while application startup owns migration execution;
that makes a fresh release fail partway through startup.

---

## Database Setup

### Run Migrations

Migrations in `src/migrations` run automatically at startup in filename order. Each file is applied
and recorded in the `schema_migrations` ledger inside one transaction, so a migration can never be
applied but unrecorded. Do not apply migration files directly with `psql`: bypassing the ledger
makes startup attempt them again.

Before a release, take a restricted PostgreSQL backup and test the complete migration set against a
restored copy of each production database using the fail-closed
[disposable clone migration gate](CLONE_MIGRATIONS.md).

The migration ledger does not prove that rows predating a `NOT VALID` constraint are clean. Run the
read-only historical audit and the rollback-only native validation proof described in
[FINANCIAL_CONSTRAINT_VALIDATION.md](FINANCIAL_CONSTRAINT_VALIDATION.md) for each restored database.
The native `VALIDATE CONSTRAINT` gate refuses live database names.

If the Wownero mainnet service will export accounting events, review and configure the durable
[financial-event outbox](FINANCIAL_EVENT_EXPORT.md) before cutover. Monero stagenet export stays
unset: those no-value test events are marked ignored locally.

### Backups

Install `wowngeon-db-backup.sh`, `.service`, and `.timer` through the hash-pinned fleet operations
change rather than from the runtime artifact, create `/var/backups/wowngeon/daily` as
`postgres:postgres` mode `0700`, then enable the timer.

Each run writes custom-format dumps atomically, verifies their catalogs with `pg_restore --list`,
chmods them `0600`, and records a SHA-256 sidecar. The script refuses any backup root other than
`/var/backups/wowngeon/daily` and refuses a missing root or a symlink.

Dumps and sidecars older than `BACKUP_RETENTION_DAYS` (default 14) are deleted, and interrupted
temporary files older than one day are cleaned up. This bounds a same-disk directory so it cannot
fill `/`; it is an operational convenience, not the retention archive. Long-horizon history belongs
in a separate, independently encrypted offsite vault configured according to the operator's recovery
policy.

### Database Reset (Development Only)

```bash
npm run db:drop    # Drop all tables
npm run db:create  # Recreate schema
```

---

## systemd Service

Install application, wallet, backup, and firewall units only through the hash-pinned fleet
operations change; the runtime artifact has no service units. Application units read secrets from
`/etc/wownerogue/app.env` or `/etc/monerogue/app.env` plus the narrow wallet-RPC environment, never
from an immutable release directory. They run `scripts/preflight.js` as `ExecStartPre` before every
start and use `/var/www/<instance>/current/src` as the working directory, so rollback is an atomic
symlink switch.

For the two Such Software services, do not replace this boundary with manual `install`, `systemctl`,
or symlink commands. Follow the default-closed wallet candidate and promotion, candidate validation,
and one-instance activation procedures in [DEPLOY_INSTANCES.md](DEPLOY_INSTANCES.md) and the
hash-pinned `such-fleet/RUNBOOK-wowngeon.md`. Independent MIT operators design and review their own
equivalent control plane.

The reviewed units drop the ambient environment with a broad `UnsetEnvironment` list (loader,
proxy, `PG*`, and `npm_config_*` variables among others) and apply these systemd hardening options:

- `NoNewPrivileges` prevents privilege escalation
- `ProtectSystem=strict` mounts the filesystem read-only except allowed paths
- `ProtectHome=yes` hides `/home`, `/root`, and `/run/user`
- `PrivateTmp=yes` isolates `/tmp`
- `CapabilityBoundingSet=` and `AmbientCapabilities=` remove all capabilities
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` and `SystemCallArchitectures=native` narrow the
  kernel surface
- `ReadWritePaths` whitelists the wallet state directory in wallet-RPC units

---

## Reverse Proxy (Nginx Proxy Manager)

If using Nginx Proxy Manager:

1. **Add Proxy Host**
   - Domain Names: `yourdomain.com`
   - Scheme: `http`
   - Forward Hostname/IP: your server's LAN IP (for example `192.168.1.100`)
   - Forward Port: `3000`
   - Enable the "Websockets Support" toggle

2. **SSL Tab**
   - Request a new SSL certificate
   - Enable "Force SSL"

3. **Advanced Tab**: paste this config for WebSocket support:

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

Record the proxy's fixed source address in `/etc/wowngeon/firewall.env` as
`NPM_SOURCE_IPV4=<address>`. `wowngeon-firewall.sh` rejects every non-loopback TCP connection to
ports 3000 and 3001 that does not originate from that address. Because direct access is rejected,
the single-hop `TRUST_PROXY_HOPS=1` setting is safe. The application clamps `TRUST_PROXY_HOPS` to
the range 1 through 8.

---

## Browser Asset Origin

Three.js is an exact production dependency and is served from the application origin at
`/vendor/three/<version>`, with the version embedded in the URL so an immutable cache cannot survive
an upgrade to different bytes. `RENDERER_CDN_ENABLED` defaults to `false`, which keeps the CSP from
granting third-party CDN scripts the same privileges as the game and payment UI. Setting it to
`true` in production logs a warning and widens `script-src` and `connect-src` to jsDelivr.

Generated 3D avatar models under `html/assets/generated/` are gitignored and are not part of the
release artifact. Provision them separately on any instance that offers the 3D renderer.

---

## Updating the Deployment

Run the full suite from the clean source commit, then build and verify the runtime artifact using
[RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md). Use the fleet blob-staging playbook, then proceed only
through the hash-pinned `wowngeon_release_activate` role after its clone, wallet, accounting, drain,
predecessor, and receipt gates pass. That role, not an application service identity or a manual
shell session, builds a new immutable `/var/www/<instance>/releases/<release-id>`, installs the
locked graph, verifies the clone and preflight evidence, seals ownership, and atomically selects
`current`.

Never run `git pull`, `npm install`, or `npm audit fix` inside the active release. Keep the previous
release and database backup until the new version has passed public health, WebSocket,
payment-intake, and (stagenet only) payout smoke tests.

---

## Multi-Instance Deployment

To run multiple instances, for example Wownero on port 3000 and Monero stagenet on port 3001:

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

Install the hash-pinned fleet copy of `monerogue.service`; it is absent from the runtime artifact.
Do not hand-maintain a second, weaker unit. The reviewed template carries the same preflight,
graceful-stop, immutable-release path, and systemd sandbox as the mainnet service.

---

## Daemon Redundancy and Graceful Degradation

`RPC_ENDPOINTS` takes any number of daemons, comma or whitespace separated, in **preference order**:

```
RPC_ENDPOINTS=http://127.0.0.1:34568,http://192.0.2.40:34568,http://192.0.2.41:34568
```

`PRIMARY_RPC_ENDPOINT` and `FALLBACK_RPC_ENDPOINT` remain supported and are appended to an explicit
list. When no list is given, primary (or `http://127.0.0.1:34568`) and fallback form the list on
their own. The result is deduplicated, so a stock configuration that points primary and fallback at
the same host yields exactly one node and no redundancy. Add at least one genuinely separate daemon
before relying on failover.

Behaviour:

- one logical RPC call tries **every** configured node before it fails;
- each node must pass the same chain-identity check before it may answer, so failover cannot
  silently serve a different chain's data;
- after failing over, the preferred node is re-tested every `RPC_PREFERRED_RETRY_MS` (default
  60000, minimum 1000), so recovery does not need a restart;
- when **no** node answers, the service reports unhealthy and throws. `getBlockCountStrict()`, used
  by match fairness and seeding, never substitutes a cached height.

**Entries are refused while no node is reachable.** A run's lifetime is counted in blocks and its
entry block comes from the last successful poll, so a game admitted during an outage is anchored to
an already-past block and is killed as a timeout on the first recovered poll. The player receives a
`chain_unavailable` event reading `Can't reach a <CHAIN> node right now, so entries are paused.
Nothing was charged`, and nothing is charged: the gate runs before any spend, so credits are not
consumed. The gate fires only when the chain health check explicitly reports false, so simulated
blocks and runtimes without the probe are unaffected.

**The wallet is deliberately not failed over.** Two `wallet-rpc` processes serving one wallet file
can build transactions from the same outputs and corrupt the wallet cache, so a standby wallet is a
custody decision for the operator rather than something the application may take on its own.
Daemons are read-only and interchangeable; wallets are neither. When the wallet is unreachable the
server declines paid intake with a `payment_unavailable` event reading `Payments are temporarily
unavailable`, and credits and free play keep working.

---

## Wallet Output Management

Wownero and Monero lock change outputs for several blocks after spending. If the wallet holds one
large output and multiple payouts fire in quick succession, the second payout fails because the
change output from the first is still locked.

The remedy is to pre-split wallet outputs into many smaller ones. `scripts/splitOutputs.js` is an
operator tool in the source repository, not part of the release artifact; run it from a source
checkout whose `src/.env` points at the wallet RPC.

```bash
# Show the current output breakdown, including locked and unlocked status
node scripts/splitOutputs.js --status

# Split into 30 outputs of 10 WOW each (requires 300+ WOW unlocked, plus fees)
node scripts/splitOutputs.js --amount 10 --count 30
```

Defaults are 10 WOW and 20 outputs; `--endpoint` overrides `PRIMARY_WALLET_ENDPOINT`. Thirty
independently spendable outputs allow up to thirty concurrent payouts before output locking becomes
an issue.

**When to re-split.** Outputs are consumed and consolidated back into change as payouts go out.
Check the wallet with `--status` periodically and re-split when the number of spendable outputs
drops low. The server also debounces payouts by 5 seconds so wins landing close together are batched
into one transfer, which conserves outputs. A slower interval sweep
(`payouts.processing.batchInterval`, default 300 seconds) picks up anything left pending.

For typical traffic, 20 to 30 outputs of 10 WOW each provides good concurrency headroom.

---

## Monitoring

### Check Service Status

```bash
systemctl status wownerogue
journalctl -u wownerogue -f  # Follow logs
```

### Health Endpoints

```bash
curl http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
```

`/health/live` reports process liveness only. `/health` returns the full public snapshot, and
`/health/ready` returns the same body with HTTP 503 until PostgreSQL, the chain daemon, and (for
paid instances) wallet RPC are ready. All three send `Cache-Control: no-store`.

Public probes omit wallet balances, RPC addresses, secrets, memory details, and abuse thresholds;
those remain in the authenticated admin stats endpoints. An optional accounting sink is reported as
sanitized informational data and never makes gameplay readiness fail.

### Admin Dashboard

The admin page is served at `/admin` and `/admin.html`. Admin API endpoints require an `X-Admin-Key`
header matching `ADMIN_API_KEY`, and return 503 when that variable is unset. The dashboard covers:

- Wallet balance and connection status
- Pending and failed payouts
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

Preflight validates operator configuration without connecting to PostgreSQL or either RPC. It
catches missing secrets, ambiguous payout flags, simulated blocks in production, missing wallet or
daemon endpoints, and operated-profile scope drift.

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

Migrations are tracked by filename to prevent duplicate execution.
