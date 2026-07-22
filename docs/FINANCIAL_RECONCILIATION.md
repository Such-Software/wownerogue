# Financial reconciliation

The admin dashboard has separate **Payouts** and **Refunds** views. Start with the
**Needs Attention** filter and compare the row, application logs, and wallet history.
The overview and each list show `processing` and `needs_review` counts; these are
liabilities, not failed transfers that can safely be resent.

## State rules

- A payout in `processing` or `needs_review` may already have broadcast. Never use the
  retry action for it.
- The payout retry action is available only for a hashless `failed` or
  `permanently_failed` row. Use it only after proving the recorded error happened before
  broadcast and confirming that wallet history contains no matching transfer. The UI
  sends the API's required explicit confirmation.
- A refund in `requested` has not yet been claimed by the refund worker. A refund in
  `processing` may have broadcast. A refund in `needs_review` is quarantined. There is no
  dashboard resend action for any refund state.
- `recorded` means entitlements/payment state was reversed without an on-chain transfer;
  `completed` requires transaction-hash evidence.

## Reconciliation checklist

1. Preserve the database row, service logs, wallet files, and current backups before
   changing anything.
2. Match currency/network, destination, exact atomic amount, creation/processing time,
   transaction hash (if present), and wallet outgoing-transfer history.
3. If a matching wallet transfer exists, record its hash and confirmation evidence in an
   audited remediation. Do not create a replacement transfer.
4. If no transfer appears, treat that as inconclusive until the wallet is synchronized and
   the relevant time window and mempool are checked. Escalate ambiguous cases instead of
   retrying.
5. Re-run the read-only financial audit after any reviewed database remediation and retain
   the before/after evidence with the incident record.

Periodic alerts use the same aggregate states. `FINANCIAL_REVIEW_STALE_MS` controls when a
payout `processing` row or refund `requested`/`processing` row is considered stale; the
default is 15 minutes. Alerts are read-only and never move or retry a transfer.

There is intentionally no generic "mark resolved" endpoint. A reviewed state transition
needs a case-specific, audited remediation because the correct result depends on wallet
evidence and whether value was actually transferred.
