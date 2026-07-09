// TileRenderer — draws a Scene as coloured tiles + entity sprites on a 2D canvas.
// The default tier. Uses programmatic tiles for now; a real tileset/atlas can slot in here.
(function (root) {
    'use strict';

    function facingDelta(f) {
        if (f === 'up') return { x: 0, y: -1 };
        if (f === 'left') return { x: -1, y: 0 };
        if (f === 'right') return { x: 1, y: 0 };
        return { x: 0, y: 1 };
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
    }

    TileRenderer.prototype.render = function (scene) {
        if (!scene) return;
        var cell = this.cell, ctx = this.ctx;
        this.canvas.width = scene.cols * cell;
        this.canvas.height = scene.rows * cell;

        ctx.fillStyle = scene.background || '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (!scene.isDungeon && window.RK && RK.roomReady && RK.roomReady()) {
            // A designed room (imported .tmx) is loaded — draw its layered tiles.
            RK.drawRoomCanvas(ctx, cell);
        } else {
            // Theme atlas tile if mapped, else the programmatic coloured tile.
            var atlas = (window.RK && RK.themeAtlas) ? RK.themeAtlas() : null;
            var tmap = (window.RK && RK.tileMap) ? RK.tileMap() : {};
            var useAtlas = atlas && atlas.ready;
            for (var y = 0; y < scene.rows; y++) {
                for (var x = 0; x < scene.cols; x++) {
                    var kind = scene.grid[y][x];
                    var px = x * cell, py = y * cell;
                    var coord = useAtlas ? tmap[kind] : null;
                    if (coord) { atlas.draw(ctx, coord[0], coord[1], px, py, cell); continue; }
                    var def = scene.legend[kind] || { color: '#333' };
                    ctx.fillStyle = def.color;
                    ctx.fillRect(px, py, cell, cell);
                    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
                    if (def.solid) {
                        ctx.fillStyle = 'rgba(255,255,255,0.06)';
                        ctx.fillRect(px, py, cell, Math.max(1, cell * 0.14));
                    }
                    // Dungeon lighting: darken tiles based on the light grid.
                    if (scene.lightGrid && scene.lightGrid[y] && scene.lightGrid[y][x] != null) {
                        var brightness = scene.lightGrid[y][x];
                        if (brightness < 1) {
                            ctx.fillStyle = 'rgba(0,0,0,' + (1 - brightness) + ')';
                            ctx.fillRect(px, py, cell, cell);
                        }
                    }
                }
            }
        }

        var now = Date.now();
        for (var i = 0; i < scene.entities.length; i++) {
            var e = scene.entities[i];
            // Dungeon features (entrance, exit, treasure) — draw as colored glyphs.
            if (e.kind === 'feature') {
                var cx = e.x * cell + cell / 2, cy = e.y * cell + cell / 2;
                ctx.fillStyle = e.color || '#fff';
                ctx.font = (cell - 4) + 'px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(e.char || '?', cx, cy);
                continue;
            }
            // Dungeon items.
            if (e.kind === 'item') {
                var ix = e.x * cell + cell / 2, iy = e.y * cell + cell / 2;
                ctx.fillStyle = e.color || '#fbbf24';
                ctx.font = (cell - 4) + 'px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('$', ix, iy);
                continue;
            }
            // Dungeon monster.
            if (e.kind === 'monster') {
                var mx = e.x * cell + cell / 2, my = e.y * cell + cell / 2, mr = cell * 0.34;
                ctx.beginPath();
                ctx.arc(mx, my, mr, 0, Math.PI * 2);
                ctx.fillStyle = e.color || '#f85149';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,100,100,0.4)';
                ctx.lineWidth = 2;
                ctx.stroke();
                continue;
            }
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
    };

    TileRenderer.prototype.destroy = function () {
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
    };

    root.RK = root.RK || {};
    root.RK.TileRenderer = TileRenderer;
})(window);
