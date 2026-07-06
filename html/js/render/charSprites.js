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
    var SKIN_SOURCE = {
        '156,118,80': 0,
        '161,125,82': 0,
        '170,143,111': 1,
        '176,128,82': 1,
        '200,164,128': 2,
        '229,196,157': 3
    };
    var HAIR_SOURCE = {
        '114,88,57': 0,
        '149,92,24': 1,
        '163,84,34': 1,
        '177,92,35': 2,
        '192,117,28': 2,
        '198,101,39': 3
    };
    var GEAR_SOURCE = {
        '114,88,57': 0,
        '149,92,24': 1,
        '163,84,34': 1,
        '176,128,82': 1,
        '177,92,35': 2,
        '192,117,28': 2,
        '198,101,39': 3,
        '200,164,128': 2,
        '135,135,135': 0,
        '202,202,202': 2,
        '204,204,204': 2,
        '232,232,232': 3,
        '247,247,247': 3
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
    RK.CHAR_SKIN_TONES = {
        natural: { id: 'natural', label: 'Natural', color: '#e5c49d', ramp: ['#9c7650', '#aa8f6f', '#c8a480', '#e5c49d'] },
        fair:    { id: 'fair',    label: 'Fair',    color: '#f2d6b3', ramp: ['#b38361', '#c9a07a', '#e2be94', '#f2d6b3'] },
        warm:    { id: 'warm',    label: 'Warm',    color: '#c78355', ramp: ['#704226', '#9a5d37', '#c78355', '#e0a777'] },
        umber:   { id: 'umber',   label: 'Umber',   color: '#8b5a3c', ramp: ['#3e291d', '#5b3a28', '#8b5a3c', '#b7825c'] },
        olive:   { id: 'olive',   label: 'Olive',   color: '#9f9a64', ramp: ['#5b5a38', '#777246', '#9f9a64', '#c2bb83'] },
        ash:     { id: 'ash',     label: 'Ash',     color: '#a7a7a7', ramp: ['#585858', '#767676', '#a7a7a7', '#d1d1d1'] }
    };
    RK.CHAR_HAIR_COLORS = {
        copper: { id: 'copper', label: 'Copper', color: '#c66527', ramp: ['#724627', '#a35424', '#c66527', '#d8893d'] },
        brown:  { id: 'brown',  label: 'Brown',  color: '#7b5437', ramp: ['#34261b', '#573a28', '#7b5437', '#a47a53'] },
        black:  { id: 'black',  label: 'Black',  color: '#333333', ramp: ['#111111', '#202020', '#333333', '#555555'] },
        blond:  { id: 'blond',  label: 'Blond',  color: '#d7b45a', ramp: ['#80662d', '#a9863a', '#d7b45a', '#f0d98a'] },
        silver: { id: 'silver', label: 'Silver', color: '#c8c8c8', ramp: ['#686868', '#929292', '#c8c8c8', '#ececec'] },
        violet: { id: 'violet', label: 'Violet', color: '#9f7aea', ramp: ['#46315f', '#694c93', '#9f7aea', '#d8c4ff'] }
    };
    var DEFAULT_COLORS = {
        base: 'none',
        skin: 'natural',
        hair: 'copper',
        body: 'none',
        head: 'none',
        shield: 'none',
        weapon: 'none'
    };
    RK.CHAR_DEFAULT_COLORS = DEFAULT_COLORS;

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
            hood:   { id: 'hood', label: 'Hood', frame: 24 },
            helm:   { id: 'helm', label: 'Helm', frame: 454 },
            horns:  { id: 'horns', label: 'Horns', frame: 354 },
            cap:    { id: 'cap', label: 'Cap', frame: 462 }
        },
        shield: {
            none:   { id: 'none', label: 'None', frame: null },
            round:  { id: 'round', label: 'Round', frame: 254 },
            kite:   { id: 'kite', label: 'Kite', frame: 304 },
            tower:  { id: 'tower', label: 'Tower', frame: 202 },
            buckler:{ id: 'buckler', label: 'Buckler', frame: 411 }
        },
        weapon: {
            none:   { id: 'none', label: 'None', frame: null },
            staff:  { id: 'staff', label: 'Staff', frame: 154 },
            sword:  { id: 'sword', label: 'Sword', frame: 369 },
            axe:    { id: 'axe', label: 'Axe', frame: 375 },
            bow:    { id: 'bow', label: 'Bow', frame: 107 }
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
    function validSkin(id) {
        return (id && RK.CHAR_SKIN_TONES[id]) ? id : 'natural';
    }
    function validHair(id) {
        return (id && RK.CHAR_HAIR_COLORS[id]) ? id : 'copper';
    }
    RK.normalizeCharColors = function (colors, legacyTint) {
        var input = colors || {};
        function tintFor(slot) {
            return validTint(Object.prototype.hasOwnProperty.call(input, slot) ? input[slot] : legacyTint);
        }
        return {
            base: tintFor('base'),
            skin: validSkin(input.skin),
            hair: validHair(input.hair),
            body: tintFor('body'),
            head: tintFor('head'),
            shield: tintFor('shield'),
            weapon: tintFor('weapon')
        };
    };

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
        var colors = RK.normalizeCharColors(ap.colors, ap.tint);
        return {
            avatar: avatar,
            tint: colors.base,
            equipment: RK.normalizeCharEquipment(ap.equipment),
            colors: colors
        };
    };

    RK.charRenderKey = function (e) {
        var ap = RK.charAppearance(e);
        return [
            ap.avatar, ap.tint,
            ap.colors.base, ap.colors.skin, ap.colors.hair,
            ap.colors.body, ap.colors.head, ap.colors.shield, ap.colors.weapon,
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

    function applyRamp(img, source, ramp) {
        if (!ramp) return;
        for (var i = 0; i < img.data.length; i += 4) {
            if (img.data[i + 3] === 0) continue;
            var k = img.data[i] + ',' + img.data[i + 1] + ',' + img.data[i + 2];
            var ri = source[k];
            if (ri == null) continue;
            var rgb = ramp[Math.min(ri, ramp.length - 1)];
            img.data[i] = rgb.r; img.data[i + 1] = rgb.g; img.data[i + 2] = rgb.b;
        }
    }

    function tintedTileCanvas(idx, tintId, colors, slot) {
        var a = RK.charAtlas();
        tintId = validTint(tintId);
        colors = RK.normalizeCharColors(colors, tintId);
        slot = slot || 'base';
        var skin = RK.CHAR_SKIN_TONES[colors.skin];
        var hair = RK.CHAR_HAIR_COLORS[colors.hair];
        var slotTint = RK.CHAR_TINTS[slot === 'base' ? colors.base : (colors[slot] || tintId)];
        var slotRamp = slotTint && slotTint.ramp ? slotTint.ramp.map(hexToRgb) : null;
        var needsSlotTint = !!slotRamp && (slot !== 'base' || colors.base !== 'none');
        var needsBodyPalette = slot === 'base' && ((skin && colors.skin !== 'natural') || (hair && colors.hair !== 'copper') || needsSlotTint);
        if (!a || (!needsBodyPalette && !needsSlotTint)) return null;
        var key = idx + '|' + slot + '|' + JSON.stringify(colors);
        if (tintedTiles[key]) return tintedTiles[key];

        var cv = document.createElement('canvas');
        cv.width = cv.height = TILE;
        var ctx = cv.getContext('2d');
        var src = a.px(idx % a.cols, Math.floor(idx / a.cols));
        ctx.drawImage(a.img, src.x, src.y, TILE, TILE, 0, 0, TILE, TILE);

        var img = ctx.getImageData(0, 0, TILE, TILE);
        if (slot === 'base') {
            applyRamp(img, SKIN_SOURCE, skin && colors.skin !== 'natural' ? skin.ramp.map(hexToRgb) : null);
            applyRamp(img, HAIR_SOURCE, hair && colors.hair !== 'copper' ? hair.ramp.map(hexToRgb) : null);
        } else {
            applyRamp(img, GEAR_SOURCE, slotRamp);
        }
        applyRamp(img, TINT_SOURCE, slotRamp);
        ctx.putImageData(img, 0, 0);
        tintedTiles[key] = cv;
        return cv;
    }

    RK.charTileTexture = function (idx, tintId, colors, slot) {
        tintId = validTint(tintId);
        if (typeof PIXI === 'undefined') return null;
        colors = RK.normalizeCharColors(colors, tintId);
        slot = slot || 'base';
        var key = idx + '|' + slot + '|' + JSON.stringify(colors);
        if (tintedTextures[key]) return tintedTextures[key];
        var cv = tintedTileCanvas(idx, tintId, colors, slot);
        if (!cv) return RK.charTexture(idx);
        var tx = PIXI.Texture.from(cv);
        if (tx.baseTexture) tx.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
        tintedTextures[key] = tx;
        return tx;
    };

    RK.drawCharTileCanvas = function (ctx, idx, tintId, dx, dy, dw, dh, colors, slot) {
        var a = RK.charAtlas();
        if (!a) return false;
        var tinted = tintedTileCanvas(idx, tintId, colors, slot);
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
        var colors = RK.normalizeCharColors(appearance.colors, appearance.tint);
        var tint = colors.base;
        var eq = RK.normalizeCharEquipment(appearance.equipment);
        var out = [];
        EQUIP_SLOTS.forEach(function (slot) {
            var item = RK.CHAR_EQUIPMENT[slot][eq[slot]];
            if (!item || item.frame == null) return;
            var colorable = item.colorable !== false;
            out.push({ slot: slot, id: item.id, frame: item.frame, tint: colorable ? tint : 'none', colorable: colorable });
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
            RK.drawCharTileCanvas(ctx, f.idx, appearance.tint, dx, dy2, dw, dh, appearance.colors, 'base');
            RK.charOverlayParts(appearance).forEach(function (part) {
                RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy2, dw, dh, part.colorable ? appearance.colors : null, part.slot);
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
        RK.drawCharTileCanvas(ctx, ch.frame, ap.tint, dx, dy, size, size, ap.colors, 'base');
        RK.charOverlayParts(ap).forEach(function (part) {
            RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy, size, size, part.colorable ? ap.colors : null, part.slot);
        });
        return true;
    };
})(window);
