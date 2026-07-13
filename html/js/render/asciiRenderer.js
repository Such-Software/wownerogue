// AsciiRenderer — draws a Scene as a monospace glyph grid on a 2D canvas.
// The always-available fallback tier: tiny, legible, accessible.
(function (root) {
    'use strict';

    function AsciiRenderer(host, opts) {
        opts = opts || {};
        this.name = 'ascii';
        this.host = host;
        this.cell = opts.cell || 22;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rk-canvas';
        this.ctx = this.canvas.getContext('2d');
        host.appendChild(this.canvas);
    }

    AsciiRenderer.prototype.render = function (scene) {
        if (!scene) return;
        this.lastScene = scene;
        var cell = this.cell, ctx = this.ctx, now = Date.now(), hasTorch = false;
        this.canvas.width = scene.cols * cell;
        this.canvas.height = scene.rows * cell;

        ctx.fillStyle = scene.background || '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        var glyphFont = (cell - 4) + "px 'Courier New', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.font = glyphFont;
        // For a designed room, ASCII shows a floor-plan from the walkability grid.
        var room = (!scene.isDungeon && window.RK && RK.roomReady && RK.roomReady()) ? RK.activeRoom.desc : null;
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                if (room) {
                    var walk = room.walkable[y] && room.walkable[y][x];
                    ctx.fillStyle = walk ? '#2f4030' : '#39404c';
                    ctx.fillText(walk ? '·' : '#', x * cell + cell / 2, y * cell + cell / 2);
                } else {
                    var def = scene.legend[scene.grid[y][x]] || { char: '?', color: '#555' };
                    var gx = x * cell + cell / 2, gy = y * cell + cell / 2;
                    if (def.fx === 'fire') {
                        // Torches are ACTUAL light sources: a warm radial glow behind the glyph that
                        // gently flickers; the glyph itself stays at full brightness (never dimmed).
                        hasTorch = true;
                        var seed = x * 7 + y * 13;
                        var fl = 0.7 + Math.sin(now / 170 + seed) * 0.3;
                        var rad = cell * (1.9 + Math.sin(now / 240 + seed) * 0.18);
                        var g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
                        g.addColorStop(0, 'rgba(255,196,96,' + (0.6 * fl) + ')');
                        g.addColorStop(0.45, 'rgba(255,140,44,' + (0.24 * fl) + ')');
                        g.addColorStop(1, 'rgba(255,120,30,0)');
                        ctx.globalAlpha = 1;
                        ctx.fillStyle = g;
                        ctx.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
                        ctx.fillStyle = '#ffd9a0';
                        ctx.fillText(def.char, gx, gy);
                    } else {
                        ctx.fillStyle = def.color;
                        // Dungeon lighting: dim tiles in shadow.
                        if (scene.lightGrid && scene.lightGrid[y] && scene.lightGrid[y][x] != null) {
                            var b = scene.lightGrid[y][x];
                            if (b < 1) ctx.globalAlpha = b;
                        }
                        ctx.fillText(def.char, gx, gy);
                        ctx.globalAlpha = 1;
                    }
                }
            }
        }

        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            var cx = e.x * cell + cell / 2, cy = e.y * cell + cell / 2;
            ctx.font = glyphFont;
            ctx.fillStyle = e.color || '#fff';
            // Dungeon features and entities use their own char/color.
            if (e.kind === 'feature' || e.kind === 'item' || e.kind === 'monster') {
                ctx.fillStyle = e.color || '#fff';
                ctx.fillText(e.char || '?', cx, cy);
                if (e.you) {
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(e.x * cell + 2, e.y * cell + 2, cell - 4, cell - 4);
                }
                if (e.label) {
                    ctx.font = '10px monospace';
                    ctx.fillStyle = '#d7dbe0';
                    ctx.fillText(e.label, cx, e.y * cell - 1);
                }
                continue;
            }
            ctx.fillStyle = e.color || '#fff';
            ctx.fillText(e.char || '@', cx, cy);
            if (e.you) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.strokeRect(e.x * cell + 2, e.y * cell + 2, cell - 4, cell - 4);
            }
            if (e.label) {
                ctx.font = '10px monospace';
                ctx.fillStyle = '#d7dbe0';
                ctx.fillText(e.label, cx, e.y * cell - 1);
            }
        }

        // Camera focus — centre the SP camera on the player cell (same convention as the tiled
        // renderer). Sticky: only update when the player is present, so switching TO ascii mid-game
        // doesn't leave focusPoint null (which pinned the whole grid to the corner → black screen).
        for (var pj = 0; pj < scene.entities.length; pj++) {
            var pe = scene.entities[pj];
            if (pe.kind === 'player' || pe.you) {
                this.focusPoint = { x: pe.x * cell + cell / 2, y: pe.y * cell + cell / 2 };
                break;
            }
        }

        // Keep a light RAF alive so the torch glows flicker between game updates (~22fps).
        this._hasTorches = hasTorch;
        if (hasTorch) this._scheduleFlicker();
    };

    // Re-render on a throttled RAF so torch glows breathe even when the game isn't updating.
    AsciiRenderer.prototype._scheduleFlicker = function () {
        if (this._flickerRaf || !this._hasTorches || !this.ctx) return;
        var self = this;
        this._flickerRaf = requestAnimationFrame(function () {
            self._flickerRaf = null;
            if (!self.ctx || !self._hasTorches || !self.lastScene) return;
            var t = Date.now();
            if (self._lastFlick && t - self._lastFlick < 45) { self._scheduleFlicker(); return; }
            self._lastFlick = t;
            self.render(self.lastScene);
        });
    };

    AsciiRenderer.prototype.destroy = function () {
        this._hasTorches = false;
        if (this._flickerRaf) { cancelAnimationFrame(this._flickerRaf); this._flickerRaf = null; }
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
    };

    root.RK = root.RK || {};
    root.RK.AsciiRenderer = AsciiRenderer;
})(window);
