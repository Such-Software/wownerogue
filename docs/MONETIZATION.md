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
3. lifetime credits PURCHASED ≥ the pack's unlock_min_credits threshold
4. the user's premium TIER ≥ the pack's tier
```

`TIER_OF = { free:0, credits:0, supporter:1, premium:2, operator:3 }`. Clause 4 is the premium hook.
**Buying credits does NOT put you on the premium ladder** (`credits` → tier 0) — that was the old bug where
any purchase unlocked every premium pack.

### The ladder (loyalty model)

Clause 3 keys off **lifetime credits _purchased_**, cumulatively — it is **not deducted**, so buying credits
to *play* also walks you up the cosmetic ladder (cosmetics never compete with the core loop). Each catalog
row is just data — a **tilepack OR a char-skin**, at any credit rung — so the operator adds more of either by
appending a row (+ assets + `registerPack` for a client pack). This IS the "infinite packs" system.

| Rung (lifetime credits) | Unlocks |
|---|---|
| **free** | `original` bare tiles (no furniture → the "ugly tavern", by design) · plain ASCII |
| 1 | `roguelike-interior` (first premium tilepack) |
| 5 | `generated-skins` (character skins) |
| 10 | `iso-dungeon` — unlocks the **Iso** technique |
| 20 | `roguelike-dungeon` (another tilepack) |
| 40 | `iso-medieval` (second iso pack) |
| 50 | `kenney-3d-characters` — unlocks **3D** |

A render **technique** (Iso/3D) is available once the user has *any* unlocked pack for its projection, so the
cheapest pack in a projection is effectively that technique's gate. Plain ASCII stays free (accessibility).
Source of truth: `cosmetic_catalog` table (migration 028) mirrored by `DEFAULT_CATALOG` in `entitlements.js`.

## Premium subscription → cosmetics

`levelForUser(user)` returns the **higher** of the stored `premium_level` and an active
`subscription_tier`. So a live **wowne.ro premium subscription** sets the entitlement tier, which unlocks
tile/customization packs at/below it — **one subscription drives both chat perks and cosmetics** (see
[CHAT_AND_NOSTR.md](CHAT_AND_NOSTR.md)).

Everything downstream — pack gating, the served catalog, the client unlock UI — already consumes `tier`.
The data source is `src/services/subscriptionService.js` (`SubscriptionService.tierForNpub`), which
`identityService.entitlementsForUser` calls to populate `user.subscription_tier` before the snapshot:

```
active premium sub ──► SubscriptionService.tierForNpub(npub) ──► user.subscription_tier ──► levelForUser ──► tier
                                                                                              ├─ relay: chat perks (badge, no-PoW, VIP)
                                                                                              └─ catalog: tile / skin / customization unlocks
```

Two sources, checked in order (both optional — absent ⇒ tier null ⇒ unchanged legacy behavior):

| Env | Meaning |
|-----|---------|
| `PREMIUM_NPUBS` | operator allowlist `npub1…\|hex[:tier],…` — works **today**, zero backend dependency |
| `PREMIUM_DEFAULT_TIER` | tier for allowlist entries without an explicit `:tier` (default `premium`) |
| `SMIRK_PREMIUM_STATUS_URL` / `_KEY` | optional HTTP endpoint answering premium-by-npub `{active, tier?}`, for full automation |

> The Smirk backend's `/premium/status` is **self-only** (user-token auth), so the game can't look up
> an arbitrary npub through it. Full automation needs a small backend addition — a service/by-npub
> premium endpoint (or a webhook that sets the tier). Until then, `PREMIUM_NPUBS` is the working source.

## Files

```
src/migrations/024_cosmetic_catalog.sql   operator-owned catalog table
src/services/catalogService.js            load/cache + DEFAULT_CATALOG fallback
src/multiplayer/entitlements.js           snapshotForUser · levelForUser · TIER_OF · unlock rule
src/services/subscriptionService.js       premium tier by npub (PREMIUM_NPUBS allowlist + HTTP seam)
src/network/identityService.js            entitlementsForUser (loads catalog + grants + sub tier)
src/game/gameModeManager.js               recordDirectEntryPurchase (direct entry = 1 credit)
html/js/render/assetPacks.js              client consumes the served catalog
```

## Open decisions

- Premium tiers: one flat "premium," or a ladder (supporter/premium/operator) where each rung unlocks
  progressively more cosmetics *and* chat perks? (`TIER_OF` already has the rungs.)
- Full-automation source: add a service/by-npub premium endpoint to the Smirk backend (then set
  `SMIRK_PREMIUM_STATUS_URL`) vs. a webhook that stamps the tier. `PREMIUM_NPUBS` covers it manually today.
