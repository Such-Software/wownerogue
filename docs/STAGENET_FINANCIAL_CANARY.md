# XMR stagenet financial canary

`src/scripts/stagenet-financial-canary.js` is the release-gate harness for Monerogue's two
direct-entry solo outcomes. Purchased-credit entry is outside the operated product profile. The
harness is intentionally narrow: one new anonymous user, one invoice, at most one funding
transfer, one bounded game, and one payout. It supports these scenarios:

| `E2E_SCENARIO` | Entry | Required outcome | Exact payout |
|---|---|---|---|
| `direct-2x` | one `single_game` invoice | escape without treasure | invoice amount × 2 |
| `direct-3x` | one `single_game` invoice | collect treasure, then escape | invoice amount × 3 |

Stagenet XMR is valueless test currency. Never send mainnet XMR to a stagenet address. This harness refuses mainnet-facing application state and funding-wallet addresses, but that guard is not a substitute for checking the wallet and daemon commands yourself.

## Hard safety properties

The harness fails closed unless all of these are true:

- The application URL explicitly names `127.0.0.1`, `localhost`, or `::1` on dedicated port `3102`. It cannot target the public router, LAN hostname, or Nebula address.
- Readiness, public disclosures, REST mode data, and Socket.IO mode data all identify real XMR stagenet with payments and payout dispatch enabled.
- Direct solo is enabled with exact 2× escape and 3× treasure multipliers. Purchased-credit solo
  and its payout path are disabled.
- The current `/api/disclosures` response requires the canonical five-field acknowledgement. The harness refetches it immediately before the value-bearing action and echoes exactly `policyVersion`, `ageEligible`, `termsRead`, `riskAccepted`, and `testnetUnderstood`.
- The selected PostgreSQL database name contains `canary`, `e2e`, and the selected scenario tag
  (`direct` for 2× or `treasure` for 3×). Its connection must be localhost, the harness session is
  read-only, current financial migrations must exist, and the database must contain only the
  migration-seeded admin with no game or financial rows.
- Before any invoice, funding-wallet call, or transfer, a nonce challenge binds the application pool to the harness connection's exact PostgreSQL cluster identifier, database OID, and database name. A same-named database on another cluster does not pass.
- The funding wallet RPC is localhost-only and either digest-authenticated or enabled by a separate explicit unauthenticated-local-RPC acknowledgement.
- The funding wallet validates both its own address and the invoice as stagenet. `get_address_index` must prove the invoice does not belong to the funding wallet; this prevents a meaningless house-wallet self-payment.
- Live execution needs three exact confirmations plus an atomic-unit transfer ceiling. The transfer gate is marked used before the sole `transfer` RPC call, so an ambiguous transport failure is never retried.
- The bot is bounded to one dungeon depth, 3,000 moves, and eight minutes. The 2× scenario treats
  treasure as blocked. The 3× scenario treats the exit as blocked until treasure is collected.
- Wallet addresses, session tokens, proof seeds, transaction hashes, and credentials are never printed. Failure messages redact those shapes.

The harness never creates, restores, exports, migrates, or backs up a wallet. It never deploys code, changes router state, or edits fleet configuration.

## Required topology

Use two different stagenet wallets:

1. The canary application owns the normal house wallet used to create invoice subaddresses and dispatch payouts.
2. A separate, low-balance funding wallet sends the direct-entry payment and receives the payout.

Expose only the separate funding wallet RPC to the harness, on loopback. Use a dedicated port such
as `38085`; port `38083` belongs to the promoted house wallet and must not be reused by the funding
wallet. Do not give the harness the house-wallet RPC URL or credentials. Keep the funding balance
no larger than needed for the selected invoice plus fees.

Before live use, independently verify that both wallet files are recoverable according to the operator's wallet-backup procedure. Do not put seeds, private keys, wallet passwords, transaction keys, or mnemonic output in this runbook, shell history, screenshots, CI variables, or canary logs. This harness deliberately does not inspect or print seed material.

## Build the disposable canary instance

Run the exact release candidate intended for production, but bind it only to localhost port `3102`. Use a dedicated PostgreSQL database for each scenario; do not run both scenarios in the same database and never reuse a database after any live attempt.

Recommended game-profile overrides for the one-shot financial check are:

```dotenv
DIFFICULTY_PRESET=easy
MONSTER_SPEED=0
DUNGEON_LEVELS=1
```

`MONSTER_SPEED=0` leaves the verifiable monster placement in the committed dungeon but prevents movement during the canary. The harness verifies the one-level state; the exact `E2E_CANARY_PROFILE` confirmation below is the operator's assertion that the easy/static-monster configuration is the one actually running.

The canary instance must otherwise use the intended production money configuration, including:

- `CRYPTO_TYPE=XMR`, `MONERO_NETWORK=stagenet`, real stagenet daemon and house wallet RPC;
- direct paid mode and direct payouts enabled;
- purchased-credit mode and credit payouts disabled;
- exact direct 2× escape and 3× treasure multipliers;
- production paid-action acknowledgement enabled and current operator/legal disclosure metadata.

Use a fresh database name such as:

```text
monerogue_canary_direct_e2e
monerogue_canary_treasure_e2e
```

First boot the release candidate against the new database with payout dispatch disabled solely to run startup migrations. Stop it after readiness. Then run database preflight. Finally boot the same release candidate and same database with the intended payout configuration on localhost port `3102`. Do not point a public router at this instance.

Enable the identity endpoint only on that final isolated canary boot:

```dotenv
NODE_ENV=production
PORT=3102
CANARY_DATABASE_HANDSHAKE=I_AM_AN_ISOLATED_XMR_STAGENET_CANARY
CANARY_EXPECT_DATABASE=monerogue_canary_direct_e2e
CANARY_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce
```

Use the corresponding `treasure` database name for the 3× scenario. If none of the three
`CANARY_DATABASE_*` variables is set, the endpoint is not registered. A partial configuration,
non-XMR-stagenet process, non-production process, wrong port, or `DB_NAME` mismatch aborts startup.
The endpoint signs its database identity and a fresh caller challenge; it never returns the nonce.
It also rejects any TCP peer that is not loopback, without trusting proxy-forwarded client headers.

## Protect local secret files

Credential files read by the harness must be regular files, not symlinks, and have no group/world permission bits (for example mode `0600` or `0400`). Prefer file-backed variables:

```text
E2E_FUNDING_RPC_USER_FILE=/run/credentials/canary/funding-rpc-user
E2E_FUNDING_RPC_PASSWORD_FILE=/run/credentials/canary/funding-rpc-password
E2E_DATABASE_URL_FILE=/run/credentials/canary/database-url
E2E_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce
```

Create a new random 32-byte nonce for each scenario and expose the same protected file to the
application (`CANARY_DATABASE_NONCE_FILE`) and harness (`E2E_DATABASE_NONCE_FILE`). Do not put its
contents in an environment variable, command argument, log, or screenshot. Delete the nonce after
the isolated canary is stopped; it is not a wallet key or recovery artifact.

Alternatively, `E2E_DATABASE_ENV_FILE` may point to a protected dotenv file containing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Set exactly one database source. `DB_HOST` and database URLs must explicitly use loopback.

## Read-only preflights

The public preflight performs no Socket.IO session registration, invoice creation, database mutation, or wallet RPC call:

```bash
E2E_MODE=preflight \
E2E_TARGET=http://127.0.0.1:3102 \
npm --prefix src run canary:stagenet
```

The database preflight opens only a read-only PostgreSQL session. Run it while the freshly migrated database still contains no canary session:

```bash
E2E_MODE=database-preflight \
E2E_SCENARIO=direct-2x \
E2E_EXPECT_DATABASE=monerogue_canary_direct_e2e \
E2E_DATABASE_URL_FILE=/run/credentials/canary/direct-database-url \
npm --prefix src run canary:stagenet
```

For the 3× scenario, use `E2E_SCENARIO=direct-3x`, a database name containing `treasure`, and its
separate protected connection file.

## Live direct 2× escape

Review the configured direct entry atomic amount before setting `E2E_MAX_TRANSFER_ATOMIC`. The ceiling must be at least the advertised invoice amount and should equal that amount when practical.

```bash
E2E_MODE=live-stagenet \
E2E_SCENARIO=direct-2x \
E2E_TARGET=http://127.0.0.1:3102 \
E2E_EXPECT_DATABASE=monerogue_canary_direct_e2e \
E2E_DATABASE_URL_FILE=/run/credentials/canary/direct-database-url \
E2E_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce \
E2E_FUNDING_RPC_URL=http://127.0.0.1:38085 \
E2E_FUNDING_RPC_USER_FILE=/run/credentials/canary/funding-rpc-user \
E2E_FUNDING_RPC_PASSWORD_FILE=/run/credentials/canary/funding-rpc-password \
E2E_MAX_TRANSFER_ATOMIC=REPLACE_WITH_REVIEWED_ATOMIC_CEILING \
E2E_FEE_CUSHION_ATOMIC=1000000000 \
E2E_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS_ONE_XMR_STAGENET_TRANSFER \
E2E_SCENARIO_CONFIRM=DIRECT_2X_ESCAPE \
E2E_CANARY_PROFILE=EASY_STATIC_MONSTER_ONE_LEVEL \
npm --prefix src run canary:stagenet
```

The harness binds a fresh fairness offer to the direct invoice before revealing its address, transfers the exact invoice amount, waits for receipt-backed confirmation and automatic game start, avoids treasure, escapes, and verifies an exact 2× payout.

## Live direct 3× treasure escape

Review the configured direct-entry atomic amount before setting the ceiling. As with the 2× run,
the ceiling must be at least the advertised invoice amount and should equal that amount when
practical.

```bash
E2E_MODE=live-stagenet \
E2E_SCENARIO=direct-3x \
E2E_TARGET=http://127.0.0.1:3102 \
E2E_EXPECT_DATABASE=monerogue_canary_treasure_e2e \
E2E_DATABASE_URL_FILE=/run/credentials/canary/treasure-database-url \
E2E_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce \
E2E_FUNDING_RPC_URL=http://127.0.0.1:38085 \
E2E_FUNDING_RPC_USER_FILE=/run/credentials/canary/funding-rpc-user \
E2E_FUNDING_RPC_PASSWORD_FILE=/run/credentials/canary/funding-rpc-password \
E2E_MAX_TRANSFER_ATOMIC=REPLACE_WITH_REVIEWED_ATOMIC_CEILING \
E2E_FEE_CUSHION_ATOMIC=1000000000 \
E2E_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS_ONE_XMR_STAGENET_TRANSFER \
E2E_SCENARIO_CONFIRM=DIRECT_3X_TREASURE_ESCAPE \
E2E_CANARY_PROFILE=EASY_STATIC_MONSTER_ONE_LEVEL \
npm --prefix src run canary:stagenet
```

The harness binds a fresh fairness offer to the direct invoice before revealing its address,
transfers the exact invoice amount, waits for receipt-backed confirmation and automatic game
start, collects treasure before allowing the exit, and verifies an exact 3× payout based on the
invoice amount.

## Exact settlement assertions

After the funding wallet observes the incoming payout, the harness checks the read-only database connection. A passing run has exactly:

- two users: the migration-seeded admin and one canary identity;
- one confirmed native-Monero payment with `received_amount == expected_amount` and valid confirmation evidence;
- one unique confirmed `chain_output` receipt whose amount exactly equals the invoice;
- one won/escaped game with consumed entry evidence, committed 2×/3× immutable payout terms, the selected paid mode, matching fairness v2 identity, and the expected treasure flag;
- one completed payout with the exact amount, multiplier, reason, payout address, and transaction evidence;
- no refunds, late reviews, matches, match queues, race-entry ledgers, or race-entry lots.

Each scenario additionally requires exactly the `direct_entry +1` and `game_entry -1`
credit-ledger rows, a zero balance, unified purchase progress of one, the game linked to the
fairness-bound payment, and no product-entitlement marker.

## Failure handling

Before the line `one exact, non-retriable XMR stagenet transfer was broadcast`, a failure means no funding transfer was attempted. Correct the configuration, recreate a fresh scenario database if any app session was made, and repeat the preflights.

At or after that line, never rerun the command and never reuse the database. A transport timeout can be ambiguous even when the wallet accepted the transfer. Preserve the database and both wallet files, stop the isolated canary, and reconcile the invoice receipt, payment, game, payout, and wallet histories manually. The harness intentionally performs no automatic retry, refund, database cleanup, wallet cleanup, or destructive recovery.

Only after both scenarios pass on separate databases should the release be considered financially canary-tested. Passing does not authorize deployment; deployment and router/fleet changes remain separate reviewed operations.

## Local verification (no network or wallet use)

```bash
node --check src/scripts/stagenet-financial-canary.js
npm --prefix src test -- --runTestsByPath ../test/canaryDatabaseIdentity.test.js ../test/stagenetFinancialCanary.test.js
npm --prefix src run canary:stagenet -- --help
```

These commands parse the harness, run its pure/static safety tests, and print help. They do not contact the application, database, or either wallet.
