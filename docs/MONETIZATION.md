# Monetization: credits, catalog, and entitlements

Cosmetics are sold through three pieces: **credits** (the unit of account), an operator-owned
**catalog** of packs, and an **entitlement rule** that decides which packs a given user has unlocked.
Payouts are a separate system and are not affected by any of this.

## Credits

Two columns on `users` drive everything:

| Column | Meaning |
|---|---|
| `credits` | spendable balance; decremented when a game is entered with credits |
| `total_credits_purchased` | lifetime credits purchased, cumulative, never decremented by play |

Credit packages are declared in `src/config/paymentConfig.js` under `modes.credits.packages`
(`{ id, credits, price, bonus }`). On confirmation, `gameModeManager.processProductPaymentConfirmation`
adds `credits + bonus` to both columns in one transaction and writes a `credit_transactions` row.

A direct (single-game) entry is modeled as *buy one credit, immediately spend it*
(`gameModeManager.recordDirectEntryPurchase`): the balance nets to zero, `total_credits_purchased`
advances by 1, and two `credit_transactions` rows (`direct_entry` purchase, `game_entry` spend)
record the pair. A direct payment therefore unlocks the same threshold cosmetics as a credit purchase.

Refunds reverse what a payment granted. `src/services/paymentRefundService.js` deducts the granted
credits, purchase progression, and race entries, restores the previous `premium_level`, and revokes
pack grants. If the grant cannot be reversed exactly (credits already spent, progression already
consumed, ambiguous provenance on a bare direct entry), the refund is parked as `needs_review`
instead of leaving a cosmetic unlock behind.

## The catalog

`cosmetic_catalog` (migration `024`, repriced by migration `028`) is the operator-owned product
table and the single server-authoritative source for pack definitions:

```
pack_id, label, kind, projection, tier, unlock_min_credits,
grant_only, sort_order, active, metadata
```

`src/services/catalogService.js` loads active rows ordered by `sort_order`, caches them for 60
seconds, and exposes `invalidate()`. It falls back to the built-in `DEFAULT_CATALOG` in
`src/multiplayer/entitlements.js` when the table is missing (`42P01`), empty, or yields no valid
rows, so the game runs on a fresh or partly-migrated database and never hard-fails on a catalog read.
Rows without both `pack_id` and `label` are skipped.

`catalogSummary()` projects the catalog into the display-facing shape the client renders
(`id, label, kind, projection, tier, premium, unlockMinCredits`).

## The unlock rule

`snapshotForUser(user, grants, catalog)` in `src/multiplayer/entitlements.js`. A pack is unlocked if
**any** of:

1. it is free: `tier === 0`, `unlockMinCredits == null`, and not `grantOnly`
2. an explicit grant exists in `user_pack_entitlements` (unexpired)
3. `total_credits_purchased >= unlock_min_credits` (when the pack sets a threshold)
4. the user's premium tier is `>=` the pack's `tier` (when `tier > 0`)

`TIER_OF = { free: 0, credits: 0, supporter: 1, premium: 2, operator: 3 }`. Clause 4 is the
subscription hook. Buying credits maps to tier 0, so a purchase never blanket-unlocks the premium
tiers; it only advances the threshold in clause 3.

The returned snapshot is `{ premium, level, tier, credits, totalCreditsPurchased, packs, catalog }`,
where `packs` is a per-pack boolean map and `premium` is true when the user has any premium tier or
any non-free pack unlocked.

## The credit ladder

Clause 3 keys off lifetime credits *purchased*, cumulatively. It is not deducted by play, so buying
credits to play also walks the user up the cosmetic ladder and cosmetics never compete with the core
loop. Each catalog row is data: a tilepack or a character skin, at any rung and any tier. Adding a
pack means appending a catalog row, shipping the assets, and calling `RK.registerPack` on the client.

| Lifetime credits | Pack | Projection | Tier |
|---|---|---|---|
| free | `original` (bare original tiles) | topdown | 0 |
| 1 | `roguelike-interior` | topdown | 1 |
| 5 | `generated-skins` (character skins) | topdown | 1 |
| 10 | `iso-dungeon` | iso | 2 |
| 20 | `roguelike-dungeon` | topdown | 2 |
| 40 | `iso-medieval` | iso | 3 |
| 50 | `kenney-3d-characters` | 3d | 3 |

The `original` pack maps only the essentials (floor, wall, door, torch, features); furniture kinds
fall back to floor, so the free tavern reads deliberately plain.

Because the tier column is also live, a `premium` subscription (tier 2) unlocks every pack at tier
2 or below without any credit spend; tier 3 packs need `operator` or the credit threshold.

### Render techniques versus packs

`RK.RENDER_MODES` in `html/js/render/renderModes.js` defines four techniques: Tiled and ASCII are
free, Iso and 3D are premium. `RK.canUseMode` grants a premium technique once the user has **any**
unlocked pack for its projection, so the cheapest pack in a projection is effectively that
technique's gate. Plain ASCII stays free for accessibility.

Client-side gating is a cosmetic honour gate, not a security boundary: rendering happens in the
browser. The server-side boundary is `Entitlements.normalizeAppearance`, which resets an appearance
whose avatar pack the user has not unlocked before it is persisted or broadcast.

## Subscription tiers

`levelForUser(user)` returns the higher of the stored `premium_level` and any `subscription_tier`,
so an active subscription sets the entitlement tier and unlocks the packs at or below it. One
subscription drives both chat perks and cosmetics; the chat side is documented in
[CHAT_AND_NOSTR.md](CHAT_AND_NOSTR.md).

`identityService.entitlementsForUser` populates `subscription_tier` before taking the snapshot by
calling `SubscriptionService.tierForNpub(user.smirk_public_key)`. The call is best-effort: any
resolver failure leaves the field unset and the snapshot falls back to credit thresholds and grants.

```
active subscription -> tierForNpub(npub) -> user.subscription_tier -> levelForUser -> tier
                                                                       |- relay: chat perks
                                                                       |- catalog: pack unlocks
```

`src/services/subscriptionService.js` resolves a tier from two optional sources, in order, and caches
the result for 5 minutes. With neither configured it returns `null` and no one is auto-promoted.

| Environment variable | Meaning |
|---|---|
| `PREMIUM_NPUBS` | operator allowlist, `npub1…\|64hex[:tier],…`; npub entries are decoded to x-only hex to match `users.smirk_public_key` |
| `PREMIUM_DEFAULT_TIER` | tier for allowlist entries with no explicit `:tier` (default `premium`) |
| `SMIRK_PREMIUM_STATUS_URL` | optional HTTP endpoint answering premium-by-npub with `{ active, tier? }` |
| `SMIRK_PREMIUM_STATUS_KEY` | bearer token sent to that endpoint |

The Smirk backend's `/premium/status` is self-only (user-token auth), so it cannot answer a lookup
for an arbitrary npub. The allowlist covers that case with no backend dependency; the HTTP seam is
for a service-scoped endpoint where one exists.

## Reaching the client

The server emits `identity_update` with `{ appearance, entitlements }`, where `entitlements` carries
the `packs` map and the projected `catalog`. `RK.setEntitlementSnapshot` in
`html/js/render/assetPacks.js` merges the served catalog into `RK.PACKS` (merge, not replace, so a
client-side fallback a render mode depends on survives a catalog that omits it), recomputes the
per-pack unlock map, and persists the snapshot to `localStorage` for the next load. Operator-added
packs appear on the client without a client release.

`?unlock=1` sets a sticky per-browser QA bypass (`RK.renderModeTestUnlocks`) that unlocks premium
modes and packs locally; `?unlock=0` clears it. It affects only the browser that sets it.

## Operated product profiles

When `OPERATED_PRODUCT_PROFILE` is set, `src/config/operatedProductProfiles.js` rejects standalone
cosmetic products (`products.cosmetic`) and any credit package carrying a `grants` object. Those
deployments sell only the credits and bonus declared at the top level of a credit package, so the
credit ladder and subscription tiers are the only unlock paths. Independent deployments do not set
the variable and are not constrained by it.

## Files

```
src/migrations/024_cosmetic_catalog.sql   catalog table
src/migrations/028_cosmetic_ladder.sql    ladder rows (idempotent upsert)
src/services/catalogService.js            load, cache, DEFAULT_CATALOG fallback
src/multiplayer/entitlements.js           snapshotForUser, levelForUser, TIER_OF, unlock rule
src/services/subscriptionService.js       premium tier by npub
src/services/paymentRefundService.js      entitlement reversal and needs-review routing
src/network/identityService.js            entitlementsForUser (catalog + grants + subscription tier)
src/game/gameModeManager.js               recordDirectEntryPurchase, credit package confirmation
html/js/render/assetPacks.js              client consumes the served catalog
html/js/render/renderModes.js             technique registry and gating
```
