# Financial-event export

Migrations 041 and 042 create a durable outbox for confirmed customer payments and final refund
states. Migration 042 stores an immutable source snapshot before delivery; the exporter never
reconstructs an event from later-mutated payment rows. Payloads contain transaction classification,
atomic amount, asset/network, catalog/provider identifiers, and receipt count, but no player ID,
wallet address, session token, IP address, email address, or authentication material.

Delivery is **at least once**. Every request sets `Idempotency-Key` to the immutable financial event
ID. The receiving system must durably deduplicate that key before acknowledging with a 2xx response.
A timeout or lost acknowledgement can otherwise produce a repeat request. The application marks a
row delivered only after a 2xx response; bounded retries use a durable lease and exponential delay,
then move an exhausted row to `dead_letter` for operator review.

The public health response exposes only aggregate exporter state: enabled/running flags, backlog,
dead-letter and ignored counts, and cumulative delivery counters. It exposes no sink URL,
token, event ID, error text, payload, or source identity. Accounting export is informational and does
not independently make gameplay readiness fail, so production monitoring must alert on backlog age,
dead letters, and the exporter process logs/metrics needed to detect stale delivery.

## Configuration contract

Configure both of these only in the protected Wownero mainnet runtime environment:

```dotenv
FINANCIAL_EVENT_SINK_URL=https://ledger.operator.example/v1/events
FINANCIAL_EVENT_SINK_TOKEN=<strong protected bearer token>
FINANCIAL_EVENT_ACCOUNT_REF=wowngeon:wow-receipts
FINANCIAL_EVENT_POLL_MS=60000
FINANCIAL_EVENT_BATCH_SIZE=20
FINANCIAL_EVENT_MAX_ATTEMPTS=8
```

Production requires HTTPS, forbids URL-embedded credentials, and requires a strong token. The account
reference is a non-PII identifier. URL and token must be set together. Never place the token in Git,
Ansible inventory, an invocation, a receipt, a log, or a public health check.

Monero stagenet deliberately sends nothing to an accounting sink. Its pending, leased, or dead-letter
test rows are moved to `ignored` with reason `non_mainnet_network`; startup rejects sink configuration
on any non-mainnet network. This keeps **NO REAL VALUE** test activity out of real books.

## Operations

Before enabling mainnet export, prove in a disposable environment that the sink:

1. authenticates the protected bearer token over TLS;
2. deduplicates repeated requests by `Idempotency-Key`;
3. durably records the event before returning 2xx;
4. rejects malformed events without echoing secrets; and
5. supports alerting and reconciliation for a deliberately generated dead letter.

Keep the outbox in database backups. Do not delete or rewrite a dead-letter row to make monitoring
green; reconcile it against the receiving ledger, preserve the evidence, and use a separately reviewed
repair procedure. An absent sink is permitted, but confirmed mainnet events then remain pending and
must be included in the production accounting handoff.
