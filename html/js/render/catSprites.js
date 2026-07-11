(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    // Pet Cats Pack (CC-0). Each idle strip is 10 frames of 50x50 laid out horizontally.
    var FRAMES = 10, FW = 50, FH = 50, FRAME_MS = 150;
    var CATS = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6'];
    var images = {};

    function imgFor(id) {
        if (!CATS.includes(id)) id = 'cat3';
        if (!images[id]) {
            var im = new Image();
            im.src = 'assets/cats/' + id + '-idle.png';
            images[id] = im;
        }
        return images[id];
    }

    RK.catIds = function () { return CATS.slice(); };
    RK.randomCatId = function () { return CATS[Math.floor(Math.random() * CATS.length)]; };
    RK.isCat = function (id) { return CATS.indexOf(id) !== -1; };

    // Draw an animated cat centered in its cell, feet near the bottom of the tile. Flips to face left.
    RK.drawCatCanvas = function (ctx, e, cell, now) {
        var im = imgFor(e.catSprite || 'cat3');
        if (!im.complete || !im.naturalWidth) return false;
        var frame = Math.floor((now || 0) / FRAME_MS) % FRAMES;
        var sx = frame * FW;
        // The cat occupies only ~40% of its 50x50 frame (lots of transparent padding), so scale
        // the frame well past the cell and centre it — the visible cat then reads about tile-sized.
        var size = cell * 2.7;
        var dx = e.x * cell + (cell - size) / 2;
        var dy = e.y * cell + (cell - size) / 2 + cell * 0.28;  // centred, nudged down onto the tile
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (e.facing === 'left') {
            ctx.translate(dx + size, dy); ctx.scale(-1, 1);
            ctx.drawImage(im, sx, 0, FW, FH, 0, 0, size, size);
        } else {
            ctx.drawImage(im, sx, 0, FW, FH, dx, dy, size, size);
        }
        ctx.restore();
        return true;
    };
})(window);
