// Designed room — loads an imported Tiled room (from tmx_import.py): layered tile-index grids
// + a tileset, and draws the layers (back-to-front) beneath the avatars. The server uses the
// same room's walkability/dims for collision, so visuals and movement match.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};
    RK.activeRoom = null;

    RK.loadRoom = function (url, cb) {
        if (!url) { if (cb) cb(null); return; }
        fetch(url).then(function (r) { return r.json(); }).then(function (desc) {
            var atlas = new RK.TilesetAtlas(desc.tileset, { tile: desc.tile, spacing: desc.spacing });
            atlas.onReady(function () {
                RK.activeRoom = { desc: desc, atlas: atlas };
                if (cb) cb(RK.activeRoom);
            });
        }).catch(function (e) {
            if (root.console) console.warn('room load failed:', e.message);
            if (cb) cb(null);
        });
    };

    RK.roomReady = function () {
        return !!(RK.activeRoom && RK.activeRoom.atlas && RK.activeRoom.atlas.ready);
    };

    // Draw the room's layers (back-to-front) onto a 2D canvas at the given cell size.
    RK.drawRoomCanvas = function (ctx, cell) {
        if (!RK.roomReady()) return;
        var d = RK.activeRoom.desc, a = RK.activeRoom.atlas;
        ctx.imageSmoothingEnabled = false;
        for (var li = 0; li < d.layerOrder.length; li++) {
            var grid = d.layers[d.layerOrder[li]];
            for (var y = 0; y < d.rows; y++) {
                var row = grid[y];
                for (var x = 0; x < d.cols; x++) {
                    if (row[x] >= 0) a.drawIndex(ctx, row[x], x * cell, y * cell, cell);
                }
            }
        }
    };
})(window);
