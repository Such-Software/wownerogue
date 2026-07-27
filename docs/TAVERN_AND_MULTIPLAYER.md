# Tavern and Multiplayer

The Tavern is a shared social room; Match mode is a shared competitive dungeon. Both are built on
the same room engine, both are opt-in per instance, and neither affects the single-player path when
disabled.

Match rules, timing, fairness, and settlement have their own reference: `docs/MATCH_MODE.md`.
Ruleset definitions are documented in `docs/RULESETS.md`.

## Shared engine: one Room, two modes

Both surfaces sit on a real-time, multi-occupant `Room`:

- **Tavern**: a peaceful room. Players pick an avatar, walk around, chat, and watch live games.
- **Match**: the same room engine with a dungeon, a monster, and ruleset-selected collision and
  combat behavior.

The engine under `src/multiplayer/` has no Socket.IO, database, or application coupling. A manager
layer owns transport (Socket.IO rooms, broadcasts) and the server-tick timer. Keeping the engine
transport-agnostic makes it unit-testable in isolation and reusable as a standalone package.

`src/multiplayer/`:

- `Occupant.js`: a shared-world avatar (position, name, avatar id, facing).
- `Room.js`: map and walkability, server-authoritative one-tile movement, optional occupant
  collision, a `tick()` hook for autonomous systems (a heartbeat in the Tavern), and
  snapshot/full-state serialization.
- `tavernMap.js`: the default tavern layout. Rows are built to a uniform width, and one legend
  drives both client tiles (`sceneModel` `TAVERN_LEGEND`/`TILE_OF`) and `Room` walkability, so the
  two cannot disagree about what is solid. Walkable characters are floor, spawn, rug, chair, and
  door; everything else blocks, which is what makes players weave between furniture.
- `appearance.js`: the cosmetic identity model and its normalizer.
- `entitlements.js`: the server-side entitlement policy.
- `MatchRoom.js`, `MatchState.js`, `MatchEngine.js`: match world, state, and lifecycle.

## Tavern

A social space that reuses the lobby and spectator infrastructure. Players choose an avatar, move
around a shared map, and chat. A spectator camera lets them watch live single-player or match games
from inside the room, and a queue button lets them enter a match.

### Entering anonymously

The Tavern requires no account or login. On connection the browser registers the client and waits
for the anonymous session handshake (`session_token`, `session_resumed`, or the associated identity
response) before enabling **Enter tavern**. The token is stored as `wownerogue_token` in that
browser's `localStorage` and reused after refresh or reconnect.

The join form accepts its submit action, including Enter from the optional name field. Its button
reads `Connecting…`, `Preparing…`, or `Entering…` while the corresponding step is pending. A
disconnect or connection error resets readiness and retries automatically; a join with no server
response becomes a visible retryable error after ten seconds. Cosmetic selections are normalized and
enforced by server entitlement policy regardless of what the client sends.

## Match

A shared dungeon room using the operator-selected ruleset. Depending on the ruleset, players race to
escape, fight to remain last alive, compete for score, or cooperate. Block-bounded rulesets end on
the first advancing block header after their active-play duration floor (`ruleset.timing.minDurationMs`),
and every match also has a hard ceiling. Match rooms enable the collision and combat rules the
ruleset selects; the Tavern does not.

Built-in rulesets are `race`, `last-alive`, `score-attack`, and `coop-escape`. A `solo-classic`
descriptor exists for catalog parity; the single-player engine does not consume it.

## Operator policy

The operator controls which modes are enabled and, for match play, the economic model. Mode
activation, the ruleset, and match economy switches are startup environment configuration: set
`SOLO_ENABLED`, `TAVERN_ENABLED`, `MATCH_ENABLED`, `MATCH_RULESET_ID`, or the `MATCH_*` economy
settings and restart the service. The server reads them once at startup:
it does not hot-reload match modes or rulesets, and there is no per-room
ruleset editor. The full environment template is `src/.env.example`.

Enabled modes are surfaced to clients in `game_mode_info` as
`modes: { solo, tavern, multiplayer, match }`. `solo`, `tavern`, and `multiplayer` are booleans;
`match` is an object carrying `enabled`, the available `economies`, `maxPlayers`, the
`activeRuleset`, and the full ruleset catalog. The client shows or hides entry points from this, so
any single mode can run on its own, including a Tavern-only instance. Solo is on unless explicitly
disabled; Tavern and Match are opt-in.

Match economic models:

| Model | Description |
|---|---|
| `free` | No entry cost or payout; competitive results use the Free/Pleb board. |
| `credits_prestige` | Spend credits; competitive results use the separate PvP Prestige board, with no crypto payout. |
| `crypto_race` | Use a backed race-entry ticket; an eligible competitive winner receives the disclosed pot less the configured fee. |

`free` is always offered. `credits_prestige` requires credits mode or free play to be enabled.
`crypto_race` additionally requires its own switch, a payout cap, a compatible ruleset, and the
global payout safety gate, all evaluated by `matchPayoutAdmissionPolicy`. Baseline defaults are
conservative (free, no payout). Operators are responsible for ensuring their selected configuration
complies with applicable law in their jurisdiction.

## Character appearance contract

The public identity shape is `appearance: { avatar, tint, equipment, colors }`. The server
normalizes this shape, persists it on `users.appearance`, stores it on the `Occupant` at join time,
and broadcasts it in room snapshots. Renderers use `appearance` as the canonical cosmetic identity;
the flat `avatar` field remains as a compatibility shortcut and as the first discriminator for
sprite and skin loading.

Normalization in `src/multiplayer/appearance.js` is total: an unknown avatar id collapses to
`default`, unknown equipment collapses to `none` per slot, and unknown tints, skin tones, and hair
colors collapse to their defaults. Flat colour avatars carry no equipment or colour detail; 3D model
avatars carry colours but no 2D equipment overlays; character avatars carry both.

The contract is renderer-agnostic:

- **Top-down grid packs** resolve `avatar` to a base tile or frame and composite `equipment`
  overlays above it. `tint` recolours only the authored recolour pixels, so outlines, skin, wood,
  and metal stay intact.
- **Isometric packs** keep the same `appearance` ids and supply an isometric resolver for base
  frames, direction rows, anchor position, and equipment overlays. A missing item falls back by role
  (`round_shield` to `shield` to `none`) rather than changing the saved identity.
- **3D packs** resolve the same ids to GLB assets, material variants, and animation clips. Source
  models and intermediates stay out of git; shipped GLB or baked sprite outputs are hosted and
  lazy-loaded like premium sprite sheets.

The client may hide or label locked choices, but gating belongs at the server policy layer: identity
saves and join requests normalize unauthorized premium avatar ids to an allowed fallback.

## Entitlements and the cosmetic catalog

`src/multiplayer/entitlements.js` is the single policy module used by identity saves, tavern joins,
render-mode gating, and payment confirmation. In production the operator-owned `cosmetic_catalog`
table (migration 024) is loaded by `CatalogService` and passed in; the `DEFAULT_CATALOG` in the
module is the fallback for fresh or partly migrated databases and for unit tests.

Each catalog entry is `{ id, label, kind, projection, tier, unlockMinCredits, grantOnly, premium }`.
A pack is unlocked when any of the following holds:

- it is a free pack (tier 0, no credit threshold, not grant-only);
- the user holds an explicit grant for it in `user_pack_entitlements`;
- the user's lifetime credits purchased (`users.total_credits_purchased`, cumulative and never
  decremented by play) is at or above the pack's `unlockMinCredits`;
- the user's premium tier is at or above the pack's tier.

Premium tier comes from `users.premium_level` or an active subscription tier, whichever is higher,
over the ladder `supporter` (1), `premium` (2), `operator` (3). Buying credits does not by itself
place a user on the tier ladder: `credits` maps to tier 0, and credit spend unlocks packs only
through the `unlockMinCredits` thresholds.

The seed ladder is the free `original` tile pack plus premium packs at rising lifetime-credit
thresholds: Roguelike Interior at 1, character skins at 5, isometric dungeon at 10, roguelike
dungeon tiles at 20, isometric medieval at 40, and animated 3D characters at 50. Adding a rung is a
catalog row plus assets, not a code change. See `docs/MONETIZATION.md` and `docs/RENDER_PACKS.md`.

`snapshotForUser()` returns `{ premium, level, tier, credits, totalCreditsPurchased, packs, catalog }`.
The `packs` map is authoritative for gating; `canUsePack` consults it first and only falls back to
the coarse `premium` flag when a caller supplies a legacy entitlement object without one.

## Product grants

Payments stay separated from entitlement policy:

- **Single-game entries** buy one paid game attempt and grant no packs by default.
- **Credits packages** grant credits and may bundle cosmetic packs or a premium tier.
- **Cosmetic products** grant packs or tiers directly and may grant zero credits.

Catalog configuration supports `grants` on credit packages and a separate `COSMETIC_PRODUCTS`
catalog (see `src/.env.example`). A grant payload normalizes to
`{ credits, packs: [{ id, expiresAt, source }], premiumLevel }`, and unknown pack ids are dropped.

```json
{
  "id": "supporter_25",
  "label": "25 Credit Supporter Pack",
  "credits": 20,
  "bonus": 5,
  "price": 1000000000000,
  "grants": {
    "packs": ["generated-skins", "kenney-3d-characters"],
    "premiumLevel": "supporter"
  }
}
```

```json
{
  "id": "pack_3d",
  "label": "3D Character Pack",
  "price": 250000000000,
  "grants": {
    "packs": ["kenney-3d-characters"]
  }
}
```

Confirmed product payments persist the normalized grant on `payments.product_grants`, update credit
balances only when credits are part of the product, and upsert pack ownership in
`user_pack_entitlements`. The client receives the updated entitlement snapshot through
`credits_update` and `identity_update`, so the same state gates character saves, tavern joins,
render modes, and match rooms.

Supporting pieces:

- `src/migrations/020_user_appearance_and_pack_entitlements.sql`: persisted appearance, premium
  tier, and pack grants.
- `src/migrations/021_payment_product_grants.sql`: product ids and normalized grants on payments.
- `src/migrations/024_cosmetic_catalog.sql` and the ladder migrations that follow it: the
  operator-owned catalog.
- `src/network/identityService.js`: appearance persistence and entitlement-aware normalization.
- `src/payments/productGrants.js`: grant normalization and public summaries.

## Chat

The chat backend sits behind a `ChatProvider` interface (`src/network/chat/`) so it can be swapped
without changing callers. `SocketChatProvider` is the default: Socket.IO delivery plus Postgres
history. `buildChatProvider()` returns the plain local provider unless `NOSTR_CHAT_ENABLED` is set
and `NOSTR_CHAT_SCOPE` is `global`, in which case `NostrChatProvider` layers cross-server relay fan-out
over it. See `docs/CHAT_AND_NOSTR.md`.

**Tavern chat is global chat.** When a global chat provider is injected, `tavern_chat` publishes to
the global scope, reaching every connected client and the persisted history, so it must clear the
same bar as the lobby path. `TavernManager._moderateChat` applies the chat ban list, the
reconnect-proof rate limiter (keyed on the stable session id plus IP), and `user_id` attribution
before publishing. Without those guards `tavern_chat` would be an unauthenticated bypass of lobby
moderation under a client-chosen display name. When no global provider is injected, messages stay in
the ephemeral tavern-scoped room that nobody outside it sees, and the per-occupant cooldown alone
governs them.

Message text is escaped at publish time because delivery is trusted-escaped and rendered as HTML on
the client.

Speech bubbles resolve the speaker from the occupant list **by display name**. The chat provider
publishes a short `publicId`, never the raw socket id, so anything keying bubbles off `socketId`
never fires.

## Chain ambience

The Tavern stage carries a decorative chain layer (`RK.mountChainAmbience`, `chainAmbience.js`):
fragments of the top block hash fade in around the border and drift away, a corner readout tracks
the height, and a landing block sends a ripple around the frame plus a brighter burst.

It consumes the public `blockheight` broadcast, which carries an optional cosmetic tip (`hash`,
`difficulty`, `txPoolSize`). The tip is refreshed from `get_info` only when the height actually
advances, since it is decoration and not worth an extra RPC per poll.
`RpcService.getChainTipInfo()` never throws and never feeds fairness, payouts, or match seeding, and
`DebugManager.getChainTip()` returns null under simulated blocks because there is no chain to
describe.

The layer is `pointer-events: none`, marked `aria-hidden` with the corner readout as its accessible
copy, honours `prefers-reduced-motion`, and stops spawning while the tab is hidden. A hidden tab
pauses CSS animations, so `animationend` never fires and motes would otherwise accumulate
indefinitely; the backlog is dropped on hide.

## Rendering

Rendering goes through a renderer-agnostic **scene model**: game or tavern state is adapted into a
`Scene` (a tile grid plus entities), and any renderer draws it. This lives in `html/js/render/` and
serves the Tavern, the match client, spectators, and the single-player render bridge.

Selectable render techniques (`RK.RENDER_MODES`):

| Mode | Implementation | Premium |
|---|---|---|
| `tiles` | Coloured tiles and entity sprites on canvas 2D. The default. | No |
| `ascii` | Monospace glyph grid on canvas. Always-available fallback; accessible. | No |
| `iso` | Canvas isometric projection using the isometric dungeon pack art. | Yes |
| `3d` | Three.js projection with generated GLB avatars (`idle`, `run`, `jump` clips) and a low-poly fallback when a model cannot load. | Yes |

A premium mode unlocks once the user holds any unlocked pack for that mode's projection, so
entitlement is expressed once in the catalog rather than duplicated per mode. Render mode is a
per-user persisted choice with an operator default. Because rendering is client-side this is a
cosmetic gate; premium-only *assets* are the enforceable lever.

`fancyRenderer.js` is an internal PixiJS prototype, not a registered selectable mode. No mode button
invokes it. If it is invoked directly it loads `@pixi/unsafe-eval` immediately after `pixi.js` so
shaders precompile without adding `'unsafe-eval'` to the CSP, and it requires the server's external
renderer policy to be on.

Production top-down styling comes from interchangeable packs plus the shared canvas FX layer. The
render kit provides the engine and programmatic tiles and effects; authored tilesets, sprite sheets,
and shader effects are a separate content effort.

## Asset delivery and performance

- **Heavy source artifacts are not committed.** 3D models and generation intermediates (`*.glb`,
  `*.fbx`, `*.blend`) are gitignored. Only the outputs the game loads are candidates for shipping.
- **Generated and premium assets are provisioned, not committed.** Premium skins and runtime GLBs
  live under `html/assets/generated/`, which is gitignored. They are provisioned into the
  same-origin runtime path or delivered by an explicitly reviewed asset host and CSP policy, and are
  not present in the Git release artifact. The base tier's small Kenney CC0 tiles stay in-repo.
- **Load by mode and entitlement.** ASCII and Tiled need no WebGL library. A premium skin's sprite
  sheet is fetched only when that skin is selected and the player is entitled to it. Generated GLBs
  are emitted by `scripts/build_kenney_3d_characters.py` from local Kenney FBX sources into
  `html/assets/generated/3d/`.
- **Three.js is served from this origin.** `src/index.js` publishes the browser build and addons
  under `/vendor/three/0.160.0/` from the pinned `three` dependency, with immutable versioned URLs
  so a cached copy cannot survive an upgrade to different bytes. Pages declare it through an import
  map, and `RK.ensureThree` imports it only when 3D is selected. `RENDERER_CDN_ENABLED` defaults to
  false: third-party renderer code would execute with the same privileges as the game and payment
  UI, so trusting a CDN is an explicit operator decision and widens the CSP when enabled.
- **Optimize what ships.** Sprite sheets are delivered as WebP with alpha, sized to display
  resolution, content-hashed with a long cache TTL. The demo walk sheet is roughly ten times smaller
  as WebP than as PNG.

## Client and transport

`src/network/tavernManager.js` owns transport and lifecycle: one shared `Room`, the server-tick
timer (default 100ms, override with `TAVERN_TICK_MS`), and Socket.IO room broadcasts on the
`tavern:<roomId>` channel. It is wired into `SocketHandlers` (`tavern_join`, `tavern_move`,
`tavern_leave`, plus disconnect cleanup and shutdown) and is inert unless `TAVERN_ENABLED=true`.

`src/network/tavernMatchBridge.js` relays match progress into the Tavern (`tavern_match_tick`,
`tavern_match_end`) and requires both `TAVERN_ENABLED` and `MATCH_ENABLED`.

`html/tavern.html` is the browser client: establish or resume an anonymous session, choose an
optional name and avatar, enter the room, walk with keyboard or on-screen controls, chat, watch solo
or match games, or join a match queue. No account login is required.

`html/js/render/` is the render kit: `sceneModel.js` (renderer-agnostic adapters), the ASCII, tiled,
isometric, and Three.js renderers, the internal Fancy prototype, and `renderModes.js` (registry,
factory with graceful fallback, entitlements, persistence). Clients expose a mode toolbar where
applicable; premium modes are marked and gated by `RK.entitlements`.

## Tests

- `test/tavernRoom.test.js`: the room engine.
- `test/tavernManager.test.js`: the manager, including chat moderation.
- `test/tavernMatchBridge.test.js`: match-to-tavern relay.
- `test/chatProvider.test.js`: the provider seam.
- `test/renderScene.test.js`: the scene adapter.
- `test/entitlements.test.js`, `test/catalogEntitlements_ultra.test.js`: entitlement policy and the
  operator catalog.
- `test/identityService.test.js`, `test/appearance.test.js`, `test/appearanceModel3d.test.js`:
  appearance normalization and persistence.
- `test/productGrants.test.js`: grant normalization.
- `test/pvpUiPolish.test.js`: anonymous readiness and join states.
- `test/rendererCdnPolicy.test.js`: the same-origin Three.js runtime policy.

## Running locally

Set `TAVERN_ENABLED=true` (optionally `TAVERN_TICK_MS`), start the server, and open `/tavern.html`
in two browser tabs. Add `MATCH_ENABLED=true` and a `MATCH_RULESET_ID` to exercise match entry from
the Tavern.
