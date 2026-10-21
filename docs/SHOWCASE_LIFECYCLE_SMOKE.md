---
title: Local multiplayer lifecycle rehearsal
status: active
updated: 2026-10-21
owner: Wowngeon
type: testing-guide
---

# Local multiplayer lifecycle rehearsal

Run `npm run test:showcase-lifecycle` from `src/` on the Linux developer workstation. It needs the repository's installed npm dependencies, PostgreSQL `initdb` and `pg_ctl` binaries, and the cached Playwright Chromium browser. It does not install dependencies or contact production services.

The runner starts a fresh PostgreSQL cluster using a private Unix socket under its output directory, runs the actual application and migrations with anonymous browser sessions, then opens two isolated browser contexts. It drives the real free queue through the existing simulated block source, whose normal fixture cadence is 30 seconds, completes an Escape Race through keyboard movement, and verifies the persisted zero-fee result and empty financial ledgers. Payments, payouts, wallet RPC setup, and external browser egress are disabled.

Each run creates a new mode-0700 directory under `~/Build/wowngeon/showcase-lifecycle/`; it never overwrites earlier evidence. Pass `--output-root PATH` to choose another private output root, using only letters, digits, slash, dot, underscore, or hyphen. The run report includes screenshot paths and sanitized match metadata. Browser cookies, session tokens, profiles, wallet state, and database contents are not copied into the report.

## Acceptance checklist

- [ ] The actual queue, simulated-block scheduler and countdown start both clients.
- [ ] Keyboard input reaches the authoritative exit and the database records the result.
- [ ] The client returns to Tavern and financial ledgers remain empty.
- [ ] No external request, browser error or unexpected HTTP failure occurs.
- [ ] The application and disposable PostgreSQL server stop after the run.

This is a local source rehearsal. Installed-wallet and deployed acceptance remain separate in
[Showcase qualification](SHOWCASE_QUALIFICATION.md).
