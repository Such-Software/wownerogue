---
title: Wowngeon showcase qualification
status: active
updated: 2026-10-21
owner: Wowngeon
type: testing-guide
---

# Showcase qualification

The first multiplayer showcase is the existing Escape Race: players share a dungeon and the first
exit wins. Combat PvP and a new cooperative game mode are separate product work. The initial visual
baseline is Tavern and Escape Race in Tiled, ASCII, and Iso. Three.js has separate runtime delivery
requirements and is not qualified by these checks.

## Fundless source checks

Install the locked graph and run the full source suite from `src`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Release artifact tests require GNU build tools on Linux. A macOS run without those tools cannot
qualify the release builder. A passing source suite does not prove a deployed game or installed
wallet works.

Run `npm run test:showcase-browser` from `src` with the cached Playwright Chromium available. The harness
uses the real Tavern manager and two fresh browser clients on a loopback-only server. It verifies
movement, chat, keyboard focus, mobile controls, missing-sheet failure, and Tiled/ASCII/Iso drawing.
Its synthetic Iso grant is a fixture, not evidence of purchased or production entitlements. Browser
output belongs under `~/Build/wowngeon`. No wallet extension, application database, or chain node is
used. See the script's usage for the output location.

For authoritative multiplayer Escape Race captures, follow [PVP_CAPTURE.md](PVP_CAPTURE.md). Run
`race` with each of `tiles`, `ascii`, and `iso`; require a decisive first exit and matching final
state hashes for the same seed. The capture imports the actual match engine but uses synthetic
players. It does not qualify the deployed scheduler, queue UI, account restoration, or Tavern-to-match
navigation.

For a fresh PostgreSQL cluster and the actual application entrypoint, run the two-browser
[local lifecycle rehearsal](SHOWCASE_LIFECYCLE_SMOKE.md). It covers the free queue, real scheduler
and countdown, keyboard-driven Escape Race, persisted result, and return to Tavern. It uses the
local simulated-block source and has no wallet or payment authority.

## Smirk checkout contract

Invoice delivery and reconnect restoration never open a wallet prompt. The user first sees the
invoice, then chooses **Pay with Smirk**. The game requires an explicitly enabled WOW mainnet
capability, an authenticated invoice owner, a valid expiry, and an exact decimal amount matching the
atomic accounting amount. Wallet review receives `memo`, not an invented description parameter.

Browser storage and Web Locks retain one submission attempt per invoice across tabs and reloads.
A positive wallet response with a transaction ID means submitted, not confirmed. False, missing,
malformed, and transport-failure results never grant credits. Unknown submission must be reconciled
against wallet history and backend invoice status before further payment. Backend receipt evidence
alone grants credits. See [PAYMENTS.md](PAYMENTS.md).

Existing Nostr identity remains the login method when available. Login failures never silently
switch to a different identity proof. WOW payment permission is explicit and separate from the
backend account link. Unknown networks and Monero stagenet refuse Smirk checkout.

## Installed-artifact and live acceptance

Before promoting the site as a wallet showcase, record the exact game release commit and installed
Smirk extension artifact. Use an explicitly authorized bounded purchase in a dedicated demonstration
wallet. Verify first connection, denied permission, returning-account recovery, subaddress payment,
backend-confirmed credit grant, and a reconnect without duplicate payment. Mock wallet tests do not
satisfy this acceptance.

Then qualify two real clients through Tavern, queue, countdown, Escape Race, result, and return to
Tavern. Exercise queue reconnect and active-match reconnect, with keyboard and touch controls. Verify
premium visual grants using actual entitlement evidence. Keep free and prestige-credit play within
the reviewed product policy; do not enable cash-out, direct-entry payments, or crypto-race payouts.

Production activation belongs to Fleet through a reviewed plan, source gate, and check/diff. A source
merge or local capture is not live deployment evidence.

## Acceptance checklist

- [ ] Full source suite passed on the supported Linux toolchain.
- [ ] Tavern browser smoke passed against the candidate source.
- [ ] Escape Race completed in Tiled, ASCII, and Iso with consistent authoritative results.
- [ ] Exact installed Smirk artifact passed account recovery and bounded payment acceptance.
- [ ] Two-client queue, reconnect, match, and return journey passed on the deployed candidate.
- [ ] Live source binding and Fleet activation evidence recorded separately.
