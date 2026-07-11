# Monetization — credits, catalog & entitlements (P1)

One unit of account (**credits**), one operator-owned **catalog**, and a tiered **entitlement** rule that
decides who has unlocked which cosmetics — and now doubles as the premium-subscription payoff.

## Credits

Credits are the unit of account. A direct/single-game entry is modeled as *buy 1 credit + spend 1 credit*
(`gameModeManager.recordDirectEntryPurchase`) so it advances `total_credits_purchased` and unlocks the same
threshold cosmetics as a real credit purchase. Payouts are orthogonal to credits.

## The catalog

`cosmetic_catalog` (migration `024`) is the operator-owned product table — it replaces the old hardcoded,
split-brain `PACKS` (server + client). Columns: `pack_id, label, kind, projection, tier, unlock_min_credits,
grant_only, sort_order, active, metadata`.

`src/services/catalogService.js` loads + caches it, falling back to `DEFAULT_CATALOG` if the table is
missing (42P01) or empty — so the game runs before the migration and never hard-fails on catalog reads.
The server ships `catalogSummary()` to the client, which merges it into `RK.PACKS` — the client no longer
owns a parallel catalog.

## The unlock rule

`src/multiplayer/entitlements.js` — `snapshotForUser(user, grants, catalog)`. A pack unlocks if **any** of:

```
1. it's free (tier 0, no gate)
2. an explicit grant (products → grants)
3. lifetime spend ≥ the pack's unlock_min_credits threshold
4. the user's premium TIER ≥ the pack's tier
```

`TIER_OF = { free:0, credits:0, supporter:1, premium:2, operator:3 }`. Clause 4 is the premium hook.
**Buying credits does NOT put you on the premium ladder** (`credits` → tier 0) — that was the old bug where
any purchase unlocked every premium pack.

## Premium subscription → cosmetics

`levelForUser(user)` returns the **higher** of the stored `premium_level` and an active
`subscription_tier`. So a live **wowne.ro premium subscription** sets the entitlement tier, which unlocks
tile/customization packs at/below it — **one subscription drives both chat perks and cosmetics** (see
[CHAT_AND_NOSTR.md](CHAT_AND_NOSTR.md)).

Everything downstream — pack gating, the served catalog, the client unlock UI — already consumes `tier`, so
"premium buys cosmetics" is a **data-source** change: populate `user.subscription_tier` from a subscription
check (against the premium backend / npub) when the user is loaded. Absent ⇒ unchanged legacy behavior.

```
active premium sub ──► user.subscription_tier ──► levelForUser ──► entitlement tier
                                                                     ├─ relay: chat perks (badge, no-PoW, VIP)
                                                                     └─ catalog: tile / skin / customization unlocks
```

## Files

```
src/migrations/024_cosmetic_catalog.sql   operator-owned catalog table
src/services/catalogService.js            load/cache + DEFAULT_CATALOG fallback
src/multiplayer/entitlements.js           snapshotForUser · levelForUser · TIER_OF · unlock rule
src/network/identityService.js            entitlementsForUser (loads catalog + grants)
src/game/gameModeManager.js               recordDirectEntryPurchase (direct entry = 1 credit)
html/js/render/assetPacks.js              client consumes the served catalog
```

## Open decisions

- Premium tiers: one flat "premium," or a ladder (supporter/premium/operator) where each rung unlocks
  progressively more cosmetics *and* chat perks? (`TIER_OF` already has the rungs.)
- Where `subscription_tier` is sourced (sync a `users` column vs. live oracle query against the premium
  backend by npub).
