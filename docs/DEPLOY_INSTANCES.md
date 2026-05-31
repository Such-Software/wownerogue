# Two-instance deployment runbook

Two independent instances of the same secured codebase, behind Nginx Proxy Manager (NPM):

| Instance | Domain | Port | Network | Money | Payouts | Leaderboards |
|----------|--------|------|---------|-------|---------|--------------|
| **wownerogue** (existing) | play.wowne.ro | 3000 | Wownero **mainnet** | real WOW | **OFF** | Pleb + Hall of Champions |
| **monerogue** (new) | monerogue.app | 3001 | Monero **stagenet** | fake XMR | **ON** | Pleb + Hall of Champions |

NPM already forwards both domains to these ports + handles TLS — no reverse-proxy work here.

> ⚠️ Nothing below has been executed. Run only after review. Step 0 is the urgent one
> (the live mainnet instance still runs pre-fix code with the underpayment exploit + payouts).

Server facts (verified): root+sudo; `monerod --stagenet` RPC on `127.0.0.1:38081`;
`monero-wallet-rpc` at `/usr/bin`; stagenet wallet `…/monero-…-v0.18.4.4/test(.keys)`;
Postgres has `wownerogue`,`wowrace`; ports `3001` and `38083` free; code at
`/var/www/wownerogue/app` on branch `main` (commit 82fdcc0).

---

## Step 0 — Get the secured branch onto the server

```bash
# Local: push the remediation branch (or merge to main first)
git push origin security/phase-0-critical-fixes

# Server (mainnet instance):
sudo -u wownerogue git -C /var/www/wownerogue/app fetch origin
sudo -u wownerogue git -C /var/www/wownerogue/app checkout security/phase-0-critical-fixes
cd /var/www/wownerogue/app/src && sudo -u wownerogue npm ci
# Migrations run automatically on boot; or apply manually with the app's runner.
```

---

## Step 1 — Reconfigure the MAINNET instance: free-to-play, NO payouts

Edit `/var/www/wownerogue/app/src/.env` — change these keys (keep everything else):

```ini
FREE_PLAY_ENABLED=true            # offer free play as a choice (Pleb board)
PAYOUTS_ENABLED=false             # no crypto leaves the house wallet
DIRECT_PAYOUTS_ENABLED=false
CREDITS_PAYOUTS_ENABLED=false
DIRECT_REQUIRES_ADDRESS=false     # no payout = no payout address needed
CREDITS_REQUIRES_ADDRESS=false
TRUST_PROXY=true                  # we are behind NPM; read real client IP from X-Forwarded-For
```

Players still buy credits / pay entry (→ Hall of Champions prestige); free players → Pleb
board. No payouts = not gambling.

```bash
sudo systemctl restart wownerogue.service
journalctl -u wownerogue.service -n 50 --no-pager   # verify: "Payment system: ENABLED", payouts disabled
curl -s localhost:3000/api/game-modes | jq '{freePlayEnabled, PAID_SINGLE:.PAID_SINGLE.payoutMultiplier}'
```

---

## Step 2 — Stand up the MONERO STAGENET wallet-rpc

```bash
sudo cp scripts/deploy/monero-wallet-rpc.service /etc/systemd/system/
sudoedit /etc/systemd/system/monero-wallet-rpc.service   # set REPLACE_WITH_WALLET_PASSWORD
sudo systemctl daemon-reload
sudo systemctl enable --now monero-wallet-rpc.service
sudo systemctl status monero-wallet-rpc.service --no-pager
# sanity: wallet answers + is the stagenet wallet that holds the coins
curl -s http://127.0.0.1:38083/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_balance"}' -H 'Content-Type: application/json'
```

> Needs the wallet password (not in the repo). Confirm `…/v0.18.4.4/test` is the stagenet
> wallet with the coins, or point `--wallet-file` at the right one.

## Step 3 — Create the monerogue user, code checkout, and DB

```bash
sudo useradd --system --home /var/www/monerogue --shell /usr/sbin/nologin monerogue
sudo mkdir -p /var/www/monerogue && sudo chown monerogue:monerogue /var/www/monerogue
sudo -u monerogue git clone git@github.com:jwinterm/wownerogue.git /var/www/monerogue/app
sudo -u monerogue git -C /var/www/monerogue/app checkout security/phase-0-critical-fixes
cd /var/www/monerogue/app/src && sudo -u monerogue npm ci

sudo -u postgres createdb monerogue
sudo -u postgres psql -c "CREATE USER monerogue WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE monerogue TO monerogue;"
```

## Step 4 — The monerogue `.env`

Write `/var/www/monerogue/app/src/.env` (owned by `monerogue`, `chmod 600`). Stagenet/fake
money, so payouts are fine. Amounts are XMR atomic units (1 XMR = 1e12):

```ini
NODE_ENV=production
PORT=3001
TRUST_PROXY=true
CRYPTO_TYPE=XMR
MONERO_NETWORK=stagenet
HOSTED_BY=https://monerogue.app
DIFFICULTY_PRESET=casino

# --- payments + free play ---
PAYMENTS_ENABLED=true
PAYMENT_MODES=direct,credits
FREE_PLAY_ENABLED=true            # both boards available

# --- direct (pay per game) WITH payouts (fake stagenet money) ---
DIRECT_PAYMENT_ENABLED=true
DIRECT_GAME_PRICE=10000000000     # 0.01 XMR
DIRECT_REQUIRES_ADDRESS=true
DIRECT_PAYOUTS_ENABLED=true
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# --- credits WITH payouts ---
CREDITS_ENABLED=true
CREDITS_PER_GAME=1
CREDITS_REQUIRES_ADDRESS=true
CREDITS_PAYOUTS_ENABLED=true
CREDITS_PAYOUT_BASE=10000000000
CREDITS_PAYOUT_ESCAPE=2.0
CREDITS_PAYOUT_TREASURE=3.0
CREDITS_PACKAGES=[{"id":"small","credits":10,"price":"90000000000","bonus":0},{"id":"medium","credits":20,"price":"170000000000","bonus":2}]
ALLOW_MIXED_MODE=true
PREFER_CREDITS_FIRST=true

# --- payouts --- (bankroll: ~0.3797 sXMR in the "test" wallet)
PAYOUTS_ENABLED=true
PAYOUT_MIN_AMOUNT=1000000000        # 0.001 XMR
PAYOUT_MAX_PER_GAME=50000000000     # 0.05 XMR safety cap (real max is 3x*0.01 = 0.03)
PAYOUT_BATCH_INTERVAL=300
PAYOUT_MAX_RETRIES=3
LOW_BALANCE_THRESHOLD=50000000000   # alert/halt when unlocked balance drops below 0.05 XMR
# Tip: lower DIRECT_GAME_PRICE/CREDITS_PAYOUT_BASE to 0.001 XMR (1000000000) for many more
# demo plays per the small bankroll; refill from a stagenet faucet as needed.

# --- wallet RPC (monero stagenet) ---
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:38083
# wallet-rpc started with --disable-rpc-login, so no WALLET_RPC_USER/PASSWORD

# --- daemon RPC (monerod stagenet) ---
PRIMARY_RPC_ENDPOINT=http://127.0.0.1:38081
FALLBACK_RPC_ENDPOINT=http://127.0.0.1:38081
RPC_POLL_INTERVAL=2000

# --- database ---
DB_HOST=localhost
DB_PORT=5432
DB_NAME=monerogue
DB_USER=monerogue
DB_PASSWORD=CHANGE_ME

# --- admin ---
ADMIN_API_KEY=GENERATE_WITH_openssl_rand_hex_32

# --- smirk: disable for monero stagenet (Smirk doesn't support stagenet) ---
SMIRK_ENABLED=false
```

```bash
sudo chmod 600 /var/www/monerogue/app/src/.env
sudo chown monerogue:monerogue /var/www/monerogue/app/src/.env
```

## Step 5 — Install + start the monerogue instance

```bash
sudo cp scripts/deploy/monerogue.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monerogue.service
journalctl -u monerogue.service -n 60 --no-pager     # expect: listening on :3001, payments ENABLED
curl -s localhost:3001/health | jq '{network:.network, wallet:.wallet.status, mode:.gameMode}'
```

## Step 6 — Verify end to end

- `monerogue.app` loads; `play.wowne.ro` still healthy.
- Stagenet: buy credits / pay entry with a stagenet wallet → game starts → win → payout
  arrives (this is the real `wownero-wallet-rpc`/`monero-wallet-rpc` integration test that
  TODO.md has always wanted — now on fake money).
- Both boards populate: free game → Pleb, paid game → Hall of Champions, on each instance.
- Mainnet: confirm a winning paid game does NOT send a payout (no crypto out).

---

## Rollback

- `sudo systemctl stop monerogue monero-wallet-rpc` (stagenet instance is independent; stopping it can't affect mainnet).
- Mainnet: `git checkout main && systemctl restart wownerogue` to revert the reconfig.
