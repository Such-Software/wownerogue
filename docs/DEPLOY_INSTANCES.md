# Two-instance deployment runbook

Two independent instances of the same secured codebase, behind Nginx Proxy Manager (NPM):

| Instance | Domain | Port | Network | Money | Payouts | Leaderboards |
|----------|--------|------|---------|-------|---------|--------------|
| **wownerogue** (existing) | play.wowne.ro | 3000 | Wownero **mainnet** | purchased service credits | **OFF, always** | Pleb + paid prestige |
| **monerogue** (new) | monerogue.app | 3001 | Monero **stagenet only** | test coins — **NO REAL VALUE** | **ON for 2×/3× solo only (target; wallet-gated)** | Pleb + Hall of Champions |

Such Software (`apps@such.software`) operates only these two domains and these exact scopes.
`play.wowne.ro` is pay-for-credits prestige with no prize/payout/cash-out and is not marketed as
gambling; legal classification depends on applicable law. `monerogue.app` is a conspicuous
no-real-value test gambling surface; never send mainnet XMR and never enable crypto-match payouts.
Stagenet payouts are a technical test surface, not authorization to offer real-money wagering.
`ALLOW_MAINNET_PAYOUTS=true` is only an engineering interlock; obtain jurisdiction-specific legal,
age/access-control, responsible-play, and operational review before attaching redeemable value.

NPM already forwards both domains to these ports + handles TLS — no reverse-proxy work here.

> ⚠️ This is an operator runbook, not a record of actions already executed. Deploy only a reviewed,
> tagged release after the full test suite and both preflights pass.

---

## Step 0 — Stage an immutable reviewed release

Build and verify one runtime artifact using [RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md), then
transfer only that blob into a new root-owned mode-0700 candidate inbox. Compare the host's SHA-256
with the independently recorded literal digest; the transferred sidecar is not an independent
provenance source.

Such Software production uses only the separate, default-closed fleet playbooks for inert blob
staging, two-dump clone validation, wallet candidate preparation/promotion, and one-instance release
activation. Each operation is bound to literal hashes and exact receipts; none infers a release,
dump, wallet, predecessor, or instance. Do not substitute manual extraction under
`/var/www/<instance>/releases`, dependency installation, service commands, or a hand-written
`current` switch. Never make a release directory writable by either application service identity.

---

## Step 1 — Reconfigure MAINNET: free + purchased-credit prestige, NO payouts

Install the reviewed source profile `src/.env.mainnet.example` as `/etc/wownerogue/app.env` (mode
0640, `root:wownerogue`), replace every placeholder, and review these money gates. Environment
examples are intentionally not present in the runtime artifact; provision this file through the
hash-pinned fleet/source change, never from the application release directory.

```ini
OPERATED_PRODUCT_PROFILE=such-play-wow-prestige
OPERATOR_NAME=Such Software
OPERATOR_CONTACT_URL=mailto:apps@such.software
OPERATOR_CONTACT_LABEL=apps@such.software
FREE_PLAY_ENABLED=true            # offer free play as a choice (Pleb board)
PAYMENT_MODES=credits             # only purchased-credit prestige is operated here
DIRECT_PAYMENT_ENABLED=false      # per-run payment is outside the operated scope
CREDITS_ENABLED=true
PAYOUTS_ENABLED=false             # no crypto leaves the house wallet
DIRECT_PAYOUTS_ENABLED=false
CREDITS_PAYOUTS_ENABLED=false
DIRECT_REQUIRES_ADDRESS=false     # no payout = no payout address needed
CREDITS_REQUIRES_ADDRESS=false
TRUST_PROXY=true
TRUST_PROXY_HOPS=1                # exactly one NPM hop
```

Players buy non-redeemable credits for leaderboard/prestige play; free players use the Pleb board.
This operated product offers no winnings, payouts, or cash-out and is not offered or marketed as
gambling. Classification depends on applicable law; this documentation is not legal advice or a
jurisdiction-specific compliance approval.

The following are post-activation verification commands, not authorization to restart the live
service while the wallet/preflight and fleet activation gates remain open:

```bash
sudo systemctl restart wownerogue.service
journalctl -u wownerogue.service -n 50 --no-pager   # verify: "Payment system: ENABLED", payouts disabled
curl -s localhost:3000/api/game-modes | jq '{freePlayEnabled, PAID_SINGLE, PAID_CREDITS}'
```

**MAINNET WALLET NO-GO:** this application release does not authorize changing, copying, stopping,
or replacing the Wownero wallet, its key file, password, unit, or RPC authentication. Keep payouts
off. A later wallet change requires independently recoverable keyfile/password and mnemonic custody,
an off-host recovery proof, an isolated rehearsal, exact address/balance verification, and a
separately reviewed maintenance/rollback plan. Root-level wallet templates are operations source,
not files in the runtime artifact and not approval to install them.

---

## Step 2 — Prove and promote the MONERO STAGENET wallet boundary

Wallet work is a separate custody operation from application release work. Use only the reviewed
`wowngeon_wallet_candidate` and `wowngeon_wallet_promote` roles from a clean, hash-pinned fleet
revision, select exactly `monerogue`, and preserve every generic receipt. Candidate preparation
must prove the fixed encrypted stagenet snapshot reopens the exact live address, has a spend key,
and enforces the application's strong Digest credentials before it publishes inert dedicated-user
material. Promotion must then stop only the selected legacy wallet, install only the reviewed
loopback-only unit, require unauthenticated `401` plus authenticated address/network/balance probes,
and automatically roll back to the exact legacy unit on a failed gate.

The earlier non-mutating design record is
[`README-monero-stagenet-parallel-candidate.md`](../scripts/deploy/README-monero-stagenet-parallel-candidate.md).
It is not an installation procedure and its sample unit is not a promotion artifact.

Neither wallet role reads, exports, or proves a mnemonic. A passing keyfile/password proof is not
independent seed custody or a full off-host recovery drill. Record those separately as unproven
until a human-controlled custody inventory and isolated off-host restore establish them. This gap
does not authorize weakening a proof, printing a secret, or applying either role to the funded
Wownero mainnet wallet. Wownero wallet promotion and the corresponding application activation
remain blocked pending that separate review.

## Step 3 — Create the monerogue identity, immutable layout, and DB

```bash
sudo useradd --system --home /var/www/monerogue --no-create-home --shell /usr/sbin/nologin monerogue
sudo install -d -m 0750 -o root -g monerogue /var/www/monerogue
sudo install -d -m 0750 -o root -g monerogue /var/www/monerogue/releases
sudo install -d -m 0750 -o root -g monerogue /etc/monerogue

sudo -u postgres createuser --pwprompt monerogue
sudo -u postgres createdb --owner=monerogue --template=template0 monerogue
```

The service identity owns its database role, not its application files. Do not clone source onto
the production host or recursively `chown` `/var/www/monerogue` to the service user.

## Step 4 — The monerogue `.env`

This is the exact no-real-value stagenet test profile. Apply its non-secret policy keys through the
fleet runtime-policy role; do not overwrite or log the protected environment. Keep
`/etc/monerogue/app.env` as `root:monerogue` mode `0640`. Amounts are XMR atomic units
(1 XMR = 1e12):

```ini
NODE_ENV=production
PORT=3001
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
OPERATED_PRODUCT_PROFILE=such-monerogue-stagenet
OPERATOR_NAME=Such Software
OPERATOR_CONTACT_URL=mailto:apps@such.software
OPERATOR_CONTACT_LABEL=apps@such.software
CRYPTO_TYPE=XMR
MONERO_NETWORK=stagenet
HOSTED_BY=https://monerogue.app
DIFFICULTY_PRESET=casino

# NO REAL VALUE: test coins only. Never send mainnet XMR.

# --- payments + free play ---
PAYMENTS_ENABLED=true
PAYMENT_MODES=direct
FREE_PLAY_ENABLED=true            # free and direct solo boards available

# --- direct (pay per game) WITH payouts (fake stagenet money) ---
DIRECT_PAYMENT_ENABLED=true
DIRECT_GAME_PRICE=10000000000     # 0.01 XMR
DIRECT_REQUIRES_ADDRESS=true
DIRECT_PAYOUTS_ENABLED=true
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0

# --- purchased credits are outside the operated Monerogue profile ---
CREDITS_ENABLED=false
CREDITS_PER_GAME=1
CREDITS_REQUIRES_ADDRESS=false
CREDITS_PAYOUTS_ENABLED=false
# Inert compatibility values; no credit purchase or credit payout path may expose them.
CREDITS_PAYOUT_BASE=10000000000
CREDITS_PAYOUT_ESCAPE=2.0
CREDITS_PAYOUT_TREASURE=3.0
CREDITS_PACKAGES=[{"id":"small","credits":10,"price":"90000000000","bonus":0},{"id":"medium","credits":20,"price":"170000000000","bonus":2}]
ALLOW_MIXED_MODE=false
PREFER_CREDITS_FIRST=false

# --- payouts --- (verify the unlocked stagenet bankroll before every rollout)
PAYOUTS_ENABLED=true
ALLOW_MAINNET_PAYOUTS=false
PAYOUT_MIN_AMOUNT=1000000000        # 0.001 XMR
PAYOUT_MAX_PER_GAME=50000000000     # 0.05 XMR safety cap (real max is 3x*0.01 = 0.03)
PAYOUT_BATCH_INTERVAL=300
PAYOUT_MAX_RETRIES=3
BALANCE_WARN=100000000000            # warn below 0.10 XMR unlocked
BALANCE_CRITICAL=50000000000         # stop accepting new payout liability below 0.05 XMR
# Tip: lower DIRECT_GAME_PRICE to 0.001 XMR (1000000000) for many more demo plays per the
# small bankroll; refill from a stagenet faucet as needed.

# --- wallet RPC (monero stagenet) ---
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:38083

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

# --- PvP financial boundary: free/prestige rulesets may evolve, crypto payouts may not ---
MATCH_CRYPTO_RACE_ENABLED=false
MATCH_PAYOUTS_ENABLED=false
```

The application unit separately requires `/etc/monerogue/wallet-rpc.env`, owned
`root:monerogue` mode `0640`, containing only `WALLET_RPC_USER` and `WALLET_RPC_PASSWORD`. Provision
it only through the reviewed wallet-candidate workflow. Never place either
password in a command argument, unit `ExecStart`, shell history, or this runbook.

Production startup proves that wallet RPC actually enforces Digest authentication: an intentional
unauthenticated, read-only probe must receive a usable `401` Digest challenge before the
authenticated identity probe is accepted. Merely setting application credentials is insufficient;
a wallet RPC that still accepts the unauthenticated request makes preflight/readiness fail closed.

```bash
sudo chmod 0640 /etc/monerogue/app.env
sudo chown root:monerogue /etc/monerogue/app.env
cd /var/www/monerogue/releases/<reviewed-release-id>/src
sudo -u monerogue bash -c 'set -a; . /etc/monerogue/app.env; . /etc/monerogue/wallet-rpc.env; set +a; npm run preflight'
```

## Step 5 — Install + start the monerogue instance

The runtime artifact contains no service units. Promote the wallet and activate `monerogue` only
through the separately reviewed, hash-pinned `~/src/such-fleet` roles after the recovery,
clone-validation, protected-environment, wallet, drain, and financial-audit gates pass. Do not copy
a unit from the application release.

Install the hash-pinned fleet copies of `wowngeon-firewall.sh` and
`wowngeon-firewall.service`, then set the fixed proxy source as `NPM_SOURCE_IPV4=<address>` in
`/etc/wowngeon/firewall.env`. Verify direct access to ports 3000/3001 is rejected while both
domains, websocket upgrades, and local readiness probes still work.

## Step 6 — Verify end to end

- `monerogue.app` loads; `play.wowne.ro` still healthy.
- After wallet promotion and the separately approved bounded canary: buy credits / pay entry with a
  stagenet wallet → game starts → qualifying solo outcome → 2×/3× test-coin payout arrives.
- After the corresponding gates clear, both boards populate: free game → Pleb, paid game → Hall of
  Champions, on each instance.
- Mainnet, only after its separate recovery gate and release: confirm purchased-credit play never
  creates a payout or cash-out path.

---

## Rollback

- Stop only the affected instance, atomically repoint `/var/www/<instance>/current` to the previous
  immutable release, and restart it. Keep the pre-deploy database backup for an operator-reviewed
  restore if a data rollback is required.
- Never overwrite either legacy dirty checkout; preserve it until the new release has passed its soak.
