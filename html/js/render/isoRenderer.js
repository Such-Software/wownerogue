// IsoRenderer — canvas isometric projection using Kenney's Isometric Miniature Dungeon pack.
// It draws the same Scene as the top-down renderers, preserving the shared Room contract.
(function (root) {
    'use strict';

    function IsoRenderer(host, opts) {
        opts = opts || {};
        this.name = 'iso';
        this.host = host;
        this.assets = (root.RK && ((RK.activeIsoAssets && RK.activeIsoAssets()) || RK.isoAssets)) || {};
        this.tileW = opts.tileW || (this.assets.tile && this.assets.tile.w) || 84;
        this.tileH = opts.tileH || (this.assets.tile && this.assets.tile.h) || 42;
        this.imageW = opts.imageW || (this.assets.tile && this.assets.tile.imageW) || 92;
        this.imageH = opts.imageH || (this.assets.tile && this.assets.tile.imageH) || 184;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rk-canvas';
        this.ctx = this.canvas.getContext('2d');
        this.cache = {};
        this.tintCache = {};
        this.boundsCache = {};
        this.last = {};
        this.lastScene = null;
        this.enabled = !(root.RK && RK.canUsePack && this.assets.pack && !RK.canUsePack(this.assets.pack));
        this._raf = null;
        this._animating = false;
        host.appendChild(this.canvas);
        if (this.enabled) this._preload();
    }

    IsoRenderer.prototype._load = function (url) {
        if (!url) return null;
        if (this.cache[url]) return this.cache[url];
        var rec = this.cache[url] = { ready: false, img: new Image() };
        var self = this;
        rec.img.onload = function () { rec.ready = true; self._invalidate(); };
        rec.img.onerror = function () { rec.error = true; };
        rec.img.src = url;
        return rec;
    };

    IsoRenderer.prototype._invalidate = function () {
        if (this._raf || !this.lastScene) return;
        var self = this;
        this._raf = requestAnimationFrame(function () {
            self._raf = null;
            if (self.lastScene) self.render(self.lastScene);
        });
    };

    IsoRenderer.prototype._preload = function () {
        var tiles = this.assets.tiles || {};
        for (var k in tiles) this._load(tiles[k]);
        var self = this;
        function loadCharacter(ch) {
            if (!ch) return;
            self._load(ch.idle);
            (ch.run || []).forEach(self._load.bind(self));
        }
        var ch = this.assets.character || {};
        loadCharacter(ch);
        var dirs = this.assets.directions || {};
        for (var d in dirs) loadCharacter(dirs[d]);
    };

    IsoRenderer.prototype._project = function (x, y, originX, originY) {
        return {
            x: originX + (x - y) * this.tileW / 2,
            y: originY + (x + y) * this.tileH / 2
        };
    };

    IsoRenderer.prototype._drawImage = function (img, cx, baseY, w, h) {
        this.ctx.drawImage(img, cx - w / 2, baseY - h, w, h);
    };

    IsoRenderer.prototype._imageBounds = function (img) {
        if (!img) return null;
        var key = img.src || img._rkBoundsKey || null;
        if (key && this.boundsCache[key]) return this.boundsCache[key];
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, w, h).data;
        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] < 8) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
        var bounds = maxX < minX ? { x: 0, y: 0, w: w, h: h } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        if (key) this.boundsCache[key] = bounds;
        return bounds;
    };

    IsoRenderer.prototype._drawSpriteImage = function (img, cx, baseY, h) {
        var b = this._imageBounds(img);
        if (!b) return;
        var w = h * (b.w / b.h);
        this.ctx.drawImage(img, b.x, b.y, b.w, b.h, cx - w / 2, baseY - h, w, h);
    };

    IsoRenderer.prototype._tintedImage = function (img, tint) {
        if (!img || !tint) return img;
        var key = img.src + '|' + tint;
        if (this.tintCache[key]) return this.tintCache[key];
        var cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width;
        cv.height = img.naturalHeight || img.height;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        cv._rkBoundsKey = key;
        this.tintCache[key] = cv;
        return cv;
    };

    IsoRenderer.prototype._skinTintFor = function (visual) {
        var ap = visual && visual.appearance;
        var skin = ap && ap.colors && ap.colors.skin;
        if (!skin || skin === 'natural') return null;
        var tones = root.RK && RK.CHAR_SKIN_TONES;
        var tone = tones && tones[skin];
        return (tone && tone.color) || null;
    };

    IsoRenderer.prototype._tileUrl = function (kind) {
        var tiles = this.assets.tiles || {};
        return tiles[kind] || tiles.fallback || tiles.floor;
    };

    IsoRenderer.prototype._visualFor = function (e) {
        var appearance = (e && e.appearance) || { avatar: (e && e.avatar) || 'default' };
        if (root.RK && RK.avatarVisuals && RK.avatarVisuals.resolve) {
            return RK.avatarVisuals.resolve(appearance, { projection: 'iso', context: 'tavern', entity: e });
        }
        if (root.RK && RK.resolveAppearance) return RK.resolveAppearance(e, 'iso');
        return null;
    };

    IsoRenderer.prototype._charFrame = function (e, now) {
        var visual = this._visualFor(e);
        if (visual && visual.allowed === false) return null;
        var dirs = this.assets.directions || {};
        var facing = (e && e.facing) || 'down';
        var key = e.id || 'anon';
        var st = this.last[key] || (this.last[key] = { x: e.x, y: e.y, t: 0 });
        if (st.x !== e.x || st.y !== e.y) { st.x = e.x; st.y = e.y; st.t = now; }
        var moving = (now - st.t) < 360;
        var ch = dirs[facing] || (visual && visual.character) || (this.assets.character || {});
        if (!moving || !ch.run || ch.run.length === 0) return { url: ch.idle, character: ch, visual: visual };
        this._animating = true;
        return { url: ch.run[Math.floor(now / 80) % ch.run.length], character: ch, visual: visual };
    };

    IsoRenderer.prototype.render = function (scene) {
        if (!scene) return;
        this.lastScene = scene;
        this._animating = false;
        var margin = 28;
        var originX = margin + scene.rows * this.tileW / 2 + this.tileW;
        var originY = margin + this.imageH;
        this.canvas.width = Math.ceil((scene.cols + scene.rows) * this.tileW / 2 + margin * 2 + this.tileW * 2);
        this.canvas.height = Math.ceil((scene.cols + scene.rows) * this.tileH / 2 + this.imageH + margin * 2);

        var ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = scene.background || '#0a0c0f';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.imageSmoothingEnabled = true;

        // Furniture kinds draw a floor tile as the base + the prop sprite on top (same idea as the
        // tiled renderer's `over` compositing). Everything else is a plain ground/wall tile.
        var PROP = { bar: 1, table: 1, chair: 1, keg: 1, shelf: 1, barrel: 1, crate: 1 };
        var items = [], x, y, kind, p;
        for (y = 0; y < scene.rows; y++) {
            for (x = 0; x < scene.cols; x++) {
                kind = scene.grid[y][x];
                p = this._project(x, y, originX, originY);
                items.push({ type: 'tile', kind: kind, x: x, y: y, sx: p.x, sy: p.y, depth: x + y });
                if (PROP[kind]) {
                    items.push({ type: 'prop', kind: kind, x: x, y: y, sx: p.x, sy: p.y, depth: x + y + 0.25 });
                }
            }
        }
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            p = this._project(e.x, e.y, originX, originY);
            items.push({ type: 'entity', e: e, sx: p.x, sy: p.y, depth: e.x + e.y + 0.55 });
        }
        items.sort(function (a, b) { return a.depth === b.depth ? (a.y || 0) - (b.y || 0) : a.depth - b.depth; });

        var now = Date.now();
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.type === 'tile') {
                var tileKind = PROP[it.kind] ? 'floor' : it.kind;
                var rec = this._load(this._tileUrl(tileKind));
                if (rec && rec.ready) this._drawImage(rec.img, it.sx, it.sy + this.tileH, this.imageW, this.imageH);
            } else if (it.type === 'prop') {
                rec = this._load(this._tileUrl(it.kind));
                if (rec && rec.ready) this._drawImage(rec.img, it.sx, it.sy + this.tileH, this.imageW, this.imageH);
            } else if (it.type === 'entity') {
                var frame = this._charFrame(it.e, now);
                rec = this._load(frame && frame.url);
                if (rec && rec.ready) {
                    var ch = frame.character || this.assets.character || {};
                    var tint = this._skinTintFor(frame.visual);
                    this._drawSpriteImage(this._tintedImage(rec.img, tint), it.sx, it.sy + this.tileH * 0.95, ch.imageH || 92);
                } else {
                    ctx.beginPath();
                    ctx.arc(it.sx, it.sy, 8, 0, Math.PI * 2);
                    ctx.fillStyle = it.e.color || '#d7dbe0';
                    ctx.fill();
                }
                if (it.e.you) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.ellipse(it.sx, it.sy + this.tileH * 0.7, 20, 8, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                if (it.e.label) {
                    ctx.fillStyle = '#d7dbe0';
                    ctx.font = '11px monospace';
                    ctx.textAlign = 'center';
                    ctx.fillText(it.e.label, it.sx, it.sy - 62);
                }
            }
        }
        if (this._animating) this._invalidate();
    };

    IsoRenderer.prototype.destroy = function () {
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        this.cache = {};
        this.tintCache = {};
        this.boundsCache = {};
        this.last = {};
        this.lastScene = null;
    };

    root.RK = root.RK || {};
    root.RK.IsoRenderer = IsoRenderer;
})(window);
