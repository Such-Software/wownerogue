// FancyRenderer — WebGL tier via PixiJS (v7). Beyond flat shapes: a real blurred bloom on
// entities, warm flickering lights along the bar, drifting dust motes, and a vignette — all
// programmatic (no art assets). Requires a global PIXI (loaded from CDN, with @pixi/unsafe-eval
// so shaders compile under a strict CSP); the factory falls back to tiled if PIXI is missing.
(function (root) {
    'use strict';

    function colorNum(hex) { return parseInt(String(hex).replace('#', ''), 16) || 0; }
    function facingDelta(f) {
        if (f === 'up') return { x: 0, y: -1 };
        if (f === 'left') return { x: -1, y: 0 };
        if (f === 'right') return { x: 1, y: 0 };
        return { x: 0, y: 1 };
    }
    // A soft radial-gradient texture (used for lights, motes, and the vignette).
    function radialTexture(size, stops) {
        var c = document.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        var g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return PIXI.Texture.from(c);
    }

    function FancyRenderer(host, opts) {
        if (typeof PIXI === 'undefined') throw new Error('PIXI not loaded');
        opts = opts || {};
        this.name = 'fancy';
        this.host = host;
        this.cell = opts.cell || 26;
        this.app = new PIXI.Application({ backgroundColor: 0x0a0c0f, antialias: true });
        this.app.view.className = 'rk-canvas';
        host.appendChild(this.app.view);

        this.tileLayer = new PIXI.Container();
        this.lightLayer = new PIXI.Container();
        this.entityLayer = new PIXI.Container();
        this.particleLayer = new PIXI.Container();
        this.app.stage.addChild(this.tileLayer, this.lightLayer, this.entityLayer, this.particleLayer);
        this.vignette = null;

        this.texLight = radialTexture(128, [[0, 'rgba(255,190,110,0.95)'], [1, 'rgba(255,190,110,0)']]);
        this.texMote = radialTexture(64, [[0, 'rgba(255,240,210,0.9)'], [1, 'rgba(255,240,210,0)']]);
        this.texVig = radialTexture(256, [[0, 'rgba(0,0,0,0)'], [0.6, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.62)']]);

        this.sprites = {};
        this.lights = [];
        this.particles = [];
        this._sizeKey = null;
        this._t = 0;

        var self = this;
        this._tick = function (dt) { self._animate(dt); };
        this.app.ticker.add(this._tick);
    }

    FancyRenderer.prototype.render = function (scene) {
        if (!scene || !this.app) return;
        var cell = this.cell, w = scene.cols * cell, h = scene.rows * cell;
        this.app.renderer.resize(w, h);
        var key = scene.cols + 'x' + scene.rows;
        var hasRoom = !!(window.RK && RK.roomReady && RK.roomReady());
        if (key !== this._sizeKey || hasRoom !== this._hadRoom) {
            this._buildTiles(scene);
            this._buildLights(scene);
            this._buildVignette(w, h);
            this._seedParticles(w, h);
            this._sizeKey = key;
            this._hadRoom = hasRoom;
        }
        this._syncEntities(scene);
    };

    FancyRenderer.prototype._buildTiles = function (scene) {
        this.tileLayer.removeChildren();
        var cell = this.cell;
        // A designed room is loaded — draw its layered tiles as sprites from the room atlas.
        if (window.RK && RK.roomReady && RK.roomReady()) {
            var d = RK.activeRoom.desc, a = RK.activeRoom.atlas;
            for (var li = 0; li < d.layerOrder.length; li++) {
                var grid = d.layers[d.layerOrder[li]];
                for (var ry = 0; ry < d.rows; ry++) {
                    for (var rx = 0; rx < d.cols; rx++) {
                        var idx = grid[ry][rx];
                        if (idx < 0) continue;
                        var tex = a.texture(idx % a.cols, Math.floor(idx / a.cols));
                        if (!tex) continue;
                        var sp = new PIXI.Sprite(tex);
                        sp.x = rx * cell; sp.y = ry * cell; sp.width = cell; sp.height = cell;
                        this.tileLayer.addChild(sp);
                    }
                }
            }
            return;
        }
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                var def = scene.legend[scene.grid[y][x]] || { color: '#333' };
                var g = new PIXI.Graphics();
                g.beginFill(colorNum(def.color));
                g.drawRoundedRect(0, 0, cell - 1, cell - 1, 4);
                g.endFill();
                if (def.solid) {
                    g.beginFill(0xffffff, 0.09);
                    g.drawRoundedRect(0, 0, cell - 1, Math.max(2, cell * 0.2), 4);
                    g.endFill();
                    g.beginFill(0x000000, 0.22);
                    g.drawRect(0, cell - 3, cell - 1, 3);
                    g.endFill();
                }
                g.x = x * cell;
                g.y = y * cell;
                this.tileLayer.addChild(g);
            }
        }
    };

    FancyRenderer.prototype._buildLights = function (scene) {
        this.lightLayer.removeChildren();
        this.lights = [];
        var cell = this.cell;
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                if (scene.grid[y][x] !== 'bar' || (x % 3) !== 0) continue; // sample the bar
                var s = new PIXI.Sprite(this.texLight);
                s.anchor.set(0.5);
                s.blendMode = PIXI.BLEND_MODES.ADD;
                s.x = x * cell + cell / 2;
                s.y = y * cell + cell / 2;
                s.scale.set(cell * 2.4 / 128);
                s.alpha = 0.5;
                this.lightLayer.addChild(s);
                this.lights.push({ s: s, base: 0.5, phase: Math.random() * 6.28 });
            }
        }
    };

    FancyRenderer.prototype._buildVignette = function (w, h) {
        if (this.vignette) { this.app.stage.removeChild(this.vignette); this.vignette.destroy(); }
        this.vignette = new PIXI.Sprite(this.texVig);
        this.vignette.anchor.set(0.5);
        this.vignette.x = w / 2;
        this.vignette.y = h / 2;
        this.vignette.width = w * 1.25;
        this.vignette.height = h * 1.35;
        this.app.stage.addChild(this.vignette); // drawn on top of everything
    };

    FancyRenderer.prototype._seedParticles = function (w, h) {
        this.particleLayer.removeChildren();
        this.particles = [];
        var n = Math.min(60, Math.max(12, Math.round(w * h / 9000)));
        for (var i = 0; i < n; i++) {
            var p = new PIXI.Sprite(this.texMote);
            p.anchor.set(0.5);
            p.blendMode = PIXI.BLEND_MODES.ADD;
            p.x = Math.random() * w;
            p.y = Math.random() * h;
            p.scale.set(0.12 + Math.random() * 0.18);
            p.alpha = 0.15 + Math.random() * 0.2;
            this.particleLayer.addChild(p);
            this.particles.push({
                s: p, w: w, h: h, ph: Math.random() * 6.28,
                vx: (Math.random() - 0.5) * 0.25, vy: -(0.05 + Math.random() * 0.15)
            });
        }
    };

    FancyRenderer.prototype._makeSprite = function (e) {
        var cell = this.cell, r = cell * 0.34, col = colorNum(e.color);
        var c = new PIXI.Container();

        var glow = new PIXI.Graphics();
        glow.beginFill(col, 0.6);
        glow.drawCircle(0, 0, r * 1.4);
        glow.endFill();
        try {
            if (!PIXI.BlurFilter) throw new Error('no blur');
            glow.filters = [new PIXI.BlurFilter(8)]; // real soft bloom
        } catch (_) {
            // No blur available: fake it with layered alpha rings.
            glow.clear();
            [[1.9, 0.05], [1.5, 0.10], [1.15, 0.18]].forEach(function (ring) {
                glow.beginFill(col, ring[1]);
                glow.drawCircle(0, 0, r * ring[0]);
                glow.endFill();
            });
        }
        glow.blendMode = PIXI.BLEND_MODES.ADD;
        c.addChild(glow);
        c._glow = glow;

        var body = new PIXI.Graphics();
        body.beginFill(col);
        body.drawCircle(0, 0, r);
        body.endFill();
        var d = facingDelta(e.facing);
        body.beginFill(0x0a0c0f);
        body.drawCircle(d.x * r * 0.55, d.y * r * 0.55, cell * 0.08);
        body.endFill();
        c.addChild(body);

        if (e.you) {
            var ring = new PIXI.Graphics();
            ring.lineStyle(2, 0xffffff, 0.9);
            ring.drawCircle(0, 0, r + 2);
            c.addChild(ring);
        }
        if (e.label) {
            var label = new PIXI.Text(e.label, { fontFamily: 'monospace', fontSize: 11, fill: 0xd7dbe0 });
            label.anchor.set(0.5, 1);
            label.y = -cell * 0.5;
            c.addChild(label);
        }
        return c;
    };

    // A premium animated-skin sprite (Pixi). Frames are swapped each tick in _animate.
    FancyRenderer.prototype._makeSkinSprite = function (e) {
        var s = window.RK.SKINS[e.avatar];
        var c = new PIXI.Container();
        var h = this.cell * (s.scale || 1.8);
        // Warm backlight so a dark character reads against the dark room.
        var glow = new PIXI.Graphics();
        [[h * 0.55, 0.05], [h * 0.4, 0.10], [h * 0.28, 0.16]].forEach(function (rr) {
            glow.beginFill(0xffe2b4, rr[1]); glow.drawCircle(0, 0, rr[0]); glow.endFill();
        });
        glow.blendMode = PIXI.BLEND_MODES.ADD;
        glow.y = this.cell * 0.5 - h * 0.42;
        c.addChild(glow);
        var spr = new PIXI.Sprite(window.RK.skinTexture(e.avatar, 0, 0));
        spr.anchor.set(0.5, 0.9);
        spr.height = h; spr.width = h * (s.frameW / s.frameH);
        spr.y = this.cell * 0.5;   // feet at the tile's bottom
        c.addChild(spr);
        c._skinSpr = spr; c._skinId = e.avatar;
        if (e.you) {
            var ring = new PIXI.Graphics();
            ring.lineStyle(2, 0xffffff, 0.85);
            ring.drawEllipse(0, this.cell * 0.5, this.cell * 0.3, this.cell * 0.16);
            c.addChild(ring);
        }
        if (e.label) {
            var label = new PIXI.Text(e.label, { fontFamily: 'monospace', fontSize: 11, fill: 0xd7dbe0 });
            label.anchor.set(0.5, 1); label.y = this.cell * 0.5 - h - 2;
            c.addChild(label);
        }
        return c;
    };

    function configureCharPart(spr, h) {
        spr.anchor.set(0.5, 0.9);
        spr.height = h;
        spr.width = h;
        return spr;
    }

    // A roguelike character sprite (procedural walk + composited equipment), animated in _animate.
    FancyRenderer.prototype._makeCharSprite = function (e) {
        var appearance = window.RK.charAppearance(e);
        var ch = window.RK.CHARS[appearance.avatar];
        var c = new PIXI.Container();
        var h = this.cell * 1.8;
        var body = new PIXI.Container();
        body.y = this.cell * 0.5;
        var baseTex = window.RK.charTileTexture(ch.frame, appearance.tint, appearance.colors, 'base');
        if (baseTex) body.addChild(configureCharPart(new PIXI.Sprite(baseTex), h));
        window.RK.charOverlayParts(appearance).forEach(function (part) {
            var tex = window.RK.charTileTexture(part.frame, part.tint, part.colorable ? appearance.colors : null, part.slot);
            if (tex) body.addChild(configureCharPart(new PIXI.Sprite(tex), h));
        });
        c.addChild(body);
        c._charBody = body; c._charId = appearance.avatar; c._charKey = window.RK.charRenderKey(e);
        if (e.you) {
            var ring = new PIXI.Graphics();
            ring.lineStyle(2, 0xffffff, 0.85);
            ring.drawEllipse(0, this.cell * 0.5, this.cell * 0.3, this.cell * 0.16);
            c.addChild(ring);
        }
        if (e.label) {
            var label = new PIXI.Text(e.label, { fontFamily: 'monospace', fontSize: 11, fill: 0xd7dbe0 });
            label.anchor.set(0.5, 1); label.y = this.cell * 0.5 - h - 2;
            c.addChild(label);
        }
        return c;
    };

    FancyRenderer.prototype._syncEntities = function (scene) {
        var cell = this.cell, seen = {}, RKr = window.RK;
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            seen[e.id] = true;
            var wantSkin = !!(RKr && RKr.isSkin && RKr.isSkin(e.avatar));
            var wantChar = !!(RKr && RKr.isChar && RKr.isChar(e.avatar));
            if (wantSkin && !RKr.skinSheet(e.avatar)) RKr.loadSkin(e.avatar); // lazy fetch
            if (wantChar && !RKr.charAtlas()) RKr.loadCharAtlas();
            var kind = (wantSkin && RKr.skinSheet(e.avatar)) ? 'skin'
                     : (wantChar && RKr.charAtlas()) ? 'char'
                     : 'circle';
            var renderKey = (kind === 'char' && RKr.charRenderKey) ? RKr.charRenderKey(e) : e.avatar;
            var s = this.sprites[e.id];
            if (s && (s.kind !== kind || s.renderKey !== renderKey)) { // sheet loaded or appearance changed -> rebuild
                this.entityLayer.removeChild(s.c); s.c.destroy({ children: true });
                s = null; delete this.sprites[e.id];
            }
            if (!s) {
                var c = (kind === 'skin') ? this._makeSkinSprite(e)
                      : (kind === 'char') ? this._makeCharSprite(e)
                      : this._makeSprite(e);
                c.x = e.x * cell + cell / 2;
                c.y = e.y * cell + cell / 2;
                this.entityLayer.addChild(c);
                s = this.sprites[e.id] = { c: c, kind: kind, renderKey: renderKey };
            }
            s.tx = e.x; s.ty = e.y; s.e = e;
        }
        for (var id in this.sprites) {
            if (!seen[id]) {
                this.entityLayer.removeChild(this.sprites[id].c);
                this.sprites[id].c.destroy({ children: true });
                delete this.sprites[id];
            }
        }
    };

    FancyRenderer.prototype._animate = function (dt) {
        this._t += dt;
        var t = this._t, cell = this.cell, k = Math.min(1, 0.22 * dt), i, nowMs = Date.now();

        for (var id in this.sprites) {
            var s = this.sprites[id];
            var tx = s.tx * cell + cell / 2, ty = s.ty * cell + cell / 2;
            s.c.x += (tx - s.c.x) * k;
            s.c.y += (ty - s.c.y) * k;
            if (s.c._charBody && s.e) {
                var cf = window.RK.charFrame(window.RK.CHARS[s.c._charId], s.e, nowMs);
                s.c._charBody.scale.x = cf.flip ? -1 : 1;
                s.c._charBody.scale.y = cf.squash;
                s.c._charBody.y = this.cell * 0.5 + cf.bob;
            } else if (s.c._skinSpr && s.e) {
                var sk = window.RK.SKINS[s.c._skinId];
                var fr = window.RK.skinFrame(sk, s.e, nowMs);
                var tex = window.RK.skinTexture(s.c._skinId, fr.row, fr.col);
                if (tex) s.c._skinSpr.texture = tex;
            } else if (s.c._glow) {
                s.c._glow.scale.set(1 + Math.sin(t * 0.09 + s.tx) * 0.16);
                s.c._glow.alpha = 0.65 + Math.sin(t * 0.11) * 0.25;
            }
        }
        for (i = 0; i < this.lights.length; i++) {
            var L = this.lights[i];
            L.s.alpha = L.base + Math.sin(t * 0.25 + L.phase) * 0.14 + Math.sin(t * 0.9 + L.phase * 1.7) * 0.06;
        }
        for (i = 0; i < this.particles.length; i++) {
            var p = this.particles[i];
            p.s.x += p.vx * dt;
            p.s.y += p.vy * dt;
            if (p.s.y < -8) { p.s.y = p.h + 8; p.s.x = Math.random() * p.w; }
            if (p.s.x < -8) p.s.x = p.w + 8; else if (p.s.x > p.w + 8) p.s.x = -8;
            p.s.alpha = 0.12 + (Math.sin(t * 0.15 + p.ph) + 1) * 0.12;
        }
    };

    FancyRenderer.prototype.destroy = function () {
        try {
            if (this.app) {
                this.app.ticker.remove(this._tick);
                this.app.destroy(true, { children: true });
            }
        } catch (_) { /* ignore */ }
        [this.texLight, this.texMote, this.texVig].forEach(function (tx) {
            try { if (tx) tx.destroy(true); } catch (_) { /* ignore */ }
        });
        this.app = null;
        this.sprites = {};
        this.lights = [];
        this.particles = [];
    };

    root.RK = root.RK || {};
    root.RK.FancyRenderer = FancyRenderer;
})(window);
