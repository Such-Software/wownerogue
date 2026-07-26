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
        this.shadeCache = {};
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

    // Map a dungeon FEATURE entity (entrance/exit/treasure/item) to a pack tile: stairs for the
    // entrance/exit, a chest for treasure/items. Null if the pack has no fitting tile (→ glyph).
    IsoRenderer.prototype._featureTileUrl = function (e) {
        var tiles = this.assets.tiles || {};
        var c = e.char;
        if (c === '<' || c === '>') return tiles.stairs || null;
        if (c === '$' || c === '$W' || c === '$M') return tiles.chestClosed || tiles.chest || null;
        return null;
    };

    // A stroked iso diamond outline — used to flag the floor cells the player can actually step to,
    // so ambiguous wall gaps are never mistaken for openings.
    IsoRenderer.prototype._diamondOutline = function (cx, cy, color) {
        var ctx = this.ctx, hw = this.tileW / 2, hh = this.tileH / 2;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
        ctx.closePath();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.restore();
    };

    // Draw a text glyph centered at a projected cell (feature fallback when no pack tile fits).
    IsoRenderer.prototype._glyph = function (cx, cy, ch, color) {
        var ctx = this.ctx;
        ctx.save();
        ctx.font = 'bold ' + Math.round(this.tileH * 0.95) + "px monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = color || '#fff';
        ctx.fillText(ch, cx, cy);
        ctx.restore();
    };

    // A flat iso diamond in the legend colour — the placeholder a tile draws while its pack image
    // loads (or if an image is missing), so the view shows the dungeon shape instead of going black.
    IsoRenderer.prototype._diamond = function (cx, cy, color) {
        var ctx = this.ctx, hw = this.tileW / 2, hh = this.tileH / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
        ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1; ctx.stroke();
    };

    // Soft contact shadow grounds props/characters so they don't float on the floor.
    IsoRenderer.prototype._contactShadow = function (cx, cy, rx, ry) {
        var ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    // Warm pool of light cast onto the scene by a torch / the player's lantern / a beacon. Drawn
    // additively after the tiles so it lights the floor, the props AND the characters standing in
    // it, which is what separates a lit room from a flat sprite collage.
    IsoRenderer.prototype._lightPool = function (cx, cy, radius, inner, outer) {
        var ctx = this.ctx;
        // A non-finite emitter would throw out of createRadialGradient and abandon the frame
        // half-drawn. Lighting is decoration — skip the bad pool, keep the dungeon.
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(radius) || radius <= 0) return;
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, inner);
        g.addColorStop(0.45, outer);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        // The pool is squashed to the iso ground plane so it reads as light ON the floor rather
        // than a sphere floating in front of the camera.
        ctx.translate(cx, cy);
        ctx.scale(1, this.tileH / this.tileW);
        ctx.translate(-cx, -cy);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    // Embers rising off a flame. Deterministic per torch (seeded by cell) so they don't reshuffle
    // every frame; only the phase advances.
    IsoRenderer.prototype._embers = function (cx, cy, seed, now) {
        var ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < 4; i++) {
            var phase = ((now / 1400) + (seed + i * 37) / 97) % 1;
            var driftX = Math.sin((seed + i * 11) * 1.7 + phase * 6.28) * 7;
            var y = cy - phase * 34;
            var a = (1 - phase) * 0.5;
            ctx.fillStyle = 'rgba(255,' + (150 + Math.floor(phase * 70)) + ',90,' + a.toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(cx + driftX, y, 1.5 * (1 - phase * 0.5), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    };

    // Crevice darkening on floor cells that touch a wall — a cheap ambient-occlusion cue. The
    // gradient is clear in the middle of the cell and dark at its rim, so tiles tucked into a corner
    // sit in shadow instead of looking like stickers laid on top of the ground.
    IsoRenderer.prototype._wallAO = function (cx, cy, strength) {
        var ctx = this.ctx, hw = this.tileW / 2, hh = this.tileH / 2;
        var g = ctx.createRadialGradient(cx, cy, hw * 0.15, cx, cy, hw);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,' + strength.toFixed(3) + ')');
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = g;
        ctx.fillRect(cx - hw, cy - hh, this.tileW, this.tileH);
        ctx.restore();
    };

    // Warm radial vignette — an ambient tavern glow that darkens the edges and lifts the centre,
    // the "juice" that makes the flat canvas feel lit rather than pasted.
    IsoRenderer.prototype._vignette = function () {
        var ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
        var g = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.18,
                                         w / 2, h * 0.46, Math.max(w, h) * 0.62);
        g.addColorStop(0, 'rgba(255, 214, 150, 0.06)');
        g.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0.58)');
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
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

    // Darkened copy of a tile image, cached at quantized levels.
    //
    // Fog-of-war used to dim tiles with globalAlpha, which made remembered walls TRANSLUCENT — you
    // could see the tiles behind them, so the dungeon read as a haze of overlapping ghosts instead
    // of solid stone in the dark. Multiplying the sprite's own pixels toward black keeps every tile
    // opaque and just unlit, which is what "you remember this room, it isn't lit" should look like.
    IsoRenderer.prototype._shadedImage = function (img, level) {
        if (!img) return img;
        var step = Math.max(0, Math.min(5, Math.round(level * 5)));
        if (step >= 5) return img;
        var key = (img.src || img._rkBoundsKey || '') + '|s' + step;
        if (this.shadeCache[key]) return this.shadeCache[key];
        var cv = document.createElement('canvas');
        cv.width = img.naturalWidth || img.width;
        cv.height = img.naturalHeight || img.height;
        if (!cv.width || !cv.height) return img;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        // A touch of blue in the shadow rather than flat black — unlit stone reads cold.
        ctx.fillStyle = 'rgba(6,10,20,' + (1 - step / 5).toFixed(3) + ')';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.globalCompositeOperation = 'source-over';
        cv._rkBoundsKey = key;
        this.shadeCache[key] = cv;
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

    // Deterministic per-cell hash (no RNG — stable across frames/reloads).
    function cellHash(x, y) {
        var h = (x * 73856093) ^ (y * 19349663);
        h = (h ^ (h >>> 13)) >>> 0;
        return h / 4294967295;
    }

    // Wall-family kinds share edge-run detection so a window/door in a wall counts as wall.
    var WALLISH = { wall: 1, window: 1, door: 1, archway: 1 };

    IsoRenderer.prototype._isWall = function (scene, x, y) {
        if (x < 0 || y < 0 || y >= scene.rows || x >= scene.cols) return false;
        return !!WALLISH[scene.grid[y][x]];
    };

    // Iso walls have a facing. A segment running along grid-x uses the base (_S) rotation; one
    // running along grid-y uses the perpendicular (`<kind>Y`, _W) rotation; a true corner (both
    // axes present) uses the corner tile. This is what makes enclosing walls read as continuous
    // faces instead of thin disconnected slabs on the y-running edges.
    IsoRenderer.prototype._wallVariant = function (scene, x, y, kind) {
        var tiles = this.assets.tiles || {};
        var xRun = this._isWall(scene, x - 1, y) || this._isWall(scene, x + 1, y);
        var yRun = this._isWall(scene, x, y - 1) || this._isWall(scene, x, y + 1);
        if (xRun && yRun && kind === 'wall' && tiles.wallCorner) return 'wallCorner';
        if (yRun && !xRun && tiles[kind + 'Y']) return kind + 'Y';
        return kind;
    };

    // Sprinkle floor variants deterministically so the ground isn't a flat identical sea.
    IsoRenderer.prototype._floorVariant = function (kind, x, y) {
        var tiles = this.assets.tiles || {};
        var r = cellHash(x, y);
        if (kind === 'floor' && tiles.floorAlt && r > 0.86) return 'floorAlt';
        if (kind === 'floor2' && tiles.stoneTile && r > 0.6) return 'stoneTile';
        if (kind === 'floor2' && tiles.floor2Alt && r > 0.82) return 'floor2Alt';
        return kind;
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
        var key = e.id || 'anon';
        var st = this.last[key] || (this.last[key] = { x: e.x, y: e.y, t: 0, facing: 'down' });
        if (st.x !== e.x || st.y !== e.y) {
            // Infer facing from the actual movement delta — the SP game doesn't send player.facing
            // (only the tavern does), so without this the character always faced 'down' (SW) no matter
            // which way it moved. Explicit e.facing (tavern) still wins below.
            var ddx = e.x - st.x, ddy = e.y - st.y;
            if (Math.abs(ddx) >= Math.abs(ddy)) st.facing = ddx > 0 ? 'right' : 'left';
            else st.facing = ddy > 0 ? 'down' : 'up';
            st.x = e.x; st.y = e.y; st.t = now;
        }
        var facing = (e && e.facing) || st.facing || 'down';
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
        var wantW = Math.ceil((scene.cols + scene.rows) * this.tileW / 2 + margin * 2 + this.tileW * 2);
        var wantH = Math.ceil((scene.cols + scene.rows) * this.tileH / 2 + this.imageH + margin * 2);
        // Only ASSIGN width/height when they actually change. Assigning either one reallocates and
        // clears the whole backing buffer, and this renderer re-runs every animation frame (the
        // walkable pulse and the flames keep `_animating` set) — so the old unconditional assignment
        // was throwing away and re-allocating a multi-megapixel canvas 60 times a second.
        if (this.canvas.width !== wantW || this.canvas.height !== wantH) {
            this.canvas.width = wantW;
            this.canvas.height = wantH;
        }

        var ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = scene.background || '#0a0c0f';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.imageSmoothingEnabled = true;

        // Furniture kinds draw a floor tile as the base + the prop sprite on top (same idea as the
        // tiled renderer's `over` compositing). Everything else is a plain ground/wall tile.
        var PROP = { bar: 1, table: 1, chair: 1, keg: 1, shelf: 1, barrel: 1, crate: 1, chest: 1 };
        var legend = scene.legend || {};
        var items = [], x, y, kind, p, def;
        for (y = 0; y < scene.rows; y++) {
            for (x = 0; x < scene.cols; x++) {
                kind = scene.grid[y][x];
                def = legend[kind];
                p = this._project(x, y, originX, originY);
                items.push({ type: 'tile', kind: kind, x: x, y: y, sx: p.x, sy: p.y, depth: x + y });
                if (PROP[kind]) {
                    items.push({ type: 'prop', kind: kind, x: x, y: y, sx: p.x, sy: p.y, depth: x + y + 0.25 });
                }
                // Fire fixtures (torch/hearth) & hazard tiles (lava/poison/spikes): a floor tile is
                // the base (drawn above via fallback); RK.fx paints the animated flame / pulse.
                if (def && (def.fx === 'fire' || def.hazard)) {
                    items.push({ type: 'fx', def: def, x: x, y: y, sx: p.x, sy: p.y, depth: x + y + 0.3 });
                }
            }
        }
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            p = this._project(e.x, e.y, originX, originY);
            items.push({ type: 'entity', e: e, sx: p.x, sy: p.y, depth: e.x + e.y + 0.55 });
            // Sticky camera target (keep last if the player is momentarily absent). Multiplayer
            // scenes explicitly mark one racer as cameraTarget; never let a later rival steal it.
            if (e.you || e.cameraTarget) { this.focusPoint = { x: p.x, y: p.y + this.tileH }; this._plx = e.x; this._ply = e.y; }
        }
        items.sort(function (a, b) { return a.depth === b.depth ? (a.y || 0) - (b.y || 0) : a.depth - b.depth; });

        var now = Date.now();
        // Light emitters collected while drawing, applied additively in one pass afterwards so the
        // pools land on the floor, the props AND the characters standing in them.
        var lights = [];
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.type === 'tile') {
                // FOG OF WAR: never render unexplored cells. Without this they fell back to the floor
                // tile (`_tileUrl('dark')` → tiles.floor) and revealed the ENTIRE map from move 0.
                if (it.kind === 'dark') continue;
                var tileKind = PROP[it.kind] ? 'floor' : it.kind;
                if (WALLISH[tileKind]) tileKind = this._wallVariant(scene, it.x, it.y, tileKind);
                else tileKind = this._floorVariant(tileKind, it.x, it.y);
                var rec = this._load(this._tileUrl(tileKind));
                // Cutaway: fade the walls sitting between the camera and the player (higher x+y, toward
                // the SE camera, within a few cells) so they don't hide the player or the openings right
                // in front of them. Iso occlusion otherwise makes near hallways impossible to read.
                var cut = WALLISH[it.kind] && this._plx != null &&
                    it.x >= this._plx && it.y >= this._ply &&
                    (it.x + it.y) > (this._plx + this._ply) &&
                    ((it.x - this._plx) + (it.y - this._ply)) <= 3;
                // Fog fade: dim explored-but-distant tiles toward the (near-black) background so the
                // remembered area melts into the dark with distance — parity with the 2D modes.
                var lb = (scene.lightGrid && scene.lightGrid[it.y] && scene.lightGrid[it.y][it.x] != null) ? scene.lightGrid[it.y][it.x] : 1;
                // Cutaway walls stay ALPHA-faded (you need to see the floor through them). Everything
                // else is shaded opaque, so distant stone is dark stone rather than a ghost.
                ctx.globalAlpha = cut ? 0.28 : 1;
                if (rec && rec.ready) {
                    var img = cut ? rec.img : this._shadedImage(rec.img, Math.max(0.16, lb));
                    this._drawImage(img, it.sx, it.sy + this.tileH, this.imageW, this.imageH);
                } else {
                    ctx.globalAlpha = cut ? 0.28 : Math.max(0.16, lb);
                    this._diamond(it.sx, it.sy + this.tileH * 0.5, (legend[it.kind] && legend[it.kind].color) || '#3a4048');
                }
                // Walkable-floor pip: mark every visible floor cell with a soft dot so the WALKABLE
                // ground is explicit everywhere. A dark gap with no pip is unambiguously NOT floor —
                // that's what stops iso wall-gaps/voids from reading as holes you can walk into.
                if (it.kind === 'floor' || it.kind === 'floor2') {
                    // Crevice shadow where this floor cell abuts stone. Cheap AO — the more walls
                    // around it, the deeper the cell sits in shadow.
                    var adj = (this._isWall(scene, it.x - 1, it.y) ? 1 : 0) + (this._isWall(scene, it.x + 1, it.y) ? 1 : 0) +
                              (this._isWall(scene, it.x, it.y - 1) ? 1 : 0) + (this._isWall(scene, it.x, it.y + 1) ? 1 : 0);
                    if (adj) {
                        ctx.globalAlpha = Math.max(0.14, lb);
                        this._wallAO(it.sx, it.sy + this.tileH * 0.5, Math.min(0.42, 0.14 * adj));
                    }
                    ctx.globalAlpha = Math.max(0.14, lb) * 0.5;
                    ctx.fillStyle = 'rgba(150,215,255,1)';
                    ctx.beginPath();
                    ctx.arc(it.sx, it.sy + this.tileH * 0.5, 2.4, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
            } else if (it.type === 'prop') {
                this._contactShadow(it.sx, it.sy + this.tileH * 1.4, 22, 9);
                rec = this._load(this._tileUrl(it.kind));
                if (rec && rec.ready) this._drawImage(rec.img, it.sx, it.sy + this.tileH, this.imageW, this.imageH);
            } else if (it.type === 'fx' && root.RK && RK.fx) {
                this._animating = true; // keep the RAF alive so the flame/pulse animates
                var fcx = it.sx, fgy = it.sy + this.tileH * 1.15;
                if (it.def.hazard) {
                    var hw = this.tileW / 2, hh = this.tileH / 2, hy = it.sy + this.tileH;
                    RK.fx.hazard(ctx, it.def.hazard, fcx, hy, this.tileW * 0.5, now, function (c) {
                        c.beginPath();
                        c.moveTo(fcx, hy - hh); c.lineTo(fcx + hw, hy);
                        c.lineTo(fcx, hy + hh); c.lineTo(fcx - hw, hy); c.closePath();
                    });
                } else {
                    var fscale = this.tileW * (it.def.fxScale || 0.34) * 0.7;
                    RK.fx.fire(ctx, fcx, fgy, fscale, now, (it.x * 7 + it.y * 13) % 97);
                    var seed = (it.x * 7 + it.y * 13) % 97;
                    this._embers(fcx, fgy - this.tileH * 0.2, seed, now);
                    // Torch flames flicker, so the pool they cast has to flicker with them.
                    var flick = 0.82 + Math.sin(now / 95 + seed) * 0.12 + Math.sin(now / 41 + seed * 2) * 0.06;
                    lights.push({
                        x: fcx, y: it.sy + this.tileH, r: this.tileW * 1.75 * flick,
                        inner: 'rgba(255,168,74,' + (0.15 * flick).toFixed(3) + ')',
                        outer: 'rgba(196,96,26,' + (0.045 * flick).toFixed(3) + ')'
                    });
                }
            } else if (it.type === 'entity') {
                // Dungeon FEATURES/ITEMS (entrance/exit/treasure/items) are tiles/glyphs, NOT avatars.
                // The iso renderer is shared with the tavern (where every entity is an avatar); without
                // this branch the entrance was drawn as a male character — the "copy of the player at
                // the start" the map origin showed.
                if (it.e.kind === 'feature' || it.e.kind === 'item') {
                    var furl = this._featureTileUrl(it.e);
                    var frec = furl && this._load(furl);
                    if (frec && frec.ready) this._drawImage(frec.img, it.sx, it.sy + this.tileH, this.imageW, this.imageH);
                    else this._glyph(it.sx, it.sy + this.tileH * 0.4, it.e.char || '?', it.e.color || '#fff');
                    // Objectives beacon. Stairs and treasure are the only two things in the dungeon
                    // worth crossing a room for, so they get a slow breathing glow in their own
                    // colour — findable from across a dark hall without leaking the layout.
                    var beaconRGB = it.e.char === '<' ? '63,185,80'
                        : it.e.char === '>' ? '210,153,34'
                        : it.e.char && it.e.char.charAt(0) === '$' ? '251,191,36' : null;
                    if (beaconRGB) {
                        this._animating = true;
                        // NB: entity items carry the cell on `it.e`, not `it.x` (that is only set on
                        // tile items) — reading it.x here produced a NaN radius and threw.
                        var breathe = 0.55 + Math.sin(now / 620 + it.e.x) * 0.45;
                        lights.push({
                            x: it.sx, y: it.sy + this.tileH, r: this.tileW * (1.1 + breathe * 0.35),
                            inner: 'rgba(' + beaconRGB + ',' + (0.10 + breathe * 0.12).toFixed(3) + ')',
                            outer: 'rgba(' + beaconRGB + ',' + (0.03 + breathe * 0.04).toFixed(3) + ')'
                        });
                    }
                    continue;
                }
                this._contactShadow(it.sx, it.sy + this.tileH * 1.15, 18, 7);
                var frame = this._charFrame(it.e, now);
                rec = this._load(frame && frame.url);
                if (rec && rec.ready) {
                    var ch = frame.character || this.assets.character || {};
                    // Monsters use the same character art — tint them RED so they don't read as a
                    // second player following you around.
                    var tint = it.e.kind === 'monster' ? '#f85149' : this._skinTintFor(frame.visual);
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

        // Walkability affordance: the iso wall tiles leave ambiguous gaps that read as doorways, so
        // flag the floor cells the player can actually step to (orthogonally adjacent, walkable +
        // explored) with a soft pulsing outline — a reliable "you can go here" cue independent of how
        // the walls render.
        if (this._plx != null) {
            var pulse = 0.30 + Math.sin(now / 320) * 0.18;
            var nbrs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
            for (var ni = 0; ni < nbrs.length; ni++) {
                var nx = this._plx + nbrs[ni][0], ny = this._ply + nbrs[ni][1];
                if (ny < 0 || nx < 0 || !scene.grid[ny] || nx >= scene.cols) continue;
                var nk = scene.grid[ny][nx];
                if (nk === 'wall' || nk === 'dark' || nk === 'torch' || nk === undefined) continue;
                var np = this._project(nx, ny, originX, originY);
                this._diamondOutline(np.x, np.y + this.tileH * 0.5, 'rgba(130,220,255,' + pulse + ')');
            }
            this._animating = true; // keep the pulse animating between game updates
        }

        // The player carries a lantern. Its pool is drawn last of the emitters so it always wins in
        // the cell you actually occupy, and it breathes slightly so a still player isn't a static image.
        if (this.focusPoint) {
            var lantern = 0.9 + Math.sin(now / 170) * 0.07 + Math.sin(now / 73) * 0.03;
            lights.push({
                x: this.focusPoint.x, y: this.focusPoint.y, r: this.tileW * 2.7 * lantern,
                inner: 'rgba(255,214,158,' + (0.115 * lantern).toFixed(3) + ')',
                outer: 'rgba(210,140,70,' + (0.04 * lantern).toFixed(3) + ')'
            });
            this._animating = true;
        }
        for (var lg = 0; lg < lights.length; lg++) {
            var L = lights[lg];
            this._lightPool(L.x, L.y, L.r, L.inner, L.outer);
        }
        // Colour-temperature separation: everything the player can currently SEE is warm torchlight;
        // the explored-but-remembered parts get a cold blue wash. Alpha alone made memory read as
        // "far away"; the temperature shift makes it read as "remembered", which is what it is.
        this._memoryWash(scene, originX, originY);

        this._vignette();
        if (this._animating) this._invalidate();
    };

    // Cold blue overlay on explored-but-not-currently-visible cells.
    IsoRenderer.prototype._memoryWash = function (scene, originX, originY) {
        var light = scene.lightGrid;
        if (!light) return;
        var ctx = this.ctx, hw = this.tileW / 2, hh = this.tileH / 2;
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        // A DARK blue. A mid-tone blue at 20% actually lifted the already-darkened memory tiles
        // brighter than the torchlit centre, inverting the whole depth hierarchy — remembered rooms
        // glowed and the room you were standing in receded.
        ctx.fillStyle = 'rgba(16,28,52,1)';
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                var kind = scene.grid[y] && scene.grid[y][x];
                if (!kind || kind === 'dark') continue;
                var lb = (light[y] && light[y][x] != null) ? light[y][x] : 1;
                if (lb >= 0.3) continue; // currently lit — leave it warm
                var p = this._project(x, y, originX, originY), cy = p.y + hh;
                ctx.globalAlpha = 0.45 * (1 - lb / 0.3);
                ctx.beginPath();
                ctx.moveTo(p.x, cy - hh); ctx.lineTo(p.x + hw, cy);
                ctx.lineTo(p.x, cy + hh); ctx.lineTo(p.x - hw, cy);
                ctx.closePath();
                ctx.fill();
            }
        }
        ctx.restore();
    };

    IsoRenderer.prototype.destroy = function () {
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        this.cache = {};
        this.tintCache = {};
        this.shadeCache = {};
        this.boundsCache = {};
        this.last = {};
        this.lastScene = null;
    };

    root.RK = root.RK || {};
    root.RK.IsoRenderer = IsoRenderer;
})(window);
