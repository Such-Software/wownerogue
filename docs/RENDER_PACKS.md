# Render kit: modes, packs & FX

The client render kit (`html/js/render/`, namespace `RK`) draws the **same `Scene`** in multiple
techniques and art styles, so the tavern and dungeon are rich, interchangeable environments and new
art can be added as products.

## Modes vs. packs

- **Render modes = techniques** (how a scene is drawn): `Tiled`, `ASCII`, `Iso`, `3D`
  (`renderModes.js`). Each declares a `projection` (`topdown` / `iso` / `3d`).
- **Packs = sets/styles within a projection** (chosen via the pack picker): e.g. topdown *Roguelike
  Interior* ↔ *Roguelike Dungeon*, iso *Dungeon* ↔ *Medieval*. Registered in `packRegistry.js` /
  `assetPacks.js`. "Fancy" is **not** a mode — it's a pack (tiles + FX).
- A premium mode unlocks once the user has **any** unlocked pack for its projection.
- The scene model is **kind-based** (`floor`/`wall`/`table`/`torch`/`monster`/…), so one pack renders
  both the tavern (`sceneFromTavern`) and the dungeon (`sceneFromGameState`) — that's what makes
  packs interchangeable across both.

Entitlement: packs are gated by the operator-owned cosmetic catalog (`cosmetic_catalog` table,
`src/multiplayer/entitlements.js`) — free / grant / lifetime-spend / subscription-tier. See
`MONETIZATION.md`.

For browser QA, `?unlock=1` sets a sticky local bypass for render-mode and pack display gates;
`?unlock=0` clears it. This affects only that browser's `localStorage`, grants no server
entitlement, and is not an operator access-control mechanism.

## Gameplay focus contract

Single-player keyboard movement is deliberately accepted only while `#game-display` owns browser
focus, so typing in chat or another form cannot move the player. Choosing Tiled, ASCII, Iso, 3D, a
pack, or a camera control immediately returns focus to that gameplay area without scrolling.

## Local 3D runtime

Three.js `0.160.0` is an exact production dependency. The server advertises the local version in
`/runtime-config.js` and exposes only the browser build and required addons beneath:

```text
/vendor/three/0.160.0/three.module.min.js
/vendor/three/0.160.0/addons/loaders/GLTFLoader.js
/vendor/three/0.160.0/addons/utils/SkeletonUtils.js
```

The modules are imported lazily when 3D is selected. Local delivery is always enabled in the
application runtime and takes precedence over external sources. `RENDERER_CDN_ENABLED=true` makes
the jsDelivr renderer source path eligible only in a runtime where local delivery is disabled. All
checked-in environment profiles keep external renderer execution off, including production, so
Three.js remains same-origin under CSP.

Three.js library delivery is separate from generated model delivery. Runtime GLBs under
`html/assets/generated/3d/` are gitignored and must be provisioned independently; the renderer
keeps a low-poly fallback when a model cannot load and removes it once the animated GLB is attached.

## The FX layer (`fxLayer.js`, `RK.fx`)

Pure-canvas animated FX (CSP-safe, no WebGL), shared by the tiled **and** iso renderers so a scene
lights up the same way in either projection:

- `RK.fx.fire` — dancing two-layer flame + warm glow (torches, hearths).
- `RK.fx.hazard` — pulsing overlay for hazard tiles (`lava` / `poison` / `spikes`) with a
  footprint-clip callback so it fits square cells and iso diamonds alike.
- `RK.fx.flicker` / `pulse` / `glow` — the primitives.

A tile carries `fx: 'fire'` or `hazard: '<kind>'` in the scene legend (`sceneModel.js`); the renderer
draws only the tile's floor **base** in the static pass and lets `RK.fx` paint the animated layer in
the live loop. The tavern has wall braziers + a hearth; the dungeon hazard kinds are wired and render
the moment the generator emits their chars (`L`/`P`/`^`) — pending the generator + gameplay stakes.

## Other pieces

| File | Role |
|------|------|
| `isoRenderer.js` | Canvas isometric projection. Orientation-aware walls (`_S` for x-runs, `_W` for y-runs, corner tile), floor variety, contact shadows + vignette juice. Kenney iso dungeon set (`assets/kenney/iso-dungeon/`). |
| `tileRenderer.js`| Top-down atlas renderer. `over` compositing (object tiles drawn on a base tile), torch-lit vignette, ember/flicker loop, animated fire/hazard emitters. |
| `zoomControl.js` | `RK.attachZoom(host)` — wheel/pinch zoom (0.4–4.0), dblclick reset, pixelated scaling. |
| `catSprites.js`  | Animated tavern cat (Pet Cats Pack idle strips). |
| `packRegistry.js`| Multi-pack-per-projection registry: active-pack selection persisted per projection, entitlement-gated, graceful fallback. Node-testable. |
| `threeRenderer.js` | Same-origin Three.js scene, fog-aware entity retention, animated GLB cloning, fitted model scale, camera follow, and complete renderer/resource cleanup. |
| `spGameRenderer.js` | Single-player render bridge, player-centred camera, local 3D lazy-load, and explicit gameplay-focus restoration. |

Tests: `test/renderPackResolver.test.js`, `test/packRegistry_ultra.test.js`,
`test/rendererCdnPolicy.test.js`, and `test/pvpUiPolish.test.js`.
