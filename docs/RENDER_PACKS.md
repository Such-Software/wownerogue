# Render kit: modes, packs and FX

The client render kit (`html/js/render/`, namespace `RK`) draws the same `Scene` in several
techniques and art styles, so the tavern and the dungeon are interchangeable environments and new
art can be shipped as a product without touching gameplay code.

## Modes vs. packs

- **Render modes are techniques** (how a scene is drawn): `Tiled`, `ASCII`, `Iso`, `3D`
  (`renderModes.js`). Each declares a `projection` of `topdown`, `iso`, or `3d`.
- **Packs are the sets and styles within a projection**, chosen from the pack picker and registered
  in `packRegistry.js` / `assetPacks.js`.
- A premium mode is usable once the account has any unlocked pack for that mode's projection
  (`RK.canUseMode`).
- The scene model is kind-based (`floor`, `wall`, `table`, `torch`, `monster`, and so on), so one
  pack renders both the tavern (`sceneFromTavern`) and the dungeon (`sceneFromGameState`). That is
  what makes packs interchangeable across town and dungeon.

Registered packs (`assetPacks.js`):

| Pack id | Projection | Label |
|---------|-----------|-------|
| `original` | topdown | Original Tiles |
| `roguelike-interior` | topdown | Roguelike Interior |
| `roguelike-dungeon` | topdown | Roguelike Dungeon |
| `iso-dungeon` | iso | Isometric Dungeon |
| `iso-medieval` | iso | Medieval Town |
| `kenney-3d-characters` | 3d | Animated 3D |

The active pack is stored per projection (`rk_pack_<projection>` in `localStorage`, an in-memory map
under Node). A stored pack that is unregistered or locked is ignored in favour of the first unlocked
pack for that projection.

Entitlement is per pack, not per purchase: each pack maps to a row in the operator-owned
`cosmetic_catalog` table and resolves through `src/multiplayer/entitlements.js` as free, grant-only,
lifetime-credits threshold, or subscription tier. `entitlements.js` also carries a built-in default
catalog used when the table is unavailable. See `MONETIZATION.md`.

For browser QA, `?unlock=1` sets a sticky local bypass for render-mode and pack display gates and
`?unlock=0` clears it. It affects only that browser's `localStorage`, grants no server entitlement,
and is not an operator access-control mechanism.

## Gameplay focus contract

Single-player keyboard movement is accepted only while `#game-display` owns browser focus, so typing
in chat or another form cannot move the player. Choosing Tiled, ASCII, Iso, 3D, a pack, or a camera
control immediately returns focus to the gameplay area without scrolling (`RK.SPGame.focusGameplay`).

## Local 3D runtime

Three.js `0.160.0` is an exact production dependency. The server advertises the local version in
`/runtime-config.js` and publishes only the browser build and the two required addons:

```text
/vendor/three/0.160.0/three.module.min.js
/vendor/three/0.160.0/addons/loaders/GLTFLoader.js
/vendor/three/0.160.0/addons/utils/SkeletonUtils.js
```

The modules are imported lazily the first time 3D is selected (`RK.ensureThree`), so ASCII and Tiled
users never download them. Local delivery is always enabled in the application runtime and takes
precedence over external sources. `RENDERER_CDN_ENABLED=true` makes the jsDelivr renderer source
path eligible only in a runtime where local delivery is disabled, and widens the CSP to trust
third-party script. All checked-in environment profiles keep it off, so Three.js stays same-origin.

Library delivery is separate from model delivery. Runtime GLBs under `html/assets/generated/3d/` are
gitignored and must be provisioned independently; the renderer keeps a low-poly placeholder while a
model cannot load and removes it once the animated GLB is attached.

## The FX layer (`fxLayer.js`, `RK.fx`)

Pure-canvas animated FX, CSP-safe and with no WebGL, shared by the tiled and iso renderers so a
scene lights up the same way in either projection:

- `RK.fx.fire` and `RK.fx.flame`: dancing two-layer flame plus warm glow, for torches and hearths.
- `RK.fx.hazard`: pulsing overlay for hazard tiles (`lava`, `poison`, `spikes`), taking a
  footprint-clip callback so it fits square cells and iso diamonds alike.
- `RK.fx.flicker`, `RK.fx.pulse`, `RK.fx.glow`: the primitives.

A tile carries `fx: 'fire'` or `hazard: '<kind>'` in the scene legend (`sceneModel.js`). The
renderer draws only the tile's base in the static pass and lets `RK.fx` paint the animated layer in
the live loop. The tavern places wall braziers and a hearth. Dungeon hazards are keyed off the map
characters `L`, `P`, and `^` in `dungeonTileKind`, so a generator that emits them renders hazards
with no renderer change.

Torches are wall-mounted: the generator places them only on wall cells adjacent to floor, so
`DUNGEON_LEGEND.torch` uses `over: 'wall'` and the fire branch draws the wall base plus the
procedural flame.

## Lighting model (iso and 3D)

Both premium projections light the dungeon rather than tinting it, and both derive lighting from the
same `scene.lightGrid` the 2D modes use, so switching projection changes the technique and never
what a player is allowed to see.

**Iso** composites in one pass per frame:

- tiles are shaded opaque (`_shadedImage`, quantized to six cached levels) rather than alpha-faded.
  Multiplying a sprite's own pixels toward a cold near-black keeps distant stone solid and unlit;
  alpha-fading would make remembered walls translucent and let the tiles behind them show through.
- light pools (`_lightPool`) are additive, squashed to the ground plane, and emitted by torches
  (flickering), the player's lantern, and objective beacons on the stairs and treasure.
- crevice AO (`_wallAO`) darkens floor cells by how many walls they touch.
- embers rise off each flame, seeded per cell so they do not reshuffle every frame.
- a cold blue wash (`_memoryWash`) separates remembered rooms from torchlit ones by colour
  temperature. The wash colour must stay darker than the tiles it covers: a mid-tone blue lifts
  memory brighter than the lit centre and inverts the depth hierarchy.

**3D** (`threeRenderer.js`) draws the level as three InstancedMeshes (walls, ground, props), so a
70x35 dungeon costs three draw calls and a fog-of-war update is a few thousand matrix writes instead
of thousands of mesh allocations. Wall and floor materials are generated on a canvas at startup
(coursed stone, irregular flagstones, both doubling as bump maps), so there is nothing extra to
download and nothing for the CSP to block. On top of that: a low warm key light with a
player-tracking shadow frustum, a pool of six point lights reassigned each frame to the nearest
braziers, a hand-held lantern, drifting dust motes, and a wall cutaway that squashes the walls
between the isometric camera and the player.

Two constraints that are easy to get wrong:

- Fog is measured from the camera, which sits about 17 world units back along the isometric offset,
  not from the player. A fog band tuned as if it started at the player puts the player a quarter of
  the way into fog and crushes the scene to near-black.
- `lightGrid` must not be applied to albedo at full strength in 3D. The point lights already provide
  falloff, so multiplying by the grid as well double-darkens every surface. 3D compresses it to
  `0.38 + 0.62 * lb` and lets the lamps shape the scene.

Features (`entrance`, `exit`, `treasure`, items) are set dressing, not avatars, in both projections:
stairs with a beacon shaft, a gold chest, a spinning pickup. Rendering them through the entity path
would draw each one as a humanoid, which makes the entrance look like a second player standing at
the map origin.

## Module reference

| File | Role |
|------|------|
| `sceneModel.js` | Renderer-agnostic `Scene` plus the tavern and game-state adapters, the dungeon legend, and tile-character mapping. Handles both array grids and the client's sparse `{y:{x:v}}` maps. |
| `renderModes.js` | Mode registry, entitlement checks, renderer factory, and lazy Three.js loading. |
| `tileRenderer.js` | Top-down atlas renderer. `over` compositing (object tiles drawn on a base tile), torch-lit vignette, ember and flicker loop, animated fire and hazard emitters. |
| `asciiRenderer.js` | Glyph renderer for the free ASCII mode. |
| `isoRenderer.js` | Canvas isometric projection. Orientation-aware walls (`_S` for x-runs, `_W` for y-runs, corner tile), floor variety, contact shadows, vignette. Kenney iso dungeon set (`html/assets/kenney/iso-dungeon/`). |
| `threeRenderer.js` | Same-origin Three.js scene. Instanced level geometry, procedural stone and flagstone materials, torch light pool and shadows, dedicated feature and monster meshes, dust motes, wall cutaway, fog-aware entity retention, animated GLB cloning, camera follow, and full renderer and resource cleanup. |
| `packRegistry.js` | Multi-pack-per-projection registry: active-pack selection persisted per projection, entitlement-gated, graceful fallback. Node-testable. |
| `assetPacks.js` | Pack definitions and asset payloads; registers the shipped packs. |
| `zoomControl.js` | `RK.attachZoom(host)` and `RK.attachCamera(host)`: wheel and pinch zoom (0.4 to 4.0), double-click reset, pixelated scaling. |
| `fxLayer.js` | Shared canvas FX primitives, fire, and hazard overlays. |
| `catSprites.js` | Animated tavern cat (Pet Cats Pack idle strips, 10 frames of 50x50). |
| `chainAmbience.js` | `RK.mountChainAmbience(host)`: drifting top-block-hash fragments, a block-height readout, and a ripple when a block lands. Consumes the public `blockheight` broadcast, is decoration only, and pauses and prunes itself while the tab is hidden. |
| `spGameRenderer.js` | Single-player render bridge (`RK.SPGame`): player-centred camera, local 3D lazy-load, gameplay-focus restoration, and fallback to the legacy render engine when the kit is unavailable. |

Tests: `test/renderScene.test.js`, `test/renderPackResolver.test.js`, `test/packRegistry_ultra.test.js`,
`test/rendererCdnPolicy.test.js`, `test/pvpUiPolish.test.js`.
