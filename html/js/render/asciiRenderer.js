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
        var cell = this.cell, ctx = this.ctx;
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
                    ctx.fillStyle = def.color;
                    // Dungeon lighting: dim tiles in shadow.
                    if (scene.lightGrid && scene.lightGrid[y] && scene.lightGrid[y][x] != null) {
                        var b = scene.lightGrid[y][x];
                        if (b < 1) ctx.globalAlpha = b;
                    }
                    ctx.fillText(def.char, x * cell + cell / 2, y * cell + cell / 2);
                    ctx.globalAlpha = 1;
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
    };

    AsciiRenderer.prototype.destroy = function () {
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
    };

    root.RK = root.RK || {};
    root.RK.AsciiRenderer = AsciiRenderer;
})(window);
