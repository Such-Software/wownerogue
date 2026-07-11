// TileRenderer — draws a Scene as tiled sprites + entity sprites on a 2D canvas.
// The default tier. Pulls tiles from the theme atlas (Kenney roguelikeSheet) when loaded,
// with a flat-colour fallback for any unmapped kind. Adds torch-lit dungeon atmosphere:
// per-cell tile variation, drop shadows, a warm torch light on the player + edge vignette,
// and a lightweight requestAnimationFrame flicker/ember loop composited over the last scene.
(function (root) {
    'use strict';

    function facingDelta(f) {
        if (f === 'up') return { x: 0, y: -1 };
        if (f === 'left') return { x: -1, y: 0 };
        if (f === 'right') return { x: 1, y: 0 };
        return { x: 0, y: 1 };
    }

    // Deterministic per-cell hash so a given (x,y) always maps to the same tile variant.
    function cellHash(x, y) {
        var h = (x * 73856093) ^ (y * 19349663);
        h = h % 100000;
        return h < 0 ? h + 100000 : h;
    }

    // A tile coord is either a single [col,row] or an ARRAY of [col,row] variants.
    // Resolve to one [col,row] for this cell.
    function pickVariant(coord, x, y) {
        if (!coord) return null;
        if (Array.isArray(coord[0])) return coord[cellHash(x, y) % coord.length];
        return coord;
    }

    // Dungeon lighting: darken a cell based on the scene's light grid (1 = lit, 0 = dark).
    function applyCellLight(ctx, scene, x, y, px, py, cell) {
        if (!scene.lightGrid || !scene.lightGrid[y] || scene.lightGrid[y][x] == null) return;
        var brightness = scene.lightGrid[y][x];
        if (brightness < 1) {
            ctx.fillStyle = 'rgba(0,0,0,' + (1 - brightness) + ')';
            ctx.fillRect(px, py, cell, cell);
        }
    }

    // The player/you entity that carries the torch (for the light composite + embers).
    function findPlayer(scene) {
        if (!scene || !scene.entities) return null;
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            if (e.kind === 'player' || e.you) return e;
        }
        return null;
    }

    // Real-tile coord for a dungeon feature entity, keyed off its glyph.
    function featureCoord(tmap, e) {
        var ch = e.char;
        if (ch === '<') return tmap.entrance;
        if (ch === '>') return tmap.exit;
        if (ch === '$' || ch === '$W' || ch === '$M') return tmap.treasure;
        return null;
    }

    function TileRenderer(host, opts) {
        opts = opts || {};
        this.name = 'tiles';
        this.host = host;
        this.cell = opts.cell || 24;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rk-canvas';
        this.ctx = this.canvas.getContext('2d');
        host.appendChild(this.canvas);
        this._snap = null;      // offscreen snapshot of the base scene (tiles + entities)
        this._lastScene = null;
        this._embers = [];
        this._raf = null;
        this._t = 0;
    }

    TileRenderer.prototype.render = function (scene) {
        if (!scene || !this.ctx) return;
        var cell = this.cell, ctx = this.ctx;
        this.canvas.width = scene.cols * cell;
        this.canvas.height = scene.rows * cell;

        ctx.fillStyle = scene.background || '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        var atlas = (window.RK && RK.themeAtlas) ? RK.themeAtlas() : null;
        var tmap = (window.RK && RK.tileMap) ? RK.tileMap() : {};
        var useAtlas = !!(atlas && atlas.ready);

        // The atlas image loads async. If you switch INTO this renderer (e.g. entering the tavern
        // in Tiled mode) before it's ready, the first paint uses the flat-colour fallback — which
        // looks like plain blocks. Without a re-render it stays stuck there until the next scene
        // update. Hook the atlas so we repaint the moment it's ready.
        if (atlas && !atlas.ready && !this._atlasHooked && typeof atlas.onReady === 'function') {
            this._atlasHooked = true;
            var self = this;
            atlas.onReady(function () { if (self.ctx && self._lastScene) self.render(self._lastScene); });
        }

        if (!scene.isDungeon && window.RK && RK.roomReady && RK.roomReady()) {
            // A designed room (imported .tmx) is loaded — draw its layered tiles.
            RK.drawRoomCanvas(ctx, cell);
        } else {
            for (var y = 0; y < scene.rows; y++) {
                for (var x = 0; x < scene.cols; x++) {
                    var kind = scene.grid[y][x];
                    var px = x * cell, py = y * cell;
                    var def = scene.legend[kind] || { color: '#333' };
                    // Fire fixtures (torch/hearth) & hazard tiles (lava/poison/spikes) draw only
                    // their ground base here; RK.fx paints the animated flame / pulse over the
                    // snapshot in the flicker loop so they actually move. Skip the solid colour block.
                    if (def.fx === 'fire' || def.hazard) {
                        var baseKind = def.over || 'floor';
                        var bco = useAtlas ? pickVariant(tmap[baseKind], x, y) : null;
                        if (bco) atlas.draw(ctx, bco[0], bco[1], px, py, cell);
                        else {
                            var bdef = scene.legend[baseKind] || def;
                            ctx.fillStyle = bdef.color || def.color;
                            ctx.fillRect(px, py, cell, cell);
                        }
                        applyCellLight(ctx, scene, x, y, px, py, cell);
                        continue;
                    }
                    var coord = useAtlas ? pickVariant(tmap[kind], x, y) : null;
                    if (coord) {
                        // Object tiles (furniture, windows, torches, treasure…) are transparent
                        // around the object. Legend `over` names the ground they sit on (floor/wall);
                        // draw that first so the transparency shows the room, not the dark canvas.
                        // Pipeline-level: any scene can declare it, not a tavern one-off.
                        if (def.over && tmap[def.over]) {
                            var base = pickVariant(tmap[def.over], x, y);
                            if (base) atlas.draw(ctx, base[0], base[1], px, py, cell);
                        }
                        atlas.draw(ctx, coord[0], coord[1], px, py, cell);
                        // Dark bottom-edge strip grounds a solid WALL against the floor below (not
                        // objects, which already sit on their own base tile).
                        if (def.solid && !def.over) {
                            var strip = Math.max(2, cell * 0.16);
                            var sg = ctx.createLinearGradient(0, py + cell - strip, 0, py + cell);
                            sg.addColorStop(0, 'rgba(0,0,0,0)');
                            sg.addColorStop(1, 'rgba(0,0,0,0.42)');
                            ctx.fillStyle = sg;
                            ctx.fillRect(px, py + cell - strip, cell, strip);
                        }
                        applyCellLight(ctx, scene, x, y, px, py, cell);
                        continue;
                    }
                    // Flat-colour fallback for any unmapped kind (or atlas not yet loaded).
                    if (def.over && scene.legend[def.over]) {
                        ctx.fillStyle = scene.legend[def.over].color;   // base colour under the object
                        ctx.fillRect(px, py, cell, cell);
                    }
                    ctx.fillStyle = def.color;
                    ctx.fillRect(px, py, cell, cell);
                    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
                    if (def.solid) {
                        ctx.fillStyle = 'rgba(255,255,255,0.06)';
                        ctx.fillRect(px, py, cell, Math.max(1, cell * 0.14));
                        ctx.fillStyle = 'rgba(0,0,0,0.35)';
                        ctx.fillRect(px, py + cell - Math.max(1, cell * 0.14), cell, Math.max(1, cell * 0.14));
                    }
                    applyCellLight(ctx, scene, x, y, px, py, cell);
                }
            }
        }

        var now = Date.now();
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            // Dungeon features (entrance / exit / treasure) — real tiles, glyph fallback.
            if (e.kind === 'feature') {
                var fpx = e.x * cell, fpy = e.y * cell;
                var fc = useAtlas ? pickVariant(featureCoord(tmap, e), e.x, e.y) : null;
                if (fc) {
                    atlas.draw(ctx, fc[0], fc[1], fpx, fpy, cell);
                    // Soft colour accent so entrance (green) / exit (amber) stay legible.
                    if (e.color) {
                        var acx = fpx + cell / 2, acy = fpy + cell / 2;
                        var ag = ctx.createRadialGradient(acx, acy, 0, acx, acy, cell * 0.6);
                        ag.addColorStop(0, hexToRgba(e.color, 0.32));
                        ag.addColorStop(1, hexToRgba(e.color, 0));
                        ctx.save();
                        ctx.globalCompositeOperation = 'lighter';
                        ctx.fillStyle = ag;
                        ctx.fillRect(fpx, fpy, cell, cell);
                        ctx.restore();
                    }
                } else {
                    softGlyph(ctx, e.char || '?', e.color || '#fff', fpx + cell / 2, fpy + cell / 2, cell);
                }
                continue;
            }
            // Dungeon items.
            if (e.kind === 'item') {
                var ipx = e.x * cell, ipy = e.y * cell;
                var ic = useAtlas ? pickVariant(tmap.treasure, e.x, e.y) : null;
                drawEntityShadow(ctx, e.x * cell + cell / 2, ipy + cell * 0.86, cell * 0.3, cell * 0.12);
                if (ic) {
                    atlas.draw(ctx, ic[0], ic[1], ipx, ipy, cell);
                } else {
                    softGlyph(ctx, '$', e.color || '#fbbf24', ipx + cell / 2, ipy + cell / 2, cell);
                }
                continue;
            }
            // Dungeon monster.
            if (e.kind === 'monster') {
                var mx = e.x * cell + cell / 2, my = e.y * cell + cell / 2, mr = cell * 0.34;
                drawEntityShadow(ctx, mx, e.y * cell + cell * 0.9, cell * 0.32, cell * 0.13);
                ctx.beginPath();
                ctx.arc(mx, my, mr, 0, Math.PI * 2);
                ctx.fillStyle = e.color || '#f85149';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,100,100,0.4)';
                ctx.lineWidth = 2;
                ctx.stroke();
                continue;
            }
            // Tavern cat — a standalone animated sprite (Pet Cats Pack), not a char-atlas avatar.
            if (e.kind === 'cat') {
                drawEntityShadow(ctx, e.x * cell + cell / 2, e.y * cell + cell * 0.9, cell * 0.28, cell * 0.11);
                if (window.RK && RK.drawCatCanvas && RK.drawCatCanvas(ctx, e, cell, now)) continue;
            }
            // Character-like entity: soft ground shadow, then the sprite (or fallback circle).
            drawEntityShadow(ctx, e.x * cell + cell / 2, e.y * cell + cell * 0.92, cell * 0.34, cell * 0.14);
            // Roguelike character sprite, or premium animated skin; else the fallback circle.
            if (window.RK && RK.avatarVisuals && RK.avatarVisuals.drawTopdownWorld) {
                var visual = RK.avatarVisuals.resolve(e.appearance || { avatar: e.avatar }, {
                    projection: 'topdown',
                    context: 'tavern',
                    entity: e
                });
                if (RK.avatarVisuals.drawTopdownWorld(ctx, visual, e, {
                    screenX: e.x,
                    screenY: e.y,
                    cell: cell
                }, { now: now })) continue;
            } else {
                if (window.RK && RK.isChar && RK.isChar(e.avatar) && RK.drawCharCanvas(ctx, e, cell, now)) continue;
                if (window.RK && RK.isSkin && RK.isSkin(e.avatar) && RK.drawSkinCanvas(ctx, e, cell, now)) continue;
            }
            var cx = e.x * cell + cell / 2, cy = e.y * cell + cell / 2, r = cell * 0.36;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = e.color || '#fff';
            ctx.fill();
            // facing pip
            var d = facingDelta(e.facing);
            ctx.beginPath();
            ctx.arc(cx + d.x * r * 0.6, cy + d.y * r * 0.6, cell * 0.08, 0, Math.PI * 2);
            ctx.fillStyle = '#0a0c0f';
            ctx.fill();
            if (e.you) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
            }
            if (e.label) {
                ctx.fillStyle = '#d7dbe0';
                ctx.font = '11px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(e.label, cx, cy - cell * 0.5);
            }
        }

        // Snapshot the base scene, then composite the torch light + vignette on top, and keep
        // an animation loop running so the light flickers and embers drift between renders.
        this._lastScene = scene;
        this._collectEmitters(scene);
        this._snapshot();
        this._ensureEmbers(scene);
        this._composite(scene);
        this._startLoop();
    };

    // Cache the fire/hazard tile positions once per scene so the flicker loop can animate them
    // without rescanning the grid every frame.
    TileRenderer.prototype._collectEmitters = function (scene) {
        var em = [], cell = this.cell, legend = scene.legend || {};
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                var def = legend[scene.grid[y][x]];
                if (!def) continue;
                if (def.fx === 'fire') {
                    em.push({ fire: true, px: x * cell, py: y * cell, cx: x * cell + cell / 2,
                              fy: y * cell + cell * 0.82, scale: cell * (def.fxScale || 0.34),
                              seed: (x * 7 + y * 13) % 97 });
                } else if (def.hazard) {
                    em.push({ hazard: def.hazard, px: x * cell, py: y * cell,
                              cx: x * cell + cell / 2, cy: y * cell + cell / 2 });
                }
            }
        }
        this._emitters = em;
    };

    // Soft drop shadow (an ellipse) under an entity's feet.
    function drawEntityShadow(ctx, cx, cy, rx, ry) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.33)';
        ctx.fill();
        ctx.restore();
    }

    // A softened glyph fallback (used only when the atlas tile is unavailable).
    function softGlyph(ctx, ch, color, cx, cy, cell) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        ctx.fillStyle = color;
        ctx.font = 'bold ' + Math.round(cell * 0.62) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, cx, cy + 1);
        ctx.restore();
    }

    function hexToRgba(hex, a) {
        hex = String(hex).replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        var n = parseInt(hex, 16);
        if (isNaN(n)) return 'rgba(255,255,255,' + a + ')';
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    // Copy the freshly-drawn base scene into an offscreen canvas so the flicker loop can
    // restore it each frame without re-running the (expensive) tile + entity passes.
    TileRenderer.prototype._snapshot = function () {
        if (!this.canvas) return;
        if (!this._snap) this._snap = document.createElement('canvas');
        if (this._snap.width !== this.canvas.width) this._snap.width = this.canvas.width;
        if (this._snap.height !== this.canvas.height) this._snap.height = this.canvas.height;
        var sctx = this._snap.getContext('2d');
        sctx.clearRect(0, 0, this._snap.width, this._snap.height);
        sctx.drawImage(this.canvas, 0, 0);
    };

    TileRenderer.prototype._ensureEmbers = function (scene) {
        // Embers belong to the dungeon torch the player carries — never in the tavern (or any
        // non-dungeon scene), where they'd make the "you" avatar look like a flaming dot.
        if (!scene || !scene.isDungeon) { this._embers = []; return; }
        var p = findPlayer(scene);
        if (!p) { this._embers = []; return; }
        if (this._embers.length) return;
        var cell = this.cell;
        var pcx = p.x * cell + cell / 2, pcy = p.y * cell + cell / 2;
        for (var i = 0; i < 10; i++) this._embers.push(this._spawnEmber(pcx, pcy, cell, true));
    };

    TileRenderer.prototype._spawnEmber = function (pcx, pcy, cell, seed) {
        var max = 60 + Math.random() * 60;
        return {
            x: pcx + (Math.random() - 0.5) * cell * 2.2,
            y: pcy + (Math.random() - 0.5) * cell * 1.6,
            vx: (Math.random() - 0.5) * 0.25,
            vy: -(0.15 + Math.random() * 0.35),
            size: cell * (0.05 + Math.random() * 0.06),
            life: seed ? Math.random() * max : max,
            max: max
        };
    };

    TileRenderer.prototype._advanceEmbers = function () {
        var scene = this._lastScene;
        var p = findPlayer(scene);
        if (!p) return;
        var cell = this.cell;
        var pcx = p.x * cell + cell / 2, pcy = p.y * cell + cell / 2;
        for (var i = 0; i < this._embers.length; i++) {
            var m = this._embers[i];
            m.x += m.vx;
            m.y += m.vy;
            m.life -= 1;
            if (m.life <= 0) this._embers[i] = this._spawnEmber(pcx, pcy, cell, false);
        }
    };

    // Warm torch light on the player cell + drifting embers + an edge vignette. Ported from
    // the FancyRenderer recipe to flat 2D canvas (no Pixi, no shaders).
    TileRenderer.prototype._composite = function (scene) {
        var ctx = this.ctx;
        if (!ctx) return;
        var w = this.canvas.width, h = this.canvas.height, cell = this.cell;
        // The warm torch light + embers are a DUNGEON effect (the player carries the torch). In the
        // tavern there's no torch, so skip it — otherwise the "you" cell glows like a flaming dot.
        var p = (scene && scene.isDungeon) ? findPlayer(scene) : null;
        if (p) {
            var cx = p.x * cell + cell / 2, cy = p.y * cell + cell / 2;
            var flick = 1 + Math.sin(this._t * 0.18) * 0.08 + Math.sin(this._t * 0.5 + 1.3) * 0.04;
            var rad = cell * 4.4 * flick;
            var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(0, 'rgba(255,190,110,0.42)');
            g.addColorStop(0.5, 'rgba(255,150,70,0.14)');
            g.addColorStop(1, 'rgba(255,150,70,0)');
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fill();
            // Embers.
            for (var i = 0; i < this._embers.length; i++) {
                var m = this._embers[i];
                var a = Math.max(0, Math.min(1, m.life / m.max)) * 0.6;
                var eg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size * 3);
                eg.addColorStop(0, 'rgba(255,220,150,' + a + ')');
                eg.addColorStop(1, 'rgba(255,150,60,0)');
                ctx.fillStyle = eg;
                ctx.beginPath();
                ctx.arc(m.x, m.y, m.size * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
        // Edge vignette (normal blend, darkens the borders).
        var vig = ctx.createRadialGradient(
            w / 2, h / 2, Math.min(w, h) * 0.34,
            w / 2, h / 2, Math.max(w, h) * 0.72
        );
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.save();
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();

        // Animated fire fixtures + hazard tiles — drawn over the vignette so their light punches
        // through the dark edges rather than being dimmed by it.
        var em = this._emitters;
        if (em && em.length && root.RK && RK.fx) {
            var nowMs = Date.now();
            for (var k = 0; k < em.length; k++) {
                var it = em[k];
                if (it.hazard) {
                    RK.fx.hazard(ctx, it.hazard, it.cx, it.cy, cell * 0.9, nowMs, makeRect(it.px, it.py, cell));
                } else {
                    RK.fx.fire(ctx, it.cx, it.fy, it.scale, nowMs, it.seed);
                }
            }
        }
    };

    // Footprint tracer for a square cell (RK.fx.hazard clips its base tint to this).
    function makeRect(px, py, cell) {
        return function (c) { c.beginPath(); c.rect(px, py, cell, cell); };
    }

    TileRenderer.prototype._startLoop = function () {
        if (this._raf != null) return;
        var self = this;
        function loop() {
            if (!self.ctx || !self._snap) { self._raf = null; return; }
            self._t += 1;
            self._advanceEmbers();
            self.ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
            self.ctx.drawImage(self._snap, 0, 0);
            self._composite(self._lastScene);
            self._raf = root.requestAnimationFrame(loop);
        }
        this._raf = root.requestAnimationFrame(loop);
    };

    TileRenderer.prototype.destroy = function () {
        if (this._raf != null) { root.cancelAnimationFrame(this._raf); this._raf = null; }
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        this._snap = null;
        this._lastScene = null;
        this._embers = [];
    };

    root.RK = root.RK || {};
    root.RK.TileRenderer = TileRenderer;
})(window);
