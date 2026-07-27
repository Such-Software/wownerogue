# Financial reconciliation

Payouts and refunds move real funds, so any row that is not in a terminal state is treated
as a liability with an unknown on-chain outcome rather than a failed transfer that can be
resent. This document describes the states, the retry rules that follow from them, and the
manual reconciliation procedure.

## Where to look

The admin dashboard (`html/admin.html`) has separate **Payouts** and **Refunds** tabs. Each
has a status filter whose **Needs Attention** option selects exactly the non-terminal states:

- Payouts: `pending`, `processing`, `failed`, `needs_review`, `permanently_failed`.
- Refunds: `requested`, `processing`, `needs_review`.

The overview panel and each list also report per-status counts. Compare the row against the
service logs and the wallet's outgoing-transfer history before taking any action.

## Payout states

| State | Meaning |
| --- | --- |
| `pending` | Queued for the batch payout worker in `gameModeManager`. That worker owns these rows exclusively. |
| `processing` | Claimed by a worker. The wallet call may already have broadcast. |
| `completed` | Settled, with a transaction hash recorded. |
| `failed` | The wallet call reported an error and the row is below the retry limit. |
| `permanently_failed` | Retries reached `PAYOUT_MAX_RETRIES` (default 3). |
| `needs_review` | Quarantined for manual reconciliation. Never retried automatically. |
| `batched` | Legacy status from an earlier batching scheme. Current code does not write it; it remains accepted by the status constraint and is counted in dashboard totals. |

`PayoutRetryService` retries only `failed` rows below the retry limit, claiming each with
`FOR UPDATE SKIP LOCKED` so the batcher and the retry worker cannot both send the same row.
It also sweeps `processing` rows that have not advanced within its stale window and moves
them to `needs_review` with the reason recorded in `last_error`. The stale window defaults to
`max(PAYOUT_RETRY_INTERVAL_MS * 3, 15 minutes)`.

## Refund states

Refunds have their own durable outbox table, `payment_refunds`. Its state shape is enforced
by a database CHECK constraint, so a state and its timestamps or evidence cannot disagree.

| State | Meaning |
| --- | --- |
| `recorded` | Entitlements and payment state were reversed with no on-chain transfer requested. Terminal. |
| `requested` | Queued for a transfer. Not yet claimed. |
| `processing` | Claimed. The wallet call may already have broadcast. |
| `completed` | Settled. The constraint requires a non-empty `tx_hash`. |
| `needs_review` | Quarantined. The constraint requires a non-empty `error_message`. |

Only `requested` rows may be claimed. No code path moves `processing` back to `requested`,
so a crash or a lost wallet response can never produce an automatic second transfer.

## Retry rules

- A payout in `processing`, `needs_review`, or any state carrying a transaction hash must
  never be retried. Absence of a matching transfer in wallet history is not proof that no
  broadcast occurred.
- `POST /api/admin/payouts/:id/retry` accepts only a hashless `failed` or
  `permanently_failed` row and requires an explicit `confirm` (query parameter or JSON body);
  anything else returns 409 or 400. The dashboard exposes the Retry button only for those
  rows and sends the confirmation after a local prompt. The update predicate re-checks every
  safety condition, so a concurrent status change cannot be overwritten.
- Use the retry action only after proving the recorded error happened before broadcast and
  confirming that wallet history contains no matching transfer.
- There is no resend action for any refund state, in the dashboard or the API.

## Reconciliation checklist

1. Preserve the database row, service logs, wallet files, and current backups before
   changing anything.
2. Match currency and network, destination, exact atomic amount, creation and processing
   times, transaction hash if present, and wallet outgoing-transfer history.
3. If a matching wallet transfer exists, record its hash and confirmation evidence in an
   audited remediation. Do not create a replacement transfer.
4. If no transfer appears, treat that as inconclusive until the wallet is synchronized and
   the relevant time window and mempool have been checked. Escalate ambiguous cases instead
   of retrying.
5. Re-run the read-only audit, `scripts/deploy/financial-audit.sql`, after any reviewed
   database remediation and retain the before and after evidence with the incident record.

## Alerts

`AlertService` runs periodic checks over the same aggregate states and sends two financial
alerts: one for any payout or refund in `needs_review`, and one for payout `processing` rows
or refund `requested`/`processing` rows that have not moved within `FINANCIAL_REVIEW_STALE_MS`
(default 900000, that is 15 minutes). Both resolve automatically once their count returns to
zero. Alerts are read-only: they never move, retry, or cancel a transfer.

Environment variables referenced here are documented in `src/.env.example`.

## No generic resolve endpoint

There is deliberately no "mark resolved" endpoint. A reviewed state transition needs a
case-specific, audited remediation because the correct result depends on wallet evidence and
on whether value was actually transferred.
