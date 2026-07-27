# Two-instance deployment runbook

Two independent instances of the same codebase run behind Nginx Proxy Manager (NPM), each with its
own service identity, database, environment file, wallet, and chain.

| Instance | Domain | Port | Chain | Entry | Payouts | Leaderboards |
|----------|--------|------|-------|-------|---------|--------------|
| `wownerogue` | play.wowne.ro | 3000 | Wownero mainnet | free play and purchased service credits | disabled | Pleb and paid prestige |
| `monerogue` | monerogue.app | 3001 | Monero stagenet | free play and direct test-coin entry | enabled, direct solo only | Pleb and Hall of Champions |

NPM forwards both domains to these ports and terminates TLS, so this runbook contains no
reverse-proxy configuration.

## Scope and legal boundary

Such Software operates only these two domains, and only within the scopes encoded in
`src/config/operatedProductProfiles.js`.

`play.wowne.ro` sells non-redeemable service credits for leaderboard and prestige play. It offers no
prize, payout, or cash-out and is not offered or marketed as gambling. Classification depends on
applicable law.

`monerogue.app` is a no-real-value test surface. Its coins are Monero stagenet test data, not money.
Never send mainnet XMR to it, and never enable crypto-match payouts on it. A stagenet payout path is
a technical test surface, not authorization to offer real-money wagering.

`ALLOW_MAINNET_PAYOUTS=true` is an engineering interlock only. Attaching redeemable value requires
jurisdiction-specific legal review, age and access controls, responsible-play measures, and an
operational review that this document does not provide. This documentation is not legal advice.

Independent MIT deployments leave `OPERATED_PRODUCT_PROFILE` unset and are not constrained by any of
the product decisions above.

## Prerequisites

- A reviewed, tagged commit with the full test suite passing.
- A release artifact built and verified per [RELEASE_ARTIFACT.md](./RELEASE_ARTIFACT.md).
- A passing `npm run preflight` for each instance's environment file.
- A pre-deploy database backup for each instance (see [LOGS_AND_BACKUP.md](./LOGS_AND_BACKUP.md)).

## Operated product profile contracts

When `OPERATED_PRODUCT_PROFILE` is set, `validateOperatedProductProfile()` runs during preflight and
normal startup and rejects any network, identity, or economic-scope drift. Both profiles require:

| Setting | Required value |
|---------|----------------|
| `OPERATOR_NAME` | `Such Software` |
| `OPERATOR_CONTACT_URL` | `mailto:apps@such.software` |
| `OPERATOR_CONTACT_LABEL` | `apps@such.software` |
| `HOSTED_BY` | the profile's exact `https://` public root |
| `LEGAL_POLICY_VERSION`, `TERMS_EFFECTIVE_DATE` | the profile's exact values |
| `PAYMENTS_ENABLED`, `FREE_PLAY_ENABLED`, `PAID_ACKNOWLEDGEMENT_REQUIRED` | `true` |
| `SOLO_ENABLED`, `TAVERN_ENABLED`, `MATCH_ENABLED` | `true` |
| `MATCH_CRYPTO_RACE_ENABLED`, `MATCH_PAYOUTS_ENABLED` | `false` |
| `ALLOW_MAINNET_PAYOUTS` | `false` |
| products | no standalone cosmetic products, and no `grants` key on a credit package |

Per profile:

| Setting | `such-play-wow-prestige` | `such-monerogue-stagenet` |
|---------|--------------------------|---------------------------|
| `CRYPTO_TYPE` / `MONERO_NETWORK` | `WOW` / `mainnet` | `XMR` / `stagenet` |
| `GAME_MODE` | `PAID_CREDITS` | `PAID_SINGLE` |
| `PAYMENT_MODES` | `credits` | `direct` |
| `DIRECT_PAYMENT_ENABLED` | `false` | `true` |
| `CREDITS_ENABLED` | `true` | `false` |
| `PAYOUTS_ENABLED` | `false` | `true` |
| `DIRECT_PAYOUTS_ENABLED` | `false` | `true` |
| `CREDITS_PAYOUTS_ENABLED` | `false` | `false` |
| `DIRECT_PAYOUT_ESCAPE` / `DIRECT_PAYOUT_TREASURE` | not applicable | exactly `2.0` / `3.0` |

The profile also controls what `/api/game-modes` publishes: `selectPublicPaidModeDescriptors()`
emits only the profile's own paid mode, so a Wownero instance never advertises `PAID_SINGLE` and a
Monerogue instance never advertises `PAID_CREDITS`.

## Step 0: Stage an immutable release

Build one runtime artifact, then transfer only that blob into a root-owned mode-0700 candidate
inbox. Compare the host's SHA-256 against an independently recorded digest; the sidecar file that
travelled with the blob is not an independent provenance source.

Blob staging, two-dump clone validation ([CLONE_MIGRATIONS.md](./CLONE_MIGRATIONS.md)), wallet
candidate preparation and promotion, and per-instance release activation are performed by the
separate, default-closed, hash-pinned fleet automation. Each operation is bound to literal hashes
and exact receipts and infers no release, dump, wallet, predecessor, or instance. Manual extraction
under `/var/www/<instance>/releases`, manual dependency installation, manual service commands, and a
hand-written `current` symlink switch are not supported substitutes. A release directory is never
writable by either application service identity.

The artifact contains only `LICENSE`, `html/**`, and the runtime subset of `src/**`. Environment
examples, tests, documentation, the balance simulator, and root-level operator tooling and service
units are excluded by construction, so none of them can be provisioned out of a release directory.

## Step 1: Configure the mainnet instance

Install `src/.env.mainnet.example` as `/etc/wownerogue/app.env`, mode 0640, owner `root:wownerogue`,
and replace every `CHANGE_ME` value. Provision this file through the hash-pinned fleet or source
change, never from the application release directory.

The decisive money gates for this instance:

```ini
OPERATED_PRODUCT_PROFILE=such-play-wow-prestige
GAME_MODE=PAID_CREDITS            # legacy/socket mode identity for the credits product
PAYMENT_MODES=credits
FREE_PLAY_ENABLED=true            # free play is a choice; free runs rank on the Pleb board
CREDITS_ENABLED=true
DIRECT_PAYMENT_ENABLED=false      # per-run payment is outside this product scope
PAYOUTS_ENABLED=false             # no crypto leaves the house wallet
DIRECT_PAYOUTS_ENABLED=false
CREDITS_PAYOUTS_ENABLED=false
DIRECT_REQUIRES_ADDRESS=false     # no payout means no payout address is collected
CREDITS_REQUIRES_ADDRESS=false
TRUST_PROXY=true
TRUST_PROXY_HOPS=1                # exactly one NPM hop
```

Amounts on this instance are WOW atomic units (1 WOW = 1e11).

Players buy non-redeemable credits for leaderboard and prestige play; free players use the Pleb
board. The product offers no winnings, payouts, or cash-out.

The Wownero wallet, its key file, password, systemd unit, and RPC credentials are outside the scope
of an application release. Changing any of them requires independently recoverable keyfile, password,
and mnemonic custody, an off-host recovery proof, an isolated rehearsal, exact address and balance
verification, and a separately reviewed maintenance and rollback plan. Root-level wallet templates in
`scripts/deploy/` are operations source, not runtime files and not an instruction to install them.

After activation, verify:

```bash
sudo systemctl restart wownerogue.service
journalctl -u wownerogue.service -n 50 --no-pager   # payment system enabled, payouts disabled
curl -fsS localhost:3000/api/game-modes \
  | jq -e '.FREE.enabled == true and .PAID_CREDITS.enabled == true and (has("PAID_SINGLE") | not)'
```

## Step 2: Prove the stagenet wallet boundary

Wallet work is a custody operation separate from application release work. It runs from a clean,
hash-pinned fleet revision against exactly one selected instance, and preserves every receipt.

Candidate preparation proves that the fixed encrypted stagenet snapshot reopens the exact live
address, has a spend key, and enforces strong Digest credentials, before it publishes inert
dedicated-user material. Promotion stops only the selected legacy wallet, installs only the reviewed
loopback-only unit, requires an unauthenticated `401` plus authenticated address, network, and
balance probes, and rolls back automatically to the exact legacy unit on a failed gate.

Neither operation reads, exports, or proves a mnemonic. A passing keyfile and password proof is not
independent seed custody and not an off-host recovery drill; record those separately until a
human-controlled custody inventory and an isolated off-host restore establish them. That gap is not a
reason to weaken a proof, print a secret, or apply the same workflow to the funded Wownero mainnet
wallet.

## Step 3: Create the monerogue identity, layout, and database

```bash
sudo useradd --system --home /var/www/monerogue --no-create-home --shell /usr/sbin/nologin monerogue
sudo install -d -m 0750 -o root -g monerogue /var/www/monerogue
sudo install -d -m 0750 -o root -g monerogue /var/www/monerogue/releases
sudo install -d -m 0750 -o root -g monerogue /etc/monerogue

sudo -u postgres createuser --pwprompt monerogue
sudo -u postgres createdb --owner=monerogue --template=template0 monerogue
```

The service identity owns its database role, not its application files. Do not clone source onto the
production host and do not recursively `chown` `/var/www/monerogue` to the service user.

## Step 4: Configure the monerogue instance

Install `src/.env.stagenet.example` as `/etc/monerogue/app.env`, mode 0640, owner `root:monerogue`.
Apply its non-secret policy keys through the fleet runtime-policy role; do not overwrite or log the
protected environment. Amounts are XMR atomic units (1 XMR = 1e12).

Host-specific values to set:

```ini
PORT=3001
PRIMARY_WALLET_ENDPOINT=http://127.0.0.1:38083   # monero-wallet-rpc, stagenet
PRIMARY_RPC_ENDPOINT=http://127.0.0.1:38081      # monerod, stagenet
FALLBACK_RPC_ENDPOINT=http://127.0.0.1:38081
DB_NAME=monerogue
DB_USER=monerogue
DB_PASSWORD=CHANGE_ME
ADMIN_API_KEY=GENERATE_WITH_openssl_rand_hex_32
SMIRK_ENABLED=false                              # Smirk does not support stagenet
```

Economy values, all in stagenet test coins with no real value:

```ini
DIRECT_GAME_PRICE=10000000000       # 0.01 XMR per run
DIRECT_PAYOUT_ESCAPE=2.0
DIRECT_PAYOUT_TREASURE=3.0
PAYOUT_MIN_AMOUNT=1000000000        # 0.001 XMR
PAYOUT_MAX_PER_GAME=50000000000     # 0.05 XMR cap; the reachable maximum is 3 x 0.01 = 0.03
PAYOUT_BATCH_INTERVAL=300
PAYOUT_MAX_RETRIES=3
BALANCE_WARN=100000000000           # warn below 0.10 XMR unlocked
BALANCE_CRITICAL=50000000000        # stop accepting new payout liability below 0.05 XMR
DIFFICULTY_PRESET=casino
```

Verify the unlocked stagenet bankroll before every rollout. Lowering `DIRECT_GAME_PRICE` to
`1000000000` (0.001 XMR) yields many more demo runs per faucet refill.

`CREDITS_PAYOUT_BASE`, `CREDITS_PAYOUT_ESCAPE`, `CREDITS_PAYOUT_TREASURE`, and `CREDITS_PACKAGES`
remain in the file as inert compatibility values. `CREDITS_ENABLED=false` and
`CREDITS_PAYOUTS_ENABLED=false` keep every credit purchase and credit payout path fail-closed, so
nothing exposes them.

The stagenet profile leaves `FINANCIAL_EVENT_SINK_URL` and `FINANCIAL_EVENT_SINK_TOKEN` blank.
Startup rejects a configured financial-event sink on a test network, because no-real-value events
must never reach a real accounting sink.

The service unit additionally requires `/etc/monerogue/wallet-rpc.env`, owner `root:monerogue`, mode
0640, containing only `WALLET_RPC_USER` and `WALLET_RPC_PASSWORD`. Provision it only through the
wallet-candidate workflow. Neither password belongs in a command argument, a unit `ExecStart`, shell
history, or this document.

Startup proves that wallet RPC actually enforces Digest authentication: a deliberate unauthenticated
`get_version` probe must receive a usable `401` Digest challenge before the authenticated identity
probe is accepted. Setting application credentials is not sufficient; a wallet RPC that still answers
the unauthenticated request fails readiness closed with `WALLET_RPC_AUTH_NOT_ENFORCED`.

```bash
sudo chmod 0640 /etc/monerogue/app.env
sudo chown root:monerogue /etc/monerogue/app.env
cd /var/www/monerogue/releases/<release-id>/src
sudo -u monerogue bash -c 'set -a; . /etc/monerogue/app.env; . /etc/monerogue/wallet-rpc.env; set +a; npm run preflight'
```

## Step 5: Activate the instance and close the network

The runtime artifact contains no service units. Wallet promotion and instance activation run through
the hash-pinned fleet roles after the recovery, clone-validation, protected-environment, wallet,
drain, and financial-audit gates pass. Do not copy a unit out of an application release.

Install the hash-pinned copies of `scripts/deploy/wowngeon-firewall.sh` (mode 0755 at
`/usr/local/sbin/wowngeon-firewall`) and `scripts/deploy/wowngeon-firewall.service`, then set the
fixed proxy address as `NPM_SOURCE_IPV4=<address>` in `/etc/wowngeon/firewall.env`. The script is
idempotent: it rejects any non-loopback traffic to ports 3000 and 3001 that does not come from that
address, and rejects all non-loopback traffic to the wallet and daemon JSON-RPC ports 34568, 34570,
38081, and 38083. Peer-to-peer ports are deliberately untouched.

Confirm afterwards that direct access to ports 3000 and 3001 is refused while both domains, their
websocket upgrades, and local readiness probes still work.

## Step 6: Verify end to end

- `monerogue.app` loads and `play.wowne.ro` stays healthy.
- Each public modes document contains only its own operated paid product: Wownero exposes
  `PAID_CREDITS` and no `PAID_SINGLE`; Monerogue exposes `PAID_SINGLE` and no `PAID_CREDITS`.
- On Monerogue, run the bounded canary described in
  [STAGENET_FINANCIAL_CANARY.md](./STAGENET_FINANCIAL_CANARY.md): pay entry from a stagenet wallet,
  the game starts, a qualifying solo outcome pays 2x or 3x in test coins.
- Both boards populate on each instance: a free game ranks on Pleb, a paid game on the Hall of
  Champions.
- On mainnet, confirm that purchased-credit play creates no payout or cash-out path.

## Rollback

- Stop only the affected instance, atomically repoint `/var/www/<instance>/current` at the previous
  immutable release, and restart it.
- Keep the pre-deploy database backup for an operator-reviewed restore if a data rollback is needed.
  The backup timer prunes dumps older than `BACKUP_RETENTION_DAYS` (default 14), so preserve a dump
  you may still need outside the pruned directory.
- Preserve the previous release directory until the new one has passed its soak.
