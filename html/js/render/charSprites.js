// Roguelike top-down characters (free tier). Each character is a SINGLE sprite on Kenney's
// character sheet (adjacent columns are DIFFERENT characters, not walk frames). We animate
// entirely procedurally: a vertical bob + squash while moving, horizontal flip when facing left.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var COLS = 54, TILE = 16, SHEET = 'assets/kenney/roguelikeChar.png';
    var EQUIP_SLOTS = ['body', 'head', 'shield', 'weapon'];

    // Kenney's sheet includes recolour-friendly purple/magenta pixels. We remap only those
    // exact source pixels so skin, outlines, wood, and metal keep their authored colours.
    var TINT_SOURCE = {
        '160,132,196': 0, // dark purple
        '181,159,206': 1,
        '199,182,220': 2,
        '213,201,228': 3,
        '255,153,204': 2  // hot-pink accent used by a few weapon overlays
    };

    RK.CHAR_TINTS = {
        none:   { id: 'none', label: 'Natural', color: null, ramp: null },
        rose:   { id: 'rose', label: 'Rose',   color: '#d85c78', ramp: ['#8f3d54', '#b84f6b', '#d96f8c', '#f4aac0'] },
        teal:   { id: 'teal', label: 'Teal',   color: '#37aaa5', ramp: ['#1f6360', '#287d79', '#37aaa5', '#99dee3'] },
        moss:   { id: 'moss', label: 'Moss',   color: '#7bad2c', ramp: ['#4f721d', '#639535', '#7bad2c', '#95ce3e'] },
        gold:   { id: 'gold', label: 'Gold',   color: '#d29922', ramp: ['#8d6640', '#b08052', '#d29922', '#eee3b3'] },
        violet: { id: 'violet', label: 'Violet', color: '#a084c4', ramp: ['#74558f', '#8f6eb0', '#a084c4', '#d5c9e4'] },
        ash:    { id: 'ash', label: 'Ash',     color: '#878787', ramp: ['#4f4f4f', '#646464', '#878787', '#cacaca'] }
    };

    RK.CHAR_EQUIPMENT = {
        body: {
            none:   { id: 'none', label: 'None', frame: null },
            robe:   { id: 'robe', label: 'Robe', frame: 14 },
            jerkin: { id: 'jerkin', label: 'Jerkin', frame: 122 },
            mail:   { id: 'mail', label: 'Mail', frame: 230 },
            sash:   { id: 'sash', label: 'Sash', frame: 440 }
        },
        head: {
            none:   { id: 'none', label: 'None', frame: null },
            hood:   { id: 'hood', label: 'Hood', frame: 24, tint: false },
            helm:   { id: 'helm', label: 'Helm', frame: 454, tint: false },
            horns:  { id: 'horns', label: 'Horns', frame: 354, tint: false },
            cap:    { id: 'cap', label: 'Cap', frame: 462 }
        },
        shield: {
            none:   { id: 'none', label: 'None', frame: null },
            round:  { id: 'round', label: 'Round', frame: 254 },
            kite:   { id: 'kite', label: 'Kite', frame: 304 },
            tower:  { id: 'tower', label: 'Tower', frame: 202 },
            buckler:{ id: 'buckler', label: 'Buckler', frame: 411, tint: false }
        },
        weapon: {
            none:   { id: 'none', label: 'None', frame: null },
            staff:  { id: 'staff', label: 'Staff', frame: 154 },
            sword:  { id: 'sword', label: 'Sword', frame: 369, tint: false },
            axe:    { id: 'axe', label: 'Axe', frame: 375, tint: false },
            bow:    { id: 'bow', label: 'Bow', frame: 107, tint: false }
        }
    };
    RK.CHAR_EQUIPMENT_SLOTS = EQUIP_SLOTS.slice();

    // Curated humanoid characters (verified non-empty, by sight), one tile index each.
    RK.CHARS = {
        'char-villager':  { id: 'char-villager',  label: 'Villager',  frame: 270 },
        'char-elder':     { id: 'char-elder',     label: 'Elder',     frame: 271 },
        'char-barbarian': { id: 'char-barbarian', label: 'Barbarian', frame: 324 },
        'char-monk':      { id: 'char-monk',      label: 'Monk',      frame: 379 },
        'char-ranger':    { id: 'char-ranger',    label: 'Ranger',    frame: 432 },
        'char-bard':      { id: 'char-bard',      label: 'Bard',      frame: 486 },
        'char-rogue':     { id: 'char-rogue',     label: 'Rogue',     frame: 540 },
        'char-merchant':  { id: 'char-merchant',  label: 'Merchant',  frame: 541 },
        'char-wizard':    { id: 'char-wizard',    label: 'Wizard',    frame: 595 },
        'char-goblin':    { id: 'char-goblin',    label: 'Goblin',    frame: 162 }
    };
    RK.isChar = function (id) { return !!(id && RK.CHARS[id]); };

    function validTint(id) {
        return (id && RK.CHAR_TINTS[id]) ? id : 'none';
    }

    function validEquipment(slot, id) {
        var catalog = RK.CHAR_EQUIPMENT[slot] || {};
        return (id && catalog[id]) ? id : 'none';
    }

    RK.normalizeCharEquipment = function (equipment) {
        equipment = equipment || {};
        var out = {};
        EQUIP_SLOTS.forEach(function (slot) {
            out[slot] = validEquipment(slot, equipment[slot]);
        });
        return out;
    };

    RK.charAppearance = function (e) {
        e = e || {};
        var ap = e.appearance || {};
        var avatar = e.avatar || ap.avatar || 'char-villager';
        return {
            avatar: avatar,
            tint: validTint(ap.tint),
            equipment: RK.normalizeCharEquipment(ap.equipment)
        };
    };

    RK.charRenderKey = function (e) {
        var ap = RK.charAppearance(e);
        return [
            ap.avatar, ap.tint,
            ap.equipment.body, ap.equipment.head, ap.equipment.shield, ap.equipment.weapon
        ].join('|');
    };

    var atlas = null;
    var tintedTiles = {};
    var tintedTextures = {};
    RK.loadCharAtlas = function (cb) {
        if (!atlas) atlas = new RK.TilesetAtlas(SHEET, { tile: TILE, spacing: 1 });
        atlas.onReady(function () { if (cb) cb(atlas); });
        return atlas;
    };
    RK.charAtlas = function () { return (atlas && atlas.ready) ? atlas : null; };

    var last = {}; // procedural animation state per entity
    RK.charFrame = function (ch, e, nowMs) {
        var st = last[e.id] || (last[e.id] = { x: e.x, y: e.y, t: 0 });
        if (e.x !== st.x || e.y !== st.y) { st.x = e.x; st.y = e.y; st.t = nowMs; }
        var moving = (nowMs - st.t) < 300;
        return {
            idx: ch.frame,
            bob: moving ? -Math.abs(Math.sin(nowMs / 100)) * 2.5 : Math.sin(nowMs / 480) * 0.6,
            squash: moving ? 1 + Math.sin(nowMs / 100) * 0.07 : 1,
            flip: e.facing === 'left',
            moving: moving
        };
    };

    RK.charTexture = function (idx) {
        var a = RK.charAtlas();
        if (!a) return null;
        return a.texture(idx % a.cols, Math.floor(idx / a.cols));
    };

    function hexToRgb(hex) {
        var n = parseInt(String(hex).replace('#', ''), 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function tintedTileCanvas(idx, tintId) {
        var a = RK.charAtlas();
        tintId = validTint(tintId);
        if (!a || tintId === 'none') return null;
        var tint = RK.CHAR_TINTS[tintId];
        if (!tint || !tint.ramp) return null;
        var key = idx + '|' + tintId;
        if (tintedTiles[key]) return tintedTiles[key];

        var cv = document.createElement('canvas');
        cv.width = cv.height = TILE;
        var ctx = cv.getContext('2d');
        var src = a.px(idx % a.cols, Math.floor(idx / a.cols));
        ctx.drawImage(a.img, src.x, src.y, TILE, TILE, 0, 0, TILE, TILE);

        var img = ctx.getImageData(0, 0, TILE, TILE);
        var ramp = tint.ramp.map(hexToRgb);
        for (var i = 0; i < img.data.length; i += 4) {
            var k = img.data[i] + ',' + img.data[i + 1] + ',' + img.data[i + 2];
            var ri = TINT_SOURCE[k];
            if (ri == null || img.data[i + 3] === 0) continue;
            var rgb = ramp[Math.min(ri, ramp.length - 1)];
            img.data[i] = rgb.r; img.data[i + 1] = rgb.g; img.data[i + 2] = rgb.b;
        }
        ctx.putImageData(img, 0, 0);
        tintedTiles[key] = cv;
        return cv;
    }

    RK.charTileTexture = function (idx, tintId) {
        tintId = validTint(tintId);
        if (tintId === 'none') return RK.charTexture(idx);
        if (typeof PIXI === 'undefined') return null;
        var key = idx + '|' + tintId;
        if (tintedTextures[key]) return tintedTextures[key];
        var cv = tintedTileCanvas(idx, tintId);
        if (!cv) return RK.charTexture(idx);
        var tx = PIXI.Texture.from(cv);
        if (tx.baseTexture) tx.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
        tintedTextures[key] = tx;
        return tx;
    };

    RK.drawCharTileCanvas = function (ctx, idx, tintId, dx, dy, dw, dh) {
        var a = RK.charAtlas();
        if (!a) return false;
        var tinted = tintedTileCanvas(idx, tintId);
        ctx.imageSmoothingEnabled = false;
        if (tinted) {
            ctx.drawImage(tinted, 0, 0, TILE, TILE, dx, dy, dw, dh);
            return true;
        }
        var src = a.px(idx % a.cols, Math.floor(idx / a.cols));
        ctx.drawImage(a.img, src.x, src.y, TILE, TILE, dx, dy, dw, dh);
        return true;
    };

    RK.charOverlayParts = function (appearance) {
        appearance = appearance || {};
        var tint = validTint(appearance.tint);
        var eq = RK.normalizeCharEquipment(appearance.equipment);
        var out = [];
        EQUIP_SLOTS.forEach(function (slot) {
            var item = RK.CHAR_EQUIPMENT[slot][eq[slot]];
            if (!item || item.frame == null) return;
            out.push({ slot: slot, id: item.id, frame: item.frame, tint: item.tint === false ? 'none' : tint });
        });
        return out;
    };

    // Canvas draw (TileRenderer + thumbnails). Returns false (and lazy-loads) if not ready.
    RK.drawCharCanvas = function (ctx, e, cell, nowMs) {
        var a = RK.charAtlas();
        if (!a) { RK.loadCharAtlas(); return false; }
        var appearance = RK.charAppearance(e);
        var ch = RK.CHARS[appearance.avatar];
        if (!ch) return false;
        var f = RK.charFrame(ch, e, nowMs);
        var dw = cell * 1.8, dh = dw * f.squash;
        var cx = e.x * cell + cell / 2;
        var dy = (e.y * cell + cell) - dh + f.bob;  // feet at tile bottom, squashed upward
        ctx.imageSmoothingEnabled = false;
        if (e.you) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.ellipse(cx, e.y * cell + cell - 2, dw * 0.3, cell * 0.16, 0, 0, Math.PI * 2); ctx.stroke();
        }
        function drawComposite(dx, dy2) {
            RK.drawCharTileCanvas(ctx, f.idx, appearance.tint, dx, dy2, dw, dh);
            RK.charOverlayParts(appearance).forEach(function (part) {
                RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy2, dw, dh);
            });
        }
        if (f.flip) {
            ctx.save();
            ctx.translate(cx + dw / 2, dy); ctx.scale(-1, 1);
            drawComposite(0, 0);
            ctx.restore();
        } else {
            drawComposite(cx - dw / 2, dy);
        }
        if (e.label) {
            ctx.fillStyle = '#d7dbe0'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
            ctx.fillText(e.label, cx, dy - 2);
        }
        return true;
    };

    RK.drawCharCompositeCanvas = function (ctx, appearance, dx, dy, size) {
        var a = RK.charAtlas();
        if (!a) { RK.loadCharAtlas(); return false; }
        var ap = RK.charAppearance({ avatar: appearance && appearance.avatar, appearance: appearance });
        var ch = RK.CHARS[ap.avatar];
        if (!ch) return false;
        RK.drawCharTileCanvas(ctx, ch.frame, ap.tint, dx, dy, size, size);
        RK.charOverlayParts(ap).forEach(function (part) {
            RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy, size, size);
        });
        return true;
    };
})(window);
