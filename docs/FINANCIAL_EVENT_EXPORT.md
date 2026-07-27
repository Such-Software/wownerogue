# Financial event export

Migrations `041_financial_event_outbox.sql` and `042_immutable_financial_event_snapshots.sql` create
`financial_event_outbox`, a durable outbox for confirmed customer payments and final refund states.
Database triggers append an immutable source snapshot inside the payment or refund transaction, so a
slow or unreachable accounting receiver can never hold a money transaction open.
`src/services/financialEventExporter.js` performs delivery asynchronously and never reconstructs an
event from later-mutated payment rows.

## Event sources

| Event kind | Trigger source | Fires when |
| --- | --- | --- |
| `payment.confirmed` | `payments` | `status` becomes `confirmed` and `received_amount > 0` |
| `payment.refund` | `payment_refunds` | `status` reaches `recorded` (bookkeeping reversal) or `completed` (wallet refund) |

Refunds in `requested`, `processing`, or `needs_review` are never accounting events. Confirmed
payments with `received_amount = 0` lack economic evidence and are never turned into revenue.
Uniqueness on `(event_kind, source_type, source_id)` and on `event_id` means one source produces at
most one event; the foreign key to `payments` is `ON DELETE RESTRICT`.

## Source snapshot

`payload_snapshot` uses schema `financial-event-source/v1`. A CHECK constraint restricts it to
exactly this key set: `schema`, `event_id`, `event_kind`, `source_type`, `source_id`,
`aggregate_id`, `occurred_at`, `atomic_amount`, `payment_type`, `product_id`, `provider_id`,
`receipt_count`, `refund_status`. The constraint also pins `event_id`, `event_kind`, `source_type`,
`source_id`, and `aggregate_id` to the matching columns.

The snapshot carries no player ID, wallet address, invoice destination, transaction hash, provider
invoice ID, session token, IP address, email address, or authentication material.

## Delivery document

On the first delivery attempt the worker builds `delivery_payload` from the snapshot plus the
deployment's chain profile (`src/chain/chainProfile.js`) and writes it once. Schema is
`financial-event/v1`:

- `id`: the immutable event ID, also used as the idempotency key.
- `occurred_at`: ISO-8601 timestamp derived from the snapshot.
- `producer` / `product`: `wowngeon`.
- `activity`: `customer-payment`, `customer-refund` (completed wallet refund), or
  `customer-payment-reversal` (recorded bookkeeping reversal).
- `account_refs` and each leg's `account_ref`: `FINANCIAL_EVENT_ACCOUNT_REF`.
- `provenance`: one entry of kind `wowngeon-payment` or `wowngeon-refund` referencing
  `payment-<id>` or `payment-refund-<id>`.
- `legs`: one leg with the chain profile's `asset` symbol, decimal `quantity`, `direction` `in` for
  payments and `out` for refunds, and a `network` identifier.
- `attributes`: `valuation_required`, `atomic_amount`, `atomic_decimals`, `source_type`,
  `source_id`, `aggregate_id`, plus `refund_status` for refunds or
  `payment_type` / `product_id` / `provider_id` / `receipt_count` for payments.

The leg's `usd_value` is `"0"` with empty `price_source` and `price_confidence`, and `memo` plus
`attributes.valuation_required` state that the receiving system must apply USD valuation before
confirming the entry. The exporter deliberately performs no pricing.

The `network` identifier is `wownero:mainnet` when `CRYPTO_TYPE` resolves to the WOW profile, and
`monero:<MONERO_NETWORK>` otherwise. An unrecognised `CRYPTO_TYPE` resolves to the XMR-shaped
default profile (12 decimals, 120000 ms mean block time).

Once written, the delivery document is immutable and every retry reuses it byte for byte.

## Delivery contract

Delivery is **at least once**. Each attempt is a `POST` with a bearer `authorization` header,
`content-type: application/json`, `idempotency-key` set to the immutable event ID, manual redirect
handling, and a 10-second timeout. The receiving system must durably deduplicate that key and
durably record the event before answering 2xx. A timeout or lost acknowledgement otherwise produces
a repeat request. The application marks a row `delivered` only after a 2xx response.

## Row lifecycle

`pending` → `in_flight` → `delivered`, with `dead_letter` and `ignored` as the other terminal
states.

- A run first moves rows whose `attempts` already reached `FINANCIAL_EVENT_MAX_ATTEMPTS` to
  `dead_letter`.
- Claiming selects the oldest due row with `FOR UPDATE SKIP LOCKED`, increments `attempts`, and
  takes a five-minute lease. An expired lease makes the row claimable again, so a crashed worker
  never strands an event.
- A failed attempt returns the row to `pending` with backoff of 30 seconds doubled per attempt and
  capped at one hour, recording the sanitised error in `last_error`.
- An attempt that exhausts `FINANCIAL_EVENT_MAX_ATTEMPTS` moves the row to `dead_letter` for
  operator review.
- Each run processes at most `FINANCIAL_EVENT_BATCH_SIZE` rows.

### Immutability

A `BEFORE UPDATE` trigger rejects any change to `event_kind`, `aggregate_id`, `source_type`,
`source_id`, `event_id`, or `payload_snapshot`. `delivery_payload` has exactly one legal transition,
`NULL` to its final value, and only while the row is `in_flight`. A row cannot reach `delivered`
without a delivery document.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `FINANCIAL_EVENT_SINK_URL` | unset | Enables export together with the token |
| `FINANCIAL_EVENT_SINK_TOKEN` | unset | Bearer secret, at least 32 characters |
| `FINANCIAL_EVENT_ACCOUNT_REF` | `wowngeon:receipts` | Non-PII account identifier |
| `FINANCIAL_EVENT_POLL_MS` | `60000` | Clamped to 5000-3600000 |
| `FINANCIAL_EVENT_BATCH_SIZE` | `20` | Clamped to 1-100 |
| `FINANCIAL_EVENT_MAX_ATTEMPTS` | `8` | Clamped to 1-100 |

```dotenv
FINANCIAL_EVENT_SINK_URL=https://ledger.operator.example/v1/events
FINANCIAL_EVENT_SINK_TOKEN=<strong protected bearer token>
FINANCIAL_EVENT_ACCOUNT_REF=wowngeon:wow-receipts
FINANCIAL_EVENT_POLL_MS=60000
FINANCIAL_EVENT_BATCH_SIZE=20
FINANCIAL_EVENT_MAX_ATTEMPTS=8
```

The full environment template is `src/.env.example`; the mainnet and stagenet profiles are
`src/.env.mainnet.example` and `src/.env.stagenet.example`.

Startup validation (`src/config/environmentValidator.js`) and the exporter constructor both enforce:

- URL and token are set together or not at all.
- The URL parses, uses `http:` or `https:`, and embeds no credentials. `https:` is required when
  `NODE_ENV=production`.
- The token is at least 32 characters, contains at least 8 distinct characters, and matches no
  placeholder pattern such as `change_me`, `example`, `password`, or `secret`.
- The account reference matches `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`.
- Sink configuration is rejected on any non-mainnet `MONERO_NETWORK`.

Set the URL and token only in the protected mainnet runtime environment. Never place the token in
Git, Ansible inventory, an invocation, a receipt, a log, or a public health check.

## Non-mainnet networks

When `MONERO_NETWORK` is not `mainnet`, export is disallowed and each run moves every `pending`,
`in_flight`, or `dead_letter` row to `ignored` with reason `non_mainnet_network`. This keeps
no-value test activity out of real books. Migration 042 separately marks legacy rows whose
historical amount is unusable as `ignored` with reason `malformed_legacy_snapshot`, so they
terminate instead of retrying forever.

## Health reporting

The public `/health` response includes a `financialEvents` object: the delivery contract string,
`enabled`, `exportAllowed`, `running`, the `backlog`, `deadLetters`, and `ignoredRows` gauges, and
the cumulative `delivered`, `deferred`, `deadLettered`, and `ignored` counters. It exposes no sink
URL, token, account reference, event ID, error text, payload, source identity, or timestamp.

Accounting export is informational and does not make gameplay readiness fail, so production
monitoring must alert on backlog age, dead letters, and the exporter's process logs and metrics in
order to detect stale delivery.

The poll loop runs even with no sink configured, so the backlog gauge stays truthful and non-mainnet
deployments keep suppressing newly appended rows.

## Operations

Before enabling mainnet export, prove in a disposable environment that the sink:

1. authenticates the protected bearer token over TLS;
2. deduplicates repeated requests by `Idempotency-Key`;
3. durably records the event before returning 2xx;
4. rejects malformed events without echoing secrets; and
5. supports alerting and reconciliation for a deliberately generated dead letter.

Keep the outbox in database backups. Do not delete or rewrite a dead-letter row to make monitoring
green: reconcile it against the receiving ledger, preserve the evidence, and use a separately
reviewed repair procedure. Running without a sink is permitted, but confirmed mainnet events then
accumulate as pending rows and must be reconciled by another route.
