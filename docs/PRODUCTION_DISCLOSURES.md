# Production disclosures and paid-action gate

This implementation makes the running server describe its actual free, paid-prestige, payout,
test-network, and PvP switches. It does **not** claim that the product is licensed or lawful in a
particular place. Obtain jurisdiction-specific advice before accepting assets with real value.

## Required production settings

Every production instance with `PAYMENTS_ENABLED=true` fails preflight/startup unless all of these
are explicit and valid:

```dotenv
OPERATOR_NAME=Truthful responsible operator name
OPERATOR_CONTACT_URL=mailto:support@example.com
OPERATOR_CONTACT_LABEL=Support
LEGAL_POLICY_VERSION=2026-07-21-v1
TERMS_EFFECTIVE_DATE=2026-07-21
MINIMUM_AGE=18
PAID_ACKNOWLEDGEMENT_REQUIRED=true
```

Production match mode also requires explicit paid-fairness timing, even if only prestige credits
are presently exposed:

```dotenv
MATCH_PAID_ENTROPY_DELAY_BLOCKS=2
MATCH_PAID_ENTROPY_CONFIRMATIONS=2
```

Both are bounded safe integers from 2 through 100. Paid PvP persists the actual delay,
confirmation requirement, activation threshold, and post-commit daemon-tip witness in its public
proof; changing these settings does not reinterpret an already-frozen match.

`RESTRICTED_LOCATIONS_NOTICE` is optional application copy. Add it only after legal review; text is
not geofencing. Changing the terms or material disclosures requires a new `LEGAL_POLICY_VERSION`,
which invalidates prior browser-session acknowledgements.

## Enforcement contract

- `/api/disclosures` returns non-secret, no-store policy data derived from runtime switches.
- `/terms`, `/privacy`, and `/responsible-play` render the active mode and operator metadata.
- Before a payment invoice, paid solo/credit entry, or paid PvP queue join, the browser requires
  unselected age/reading/risk boxes. Test networks require an additional mainnet/test-coin box.
- Acceptance is a five-field canonical record (policy version plus four booleans), scoped to the
  current browser tab and policy version, and cleared on rejection or socket disconnect.
- The server validates the exact current version and booleans before consuming a fairness offer,
  opening an invoice, consuming a credit, or escrowing a paid PvP entry. A modified client cannot
  bypass this check.
- Free entry remains available without a paid acknowledgement where the instance offers it.

The acknowledgement is a player statement, not proof of identity, age, capacity, or location.

## Mode language

| Runtime mode | Player-facing contract |
|---|---|
| Free | No entry payment; free leaderboard; no free payout |
| Paid, payouts off | Entry/credits/product purchase and paid prestige leaderboard; no crypto prize |
| Paid, solo payouts on | Full entry can be lost; only pre-entry recorded outcomes/amounts qualify |
| Crypto PvP on | Paid ticket escrow and configured winner/fee contract; separate from free/prestige PvP |
| XMR stagenet/testnet | Valueless test currency; explicit warning never to send mainnet XMR |

## Unresolved launch decisions

Technical copy and checkboxes do not resolve these. Keep real-value modes gated until the responsible
operator records decisions for:

1. entity/operator identity, licences/registrations, permitted and excluded locations;
2. age and location verification appropriate to those locations;
3. consumer terms: refunds, late/under/overpayments, complaints, dispute venue, and downtime;
4. privacy roles, processors, retention/deletion schedule, user-rights procedure, breach response,
   and whether a privacy-minimized durable acknowledgement record is legally required;
5. responsible-play features such as account-level deposit/time/loss limits and durable self-exclusion;
6. tax, sanctions/AML, accounting, and cryptocurrency reporting obligations;
7. an independent review of game rules, advertised multipliers, house fee, bankroll, and provable-fair claims.

Stagenet can be used for end-to-end mechanics without representing test coins as money. Mainnet
payouts remain a separate, explicit operational and legal decision.

## Front-end dependency note

The same-origin jQuery copy is 3.7.1 from the Ubuntu `libjs-jquery` package; exact provenance and
SHA-256 are in `html/js/lib/jquery-3.7.1.PROVENANCE.md`. The CSP still permits inline script/style
because current pages depend on them. A nonce migration must move every inline handler/script before
removing `unsafe-inline`; do not partially tighten it and strand payment/game controls.
