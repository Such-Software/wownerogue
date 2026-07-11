# Payments (P3)

The game no longer implements per-chain wallet/daemon code inline. It talks to pluggable **payment
providers** behind one contract, so an operator routes each chain to whichever backend they run.

## The contract

`src/payments/providers/paymentProvider.js`:

```
createInvoice({chain, amountAtomic, description, userId, orderId})
    → {invoiceId, address, uri, amountAtomic, expiresAt, raw}
getInvoiceStatus(ref)   → {status, complete, paidAtomic, confirmations, raw}
startWatch(ref, onUpdate, intervalMs)   /  stopWatch(ref)
sendPayout({chain, address, amountAtomic})  → {txids, raw}
validateAddress(chain, address)  → {valid}
supportsChain(chain)  → bool
```

`PaymentProviderRegistry` routes `chain → providerId` (operator-configurable) with a support-based
fallback: if the routed provider can't serve a chain, any registered provider that *can* is used.

## The providers

| Provider | id | Serves | Notes |
|----------|-----|--------|-------|
| **BTCPay Greenfield** | `btcpay` | BTC, LTC | `src/payments/providers/btcpayProvider.js` — real BTCPay Server. Invoice priced in the chain's own crypto; address read from the invoice payment-methods; `token` auth. |
| **xmrcheckout** | `xmrcheckout` | XMR | Same class, different endpoint — the checkout app exposes a **BTCPay-Greenfield-compatible** shim. |
| **wowcheckout** | `wowcheckout` | WOW | Ditto (matched pair to xmrcheckout). |
| **Native Monero** | `native-monero` | XMR, WOW | `src/payments/providers/nativeMoneroProvider.js` — wraps the existing `walletRPCService` (subaddress invoicing + `transfer_split` payouts). |

The key discovery: **BTCPay, xmrcheckout, and wowcheckout all speak one Greenfield contract**, so a single
`BTCPayProvider` class (constructor-configurable `id`) serves all three — just registered at different
endpoints. See the `btcpay-infra-topology` note for the operator's LAN endpoints.

## Bootstrap & routing

`buildProviderRegistry({env, walletService})` (`src/payments/providers/index.js`) is the single wiring seam:

- Native Monero/Wownero provider registers whenever a `walletService` exists.
- Each Greenfield gateway activates from its own env trio:
  `BTCPAY_URL/_STORE_ID/_API_KEY` (chains from `BTCPAY_CHAINS`, default BTC,LTC),
  `XMRCHECKOUT_URL/_STORE_ID/_API_KEY` (XMR), `WOWCHECKOUT_URL/_STORE_ID/_API_KEY` (WOW).
- Default routing: BTC/LTC → btcpay, XMR/WOW → their checkout gateway (else native). `PAYMENT_ROUTING`
  (`CHAIN:provider,…` or JSON) overrides any mapping.

**Behavior-preserving:** with no gateway env set (prod today), only the native provider registers and
*every* chain routes to it — byte-for-byte the legacy flow.

## The hot path

- **Invoice creation** — `gameModeManager.createPaymentRequest` calls `getProvider(cryptoType).createInvoice(...)`.
  The native provider delegates to the same `walletService.createPaymentRequest`, so the subaddress and
  monitoring maps are identical to before.
- **Monitoring** — `network/paymentHandlers._monitorAddress` calls `provider.startWatch`. Native passes the
  raw wallet status straight through (legacy path unchanged); `BTCPayProvider.getWalletStatus` maps a
  Greenfield invoice to the same raw shape (`Settled → confirmed+complete`, `Processing → in_mempool`,
  paid/required amounts from payment-methods via `ChainProfile` decimals). The confirmation logic is
  extracted to `_handlePaymentStatus`, shared by native + gateway.
- **Payouts** stay native (the checkout apps are receive-only; XMR/WOW payouts remain on wallet-RPC).

## Turning a gateway on

1. Mint a store API key in the gateway's admin (money infra — a human step).
2. Set the `*_URL/_STORE_ID/_API_KEY` env on the deploy host, using an address the host can actually reach
   (verify LAN reachability; a nebula/overlay IP may not route).
3. Restart. Invoices for that chain now create + confirm through the gateway; no code redeploy.

## Money math

All amounts are **atomic BigInt**, decimals-parameterized via `src/money/atomic.js` (`format`, `add`,
`mulByDecimal`, …) and `src/chain/chainProfile.js` (`decimalsFor`, `atomicDivisor`). Never floats. WOW = 11
decimals, XMR/BTC/LTC per their chain, GRIN = 9.

## Files

```
src/payments/providers/paymentProvider.js      contract + registry
src/payments/providers/btcpayProvider.js        Greenfield client (btcpay / xmrcheckout / wowcheckout)
src/payments/providers/nativeMoneroProvider.js  wraps walletRPCService
src/payments/providers/index.js                 buildProviderRegistry (env → registry)
src/payments/walletRPCService.js                Monero/Wownero wallet-RPC
src/game/gameModeManager.js                     createPaymentRequest (invoice seam)
src/network/paymentHandlers.js                  _monitorAddress / _handlePaymentStatus (monitoring seam)
```
