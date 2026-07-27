# Production disclosures and paid-action gate

The server derives its public disclosures from its own runtime switches, so the words shown to a
player describe the free, paid-prestige, payout, test-network, and PvP configuration that instance
actually runs. Nothing here asserts that a deployment is licensed or lawful in a particular place.
Obtain jurisdiction-specific advice before accepting assets with real value.

Implementation: `src/config/commerceDisclosurePolicy.js` (disclosure generation and acknowledgement
validation), `src/config/operatedProductProfiles.js` (operated-product contracts),
`src/config/environmentValidator.js` (startup and preflight checks),
`html/js/legal/commerceConsent.js` (browser acknowledgement), `src/views/legalPages.js`
(`/terms`, `/privacy`, `/responsible-play`).

## Operated-product boundary

Such Software (`apps@such.software`) operates two public services and nothing else.

| Profile | Service | Policy version | Scope |
|---|---|---|---|
| `such-play-wow-prestige` | `play.wowne.ro` | `2026-07-22-v1`, effective `2026-07-22` | Wownero mainnet free play plus pay-for-credits leaderboard and prestige play. Credits are non-redeemable service entitlements. No prizes, payouts, cash-out, or crypto racing, and the service is not offered or marketed as gambling. Legal classification depends on applicable law. |
| `such-monerogue-stagenet` | `monerogue.app` | `2026-07-23-v2`, effective `2026-07-23` | Monero stagenet direct-entry solo play only. The single-player 2x and 3x outcomes are test gambling mechanics using test coins with **NO REAL VALUE**. Purchased-credit entry and crypto-match payouts are off. Never mainnet XMR. |

Setting `OPERATED_PRODUCT_PROFILE` to one of those identifiers opts a deployment into a fail-closed
startup contract. Preflight (`npm run preflight`) and normal startup reject any drift from the
profile in:

- `HOSTED_BY` public root, `OPERATOR_NAME`, `OPERATOR_CONTACT_URL`, `OPERATOR_CONTACT_LABEL`;
- `LEGAL_POLICY_VERSION` and `TERMS_EFFECTIVE_DATE`;
- `CRYPTO_TYPE`, `MONERO_NETWORK`, `GAME_MODE`, and `PAYMENT_MODES`;
- direct/credits mode switches, every payout switch, and `ALLOW_MAINNET_PAYOUTS`;
- the stagenet product's exact `DIRECT_PAYOUT_ESCAPE=2` and `DIRECT_PAYOUT_TREASURE=3` multipliers;
- the product catalog: no standalone products, and a credit package may grant only its top-level
  credits and bonus. The whole `grants` object is rejected, including keys added later, so a new
  entitlement cannot silently widen the public product contract.

Independent MIT self-hosts leave `OPERATED_PRODUCT_PROFILE` unset and configure a truthful operator
identity of their own; none of the profile constraints apply to them. Reference environments are
`src/.env.mainnet.example` and `src/.env.stagenet.example`; the full annotated template is
`src/.env.example`.

## Open-source and operator disclaimer

MIT permission to use, copy, modify, merge, publish, distribute, sublicense, and sell copies is
subject to retaining the copyright and permission notice in all copies or substantial portions. The
software is provided "AS IS", without warranty of any kind, as stated in `LICENSE`. The MIT License
governs rights in the source. Documentation, examples, and disclosure copy are informational only;
they are not legal advice or a determination that a deployment complies with applicable law.

A third-party or self-hosted operator is solely responsible for its deployment, product design,
legal compliance, funds, players, representations, and support. The MIT License does not make that
deployment a Such Software service or authorize it to claim Such Software sponsorship or
endorsement. Such Software does not operate, supervise, endorse, or accept responsibility for
third-party deployments.

## Required production settings

With `NODE_ENV=production` and payments resolved as enabled, startup and preflight fail unless each
of these is explicit and valid:

```dotenv
OPERATOR_NAME=Truthful responsible operator name
OPERATOR_CONTACT_URL=mailto:support@example.com
LEGAL_POLICY_VERSION=2026-07-22-v1
TERMS_EFFECTIVE_DATE=2026-07-22
MINIMUM_AGE=18
PAID_ACKNOWLEDGEMENT_REQUIRED=true
```

Constraints: `OPERATOR_NAME` is 2 to 120 characters and may not contain placeholder text;
`OPERATOR_CONTACT_URL` must parse as an `https:` or `mailto:` URL without placeholder text;
`LEGAL_POLICY_VERSION` is 1 to 64 characters of `[A-Za-z0-9._-]` starting alphanumeric;
`TERMS_EFFECTIVE_DATE` is a real `YYYY-MM-DD` date; `MINIMUM_AGE` is an integer from 18 through 120.

`OPERATOR_CONTACT_LABEL` is optional. Without it the disclosure derives a label from the contact
URL. An operated product profile does require its exact configured value.

`RESTRICTED_LOCATIONS_NOTICE` is optional application copy. Add it only after legal review; text is
not geofencing.

Changing the terms or any material disclosure requires a new `LEGAL_POLICY_VERSION`. That
invalidates every prior browser-session acknowledgement.

### Match fairness timing

Production with `MATCH_ENABLED=true` also requires explicit paid-fairness timing, even when only
prestige credits are exposed:

```dotenv
MATCH_PAID_ENTROPY_DELAY_BLOCKS=2
MATCH_PAID_ENTROPY_CONFIRMATIONS=2
```

Both are safe integers from 2 through 100. A paid match freezes its entry set, commits to a target
block `DELAY_BLOCKS` ahead, and derives its seed only from a header confirmed to the configured
depth. The persisted proof records the derivation, the confirmation requirement, the minimum
confirmed tip height, and the pre-commit daemon-tip witness with its timestamp, so changing these
settings later cannot reinterpret an already-frozen match.

## Enforcement contract

- `/api/disclosures` returns non-secret, `no-store` policy data derived from runtime switches.
- `/terms`, `/privacy`, and `/responsible-play` render the active mode and operator metadata.
- Before a payment invoice, paid solo or credit entry, or a paid PvP queue join, the browser
  presents unchecked age, terms-read, and risk boxes and enables the continue button only when all
  are selected. Test networks add a mainnet/test-coin box.
- Acceptance is a five-field canonical record: `policyVersion` plus `ageEligible`, `termsRead`,
  `riskAccepted`, and `testnetUnderstood`. It lives in `sessionStorage`, so it is scoped to the
  browser tab and to the exact policy version, and it is cleared on cancel, on a version mismatch,
  and on socket disconnect.
- The server independently validates the exact current version and every boolean before consuming a
  fairness offer, opening an invoice, consuming a credit, or escrowing a paid PvP entry. The check
  runs at each of those handlers, so a modified client cannot bypass it.
- The paid-action requirement does not lapse when invoice intake is paused: already-purchased
  credits and race tickets still carry value and are still gated.
- Free entry stays available without a paid acknowledgement where the instance offers it. Early
  entry is treated as free only on a free-only instance, because mixed and credits instances may
  consume a credit.

The acknowledgement is a player statement. It does not verify identity, age, capacity, or location.

## Mode language

| Runtime mode | Player-facing contract |
|---|---|
| Free | No entry payment; free leaderboard; no free payout |
| Paid, payouts off | Entry, credits, or product purchase and paid prestige leaderboard; no cryptocurrency prize |
| Paid, solo payouts on | The full entry can be lost; only outcomes and amounts shown before entry qualify |
| Crypto PvP on | Paid ticket escrow and the configured winner/fee contract; separate from free and prestige PvP |
| XMR stagenet/testnet | Valueless test currency; explicit warning never to send mainnet XMR |

For the operated products the generic rows narrow further: `play.wowne.ro` exposes purchased credits
only, offers no payout or cash-out, and is not marketed as gambling; `monerogue.app` labels its
direct-entry 2x and 3x stagenet mechanics as **NO REAL VALUE** and keeps purchased-credit entry and
crypto-match payouts disabled.

## Operator decisions before enabling real-value modes

Disclosure copy and checkboxes are product safety controls, not a substitute for the following. A
responsible operator records decisions on each before exposing a real-value mode:

1. entity and operator identity, licences and registrations, permitted and excluded locations;
2. age and location verification appropriate to those locations;
3. consumer terms: refunds, late, under, and overpayments, complaints, dispute venue, and downtime;
4. privacy roles, processors, retention and deletion schedule, user-rights procedure, breach
   response, and whether a privacy-minimized durable acknowledgement record is legally required;
5. responsible-play features such as account-level deposit, time, and loss limits, and durable
   self-exclusion;
6. tax, sanctions and AML, accounting, and cryptocurrency reporting obligations;
7. an independent review of game rules, advertised multipliers, house fee, bankroll, and
   provable-fair claims.

Stagenet exercises end-to-end mechanics without representing test coins as money. Mainnet payouts
are a separate, explicit operational and legal decision.

## Front-end dependency notes

The same-origin jQuery copy is 3.7.1 from the Ubuntu `libjs-jquery` package; exact provenance and
SHA-256 are in `html/js/lib/jquery-3.7.1.PROVENANCE.md`. No runtime CDN or package-registry request
is needed to serve it.

Third-party renderer code executes with the same privileges as the game and payment UI, so CDN
execution is off unless an operator sets `RENDERER_CDN_ENABLED=true`. Enabling it adds
`cdn.jsdelivr.net` to `script-src` and `connect-src` and logs a warning in production. The
Three.js build served from `/vendor/three/<version>` is same-origin.

The CSP permits inline script and style because current pages depend on them. A nonce migration has
to move every inline handler and script first; a partial tightening removes payment and game
controls from the page.
