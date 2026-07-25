# `play.wowne.ro` production state — 2026-07-25

> This is a dated evidence record, not a deployment procedure or authorization to repeat an
> exceptional release path. The normal gates in [DEPLOY.md](DEPLOY.md),
> [DEPLOY_INSTANCES.md](DEPLOY_INSTANCES.md), and [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md) remain
> controlling.

## Active schema-neutral release

`play.wowne.ro` is serving the immutable release
`20260725T121348Z-28d513-overlay-a9d6f8a`. It was prepared from exact predecessor
`20260721T143902Z-28d513b29b36` and carries feature source marker
`a9d6f8a1bd1af7e77f7872629e325452ed5ae46a`.

The overlay changes only browser/static renderer and Tavern behavior plus the same-origin
Three.js runtime:

- single-player Tiled, ASCII, Iso, 3D, pack, and camera controls return keyboard focus to the game;
- Tavern entry is explicitly anonymous, waits for session readiness, exposes pending/error states,
  and remains retryable;
- Three.js `0.160.0` is loaded from versioned same-origin vendor routes;
- production CDN renderer execution remains off;
- the existing Wownero mainnet purchased-credit profile remains unchanged, with every payout path
  off.

The live database migration ledger still ends at
`038_economic_identity_immutability.sql`. The overlay neither applied nor marked migrations
039–043 and did not adopt their payment/accounting behavior.

## Verification evidence

- Complete source suite: 123 suites passed, 979 tests passed.
- Local and public readiness probes passed with PostgreSQL, Wownero daemon, and wallet dependencies
  ready.
- External HTTPS and Socket.IO/WebSocket smoke tests passed through the public domain.
- A fresh browser anonymously entered the Tavern and rendered local Three.js plus the generated GLB
  model from same-origin resources.
- Single-player mode/pack clicks retained exact `#game-display` focus; a live 3D run rendered WebGL,
  attached the animated model, and removed its temporary fallback.
- Activation rollback was exercised by failed smoke gates before the corrected release passed.

Operator-host evidence:

| Record | SHA-256 |
|---|---|
| Release manifest | `8ffd5077d906c7307094eda9f1c2332fd7d1edf1bf3b337807dc8c8e5a54b780` |
| Activation receipt | `be9ee6c8657222e11464a6e4aff6aebede067e54e83d5d70aa1cf2ac7fa5b437` |

## Full mainline cutover remains STOP-SHIP

This production state does **not** mean the complete mainline runtime artifact has been activated.
Mainline contains migrations through 043; the existing Wownerogue database remains five migrations
behind. A full cutover must not proceed until the reviewed fleet runbook's clone-validation,
daemon/wallet, accounting, drain, activation-receipt, and rollback gates all pass for the exact
candidate and predecessor.

The schema-neutral overlay is not precedent for bypassing those gates. Future activation or
rollback must use the reviewed fleet control plane with literal targets, hashes, and receipts.
