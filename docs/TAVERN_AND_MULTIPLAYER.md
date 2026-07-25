# Tavern & Multiplayer — Design & Build Plan

Match mode has its own dedicated design doc: see `docs/MATCH_MODE.md`.

**Status:** Tavern and server-selected multiplayer rulesets (`race`, `last-alive`, `score-attack`,
`coop-escape`) are implemented (see `docs/MATCH_MODE.md`). Both surfaces are disabled by default
and gated by config, so existing single-player play is unaffected.

## Shared engine: one Room, two modes

Both modes are built on a single shared component — a real-time, multi-occupant `Room`:

- **Tavern** — a peaceful Room: players pick an avatar, walk around, chat, and watch live games.
- **Multiplayer** — the same Room engine with a dungeon, monsters, and ruleset-selected
  collision/combat behavior.

The engine (`src/multiplayer/`) has no Socket.IO, database, or Wownerogue coupling. A manager
layer owns transport (Socket.IO rooms, broadcasts) and the server-tick timer. Keeping the engine
transport-agnostic makes it unit-testable in isolation and reusable as a standalone package.

## Modes

**Tavern** — a social space that reuses the existing lobby and spectator infrastructure. Players
choose an avatar, move around a shared map, and chat. A spectator camera lets them watch live
single-player or multiplayer games from inside the room.

### Entering anonymously

The Tavern requires no account or login. On connection, the browser registers the client and waits
for the normal anonymous session handshake (`session_token`, `session_resumed`, or the associated
identity response) before enabling **Enter tavern**. The token is stored as `wownerogue_token` in
that browser's `localStorage` and is reused after refresh or reconnect.

The join form accepts its submit action, including Enter from the optional name field. Its button
shows `Connecting…`, `Preparing…`, or `Entering…` while the corresponding step is pending. A
disconnect or connection error resets readiness and retries automatically; a join with no server
response becomes a visible retryable error after ten seconds. Cosmetic availability is still
normalized and enforced by server entitlement policy.

**Multiplayer Match** — a shared dungeon Room using the operator-selected ruleset. Players may race
to escape, fight to remain last alive, compete for score, or cooperate. Block-bounded rulesets end
on the first advancing header after their active-play duration floor; every match also has a hard
ceiling. Match rooms enable the collision/combat rules selected by the ruleset; the Tavern does not.

## Operator Policy

The server operator controls which modes are enabled and, for multiplayer, the economic model.
Mode activation, the multiplayer ruleset, and multiplayer economy switches are startup environment
configuration. Change `SOLO_ENABLED`, `TAVERN_ENABLED`, `MATCH_ENABLED`, `MATCH_RULESET_ID`, or the
`MATCH_*` economy settings in the deployment configuration and restart the service. The separate
database-backed `ConfigPersistence` allowlist covers a limited set of solo payment/difficulty
values; it does not hot-reload match modes or rulesets. There is no per-room ruleset editor today.

Which modes are enabled is surfaced to clients in the `game_mode_info` event as
`modes: { solo, tavern, match }` (from `SOLO_ENABLED`, `TAVERN_ENABLED`, and `MATCH_ENABLED`).
The client shows or hides entry points from this, so any single mode can run on its own — including
a Tavern-only instance. Solo is on unless explicitly disabled; Tavern and Match are opt-in.

Multiplayer economic models (operator-selected per instance):

| Model | Description |
|---|---|
| `free` | No entry cost or payout; competitive results use the Free/Pleb board. |
| `credits_prestige` | Spend credits; competitive results use the separate PvP Prestige board, with no crypto payout. |
| `crypto_race` | Use a backed race-entry ticket; an eligible competitive winner receives the disclosed pot less the configured fee. |

The baseline defaults are conservative (free, no payout). Instance deployment configuration may
enable additional economies; operators are responsible for ensuring their selected configuration
complies with applicable laws in their jurisdiction.

## Avatars

Avatars are cosmetic. Availability is controlled by Operator Policy — for example, a set available
to everyone plus additional avatars unlocked by credit purchases. The avatar id is stored on the
occupant and broadcast to the room; unlock eligibility is enforced at join time.

## Character Appearance Contract

The public identity shape is `appearance: { avatar, tint, equipment }`. The server normalizes this
shape, persists it on `users.appearance`, stores it on the `Occupant` at join time, and broadcasts
it in room snapshots. Renderers use `appearance` as the canonical cosmetic identity; the flat
`avatar` field remains as a compatibility shortcut and as the first discriminator for sprite/skin
loading.

This contract is intentionally renderer-agnostic:

- **Top-down grid packs** resolve `avatar` to a base tile/frame and composite `equipment` overlays
  above it. `tint` recolours only the authored recolour pixels so outlines, skin, wood, and metal
  remain intact.
- **Isometric packs** should keep the same `appearance` ids and supply an isometric resolver for
  base frames, direction rows, anchor/feet position, and equipment overlays. If an exact item is
  missing, the resolver should fall back by role (`round_shield -> shield -> none`) rather than
  changing the saved identity.
- **True 3D packs** should resolve the same ids to GLB assets/material variants/animation clips.
  Source models and intermediates stay out of git; shipped GLB or baked sprite outputs are hosted
  and lazy-loaded like premium sprite sheets.

Premium costumes are catalog entries with an entitlement requirement. The client may hide or label
locked choices, but real gating belongs at the server/operator policy layer: identity saves and
join requests normalize unauthorized premium `avatar` ids to an allowed fallback.

Current baseline premium policy: a player is treated as premium after any successful credits
purchase (`users.total_credits_purchased > 0`). That unlocks the preview premium packs
(`generated-skins`, `iso-dungeon`, and `kenney-3d-characters`) unless a future operator policy
tightens them. The policy shape is already pack-based so products can sell or grant different packs
independently. Operator/admin grants go through
`user_pack_entitlements(user_id, pack_id, source, expires_at, metadata)`, while
`users.premium_level` is reserved for broader tiering.

## Product Grants

Payments stay separated from entitlement policy:

- **Single-game entries** buy one paid game attempt and do not grant premium by default.
- **Credits packages** grant credits and may bundle cosmetic/render packs or a premium tier.
- **Cosmetic products** grant packs or tiers directly and may grant zero credits.

Catalog configuration supports `grants` on credit packages and a separate `COSMETIC_PRODUCTS`
catalog. A grant payload is normalized to:
`{ credits, packs: [{ id, expiresAt, source }], premiumLevel }`.

Examples:

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

Confirmed product payments persist the normalized grant on `payments.product_grants`, update
credit balances only when credits are part of the product, and upsert pack ownership in
`user_pack_entitlements`. The client receives the updated entitlement snapshot through
`credits_update` / `identity_update`, so the same premium state gates character saves, tavern joins,
render modes, and later multiplayer rooms.

## Chat

The existing chat backend is retained and wrapped behind a `ChatProvider` interface so the backend
can be swapped later without changing callers. The current backend remains the default.

## Rendering (art pass)

Rendering goes through a shared, renderer-agnostic **scene model**: game/tavern state is adapted
into a `Scene` (a tile grid + entities), and any renderer draws it. This lives in
`html/js/render/` and is used by the Tavern, multiplayer client, spectators, and the single-player
render bridge.

Selectable render techniques:
- **ASCII** — monospace glyph grid (canvas). Always-available fallback; accessible.
- **Tiled** — coloured tiles + entity sprites (canvas 2D). The default. Real tilesets/atlases
  slot in here later.
- **Iso** — canvas isometric projection using Kenney's Isometric Miniature Dungeon runtime PNGs.
- **3D** — Three.js projection, loaded lazily from the pinned same-origin `three@0.160.0` runtime.
  It attaches generated GLB avatars with `idle` / `run` / `jump` clips when available and keeps a
  lightweight low-poly fallback only when the model cannot load.

`fancyRenderer.js` remains an internal PixiJS prototype, not a registered selectable mode.
Production top-down styling comes from interchangeable packs plus the shared canvas FX layer.
Planned: **Fancy ASCII** — shader-lit, animated glyphs.

Render mode is a per-user choice (persisted) with an operator default. Modes can be marked
**premium** — a cosmetic entitlement intended to be unlocked with credits (the same Operator
Policy pattern as avatar unlocks). Because rendering is client-side, this is a soft/cosmetic gate,
not a hard boundary; premium-only *assets* (special tilesets, shaders) are the real lever if
stronger gating is wanted. The render kit provides the engine and programmatic tiles/effects —
polished pixel-art tilesets, sprite sheets, and shader effects are a separate content effort.

**CSP note:** If the internal PixiJS prototype is invoked, it loads `@pixi/unsafe-eval`
immediately after `pixi.js` to precompile shaders without adding `'unsafe-eval'` to CSP. It also
requires the server's explicit external-renderer policy; no current mode button invokes it.

## Asset delivery & performance

Rules for keeping the tree lean and the client fast:

- **Heavy source artifacts never go in git.** 3D models and generation intermediates (`*.glb`,
  `*.fbx`, `*.blend`, …) are produced by the sprite pipeline (`~/src/docs/animated-sprite-pipeline.md`)
  and are gitignored. Only the *outputs* the game loads are considered for shipping.
- **Generated / premium assets are provisioned, not committed.** Premium skins and runtime GLBs
  live under `html/assets/generated/` (gitignored). They may be provisioned into the same-origin
  runtime path or delivered by an explicitly reviewed asset host and CSP policy; they are not
  present in the Git release artifact. The base tier's small Kenney CC0 tiles stay in-repo.
- **Lazy-load by mode / entitlement.** Nothing heavy loads until it's actually needed:
  - ASCII and Tiled need no WebGL library. The unregistered Fancy prototype requests PixiJS plus
    `@pixi/unsafe-eval` only if called directly.
  - A premium skin's sprite sheet is fetched only when that skin is selected and the player is
    entitled to it.
  - The exact production Three.js dependency is served beneath `/vendor/three/0.160.0/` and
    imported only when **3D** is selected. Local delivery takes precedence; external renderer
    execution remains off unless `RENDERER_CDN_ENABLED=true`.
  - Generated GLBs are emitted by `scripts/build_kenney_3d_characters.py` from local Kenney FBX
    sources into `html/assets/generated/3d/` (gitignored).
- **Optimize what ships.** Sprite sheets are delivered as **WebP** (alpha), right-sized to display
  resolution, content-hashed with a long cache TTL. (Example: the demo walk sheet is 633 KB as PNG,
  65 KB as WebP — ~10×.)

## Milestones

Tavern:
- **T0** — Shared engine scaffold: `Room`, `Occupant`, tavern map, unit tests. (Done)
- **T1** — `TavernManager`: Socket.IO room, server-tick timer, join/move/leave broadcasts; minimal
  client (`html/tavern.html`) rendering avatars; gated behind `TAVERN_ENABLED`. (Done)
- **T2a** — `ChatProvider` seam + tavern chat. (Done)
- **T2b** — Spectator camera into live solo and multiplayer games from the Tavern. (Done)
- **T3** — Avatar picker with policy-gated unlocks. (Done)

Multiplayer:
- **M0** — Match Room with a dungeon, shared monster, server ticks, and bounded lifecycle. (Done)
- **M1** — Player-vs-player combat for the `last-alive` ruleset. (Done)
- **M2** — Environmental hazards.
- **M3** — Free, credit-prestige, and gated crypto-race economies wired in. (Done)

Rendering:
- **R0** — Shared render kit: scene model + selectable ASCII / Tiled / Iso / 3D techniques,
  internal Fancy prototype, and a mode switch wired to the Tavern. Premium-mode gating
  scaffolded. (Done)
- **R1** — Wire the main game to the render kit behind the existing display layer. (Done)
- **R2** — Real tilesets / sprite sheets and the Fancy-ASCII tier.
- **R3** — Wire premium render modes to credit entitlements (Operator Policy). (Done)

All milestones are additive and config-gated; the single-player path is unchanged.

## Current status

`src/multiplayer/`
- `Occupant.js` — a shared-world avatar (position, name, avatar id, facing).
- `Room.js` — map/walkability, server-authoritative one-tile movement, optional occupant
  collision, a `tick()` hook for future autonomous systems, and snapshot/full-state serialization.
- `tavernMap.js` — a procedurally generated (rectangular) default tavern layout.

`src/network/tavernManager.js` — transport + lifecycle: a shared Room, the server-tick timer,
and Socket.IO room broadcasts. Wired into `SocketHandlers` (`tavern_join` / `tavern_move` /
`tavern_leave`, plus disconnect cleanup and shutdown). Inert unless `TAVERN_ENABLED=true`.

`html/tavern.html` — the browser client: establish/resume an anonymous session, choose an optional
name/avatar, enter the room, walk with keyboard or on-screen controls, chat, watch
solo/multiplayer games, or join a match. No account login is required.

`src/network/chat/` — the `ChatProvider` seam. `ChatProvider` (interface) + `SocketChatProvider`
(default: Socket.IO delivery + Postgres history). Both the global chat (`ChatHandler`) and tavern
chat deliver through it, so the backend can be swapped (e.g. a Nostr channel) without changing
callers. Tavern chat is room-scoped and ephemeral.

`html/js/render/` — the render kit: `sceneModel.js` (renderer-agnostic adapters), ASCII, tiled,
isometric, and Three.js renderers plus the internal Fancy (PixiJS) prototype, and
`renderModes.js` (registry, factory with graceful fallback, entitlements, persistence). Clients
expose a mode toolbar where applicable; premium modes are marked and gated by `RK.entitlements`.

Tests: `test/tavernRoom.test.js` (engine), `test/tavernManager.test.js` (manager incl. chat),
`test/chatProvider.test.js`, `test/renderScene.test.js` (scene adapter),
`test/entitlements.test.js`, `test/identityService.test.js`, and `test/productGrants.test.js`.
`test/pvpUiPolish.test.js` covers the anonymous readiness/join states, and
`test/rendererCdnPolicy.test.js` covers the same-origin Three.js runtime policy. End-to-end
join/move/leave, local 3D, and chat over a real socket are verified out-of-band.

Payment/product entitlement pieces:
- `src/migrations/020_user_appearance_and_pack_entitlements.sql` — persisted appearance,
  premium tier, and pack grants.
- `src/migrations/021_payment_product_grants.sql` — product ids and normalized grants on payments.
- `src/network/identityService.js` — server-side appearance persistence and entitlement-aware
  normalization.
- `src/payments/productGrants.js` — product grant normalization/public summaries.
- `src/multiplayer/entitlements.js` — server policy snapshot used by identity, tavern joins, and
  payment confirmations.

Enable locally with `TAVERN_ENABLED=true` (optionally `TAVERN_TICK_MS`), then open `/tavern.html`
in two browser tabs.
