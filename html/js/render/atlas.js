// TilesetAtlas — loads a tileset image and serves individual tiles to either a 2D canvas
// (TileRenderer) or PixiJS (FancyRenderer). Source-agnostic: any pack's sheet loads through it.
(function (root) {
    'use strict';

    function TilesetAtlas(url, opts) {
        opts = opts || {};
        this.url = url;
        this.tile = opts.tile || 16;
        this.spacing = opts.spacing != null ? opts.spacing : 1;
        this.margin = opts.margin || 0;
        this.ready = false;
        this.cols = 0;
        this.rows = 0;
        this._cbs = [];

        var self = this;
        this.img = new Image();
        this.img.onload = function () {
            self.ready = true;
            var stride = self.tile + self.spacing;
            self.cols = Math.floor((self.img.width - self.margin + self.spacing) / stride);
            self.rows = Math.floor((self.img.height - self.margin + self.spacing) / stride);
            var cbs = self._cbs; self._cbs = [];
            cbs.forEach(function (cb) { try { cb(self); } catch (_) { /* ignore */ } });
        };
        this.img.onerror = function () { self.ready = false; };
        this.img.src = url;
    }

    TilesetAtlas.prototype.onReady = function (cb) {
        if (this.ready) cb(this); else this._cbs.push(cb);
    };

    // Source pixel of tile (col,row).
    TilesetAtlas.prototype.px = function (col, row) {
        var stride = this.tile + this.spacing;
        return { x: this.margin + col * stride, y: this.margin + row * stride };
    };

    // Canvas: draw tile (col,row) at (dx,dy) scaled to `size`. Returns false if not ready.
    TilesetAtlas.prototype.draw = function (ctx, col, row, dx, dy, size) {
        if (!this.ready) return false;
        var p = this.px(col, row);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.img, p.x, p.y, this.tile, this.tile, dx, dy, size, size);
        return true;
    };

    // Canvas: draw by flat tile index (row-major across the tileset's columns).
    TilesetAtlas.prototype.drawIndex = function (ctx, idx, dx, dy, size) {
        if (idx < 0 || !this.ready) return false;
        return this.draw(ctx, idx % this.cols, Math.floor(idx / this.cols), dx, dy, size);
    };

    // Pixi: a cached Texture for tile (col,row), sharing one BaseTexture (nearest-neighbour).
    TilesetAtlas.prototype.texture = function (col, row) {
        if (typeof PIXI === 'undefined' || !this.ready) return null;
        if (!this._base) {
            this._base = PIXI.BaseTexture.from(this.img);
            this._base.scaleMode = PIXI.SCALE_MODES.NEAREST;
            this._texCache = {};
        }
        var key = col + ',' + row;
        if (!this._texCache[key]) {
            var p = this.px(col, row);
            this._texCache[key] = new PIXI.Texture(this._base, new PIXI.Rectangle(p.x, p.y, this.tile, this.tile));
        }
        return this._texCache[key];
    };

    root.RK = root.RK || {};
    root.RK.TilesetAtlas = TilesetAtlas;
})(window);
