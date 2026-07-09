// FXOverlay — dependency-free 2D-canvas FX layer for the FREE ROT.js dungeon (Pipeline A).
// Ports the premium FancyRenderer look (warm flickering torch light, screen-edge vignette,
// drifting-ember particle field, transient sparkles/bursts, full-screen color flash and a
// decaying screen shake) using plain <canvas> radial gradients instead of Pixi.
//
// Exposes a single global `window.FX`. EVERY method is a no-op when there is no
// #game-display / ROT base canvas present (so match.html & tavern.html — which never
// include this file — and any early-boot call are safe). It draws onto its OWN
// absolutely-positioned canvas layered just above the avatar overlay (z-index 7,
// pointer-events:none) and reuses the same overlay-sync math as
// SinglePlayerAvatar._syncOverlay. It runs its own requestAnimationFrame loop for
// flicker/embers/particles, and self-suspends (cancelAnimationFrame — no leaks) once the
// scene is idle; stop() hard-cancels it. Coordinates are in base-canvas pixel space.
(function (root) {
    'use strict';

    var doc = root.document;

    function now() {
        return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    }

    // A soft radial-gradient sprite baked onto an offscreen canvas (mirrors
    // FancyRenderer.radialTexture, but returns a <canvas> we blit with drawImage).
    function radialSprite(size, stops) {
        if (!doc) return null;
        var c = doc.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        if (!ctx) return null;
        var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    var FX = {
        _base: null,        // ROT base canvas (fallback if DisplayManager is unavailable)
        _host: null,        // #game-display container
        _canvas: null,      // our overlay canvas
        _ctx: null,
        _hostOrig: null,    // saved inline transform of the host (for shake restore)

        _running: false,
        _raf: 0,
        _lastT: 0,
        _t: 0,              // seconds accumulator for flicker/drift

        _active: false,     // a dungeon torch is being driven (renderLighting called)
        _forceAmbient: false, // screens can force the ambient scene without a player torch
        _light: { x: 0, y: 0, cell: 32, radius: 6.5, color: null, intensity: 1 },

        _embers: null,      // ambient drifting-ember field
        _particles: [],     // transient sparkles / bursts
        _flash: null,       // { color, alpha, t, dur }
        _shake: null,       // { mag, t, dur }

        _texLight: null,
        _texEmber: null,
        _texVig: null,
        _vigKey: '',
        _sizeKey: '',
        _tint: {},          // css-color -> tinted mote canvas (cache)
        _frameBound: null,

        // ---- texture bootstrap -------------------------------------------------
        _initTex: function () {
            if (this._texLight) return;
            this._texLight = radialSprite(160, [
                [0, 'rgba(255,205,130,0.95)'],
                [0.45, 'rgba(255,160,80,0.40)'],
                [1, 'rgba(255,150,70,0)']
            ]);
            this._texEmber = radialSprite(48, [
                [0, 'rgba(255,228,182,0.95)'],
                [1, 'rgba(255,228,182,0)']
            ]);
        },

        _tintedMote: function (color) {
            color = color || 'rgba(255,228,182,1)';
            if (this._tint[color]) return this._tint[color];
            if (!doc) return null;
            var size = 64;
            var c = doc.createElement('canvas');
            c.width = c.height = size;
            var ctx = c.getContext('2d');
            if (!ctx) return null;
            var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
            try {
                g.addColorStop(0, color);
                g.addColorStop(0.4, color);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
            } catch (_) {
                ctx.fillStyle = 'rgba(255,228,182,0.9)';
            }
            ctx.fillRect(0, 0, size, size);
            this._tint[color] = c;
            return c;
        },

        // ---- overlay sync (mirrors SinglePlayerAvatar._syncOverlay) -------------
        _resolveBase: function () {
            if (root.DisplayManager && root.DisplayManager.getDisplay) {
                var d = root.DisplayManager.getDisplay();
                if (d && d.getContainer) {
                    var c = d.getContainer();
                    if (c) return c;
                }
            }
            return this._base || null;
        },

        // Returns the 2D context of a correctly sized/positioned overlay, or null
        // (which makes every public method a no-op — keeps other pages unaffected).
        _ensure: function () {
            if (!doc) return null;
            var base = this._resolveBase();
            var host = doc.getElementById('game-display');
            if (!base || !host) return null;
            this._host = host;

            if (!this._canvas) {
                var cv = doc.createElement('canvas');
                cv.className = 'fx-overlay';
                cv.style.position = 'absolute';
                cv.style.pointerEvents = 'none';
                cv.style.zIndex = '7'; // just above the avatar overlay (z-index 6)
                cv.style.left = '0px';
                cv.style.top = '0px';
                // Override the retro `.rotdis canvas { image-rendering: pixelated }` rule so
                // the soft light/vignette gradients scale smoothly rather than blocky.
                cv.style.imageRendering = 'auto';
                this._canvas = cv;
                this._ctx = cv.getContext('2d');
            }
            // If a fresh ROT display replaced the host contents, re-attach.
            if (this._canvas.parentNode !== host) host.appendChild(this._canvas);
            if (!this._ctx) this._ctx = this._canvas.getContext('2d');
            if (!this._ctx) return null;

            this._initTex();

            var sizeKey = base.width + 'x' + base.height;
            if (sizeKey !== this._sizeKey) {
                if (base.width) this._canvas.width = base.width;
                if (base.height) this._canvas.height = base.height;
                this._sizeKey = sizeKey;
                this._buildVignette();
                this._seedEmbers();
            }
            this._canvas.style.left = base.offsetLeft + 'px';
            this._canvas.style.top = base.offsetTop + 'px';
            this._canvas.style.width = base.offsetWidth + 'px';
            this._canvas.style.height = base.offsetHeight + 'px';
            this._canvas.style.display = 'block';
            return this._ctx;
        },

        _buildVignette: function () {
            if (!doc || !this._canvas) return;
            var w = this._canvas.width, h = this._canvas.height;
            if (!w || !h) { this._texVig = null; return; }
            var c = doc.createElement('canvas');
            c.width = w; c.height = h;
            var ctx = c.getContext('2d');
            if (!ctx) { this._texVig = null; return; }
            var r = Math.max(w, h) * 0.72;
            var g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(0.62, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(0,0,0,0.62)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            this._texVig = c;
        },

        _seedEmbers: function () {
            if (!this._canvas) return;
            var w = this._canvas.width, h = this._canvas.height;
            if (!w || !h) { this._embers = []; return; }
            var n = Math.round(clamp((w * h) / 16000, 10, 46));
            var list = [];
            for (var i = 0; i < n; i++) {
                list.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    vx: (Math.random() - 0.5) * 8,
                    vy: -(6 + Math.random() * 14),
                    size: 3 + Math.random() * 6,
                    ph: Math.random() * 6.28,
                    baseA: 0.10 + Math.random() * 0.16
                });
            }
            this._embers = list;
        },

        // ---- lifecycle ---------------------------------------------------------
        _gameActive: function () {
            var g = root.Game;
            if (!g) return true; // no host game object -> assume caller knows best
            try { return !!g._gameActive; } catch (_) { return true; }
        },

        _sceneOn: function () {
            return (this._active && this._gameActive()) || this._forceAmbient;
        },

        _busy: function () {
            return this._sceneOn() || this._particles.length > 0 || !!this._flash || !!this._shake;
        },

        start: function () {
            if (!this._ensure()) return this;
            if (this._running) return this;
            if (!root.requestAnimationFrame) return this;
            this._running = true;
            this._lastT = 0;
            this._raf = root.requestAnimationFrame(this._frameBound);
            return this;
        },

        stop: function () {
            this._running = false;
            if (this._raf && root.cancelAnimationFrame) root.cancelAnimationFrame(this._raf);
            this._raf = 0;
            this._active = false;
            this._particles = [];
            this._flash = null;
            this._shake = null;
            this._resetHostTransform();
            if (this._ctx && this._canvas) {
                this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            }
            return this;
        },

        clear: function () {
            this._particles = [];
            this._flash = null;
            this._shake = null;
            this._resetHostTransform();
            if (this._ctx && this._canvas) {
                this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            }
            return this;
        },

        // ---- public FX API -----------------------------------------------------
        attach: function (baseCanvas) {
            if (baseCanvas) this._base = baseCanvas;
            this._ensure();
            return this;
        },

        syncTo: function (baseCanvas) {
            if (baseCanvas) this._base = baseCanvas;
            this._ensure();
            return this;
        },

        // Warm torch light centered on the player cell (base-canvas pixel space).
        renderLighting: function (playerScreenX, playerScreenY, cellPx, opts) {
            if (typeof playerScreenX !== 'number' || typeof playerScreenY !== 'number') return this;
            if (!isFinite(playerScreenX) || !isFinite(playerScreenY)) return this;
            opts = opts || {};
            var L = this._light;
            L.x = playerScreenX;
            L.y = playerScreenY;
            L.cell = cellPx || L.cell || 32;
            L.radius = opts.radius || L.radius || 6.5;
            L.color = opts.color || null;
            L.intensity = (typeof opts.intensity === 'number') ? opts.intensity : 1;
            this._active = true;
            if (!this._ensure()) return this; // no overlay -> no-op
            this.start();
            return this;
        },

        setAmbient: function (on) {
            this._forceAmbient = !!on;
            if (on) this.start();
            return this;
        },

        sparkle: function (x, y, color) {
            if (typeof x !== 'number' || typeof y !== 'number') return this;
            if (!this._ensure()) return this;
            var n = 5;
            for (var i = 0; i < n; i++) {
                var a = Math.random() * Math.PI * 2;
                var sp = 10 + Math.random() * 40;
                this._particles.push({
                    x: x, y: y,
                    vx: Math.cos(a) * sp,
                    vy: Math.sin(a) * sp - 20,
                    life: 0.5 + Math.random() * 0.4,
                    max: 0.9,
                    size: 6 + Math.random() * 8,
                    color: color || '#ffd700',
                    twinkle: true
                });
            }
            this._cap();
            this.start();
            return this;
        },

        burst: function (x, y, color, count) {
            if (typeof x !== 'number' || typeof y !== 'number') return this;
            if (!this._ensure()) return this;
            var n = count || 14;
            for (var i = 0; i < n; i++) {
                var a = Math.random() * Math.PI * 2;
                var sp = 40 + Math.random() * 140;
                this._particles.push({
                    x: x, y: y,
                    vx: Math.cos(a) * sp,
                    vy: Math.sin(a) * sp,
                    life: 0.45 + Math.random() * 0.55,
                    max: 1.0,
                    size: 8 + Math.random() * 12,
                    color: color || '#fbbf24',
                    twinkle: false
                });
            }
            this._cap();
            this.start();
            return this;
        },

        flash: function (color, alpha, ms) {
            if (!this._ensure()) return this;
            this._flash = {
                color: color || '#ffffff',
                alpha: (typeof alpha === 'number') ? alpha : 0.5,
                t: 0,
                dur: Math.max(0.05, (ms || 220) / 1000)
            };
            this.start();
            return this;
        },

        shake: function (intensity, ms) {
            if (!this._ensure()) return this;
            this._shake = {
                mag: intensity || 6,
                t: 0,
                dur: Math.max(0.05, (ms || 320) / 1000)
            };
            this.start();
            return this;
        },

        _cap: function () {
            var maxP = 180;
            if (this._particles.length > maxP) {
                this._particles.splice(0, this._particles.length - maxP);
            }
        },

        // ---- shake host transform ---------------------------------------------
        _setHostTransform: function (dx, dy) {
            if (!this._host) return;
            if (this._hostOrig == null) this._hostOrig = this._host.style.transform || '';
            this._host.style.transform = (this._hostOrig + ' translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px)').trim();
        },

        _resetHostTransform: function () {
            if (this._host && this._hostOrig != null) {
                this._host.style.transform = this._hostOrig;
            }
            this._hostOrig = null;
        },

        // ---- animation loop ----------------------------------------------------
        _frame: function () {
            if (!this._running) return;
            var ctx = this._ensure();
            if (!ctx) { this._running = false; this._raf = 0; return; }

            var t = now();
            var dt = this._lastT ? (t - this._lastT) / 1000 : 0.016;
            if (dt > 0.05) dt = 0.05; // clamp tab-switch gaps
            this._lastT = t;
            this._t += dt;

            this._update(dt);
            this._render(ctx);

            if (this._busy()) {
                this._raf = root.requestAnimationFrame(this._frameBound);
            } else {
                // Idle (game over / title, nothing animating): suspend the loop
                // entirely — no lingering rAF, no leak. A future call restarts it.
                this._running = false;
                this._raf = 0;
                this._active = false;
                this._resetHostTransform();
                ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            }
        },

        _update: function (dt) {
            var w = this._canvas.width, h = this._canvas.height;

            if (this._embers) {
                for (var i = 0; i < this._embers.length; i++) {
                    var e = this._embers[i];
                    e.x += e.vx * dt;
                    e.y += e.vy * dt;
                    if (e.y < -10) { e.y = h + 10; e.x = Math.random() * w; }
                    if (e.x < -10) e.x = w + 10; else if (e.x > w + 10) e.x = -10;
                }
            }

            for (var j = this._particles.length - 1; j >= 0; j--) {
                var p = this._particles[j];
                p.life -= dt;
                if (p.life <= 0) { this._particles.splice(j, 1); continue; }
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vx *= (1 - 1.6 * dt);      // drag
                p.vy += 60 * dt;             // gentle gravity
                p.vy *= (1 - 1.2 * dt);
            }

            if (this._flash) {
                this._flash.t += dt;
                if (this._flash.t >= this._flash.dur) this._flash = null;
            }

            if (this._shake) {
                this._shake.t += dt;
                if (this._shake.t >= this._shake.dur) {
                    this._shake = null;
                    this._resetHostTransform();
                }
            }
        },

        _render: function (ctx) {
            var w = this._canvas.width, h = this._canvas.height;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, w, h);

            // Screen shake: translate the whole host (base ROT canvas + overlays move
            // together, stays perfectly aligned); decays to zero.
            if (this._shake) {
                var k = 1 - (this._shake.t / this._shake.dur);
                var mag = this._shake.mag * k;
                this._setHostTransform((Math.random() * 2 - 1) * mag, (Math.random() * 2 - 1) * mag);
            }

            var scene = this._sceneOn();

            if (scene) {
                // (a) warm torch light on the player cell, gently flickering
                if (this._active && this._gameActive() && this._texLight) {
                    var L = this._light;
                    var cell = L.cell || 32;
                    var flick = 0.86 + Math.sin(this._t * 7.0) * 0.06 + Math.sin(this._t * 17.0) * 0.04 + Math.random() * 0.03;
                    var rad = (L.radius || 6.5) * cell * flick;
                    var a = clamp(0.42 * (L.intensity || 1) * flick, 0, 0.85);
                    var tex = L.color ? this._tintedMote(L.color) : this._texLight;
                    if (tex) {
                        ctx.globalCompositeOperation = 'lighter';
                        ctx.globalAlpha = a;
                        ctx.drawImage(tex, L.x - rad, L.y - rad, rad * 2, rad * 2);
                    }
                }

                // (c) ambient drifting-ember field (subtle, additive)
                if (this._embers && this._texEmber) {
                    ctx.globalCompositeOperation = 'lighter';
                    for (var i = 0; i < this._embers.length; i++) {
                        var e = this._embers[i];
                        ctx.globalAlpha = e.baseA * (0.55 + 0.45 * Math.sin(this._t * 1.6 + e.ph));
                        ctx.drawImage(this._texEmber, e.x - e.size, e.y - e.size, e.size * 2, e.size * 2);
                    }
                }

                // (b) screen-edge vignette (normal blend, darkens toward the frame)
                if (this._texVig) {
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = 1;
                    ctx.drawImage(this._texVig, 0, 0, w, h);
                }
            }

            // (d) transient one-shot particles (sparkle / burst), additive glow
            if (this._particles.length) {
                ctx.globalCompositeOperation = 'lighter';
                for (var j = 0; j < this._particles.length; j++) {
                    var p = this._particles[j];
                    var lk = clamp(p.life / p.max, 0, 1);
                    var tw = p.twinkle ? (0.6 + 0.4 * Math.sin(this._t * 22 + p.x)) : 1;
                    ctx.globalAlpha = lk * tw;
                    var tex2 = this._tintedMote(p.color);
                    if (tex2) {
                        var s = p.size * (0.55 + 0.45 * lk);
                        ctx.drawImage(tex2, p.x - s, p.y - s, s * 2, s * 2);
                    }
                }
            }

            // (e) full-canvas color flash (normal blend, fades out)
            if (this._flash) {
                var fk = clamp(1 - (this._flash.t / this._flash.dur), 0, 1);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = clamp(this._flash.alpha * fk, 0, 1);
                ctx.fillStyle = this._flash.color;
                ctx.fillRect(0, 0, w, h);
            }

            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }
    };

    FX._frameBound = function () { FX._frame(); };

    root.FX = FX;
    if (typeof module !== 'undefined' && module.exports) module.exports = FX;
})(typeof window !== 'undefined' ? window : globalThis);
