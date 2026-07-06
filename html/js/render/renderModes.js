// Render mode registry, factory, and entitlements for the render kit (RK).
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    // Render tiers. `premium` marks modes intended to be unlocked with credits — a cosmetic
    // entitlement gated by Operator Policy, the same pattern as avatar unlocks. NOTE: rendering
    // is client-side, so this is a soft/honour gate for cosmetics, not a hard security boundary.
    RK.RENDER_MODES = [
        { id: 'tiles', label: 'Tiled', premium: false },
        { id: 'ascii', label: 'ASCII', premium: true },
        { id: 'fancy', label: 'Fancy', premium: true, pack: 'generated-skins' },
        { id: 'iso', label: 'Iso', premium: true, pack: 'iso-dungeon' },
        { id: '3d', label: '3D', premium: true, pack: 'kenney-3d-characters' }
        // Planned: 'fancy-ascii' — shader-lit, animated glyphs.
    ];

    RK.entitlements = RK.entitlements || { premium: false, level: 'free', packs: {} };

    RK.modeMeta = function (id) {
        for (var i = 0; i < RK.RENDER_MODES.length; i++) {
            if (RK.RENDER_MODES[i].id === id) return RK.RENDER_MODES[i];
        }
        return null;
    };

    RK.canUseMode = function (id) {
        var m = RK.modeMeta(id);
        if (!m) return false;
        if (m.pack && RK.canUsePack) return RK.canUsePack(m.pack);
        return !m.premium || !!RK.entitlements.premium;
    };

    RK.createRenderer = function (mode, host, opts) {
        if (!RK.canUseMode(mode)) return new RK.TileRenderer(host, opts);
        if (mode === 'ascii' && RK.AsciiRenderer) return new RK.AsciiRenderer(host, opts);
        if (mode === 'iso' && RK.IsoRenderer) return new RK.IsoRenderer(host, opts);
        if (mode === '3d' && RK.ThreeRenderer && RK.THREE) return new RK.ThreeRenderer(host, opts);
        if (mode === 'fancy') {
            try {
                if (!RK.FancyRenderer) throw new Error('fancy renderer not loaded');
                return new RK.FancyRenderer(host, opts);
            } catch (e) {
                if (root.console) console.warn('Fancy renderer unavailable; using tiled:', e.message);
                return new RK.TileRenderer(host, opts);
            }
        }
        return new RK.TileRenderer(host, opts); // default / fallback
    };

    // Lazy-load PixiJS (+ @pixi/unsafe-eval for the strict CSP) only when Fancy is first needed,
    // so ASCII/Tiled users never download the WebGL library.
    var pixiLoading = false, pixiCbs = [];
    RK.pixiReady = function () { return typeof PIXI !== 'undefined'; };
    RK.ensurePixi = function (cb) {
        if (RK.pixiReady()) { cb(true); return; }
        pixiCbs.push(cb);
        if (pixiLoading) return;
        pixiLoading = true;
        var inject = function (src, onload, onerror) {
            var el = document.createElement('script');
            el.src = src; el.onload = onload; el.onerror = onerror;
            document.head.appendChild(el);
        };
        var done = function (ok) { var cbs = pixiCbs; pixiCbs = []; cbs.forEach(function (f) { f(ok); }); };
        inject('https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js', function () {
            // @pixi/unsafe-eval patches the shader compiler on load (needed under the CSP).
            inject('https://cdn.jsdelivr.net/npm/@pixi/unsafe-eval@7.4.2/dist/unsafe-eval.min.js',
                function () { done(true); }, function () { done(false); });
        }, function () { done(false); });
    };

    var threeLoading = false, threeCbs = [];
    RK.threeReady = function () { return !!(RK.THREE && RK.THREE.THREE); };
    RK.ensureThree = function (cb) {
        if (RK.threeReady()) { cb(true); return; }
        threeCbs.push(cb);
        if (threeLoading) return;
        threeLoading = true;
        Promise.all([
            import('https://cdn.jsdelivr.net/npm/three@0.160.0/+esm'),
            import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm')
        ]).then(function (mods) {
            RK.THREE = { THREE: mods[0], GLTFLoader: mods[1].GLTFLoader };
            var cbs = threeCbs; threeCbs = [];
            cbs.forEach(function (f) { f(true); });
        }).catch(function (e) {
            if (root.console) console.warn('Three renderer unavailable:', e && e.message);
            var cbs = threeCbs; threeCbs = [];
            cbs.forEach(function (f) { f(false); });
        });
    };

    // Create a renderer, loading Pixi on demand for Fancy; falls back to Tiled if Pixi fails.
    RK.createRendererAsync = function (mode, host, opts, cb) {
        if (!RK.canUseMode(mode)) {
            cb(new RK.TileRenderer(host, opts));
            return;
        }
        if (mode === 'fancy') {
            RK.ensurePixi(function (ok) {
                if (!ok) { cb(new RK.TileRenderer(host, opts)); return; }
                try { cb(new RK.FancyRenderer(host, opts)); }
                catch (e) {
                    if (root.console) console.warn('Fancy renderer failed; using tiled:', e.message);
                    cb(new RK.TileRenderer(host, opts));
                }
            });
            return;
        }
        if (mode === '3d') {
            RK.ensureThree(function (ok) {
                if (!ok) { cb(new RK.TileRenderer(host, opts)); return; }
                try { cb(new RK.ThreeRenderer(host, opts)); }
                catch (e) {
                    if (root.console) console.warn('3D renderer failed; using tiled:', e.message);
                    cb(new RK.TileRenderer(host, opts));
                }
            });
            return;
        }
        cb(RK.createRenderer(mode, host, opts));
    };

    RK.loadMode = function (def) {
        try {
            var m = localStorage.getItem('rk_mode');
            if (RK.modeMeta(m) && RK.canUseMode(m)) return m;
        } catch (_) { /* ignore */ }
        return def || 'tiles';
    };

    RK.saveMode = function (mode) {
        try { localStorage.setItem('rk_mode', mode); } catch (_) { /* ignore */ }
    };
})(window);
