// SP game render bridge (RK.SPGame) — renders the single-player DUNGEON through the render kit
// (Tiled / ASCII / Iso / 3D + unlocked packs) instead of the legacy ROT display, so a pack you
// bought applies in actual gameplay, not just the tavern. It mounts a renderer in a dedicated host
// inside #game-display and hides the legacy ROT canvases while a game is live; the retro splash /
// win / lose text screens still use ROT. If anything here is unavailable it returns false and the
// caller falls back to the legacy RenderEngine, so the live game can never hard-break.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};
    var SP = RK.SPGame = RK.SPGame || {};

    SP._renderer = null;
    SP._mode = null;
    SP._live = false;

    function doc() { return root.document; }
    function gameDisplay() { return doc() && doc().getElementById('game-display'); }

    // A dedicated, SELF-SIZING child host so the RK canvas doesn't collide with the ROT canvas and
    // doesn't depend on the ROT canvas for its dimensions (it's an aspect-ratio viewport the camera
    // transform is clipped to).
    function rkHost() {
        var gd = gameDisplay();
        if (!gd) return null;
        var host = doc().getElementById('rk-game-host');
        if (!host) {
            host = doc().createElement('div');
            host.id = 'rk-game-host';
            // FILL #game-display exactly (inset:0). #game-display is a definite, grid-bounded height
            // (the .container is height:100vh; overflow:hidden), so filling it gives the camera
            // reliable clientWidth/clientHeight every frame. The earlier `min(78vh)` + translate(-50%)
            // centering could resolve to a wrong/transient size, stranding the view in a top band.
            // Pure-black background so the area BEYOND the map edge is the SAME black as an
            // unexplored ('dark') in-bounds tile — otherwise the shade difference outlines the map.
            host.style.cssText = 'display:none; position:absolute; inset:0;' +
                ' overflow:hidden; background:#000; z-index:6; touch-action:none; cursor:grab;';
            gd.appendChild(host);
        }
        return host;
    }

    SP.available = function () {
        return !!(RK.createRenderer && RK.sceneFromGameState && gameDisplay());
    };

    SP.mode = function () {
        if (!SP._mode) {
            var m = (RK.loadMode && RK.loadMode('tiles')) || 'tiles';
            SP._mode = (RK.canUseMode && !RK.canUseMode(m)) ? 'tiles' : m;
        }
        return SP._mode;
    };

    SP.setMode = function (mode) {
        if (RK.canUseMode && !RK.canUseMode(mode)) return false;
        SP._mode = mode;
        if (RK.saveMode) RK.saveMode(mode);
        SP._destroyRenderer();
        if (SP._live && SP._lastState) SP.render(SP._lastState, SP._lastOpts);
        return true;
    };

    // Re-mount after a pack switch (same mode, new active pack/assets).
    SP.refreshPack = function () {
        SP._destroyRenderer();
        if (SP._live && SP._lastState) SP.render(SP._lastState, SP._lastOpts);
    };

    SP._destroyRenderer = function () {
        if (SP._renderer && SP._renderer.destroy) { try { SP._renderer.destroy(); } catch (_) {} }
        SP._renderer = null;
    };

    SP._ensureRenderer = function () {
        if (SP._renderer) return SP._renderer;
        var host = rkHost();
        if (!host || !RK.createRenderer) return null;
        var mode = SP.mode();
        // 3D needs THREE, lazy-loaded from a CDN. The sync createRenderer() silently returns a Tiled
        // renderer when THREE isn't loaded yet ("picked 3D, got original"). Kick off the load and
        // re-mount as real 3D once it's ready; meanwhile we render Tiled so the screen isn't blank.
        if (mode === '3d' && RK.ensureThree && RK.threeReady && !RK.threeReady()) {
            if (!SP._threePending) {
                SP._threePending = true;
                RK.ensureThree(function (ok) {
                    SP._threePending = false;
                    if (ok && SP._live && SP.mode() === '3d') {
                        SP._destroyRenderer();
                        if (SP._lastState) SP.render(SP._lastState, SP._lastOpts);
                    }
                });
            }
        }
        SP._renderer = RK.createRenderer(mode, host, { cell: 24 });
        // The camera owns the canvas transform (centre on the player), so position it absolutely
        // and let it overflow — do NOT use RK.attachZoom (it fights this transform).
        if (SP._renderer && SP._renderer.canvas) {
            var c = SP._renderer.canvas;
            c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0';
            // Beat `.rotdis canvas { max-width:100% !important }` so the camera controls the size.
            c.style.setProperty('max-width', 'none', 'important');
            c.style.setProperty('image-rendering', 'pixelated', 'important');
        }
        if (!host._rkZoomBound) {
            host._rkZoomBound = true;
            host.addEventListener('wheel', function (ev) {
                ev.preventDefault();
                SP._zoom = Math.max(0.6, Math.min(4, (SP._zoom || 1.7) * Math.exp(-ev.deltaY * 0.0015)));
                SP._applyCamera();
            }, { passive: false });
        }
        return SP._renderer;
    };

    // Centre the (whole-scene) canvas on the player via a CSS transform, clipped to the host —
    // renderer-agnostic (works for tiled / iso / 3d, each of which reports its own focusPoint).
    SP._applyCamera = function () {
        var r = SP._renderer;
        var host = doc() && doc().getElementById('rk-game-host');
        if (!r || !r.canvas || !host) return;
        // The 3D renderer fills the host itself (setSize) and its OWN THREE camera follows the
        // player — so DON'T apply a CSS transform (it would double-transform the WebGL view).
        if (r.name === '3d') {
            r.canvas.style.transform = 'none';
            r.canvas.style.left = '0';
            r.canvas.style.top = '0';
            return;
        }
        var scale = SP._zoom || 1.7;
        var fp = r.focusPoint;
        // ROBUSTNESS: if the renderer hasn't reported a focus this frame — a race at game start, or a
        // camera tick reading a just-(re)created renderer instance before its first render — derive the
        // focus straight from the last known player cell (tiled coords). Without this the camera falls
        // back to a scale-only transform that pins the whole level to the top-left corner.
        if (!fp && (r.name === 'tiles' || r.name === 'ascii') && SP._lastState && SP._lastState.player &&
            typeof SP._lastState.player.x === 'number') {
            var _c = r.cell || 24;
            fp = { x: (SP._lastState.player.x + 0.5) * _c, y: (SP._lastState.player.y + 0.5) * _c };
        }
        r.canvas.style.transformOrigin = '0 0';
        if (!fp) { r.canvas.style.transform = 'scale(' + scale + ')'; return; }
        var w = host.clientWidth || host.offsetWidth || 640, h = host.clientHeight || host.offsetHeight || 400;
        var tx = w / 2 - fp.x * scale, ty = h / 2 - fp.y * scale;
        // Smooth follow: glide toward the target so single steps aren't jerky; SNAP on a big jump
        // (level-change teleport / a stale-then-updated focus) rather than slowly panning the map.
        if (SP._camX == null || Math.abs(tx - SP._camX) > w || Math.abs(ty - SP._camY) > h) {
            SP._camX = tx; SP._camY = ty;
        } else {
            SP._camX += (tx - SP._camX) * 0.3;
            SP._camY += (ty - SP._camY) * 0.3;
        }
        r.canvas.style.transform = 'translate(' + SP._camX + 'px,' + SP._camY + 'px) scale(' + scale + ')';
    };

    function toggleLegacy(hide) {
        var gd = gameDisplay();
        if (!gd) return;
        var kids = gd.children;
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].id === 'rk-game-host') continue;
            kids[i].style.display = hide ? 'none' : '';
        }
    }

    // Show the render-kit view (hide the ROT splash canvases). Call on game start.
    SP.show = function () {
        if (!SP.available()) return false;
        var host = rkHost();
        if (!host) return false;
        host.style.display = 'block';
        toggleLegacy(true);
        SP._live = true;
        SP._camX = null; // snap-center on the first frame of a new game
        SP._startCameraLoop();
        return true;
    };

    // Re-apply the camera every frame while live — robust against the renderer resizing its canvas
    // or a transient focusPoint, which was making the view snap to the corner mid-run.
    SP._startCameraLoop = function () {
        if (SP._camRaf != null) return;
        function tick() {
            if (!SP._live) { SP._camRaf = null; return; }
            SP._applyCamera();
            SP._camRaf = root.requestAnimationFrame(tick);
        }
        SP._camRaf = root.requestAnimationFrame(tick);
    };

    // Back to the ROT view (splash / win / lose). Call on game end.
    SP.hide = function () {
        SP._live = false;
        SP._destroyRenderer();
        var host = doc() && doc().getElementById('rk-game-host');
        if (host) host.style.display = 'none';
        toggleLegacy(false);
    };

    // Build the Scene from the SP client render-state and draw it. Returns true if it rendered
    // (caller then skips the legacy renderer). Non-destructive on failure.
    SP.render = function (clientState, opts) {
        if (!SP._live || !SP.available()) return false;
        var r = SP._ensureRenderer();
        if (!r) return false;
        opts = opts || {};
        SP._lastState = clientState;
        SP._lastOpts = opts;
        try {
            var scene = RK.sceneFromGameState(clientState, {
                cryptoType: opts.cryptoType,
                playerAppearance: opts.playerAppearance,
                isSpectating: opts.isSpectating
            });
            r.render(scene);
            SP._applyCamera();
            return true;
        } catch (e) {
            if (root.console) console.warn('SPGame render failed; falling back to legacy:', e && e.message);
            return false;
        }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = SP;
})(typeof window !== 'undefined' ? window : this);
