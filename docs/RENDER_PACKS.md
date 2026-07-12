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
`src/multiplayer/entitlements.js`) — free / grant / lifetime-spend / subscription-tier. `?unlock=1`
sets a sticky local QA bypass. See `MONETIZATION.md`.

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

Tests: `test/renderPackResolver.test.js`, `test/packRegistry_ultra.test.js`.
