// Character skins for the render kit. A skin is an animated sprite sheet (rows = facing
// directions, cols = animation frames) produced by the sprite pipeline
// (~/src/docs/animated-sprite-pipeline.md). Sheets are HEAVY and PREMIUM, so they are:
//   - lazy-loaded (only fetched when an entity actually uses the skin, in a sprite-capable mode),
//   - gated by entitlement (RK.entitlements.premium),
//   - delivered as WebP.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    // Skin registry. `sheet` is hosted under assets/generated (gitignored / CDN-delivered).
    RK.SKINS = {
        'monero-knight': {
            id: 'monero-knight', label: 'Monero Knight', premium: true, pack: 'generated-skins',
            sheet: 'assets/generated/monero_knight_walk.webp',
            frameW: 190, frameH: 233, cols: 8, rows: 4, fps: 10,
            dirRows: { down: 0, left: 1, right: 2, up: 3 },
            scale: 2.0,        // sprite height ≈ scale × tile cell
            moveWindowMs: 350  // consider "moving" (animate) if position changed this recently
        },
        'wownero-rogue': {
            id: 'wownero-rogue', label: 'Wownero Rogue', premium: true, pack: 'generated-skins',
            sheet: 'assets/generated/wownero_walk.webp',
            frameW: 169, frameH: 223, cols: 8, rows: 4, fps: 10,
            dirRows: { down: 0, left: 1, right: 2, up: 3 },
            scale: 2.0, moveWindowMs: 350
        },
        'cypher-operative': {
            id: 'cypher-operative', label: 'Cypher Operative', premium: true, pack: 'generated-skins',
            sheet: 'assets/generated/operative_walk.webp',
            frameW: 160, frameH: 225, cols: 8, rows: 4, fps: 10,
            dirRows: { down: 0, left: 1, right: 2, up: 3 },
            scale: 2.0, moveWindowMs: 350
        }
    };

    RK.isSkin = function (id) { return !!(id && RK.SKINS[id]); };

    // --- Lazy sheet loading ------------------------------------------------------------------
    var sheets = {}; // id -> { ready, img, base, texCache, cbs }
    RK.loadSkin = function (id) {
        var s = RK.SKINS[id];
        if (!s) return null;
        if (sheets[id]) return sheets[id];
        var rec = sheets[id] = { ready: false, cbs: [] };
        var img = new Image();
        img.onload = function () {
            rec.ready = true; rec.img = img;
            rec.cbs.forEach(function (cb) { try { cb(rec); } catch (_) {} });
            rec.cbs = [];
        };
        img.onerror = function () { if (root.console) console.warn('skin sheet failed:', s.sheet); };
        img.src = s.sheet;
        return rec;
    };
    RK.skinSheet = function (id) { return (sheets[id] && sheets[id].ready) ? sheets[id] : null; };

    // --- Movement-aware frame selection ------------------------------------------------------
    var last = {}; // entity id -> { x, y, t }
    RK.skinFrame = function (skin, e, nowMs) {
        var st = last[e.id] || (last[e.id] = { x: e.x, y: e.y, t: 0 });
        if (e.x !== st.x || e.y !== st.y) { st.x = e.x; st.y = e.y; st.t = nowMs; }
        var moving = (nowMs - st.t) < (skin.moveWindowMs || 350);
        var row = (skin.dirRows && skin.dirRows[e.facing] != null) ? skin.dirRows[e.facing] : 0;
        var col = moving ? Math.floor(nowMs / 1000 * skin.fps) % skin.cols : 0; // idle -> frame 0
        return { row: row, col: col };
    };

    // --- Canvas draw (TileRenderer). Returns false (and kicks a lazy load) if not ready. ------
    RK.drawSkinCanvas = function (ctx, e, cell, nowMs) {
        var rec = RK.skinSheet(e.avatar);
        if (!rec) { RK.loadSkin(e.avatar); return false; }
        var s = RK.SKINS[e.avatar];
        var fr = RK.skinFrame(s, e, nowMs);
        var dh = cell * (s.scale || 1.7);
        var dw = dh * (s.frameW / s.frameH);
        var cx = e.x * cell + cell / 2;
        var dx = cx - dw / 2;
        var dy = (e.y * cell + cell) - dh;   // feet at tile bottom
        ctx.imageSmoothingEnabled = true;
        // Warm backlight so a dark character separates from the dark background.
        var midY = dy + dh * 0.45;
        var halo = ctx.createRadialGradient(cx, midY, 0, cx, midY, dw * 0.8);
        halo.addColorStop(0, 'rgba(255,226,180,0.30)');
        halo.addColorStop(1, 'rgba(255,226,180,0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(cx, midY, dw * 0.8, 0, Math.PI * 2); ctx.fill();
        if (e.you) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cx, e.y * cell + cell - 2, dw * 0.3, cell * 0.16, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.drawImage(rec.img, fr.col * s.frameW, fr.row * s.frameH, s.frameW, s.frameH, dx, dy, dw, dh);
        if (e.label) {
            ctx.fillStyle = '#d7dbe0'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
            ctx.fillText(e.label, cx, dy - 2);
        }
        return true;
    };

    // --- Pixi texture for a skin frame (FancyRenderer), cached. ------------------------------
    RK.skinTexture = function (id, row, col) {
        var rec = RK.skinSheet(id);
        if (!rec || typeof PIXI === 'undefined') return null;
        var s = RK.SKINS[id];
        if (!rec.base) {
            rec.base = PIXI.BaseTexture.from(rec.img);
            rec.base.scaleMode = PIXI.SCALE_MODES.LINEAR;
            rec.texCache = {};
        }
        var key = row + ',' + col;
        if (!rec.texCache[key]) {
            rec.texCache[key] = new PIXI.Texture(rec.base, new PIXI.Rectangle(col * s.frameW, row * s.frameH, s.frameW, s.frameH));
        }
        return rec.texCache[key];
    };
})(window);
