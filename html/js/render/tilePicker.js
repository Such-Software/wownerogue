// Tile-picker — a dev overlay to map a theme's tileset cells to game tile-kinds by CLICKING.
// Pick a kind (floor/wall/bar/table), click the matching cell in the sheet; it's saved to
// localStorage and the tavern re-renders live. Works for any pack, so no coordinate-guessing.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    RK.openTilePicker = function (onChange) {
        var themeId = RK.activeThemeId;
        var atlas = RK.themeAtlas(themeId);
        if (!atlas) return;
        atlas.onReady(function () { build(themeId, atlas, onChange); });
    };

    function build(themeId, atlas, onChange) {
        var SCALE = 2;
        var stride = atlas.tile + atlas.spacing;

        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;overflow:auto;padding:16px;font-family:ui-monospace,monospace;color:#d7dbe0;';

        var bar = document.createElement('div');
        bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;';
        var active = RK.TILE_KINDS[0];
        var status = document.createElement('span');
        status.style.cssText = 'font-size:13px;color:#9cf;';

        RK.TILE_KINDS.forEach(function (k) {
            var b = document.createElement('button');
            b.textContent = k; b.dataset.kind = k;
            b.style.cssText = 'font:inherit;padding:6px 10px;border:1px solid #2a313a;border-radius:4px;background:#0a0c0f;color:#d7dbe0;cursor:pointer;';
            b.onclick = function () { active = k; refresh(); status.textContent = 'Click the tile for: ' + k; };
            bar.appendChild(b);
        });
        var done = document.createElement('button');
        done.textContent = 'Done';
        done.style.cssText = 'font:inherit;padding:6px 12px;border:0;border-radius:4px;background:#3fb950;color:#08130a;cursor:pointer;font-weight:600;margin-left:auto;';
        done.onclick = function () { document.body.removeChild(wrap); };
        bar.appendChild(status); bar.appendChild(done);
        function refresh() {
            Array.prototype.forEach.call(bar.querySelectorAll('button[data-kind]'), function (b) {
                b.style.outline = b.dataset.kind === active ? '2px solid #3fb950' : 'none';
            });
        }
        wrap.appendChild(bar);

        var cv = document.createElement('canvas');
        cv.width = atlas.img.width * SCALE; cv.height = atlas.img.height * SCALE;
        cv.style.cssText = 'image-rendering:pixelated;border:1px solid #2a313a;background:#111;cursor:crosshair;';
        var ctx = cv.getContext('2d');

        function draw() {
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, cv.width, cv.height);
            ctx.drawImage(atlas.img, 0, 0, cv.width, cv.height);
            ctx.strokeStyle = 'rgba(63,185,80,0.22)'; ctx.lineWidth = 1;
            for (var c = 0; c <= atlas.cols; c++) { ctx.beginPath(); ctx.moveTo(c * stride * SCALE, 0); ctx.lineTo(c * stride * SCALE, cv.height); ctx.stroke(); }
            for (var r = 0; r <= atlas.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * stride * SCALE); ctx.lineTo(cv.width, r * stride * SCALE); ctx.stroke(); }
            var map = RK.tileMap(themeId);
            RK.TILE_KINDS.forEach(function (k) {
                var co = map[k]; if (!co) return;
                ctx.strokeStyle = '#ffb800'; ctx.lineWidth = 2;
                ctx.strokeRect(co[0] * stride * SCALE, co[1] * stride * SCALE, atlas.tile * SCALE, atlas.tile * SCALE);
                ctx.fillStyle = '#ffb800'; ctx.font = 'bold 11px monospace';
                ctx.fillText(k[0].toUpperCase(), co[0] * stride * SCALE + 2, co[1] * stride * SCALE + 11);
            });
        }
        cv.onclick = function (e) {
            var rect = cv.getBoundingClientRect();
            var col = Math.floor(((e.clientX - rect.left) / SCALE) / stride);
            var row = Math.floor(((e.clientY - rect.top) / SCALE) / stride);
            if (col < 0 || row < 0 || col >= atlas.cols || row >= atlas.rows) return;
            RK.setTile(themeId, active, col, row);
            draw();
            if (onChange) onChange();
        };

        wrap.appendChild(cv);
        document.body.appendChild(wrap);
        refresh(); status.textContent = 'Click the tile for: ' + active; draw();
    }
})(window);
