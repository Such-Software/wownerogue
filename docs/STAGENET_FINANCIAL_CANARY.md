# XMR stagenet financial canary

`src/scripts/stagenet-financial-canary.js` is the release-gate harness for the two direct-entry
solo money outcomes. Purchased-credit entry is outside the operated stagenet profile and the
harness requires it to be disabled. The harness is deliberately narrow: one new anonymous user,
one invoice, at most one funding transfer, one bounded game, and one payout.

| `E2E_SCENARIO` | Entry | Required outcome | Exact payout |
|---|---|---|---|
| `direct-2x` | one `single_game` invoice | escape without treasure | invoice amount × 2 |
| `direct-3x` | one `single_game` invoice | collect treasure, then escape | invoice amount × 3 |

Stagenet XMR is valueless test currency. Never send mainnet XMR to a stagenet address. The harness
refuses mainnet-facing application state and mainnet funding-wallet addresses, but that guard is
not a substitute for checking the wallet and daemon commands yourself.

## Safety envelope

The harness fails closed unless all of these hold.

- `E2E_TARGET` explicitly names `127.0.0.1`, `localhost`, or `::1` on dedicated port `3102`, with
  no path, query, fragment, or embedded credentials. It cannot target a public hostname or a LAN
  address.
- `/health/ready` reports a real (non-simulated) stagenet chain, database/chain/wallet checks up,
  and both payment intake and payout dispatch enabled.
- `/api/game-modes`, `/api/stats`, and the Socket.IO `game_mode_info` payload all identify the
  `such-monerogue-stagenet` operated profile, `sXMR`, direct entry and direct payouts enabled,
  purchased-credit entry and credit payouts disabled, Smirk disabled, crypto match payouts
  disabled, and match economies limited to `free` and `credits_prestige`. `PAID_CREDITS` must be
  absent from the public mode descriptors entirely.
- Direct payout multipliers are exactly 2 for escape and 3 for escape with treasure, in both the
  REST and Socket.IO views.
- `/api/disclosures` is `no-store`, requires paid-action acknowledgement, carries the operated
  product's `2×/3×` scope notice and `NO REAL VALUE` warning, and exposes `/terms`, `/privacy`,
  and `/responsible-play`. The harness echoes exactly `policyVersion`, `ageEligible`, `termsRead`,
  `riskAccepted`, and `testnetUnderstood`, and refetches the disclosure immediately before the
  value-bearing action so a policy change aborts the run before any invoice exists.
- The selected PostgreSQL database passes the naming rules below, connects over loopback, is
  opened with `default_transaction_read_only = on`, carries the required financial migrations, and
  contains only the migration-seeded admin with no game or financial rows.
- Before any invoice, funding-wallet call, or transfer, a nonce challenge binds the application's
  own pool to the harness connection's exact PostgreSQL cluster identifier, database OID, and
  database name. A same-named database on another cluster does not pass.
- The funding wallet RPC origin is loopback-only and is either digest-authenticated or explicitly
  enabled with `E2E_ALLOW_UNAUTH_FUNDING_RPC=I_ACCEPT_LOCAL_UNAUTH_RPC`.
- The funding wallet validates both its own primary address and the invoice address as stagenet.
  `get_address_index` must fail on the invoice address, proving the invoice does not belong to the
  funding wallet and the run is not a house-wallet self-payment.
- Live execution requires three exact confirmation strings (`E2E_CONFIRM`,
  `E2E_SCENARIO_CONFIRM`, `E2E_CANARY_PROFILE`), an explicit `E2E_MAX_TRANSFER_ATOMIC` ceiling, and
  the database nonce file. The one-shot transfer gate is marked used before the sole `transfer` RPC
  call, so an ambiguous transport failure is never retried.
- The bot is bounded to one dungeon depth, 3,000 moves, and eight minutes. The 2× scenario treats
  the treasure tile as blocked; the 3× scenario treats the exit tile as blocked until treasure is
  collected. Both scenarios treat the monster tile as blocked.
- Server-side fog of war is asserted, not bypassed: a start state that already names the exit or
  the treasure fails the run. The bot explores frontiers until an objective is revealed.
- Wallet addresses, session tokens, proof seeds, transaction hashes, and credentials are never
  printed. Failure messages redact those shapes.

The harness never creates, restores, exports, migrates, or backs up a wallet, and performs no
deployment or infrastructure change. Its only write actions are the Socket.IO gameplay events, the
single funding transfer, and whatever the application itself persists in response.

## Required topology

Use two different stagenet wallets.

1. The canary application owns the normal house wallet that creates invoice subaddresses and
   dispatches payouts.
2. A separate, low-balance funding wallet sends the direct-entry payment and receives the payout.
   Its primary address (account 0, index 0) is registered as the canary identity's payout address.

Expose only the funding wallet RPC to the harness, on loopback. Use a dedicated port such as
`38085`. In `src/.env.stagenet.example`, port `38083` belongs to the promoted house wallet and must
not be reused: pointing the harness at it would hand a test script the RPC that holds real balances
and dispatches payouts. Do not give the harness the house-wallet RPC URL or credentials. Keep the
funding balance no larger than the invoice plus fees.

Before live use, independently verify that both wallet files are recoverable under the operator's
wallet-backup procedure. Do not put seeds, private keys, wallet passwords, transaction keys, or
mnemonic output in this runbook, shell history, screenshots, CI variables, or canary logs. The
harness deliberately does not inspect or print seed material.

## Build the disposable canary instance

Run the exact release candidate intended for production, bound only to localhost port `3102`. Use
a dedicated PostgreSQL database per scenario. Do not run both scenarios against one database, and
never reuse a database after any live attempt.

The instance must use the intended production money configuration, which
`src/.env.stagenet.example` already encodes:

- `CRYPTO_TYPE=XMR`, `MONERO_NETWORK=stagenet`, a real stagenet daemon and house wallet RPC;
- `OPERATED_PRODUCT_PROFILE=such-monerogue-stagenet`;
- `PAYMENTS_ENABLED=true`, `DIRECT_PAYMENT_ENABLED=true`, `DIRECT_PAYOUTS_ENABLED=true`,
  `PAYOUTS_ENABLED=true`, `ALLOW_MAINNET_PAYOUTS=false`;
- `CREDITS_ENABLED=false`, `CREDITS_PAYOUTS_ENABLED=false`;
- `DIRECT_PAYOUT_ESCAPE=2.0`, `DIRECT_PAYOUT_TREASURE=3.0`;
- `PAID_ACKNOWLEDGEMENT_REQUIRED=true` with current operator and legal disclosure metadata.

Recommended game-profile overrides for the one-shot financial check:

```dotenv
DIFFICULTY_PRESET=easy
MONSTER_SPEED=0
DUNGEON_LEVELS=1
```

`MONSTER_SPEED=0` leaves the monster placed in the committed dungeon, so its seeded position stays
verifiable, but its per-turn move accumulator never reaches one step. The harness independently
asserts the one-level state; `E2E_CANARY_PROFILE=EASY_STATIC_MONSTER_ONE_LEVEL` is the operator's
assertion that this easy, static-monster configuration is the one actually running.

### Scenario database names

Both the harness and the application validate the database name, with slightly different rules,
and the name must satisfy both.

- The harness (`validateExpectedDatabaseName`) requires a simple `[a-z0-9_]` name containing
  `canary`, `e2e`, and the scenario tag: `direct` for `direct-2x`, `treasure` for `direct-3x`.
- The application (`src/services/canaryDatabaseIdentity.js`) requires `canary`, `e2e`, and either
  `direct` or `credits` as an underscore-delimited token.

Names that satisfy both:

```text
monerogue_canary_direct_e2e            # direct-2x
monerogue_canary_direct_treasure_e2e   # direct-3x
```

### Boot order

1. Boot the release candidate against the new database with payout dispatch disabled, solely to
   run startup migrations. Stop it once it reports ready.
2. Run the database preflight.
3. Boot the same release candidate against the same database with the intended payout
   configuration on localhost port `3102`. Do not point a public router at this instance.

### Database identity endpoint

Enable the identity endpoint only on that final isolated boot:

```dotenv
NODE_ENV=production
PORT=3102
CANARY_DATABASE_HANDSHAKE=I_AM_AN_ISOLATED_XMR_STAGENET_CANARY
CANARY_EXPECT_DATABASE=monerogue_canary_direct_e2e
CANARY_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce
```

Use the corresponding `treasure` database name for the 3× scenario. If none of
`CANARY_DATABASE_HANDSHAKE`, `CANARY_EXPECT_DATABASE`, and `CANARY_DATABASE_NONCE_FILE` is set, the
endpoint is not registered. A partial configuration, a non-production process, a non-XMR-stagenet
process, a port other than `3102`, a non-canary database name, or a `DB_NAME` that differs from
`CANARY_EXPECT_DATABASE` aborts startup.

The endpoint serves `GET /api/canary/database-identity` as `no-store`. It requires a 256-bit
lowercase-hex `X-Canary-Database-Challenge` header, returns the cluster id, database OID, and
database name, and HMACs that tuple plus the challenge under the nonce. It never returns the nonce
itself. It rejects any TCP peer that is not loopback, judging by the socket's remote address rather
than proxy-forwarded client headers, so an accidentally routed canary discloses nothing.

## Protect local secret files

Credential files read by the harness must be regular files, not symlinks, and must have no
group or world permission bits (for example mode `0600` or `0400`). Prefer file-backed variables:

```text
E2E_FUNDING_RPC_USER_FILE=/run/credentials/canary/funding-rpc-user
E2E_FUNDING_RPC_PASSWORD_FILE=/run/credentials/canary/funding-rpc-password
E2E_DATABASE_URL_FILE=/run/credentials/canary/database-url
E2E_DATABASE_NONCE_FILE=/run/credentials/canary/database-nonce
```

`E2E_FOO` and `E2E_FOO_FILE` are mutually exclusive for each secret.

Create a new random nonce for each scenario (`openssl rand -hex 32`) and expose the same protected
file to the application (`CANARY_DATABASE_NONCE_FILE`) and to the harness
(`E2E_DATABASE_NONCE_FILE`). The nonce file must be an absolute path holding exactly 64 lowercase
hex characters; it is opened with `O_NOFOLLOW`. Do not put its contents in an environment variable,
command argument, log, or screenshot. Delete the nonce after the isolated canary is stopped; it is
not a wallet key or recovery artifact.

Alternatively, `E2E_DATABASE_ENV_FILE` may point to a protected dotenv file containing `DB_HOST`,
`DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Set exactly one database source. `DB_HOST` and
database URLs must explicitly name loopback, and the database they name must equal
`E2E_EXPECT_DATABASE`.

## Read-only preflights

The public preflight performs no Socket.IO session registration, invoice creation, database
mutation, or wallet RPC call:

```bash
E2E_MODE=preflight \
E2E_TARGET=http://127.0.0.1:3102 \
npm --prefix src run canary:stagenet
```

The database preflight opens only a read-only PostgreSQL session and contacts nothing else. Run it
while the freshly migrated database still contains no canary session:

```bash
E2E_MODE=database-preflight \
E2E_SCENARIO=direct-2x \
E2E_EXPECT_DATABASE=monerogue_canary_direct_e2e \
E2E_DATABASE_URL_FILE=/run/credentials/canary/direct-database-url \
npm --prefix src run canary:stagenet
```

For the 3× scenario use `E2E_SCENARIO=direct-3x`, a database name containing `treasure`, and its
own protected connection file.

## Live direct 2× escape

Review the configured direct entry price before setting `E2E_MAX_TRANSFER_ATOMIC`. The ceiling must
be at least the advertised invoice amount and should equal it when practical; with the template's
`DIRECT_GAME_PRICE=10000000000` (0.01 sXMR) the ceiling is `10000000000`.

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

## Live direct 3× treasure escape

```bash
E2E_MODE=live-stagenet \
E2E_SCENARIO=direct-3x \
E2E_TARGET=http://127.0.0.1:3102 \
E2E_EXPECT_DATABASE=monerogue_canary_direct_treasure_e2e \
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

## Live run sequence

1. Register an anonymous Socket.IO client and capture its session token and `game_mode_info`.
2. Refetch `/api/disclosures` and abort if the policy version moved since preflight.
3. Save the funding wallet's primary address as the payout destination.
4. Request a fresh fairness offer, then create the `single_game` invoice bound to that offer and a
   random 256-bit client seed. The invoice must echo proof version 2 with the same offer id,
   commitment, and client seed, must not be a reused invoice, and must equal the advertised atomic
   entry price.
5. Prove the invoice address is stagenet and is not owned by the funding wallet.
6. Broadcast the sole transfer of the exact invoice amount, after checking that unlocked balance
   covers the amount plus `E2E_FEE_CUSHION_ATOMIC`.
7. Wait for `payment_confirmed` and the automatic `game_start`, and check the started dungeon is
   bound to the invoice's fairness proof.
8. Run the bounded bot to the scenario outcome.
9. Verify the reveal: the server seed hashes to the pre-game commitment, the effective seed is
   `HMAC-SHA256(serverSeed, clientSeed)`, and the outcome metadata matches.
10. Verify the committed payout amount and multiplier, poll the owned payout history until the
    payout is `completed` with a transaction hash, and confirm the funding wallet observes the
    exact incoming amount.
11. Run the database settlement assertions.

## Exact settlement assertions

A passing run leaves the scenario database with exactly:

- two users: the migration-seeded admin and one canary identity with a payout address and one
  game played;
- one `confirmed` `native-monero` payment of `payment_type = single_game` with
  `received_amount == expected_amount`, confirmation evidence, a valid transaction hash, and an
  immutable invoice destination identity (`subaddress`, `provider_invoice_id`, `address_index`);
- product identity `single_game` granting zero credits, zero race entries, no packs, and no
  premium level;
- fairness proof version 2 bound and consumed exactly once, matching the offer, commitment, and
  client seed;
- one unique `confirmed` `chain_output` receipt whose amount exactly equals the invoice, whose
  `evidence_id` is `tx_hash:output_id`, and whose address index matches the payment;
- one `won`/`escaped` game in the selected paid mode, with consumed entry evidence, a revealed
  proof, the expected treasure flag, and immutable payout terms committing both the 2× escape and
  3× treasure amounts;
- one `completed` payout with the exact amount, multiplier, reason
  (`escape` or `escape_with_treasure`), payout address, and transaction evidence;
- exactly two credit-ledger rows, `direct_entry +1` and `game_entry -1`, both settling to a zero
  balance with no linked payment id, leaving `credits = 0` and `total_credits_purchased = 1`;
- zero refunds, late reviews, entitlement grants, pack entitlements, matches, match entrants,
  match events, match queue entries, race-entry transactions, and race-entry lots.

## Optional bounded tunables

Each is a positive integer with a hard safety bound; exceeding the bound fails the run.

| Variable | Default | Maximum |
|---|---|---|
| `E2E_PAYMENT_TIMEOUT_MS` | 1800000 | 2700000 |
| `E2E_PAYOUT_TIMEOUT_MS` | 900000 | 1800000 |
| `E2E_RPC_POLL_MS` | 2000 | 10000 |
| `E2E_BOT_MOVE_DELAY_MS` | 140 | 1000 |
| `E2E_BOT_MAX_MOVES` | 3000 | 3000 |
| `E2E_BOT_TIMEOUT_MS` | 480000 | 480000 |

`E2E_FEE_CUSHION_ATOMIC` defaults to `1000000000` and has no maximum beyond
`Number.MAX_SAFE_INTEGER`. `E2E_MAX_TRANSFER_ATOMIC` has no default and is mandatory for live runs.

## Failure handling

The harness prints `one exact, non-retriable XMR stagenet transfer was broadcast` immediately after
its sole `transfer` call.

Before that line, a failure means no funding transfer was attempted. Correct the configuration,
recreate a fresh scenario database if any application session was made, and repeat the preflights.

At or after that line, never rerun the command and never reuse the database. A transport timeout
can be ambiguous even when the wallet accepted the transfer. Preserve the database and both wallet
files, stop the isolated canary, and reconcile the invoice receipt, payment, game, payout, and
wallet histories manually. The harness performs no automatic retry, refund, database cleanup,
wallet cleanup, or destructive recovery.

A release is financially canary-tested only after both scenarios pass on separate databases.
Passing does not authorize deployment; deployment remains a separate reviewed operation.

## Offline verification

```bash
node --check src/scripts/stagenet-financial-canary.js
npm --prefix src test -- --runTestsByPath ../test/canaryDatabaseIdentity.test.js ../test/stagenetFinancialCanary.test.js
npm --prefix src run canary:stagenet -- --help
```

These parse the harness, run its pure and static safety tests, and print help. They contact no
application, database, or wallet.
