# Payments

The game does not implement per-chain wallet or daemon code inline. It talks to pluggable **payment
providers** behind one contract, so an operator routes each chain to whichever backend they run.

## Provider contract

`src/payments/providers/paymentProvider.js` defines the interface. All amounts are atomic units for
the chain (BigInt or an integer-valued string), never decimal floats.

```
createInvoice({chain, amountAtomic, description, userId, orderId})
    -> {invoiceId, address, uri, amountAtomic, expiresAt, raw}
getInvoiceStatus(ref)
    -> {status: 'pending'|'processing'|'paid'|'expired'|'invalid', complete, paidAtomic, confirmations, raw}
startWatch(ref, onUpdate, intervalMs)   /  stopWatch(ref)
sendPayout({chain, address, amountAtomic})  -> {txids, raw}     (optional)
validateAddress(chain, address)  -> {valid, reason}             (optional)
supportsChain(chain)  -> boolean
```

`PaymentProviderRegistry` maps `chain -> providerId` and is operator-configurable. `getProvider(chain)`
returns the routed provider; if that provider does not support the chain, the registry falls back to
any registered provider that does, and finally to the default provider.

## Providers

| Provider | id | Serves | Implementation |
|----------|-----|--------|----------------|
| BTCPay Greenfield | `btcpay` | BTC, LTC by default | `src/payments/providers/btcpayProvider.js`, a BTCPay Server client |
| xmrcheckout | `xmrcheckout` | XMR | Same class against a checkout app that exposes Greenfield-compatible routes |
| wowcheckout | `wowcheckout` | WOW | Same class, matched pair to xmrcheckout |
| Native Monero/Wownero | `native-monero` | XMR, WOW | `src/payments/providers/nativeMoneroProvider.js`, wraps `walletRPCService` |

BTCPay, xmrcheckout, and wowcheckout all speak the same Greenfield contract, so one `BTCPayProvider`
class with a constructor-configurable `id` serves all three; they differ only in base URL, store id,
API key, and chain set. Auth on all three is `Authorization: token <apiKey>`. Invoices are priced in
the chain's own crypto by passing the chain ticker as the Greenfield `currency`, and the receiving
address is read from the invoice's payment-methods endpoint.

The native provider keys invoices by their Monero/Wownero subaddress and returns the wallet's
`addressIndex`, which is what lets monitoring be restored after a restart.

## Bootstrap and routing

`buildProviderRegistry({env, walletService})` in `src/payments/providers/index.js` is the single
wiring seam:

- The native provider is registered whenever a `walletService` is supplied, and claims XMR and WOW.
- Each Greenfield gateway activates from its own environment trio:
  `BTCPAY_URL` / `BTCPAY_STORE_ID` / `BTCPAY_API_KEY` (chain list from `BTCPAY_CHAINS`, default
  `BTC,LTC`), `XMRCHECKOUT_URL` / `_STORE_ID` / `_API_KEY` (XMR), and
  `WOWCHECKOUT_URL` / `_STORE_ID` / `_API_KEY` (WOW).
- A dedicated checkout gateway wins over native for its own chain.
- `PAYMENT_ROUTING` overrides every mapping. It accepts JSON (`{"BTC":"btcpay","XMR":"native-monero"}`)
  or a compact `CHAIN:provider,CHAIN:provider` string; unparseable values are ignored.
- The default provider, used for chains with no explicit route, is the native provider when present,
  otherwise the first registered gateway.

With no gateway environment set, only the native provider is registered and every chain routes to it,
which is the single-chain wallet-RPC flow. `GameModeManager` builds this registry in its constructor
unless one is injected.

The general environment template is `src/.env.example`. The gateway variables above are read straight
from the process environment; add them to the deploy host's environment when enabling a gateway.

## Invoice lifecycle

**Creation.** `gameModeManager.createPaymentRequest` resolves the provider for `CRYPTO_TYPE` and calls
`createInvoice`. Any stale `pending` payments for the user are expired first, so a user holds at most
one active invoice. The row is inserted into `payments` with `provider_id`, `provider_invoice_id`,
`address_index`, the expected atomic amount, product grants, and the fairness commitment fields.
Invoices expire at the provider-supplied `expiresAt`, or 30 minutes from creation when the provider
does not supply one.

**Monitoring.** `network/paymentHandlers._monitorAddress` records a socket-to-payment mapping, arms a
30 minute expiry timer, and calls `provider.startWatch(watchRef, onStatus, 2000)`. The watch reference
is the subaddress for the native provider and the invoice id for a gateway. `onStatus` receives a raw
wallet-style status (`in_mempool`, `confirmed`, `complete`, `amount`, `required`, `confirmations`,
`receipts`): the native provider passes the wallet's own status through untouched, and
`BTCPayProvider.getWalletStatus` maps a Greenfield invoice into the same shape (`Settled` and
`Complete` become confirmed and complete, `Processing` becomes in-mempool, paid and required amounts
come from the payment-methods response converted through `ChainProfile` decimals). Both feed the one
handler, `_handlePaymentStatus`.

**Confirmation.** A mempool sighting queues a single-game entry or announces a pending purchase; a
confirmed status applies the entitlement. Underpayment emits `payment_underpaid` and leaves the
invoice open so the balance can be topped up to the same address. Confirmation is idempotent: an
in-memory set is only a fast path, and the database status transition under `FOR UPDATE` is the source
of truth, so a restart cannot double-apply. When paid fairness binding is required, an entry whose
invoice carries no bound fairness proof is refused at both the queue and confirm steps and reported as
`payment_review_required` rather than started.

**Receipt evidence.** Every confirmation must be backed by durable receipts in `payment_receipts`
(migration `037_payment_receipt_evidence.sql`). Native receipts are `chain_output` rows identified by
`txHash:outputId` and carrying the invoice's `address_index`; gateway receipts are `provider_invoice`
rows identified by the invoice id. A unique index on `(provider_id, evidence_id)` makes each piece of
evidence consumable exactly once, and a database trigger rejects any transition into `confirmed` whose
confirmed receipts do not cover `expected_amount`. This is why one transaction with several outputs,
or one invoice topped up by several transactions, both settle correctly.

**Late payments.** `src/services/latePaymentReconciler.js` scans expired invoices, re-reads status
through the owning provider (`getWalletStatus` for gateways, wallet RPC for native), and records
durable evidence in `payment_late_reviews` for manual adjudication. A late receipt never grants an
entitlement on its own. See [FINANCIAL_RECONCILIATION.md](FINANCIAL_RECONCILIATION.md).

## Payouts

Payouts run through the native wallet service, not through the routed provider: the checkout gateways
are receive-only. `gameModeManager` sends winnings via `walletService.processPayout` for single
payouts and `processBatchPayout` for batches, both of which use `transfer_split` and return
`tx_hash_list`. `src/payments/payoutRetryService.js` retries failures. `NativeMoneroProvider`
implements `sendPayout` so the contract is complete, and it delegates to the same batch call.

Payout address validation prefers `walletService.validateAddress`, which is network-aware
(mainnet/stagenet/testnet), and falls back to the provider's `validateAddress` only when the wallet
service exposes none.

Payout behaviour is gated by `PAYOUTS_ENABLED` as a master switch with subordinate per-mode flags
(`DIRECT_PAYOUTS_ENABLED`, `CREDITS_PAYOUTS_ENABLED`, `MATCH_PAYOUTS_ENABLED`). See
[PRODUCTION_DISCLOSURES.md](PRODUCTION_DISCLOSURES.md).

## Money and chain parameters

All amounts are atomic integers. Arithmetic goes through `src/money/atomic.js` (`toBig`, `toSafe`,
`sum`, `add`, `mulByDecimal`, `format`), and decimals come from `src/chain/chainProfile.js`
(`decimalsFor`, `atomicDivisor`). No floating-point money anywhere.

| Chain | Decimals | Mean block time | Family | URI scheme |
|-------|----------|-----------------|--------|------------|
| WOW | 11 | 300000 ms | monero | `wownero` |
| XMR | 12 | 120000 ms | monero | `monero` |
| BTC | 8 | 600000 ms | utxo | `bitcoin` |
| LTC | 8 | 150000 ms | utxo | `litecoin` |
| GRIN | 9 | 60000 ms | mimblewimble | `grin` |

An unknown or unset chain resolves to an XMR-shaped default (12 decimals, 120000 ms, monero family)
so a mis-set `CRYPTO_TYPE` degrades instead of crashing. `meanBlockTimeMsFor` is what block-time-aware
difficulty scales against; per-chain dungeon sizing lives in `NETWORK_TUNING` in
`src/game/difficultyConfig.js`.

Payment QR codes are generated by `src/payments/qrService.js` as `monero:` or `wownero:` URIs with
`tx_amount` and a truncated `tx_description`. It returns `null` when the optional `qrcode` package is
absent, and the address and amount are always shown as text as well.

## Enabling a gateway

1. Mint a store API key in the gateway's own admin interface.
2. Set that gateway's `*_URL`, `*_STORE_ID`, and `*_API_KEY` on the deploy host, using an address the
   host can actually reach. Verify reachability from the host itself; an overlay-network address may
   not route from the service account.
3. Restart the service. Invoices for that chain are created and confirmed through the gateway with no
   code change.

## File map

```
src/payments/providers/paymentProvider.js       contract + registry
src/payments/providers/btcpayProvider.js        Greenfield client (btcpay / xmrcheckout / wowcheckout)
src/payments/providers/nativeMoneroProvider.js  wraps walletRPCService
src/payments/providers/index.js                 buildProviderRegistry (env -> registry)
src/payments/walletRPCService.js                Monero/Wownero wallet RPC, payouts
src/payments/payoutRetryService.js              payout retry worker
src/payments/qrService.js                       payment-URI QR codes
src/chain/chainProfile.js                       decimals, block times, families, URI schemes
src/money/atomic.js                             atomic-integer money arithmetic
src/game/gameModeManager.js                     invoice creation, confirmation, receipts, payouts
src/network/paymentHandlers.js                  monitoring and status handling
src/services/latePaymentReconciler.js           post-expiry evidence and review records
src/migrations/037_payment_receipt_evidence.sql receipts, late reviews, confirmation-evidence trigger
```
