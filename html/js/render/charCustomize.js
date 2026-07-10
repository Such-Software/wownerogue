// Character customization -- a persistent "appearance identity" the player picks once and carries
// across the tavern (and, next, single-player / PvP / dead-kernel). The saved shape is structured
// so premium character packs can add their own tint/equipment catalogs without changing join flow.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var DEFAULT_EQUIPMENT = { body: 'none', head: 'none', shield: 'none', weapon: 'none' };
    var DEFAULT_COLORS = { base: 'none', skin: 'natural', hair: 'copper', body: 'none', head: 'none', shield: 'none', weapon: 'none' };
    var thumbImages = {};
    var thumbBounds = {};

    function cloneEquipment(eq) {
        eq = eq || {};
        var out = {};
        var slots = (RK.CHAR_EQUIPMENT_SLOTS || ['body', 'head', 'shield', 'weapon']);
        slots.forEach(function (slot) { out[slot] = eq[slot] || 'none'; });
        return out;
    }

    function cloneColors(colors, legacyTint) {
        if (RK.normalizeCharColors) return RK.normalizeCharColors(colors, legacyTint);
        colors = colors || {};
        var out = {};
        for (var k in DEFAULT_COLORS) out[k] = colors[k] || (k === 'base' ? (legacyTint || DEFAULT_COLORS[k]) : DEFAULT_COLORS[k]);
        return out;
    }

    function baseAppearances() {
        var list = [
            { id: 'default', label: 'Operator', kind: 'color', color: '#9aa4b2' },
            { id: 'green', label: 'Verdant', kind: 'color', color: '#3fb950' },
            { id: 'amber', label: 'Amber', kind: 'color', color: '#d29922' },
            { id: 'red', label: 'Crimson', kind: 'color', color: '#f85149' }
        ];
        for (var cid in (RK.CHARS || {})) {
            var c = RK.CHARS[cid];
            list.push({ id: cid, label: c.label || cid, kind: 'char' });
        }
        for (var id in (RK.SKINS || {})) {
            var s = RK.SKINS[id];
            list.push({ id: id, label: s.label || id, kind: 'skin', premium: !!s.premium, pack: s.pack || 'generated-skins' });
        }
        if (RK.packAppearances) {
            RK.packAppearances().forEach(function (a) { list.push(a); });
        }
        return list;
    }

    function baseAppearance(id) {
        var all = baseAppearances();
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return all[0];
    }

    // The base appearance catalog. Kept for existing callers that expect a flat list.
    RK.appearances = baseAppearances;

    RK.normalizeAppearance = function (input) {
        if (input && input.appearance && !input.avatar) input = input.appearance;
        if (typeof input === 'string') input = { avatar: input };
        input = input || {};

        var avatar = input.avatar || input.id || 'default';
        if (!baseAppearance(avatar) || baseAppearance(avatar).id !== avatar) avatar = 'default';

        var base = baseAppearance(avatar);
        var isChar = !!(RK.isChar && RK.isChar(avatar));
        var isModel = base && base.kind === 'model3d';
        var tint = 'none';
        var equipment = cloneEquipment(DEFAULT_EQUIPMENT);
        var colors = null;
        if (isChar || isModel) {
            colors = cloneColors(input.colors, input.tint);
            tint = colors.base;
        }
        if (isChar) {
            equipment = RK.normalizeCharEquipment ? RK.normalizeCharEquipment(input.equipment) : cloneEquipment(input.equipment);
        }
        var out = { avatar: avatar, tint: tint, equipment: equipment };
        if (isChar || isModel) out.colors = colors;
        return out;
    };

    RK.appearance = function (input) {
        var ap = RK.normalizeAppearance(input);
        var base = baseAppearance(ap.avatar);
        var label = base.label || base.id;
        if (base.kind === 'char' && ap.colors && ap.colors.base && ap.colors.base !== 'none' && RK.CHAR_TINTS && RK.CHAR_TINTS[ap.colors.base]) {
            label += ' / ' + RK.CHAR_TINTS[ap.colors.base].label;
        }
        return {
            id: ap.avatar,
            label: label,
            kind: base.kind,
            color: base.color,
            premium: !!base.premium,
            appearance: ap
        };
    };

    // Identity persistence (client-side for now; server/DB persistence is the next step so it
    // follows the player across modes and survives device changes).
    RK.saveIdentity = function (appearance) {
        try { localStorage.setItem('rk_identity', JSON.stringify({ appearance: RK.normalizeAppearance(appearance) })); } catch (_) { /* ignore */ }
    };
    RK.loadIdentity = function () {
        try {
            var raw = JSON.parse(localStorage.getItem('rk_identity') || 'null');
            if (!raw) return null;
            return { appearance: RK.normalizeAppearance(raw.appearance || raw) };
        } catch (_) { return null; }
    };

    function projectionToMode(projection) {
        if (projection === 'iso') return 'iso';
        if (projection === '3d') return '3d';
        if (projection === 'ascii') return 'ascii';
        return 'tiles';
    }

    function projectionForMode(mode) {
        if (mode === 'iso' || mode === '3d' || mode === 'ascii') return mode;
        return 'topdown';
    }

    function isoAvatarId() {
        return (RK.isoAssets && RK.isoAssets.avatar) || 'char-villager';
    }

    function hasIsoCharacter(a) {
        return !!(a && a.kind === 'char' && a.id === isoAvatarId());
    }

    function appearanceVisibleInProjection(a, projection) {
        if (!a) return false;
        if (projection === 'topdown') return a.kind === 'color' || a.kind === 'char' || a.kind === 'skin';
        if (projection === 'iso') return hasIsoCharacter(a);
        if (projection === '3d') return a.kind === 'model3d';
        if (projection === 'ascii') return a.kind === 'color';
        return a.kind === 'color';
    }

    function loadThumbImage(url, onReady) {
        if (!url) return null;
        if (thumbImages[url]) return thumbImages[url];
        var rec = thumbImages[url] = { ready: false, error: false, img: new Image() };
        rec.img.onload = function () { rec.ready = true; if (onReady) onReady(); };
        rec.img.onerror = function () { rec.error = true; };
        rec.img.src = url;
        return rec;
    }

    function tintColorForThumb(a, draft, projection) {
        if (projection === 'iso') return null;
        var source = {};
        var d = draft || {};
        for (var dk in d) source[dk] = d[dk];
        source.avatar = a.id;
        if (a.kind === 'color') return a.color;
        if (RK.avatarVisuals && RK.avatarVisuals.tintColorFor) return RK.avatarVisuals.tintColorFor(source, '#9aa4b2');
        return '#9aa4b2';
    }

    function isoCharacterForThumb(a, draft) {
        var source = {};
        var d = draft || {};
        for (var dk in d) source[dk] = d[dk];
        source.avatar = a.id;
        if (RK.avatarVisuals && RK.avatarVisuals.resolve) {
            var visual = RK.avatarVisuals.resolve(source, { projection: 'iso', context: 'customizer' });
            if (visual && visual.character) return visual.character;
        }
        var chars = RK.isoAssets && RK.isoAssets.characters;
        return (chars && (chars[a.id] || chars.fallback)) || (RK.isoAssets && RK.isoAssets.character) || null;
    }

    function isoSkinTintForDraft(draft) {
        var colors = cloneColors(draft && draft.colors, draft && draft.tint);
        if (!colors.skin || colors.skin === 'natural') return null;
        var tone = RK.CHAR_SKIN_TONES && RK.CHAR_SKIN_TONES[colors.skin];
        return (tone && tone.color) || null;
    }

    function imageBounds(img) {
        var key = img && img.src;
        if (!img || !key) return null;
        if (thumbBounds[key]) return thumbBounds[key];
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, w, h).data;
        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] < 8) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
        thumbBounds[key] = maxX < minX ? { x: 0, y: 0, w: w, h: h } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        return thumbBounds[key];
    }

    function drawTintedImage(ctx, img, bounds, x, y, w, h, tint) {
        bounds = bounds || { x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
        if (!tint) {
            ctx.drawImage(img, bounds.x, bounds.y, bounds.w, bounds.h, x, y, w, h);
            return;
        }
        var cv = document.createElement('canvas');
        cv.width = bounds.w;
        cv.height = bounds.h;
        var tctx = cv.getContext('2d');
        tctx.drawImage(img, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
        tctx.globalCompositeOperation = 'source-atop';
        tctx.globalAlpha = 0.42;
        tctx.fillStyle = tint;
        tctx.fillRect(0, 0, cv.width, cv.height);
        tctx.globalAlpha = 1;
        tctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(cv, x, y, w, h);
    }

    function drawProjectionThumb(ctx, a, draft, projection, onReady) {
        var color = tintColorForThumb(a, draft, projection);
        ctx.clearRect(0, 0, 72, 80);
        if (projection === 'ascii') {
            ctx.fillStyle = color || '#9aa4b2';
            ctx.font = '42px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('@', 36, 43);
            return;
        }
        if (projection === 'iso') {
            ctx.imageSmoothingEnabled = true;
            ctx.fillStyle = '#705842';
            ctx.beginPath();
            ctx.moveTo(36, 54);
            ctx.lineTo(62, 42);
            ctx.lineTo(36, 30);
            ctx.lineTo(10, 42);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.stroke();
            var ch = isoCharacterForThumb(a, draft);
            var rec = loadThumbImage(ch && ch.idle, onReady);
            if (rec && rec.ready) {
                var b = imageBounds(rec.img);
                var dh = 52;
                var dw = dh * (b.w / b.h);
                drawTintedImage(ctx, rec.img, b, 36 - dw / 2, 74 - dh, dw, dh, isoSkinTintForDraft(draft));
            } else {
                ctx.fillStyle = color || '#9aa4b2';
                ctx.beginPath();
                ctx.ellipse(36, 37, 8, 16, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#0a0c0f';
                ctx.fillRect(32, 34, 8, 3);
            }
            return;
        }
        if (projection === '3d') {
            ctx.imageSmoothingEnabled = true;
            ctx.fillStyle = color || '#64748b';
            ctx.beginPath();
            ctx.ellipse(36, 45, 17, 24, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.28)';
            ctx.beginPath();
            ctx.ellipse(29, 34, 6, 9, -0.5, 0, Math.PI * 2);
            ctx.fill();
            if (a.kind === 'model3d') {
                ctx.fillStyle = '#d7dbe0';
                ctx.font = '15px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('3D', 36, 49);
            }
            return;
        }
    }

    function drawBaseThumb(ctx, a, draft, projection, onReady) {
        ctx.clearRect(0, 0, 72, 80);
        if (projection && projection !== 'topdown') {
            drawProjectionThumb(ctx, a, draft, projection, onReady);
            return;
        }
        if (a.kind === 'color') {
            ctx.beginPath(); ctx.arc(36, 44, 21, 0, Math.PI * 2);
            ctx.fillStyle = a.color; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.stroke();
            return;
        }
        if (a.kind === 'char') {
            var at = RK.charAtlas && RK.charAtlas();
            if (!at) {
                RK.loadCharAtlas(onReady);
                ctx.fillStyle = '#666'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText('...', 36, 44);
                return;
            }
            var source = {};
            var d = draft || {};
            for (var dk in d) source[dk] = d[dk];
            source.avatar = a.id;
            var ap = RK.normalizeAppearance(source);
            if (!RK.drawCharCompositeCanvas(ctx, ap, 1, 8, 70)) {
                RK.loadCharAtlas(onReady);
                ctx.fillStyle = '#666'; ctx.fillText('...', 36, 44);
            }
            return;
        }
        if (a.kind === 'model3d') {
            ctx.beginPath(); ctx.arc(36, 43, 21, 0, Math.PI * 2);
            ctx.fillStyle = '#64748b'; ctx.fill();
            ctx.fillStyle = '#d7dbe0'; ctx.font = '18px monospace'; ctx.textAlign = 'center'; ctx.fillText('3D', 36, 49);
            return;
        }
        var rec = RK.skinSheet(a.id);
        if (!rec) {
            var r = RK.loadSkin(a.id);
            if (r && r.cbs && onReady) r.cbs.push(onReady);
            ctx.fillStyle = '#666'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
            ctx.fillText('...', 36, 44);
            return;
        }
        var s = RK.SKINS[a.id];
        var row = (s.dirRows && s.dirRows.down) || 0;
        var dh = 72, dw = dh * (s.frameW / s.frameH);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(rec.img, 0, row * s.frameH, s.frameW, s.frameH, 36 - dw / 2, 80 - dh, dw, dh);

    }

    function thumbCanvas(a, getDraft, redraw) {
        var cv = document.createElement('canvas');
        cv.width = 72; cv.height = 80;
        cv.style.cssText = 'display:block;margin:0 auto;image-rendering:pixelated;';
        var ctx = cv.getContext('2d');
        function draw() {
            var d = getDraft && getDraft();
            var projection = (d && d.__projection) || 'topdown';
            drawBaseThumb(ctx, a, d, projection, draw);
        }
        draw();
        if (redraw) redraw.push(draw);
        return cv;
    }

    function optionTileCanvas(slot, item, draft, redraw) {
        var cv = document.createElement('canvas');
        cv.width = 52; cv.height = 52;
        cv.style.cssText = 'display:block;margin:0 auto 4px;image-rendering:pixelated;';
        var ctx = cv.getContext('2d');
        function draw() {
            ctx.clearRect(0, 0, 52, 52);
            if (!item || item.frame == null) {
                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
                ctx.beginPath(); ctx.moveTo(17, 26); ctx.lineTo(35, 26); ctx.stroke();
                return;
            }
            var colorable = item.colorable === true;
            var tint = colorable ? ((draft.colors && draft.colors[slot]) || draft.tint) : 'none';
            var colors = colorable ? draft.colors : null;
            if (!RK.drawCharTileCanvas || !RK.drawCharTileCanvas(ctx, item.frame, tint, 2, 2, 48, 48, colors, slot)) {
                RK.loadCharAtlas(draw);
                ctx.fillStyle = '#666'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText('...', 26, 30);
            }
        }
        draw();
        if (redraw) redraw.push(draw);
        return cv;
    }

    function ensureCustomizeStyle() {
        if (document.getElementById('rk-customize-style')) return;
        var style = document.createElement('style');
        style.id = 'rk-customize-style';
        style.textContent = [
            '.rk-customize{position:fixed;inset:0;z-index:9999;background:rgba(4,6,8,.94);color:#d7dbe0;font-family:ui-monospace,monospace;overflow:hidden;}',
            '.rk-customize *{box-sizing:border-box;letter-spacing:0;}',
            '.rk-customize-shell{height:100%;max-width:1080px;margin:0 auto;padding:12px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;}',
            '.rk-customize-top{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #202832;padding-bottom:10px;}',
            '.rk-customize-title{font-size:15px;font-weight:700;color:#f0f3f6;overflow-wrap:anywhere;}',
            '.rk-customize-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}',
            '.rk-customize-body{min-height:0;display:grid;grid-template-columns:168px minmax(0,1fr);gap:12px;}',
            '.rk-customize-preview{align-self:start;position:sticky;top:0;border:1px solid #26303b;background:#0b0f14;border-radius:6px;padding:10px;}',
            '.rk-customize-preview canvas{display:block;width:100%;height:auto;image-rendering:pixelated;background:#090c10;border:1px solid #2a313a;border-radius:6px;}',
            '.rk-customize-name{font-size:12px;font-weight:700;color:#f0f3f6;margin-top:8px;overflow-wrap:anywhere;}',
            '.rk-customize-meta{font-size:11px;color:#8b949e;margin-top:4px;overflow-wrap:anywhere;}',
            '.rk-customize-content{min-width:0;overflow:auto;padding-right:4px;scrollbar-gutter:stable;}',
            '.rk-customize-section{margin-bottom:12px;}',
            '.rk-customize-section h3{margin:0 0 8px;font-size:12px;line-height:1.2;color:#9aa4b2;font-weight:700;text-transform:uppercase;}',
            '.rk-mode-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;}',
            '.rk-mode-card{min-width:0;border:2px solid #2a313a;border-radius:6px;background:#11161c;color:#c7ccd4;cursor:pointer;padding:7px 8px;font:inherit;text-align:left;display:grid;gap:2px;}',
            '.rk-mode-card:hover{border-color:#566274;background:#151b22;}',
            '.rk-mode-card.is-selected{border-color:#3fb950;box-shadow:0 0 0 1px rgba(63,185,80,.3) inset;}',
            '.rk-mode-card.is-locked{opacity:.5;cursor:not-allowed;}',
            '.rk-mode-label{font-size:12px;font-weight:700;color:#dce2ea;overflow-wrap:anywhere;}',
            '.rk-mode-status{font-size:10px;color:#8b949e;overflow-wrap:anywhere;}',
            '.rk-avatar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;}',
            '.rk-option-card{min-width:0;min-height:92px;border:2px solid #2a313a;border-radius:6px;background:#11161c;color:#c7ccd4;cursor:pointer;padding:6px;font:inherit;font-size:10px;text-align:center;}',
            '.rk-option-card:hover{border-color:#566274;background:#151b22;}',
            '.rk-option-card.is-selected{border-color:#3fb950;box-shadow:0 0 0 1px rgba(63,185,80,.3) inset;}',
            '.rk-option-card.is-locked{opacity:.48;cursor:not-allowed;}',
            '.rk-option-card canvas{max-width:60px;width:100%;height:auto;}',
            '.rk-option-label{margin-top:5px;line-height:1.2;overflow-wrap:anywhere;color:#d0d6de;}',
            '.rk-customize-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:start;margin-bottom:8px;}',
            '.rk-row-label{font-size:11px;color:#9aa4b2;padding-top:8px;overflow-wrap:anywhere;}',
            '.rk-row-options{display:flex;gap:6px;flex-wrap:wrap;min-width:0;}',
            '.rk-swatch,.rk-equip-option{border:2px solid #2a313a;border-radius:6px;background:#11161c;color:#c7ccd4;cursor:pointer;font:inherit;font-size:10px;}',
            '.rk-swatch{width:58px;min-height:50px;padding:5px;}',
            '.rk-equip-option{width:64px;min-height:68px;padding:4px;}',
            '.rk-swatch:hover,.rk-equip-option:hover{border-color:#566274;background:#151b22;}',
            '.rk-swatch.is-selected,.rk-equip-option.is-selected{border-color:#3fb950;box-shadow:0 0 0 1px rgba(63,185,80,.3) inset;}',
            '.rk-swatch-dot{display:block;width:20px;height:20px;margin:0 auto 4px;border-radius:50%;border:1px solid rgba(255,255,255,.35);}',
            '.rk-none-dot{background:linear-gradient(135deg,#171c22 0,#171c22 45%,#9aa4b2 47%,#9aa4b2 53%,#171c22 55%,#171c22 100%);}',
            '.rk-button{font:inherit;border-radius:6px;padding:7px 12px;cursor:pointer;font-weight:700;}',
            '.rk-save{border:0;background:#3fb950;color:#071109;}',
            '.rk-cancel{border:1px solid #2a313a;background:#10151b;color:#d7dbe0;}',
            '@media (max-width:760px){.rk-customize-shell{padding:10px;}.rk-customize-top{align-items:flex-start;}.rk-customize-body{grid-template-columns:1fr;overflow:auto;}.rk-customize-content{overflow:visible;padding-right:0;}.rk-customize-preview{position:relative;display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;align-items:center;}.rk-customize-preview canvas{width:88px;}.rk-customize-row{grid-template-columns:1fr;gap:5px;}.rk-row-label{padding-top:0;}.rk-avatar-grid{grid-template-columns:repeat(auto-fill,minmax(76px,1fr));}.rk-option-card{min-height:90px;}.rk-customize-actions{width:100%;justify-content:flex-start;}}'
        ].join('');
        document.head.appendChild(style);
    }

    RK.openCustomize = function (current, onSave, opts) {
        opts = opts || {};
        ensureCustomizeStyle();

        var draft = RK.normalizeAppearance(current);
        var redrawers = [];      // avatar thumbnail draws (reset in buildAvatarGrid)
        var equipRedrawers = [];  // equipment option tile draws (reset in renderEditor)
        var cards = {};

        function isCharDraft() {
            return !!(RK.isChar && RK.isChar(draft.avatar));
        }

        function draftKind() {
            return (baseAppearance(draft.avatar) || {}).kind;
        }

        function supportsColorDraft() {
            var kind = draftKind();
            return isCharDraft() || kind === 'model3d';
        }

        function activeProjection() {
            return projectionForMode(selectedMode);
        }

        function ensureColorDraft() {
            if (!draft.colors) draft.colors = cloneColors(null, draft.tint);
            draft.tint = draft.colors.base;
        }

        function ensureCharDraft() {
            ensureColorDraft();
            if (!draft.equipment) draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
        }

        var wrap = document.createElement('div');
        wrap.className = 'rk-customize';

        var shell = document.createElement('div');
        shell.className = 'rk-customize-shell';
        wrap.appendChild(shell);

        var top = document.createElement('div');
        top.className = 'rk-customize-top';
        shell.appendChild(top);

        var title = document.createElement('div');
        title.className = 'rk-customize-title';
        title.textContent = 'Customize your character';
        top.appendChild(title);

        var actions = document.createElement('div');
        actions.className = 'rk-customize-actions';
        top.appendChild(actions);

        var save = document.createElement('button');
        save.type = 'button';
        save.className = 'rk-button rk-save';
        save.textContent = 'Save';
        actions.appendChild(save);

        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'rk-button rk-cancel';
        cancel.textContent = 'Cancel';
        actions.appendChild(cancel);

        var body = document.createElement('div');
        body.className = 'rk-customize-body';
        shell.appendChild(body);

        var previewPane = document.createElement('div');
        previewPane.className = 'rk-customize-preview';
        body.appendChild(previewPane);

        var preview = document.createElement('canvas');
        preview.width = 150;
        preview.height = 164;
        var pctx = preview.getContext('2d');
        previewPane.appendChild(preview);

        var previewText = document.createElement('div');
        previewPane.appendChild(previewText);

        var previewName = document.createElement('div');
        previewName.className = 'rk-customize-name';
        previewText.appendChild(previewName);

        var previewMeta = document.createElement('div');
        previewMeta.className = 'rk-customize-meta';
        previewText.appendChild(previewMeta);

        var content = document.createElement('div');
        content.className = 'rk-customize-content';
        body.appendChild(content);

        // The main game page only uses top-down rendering, so the customizer there should
        // default to top-down and not offer the tavern's render-mode picker. The tavern passes
        // no opts, so it gets the full picker and the user's saved mode.
        var selectedMode = opts.projection ? projectionToMode(opts.projection) : (RK.loadMode ? RK.loadMode('tiles') : 'tiles');
        var showRenderModes = !opts.projection && RK.RENDER_MODES && RK.RENDER_MODES.length;
        var modeCards = {};
        var renderModeGrid = null;
        if (showRenderModes) {
            var renderSection = document.createElement('section');
            renderSection.className = 'rk-customize-section';
            content.appendChild(renderSection);
            var renderTitle = document.createElement('h3');
            renderTitle.textContent = 'Render';
            renderSection.appendChild(renderTitle);
            renderModeGrid = document.createElement('div');
            renderModeGrid.className = 'rk-mode-grid';
            renderSection.appendChild(renderModeGrid);
        }

        var avatarSection = document.createElement('section');
        avatarSection.className = 'rk-customize-section';
        content.appendChild(avatarSection);
        var avatarTitle = document.createElement('h3');
        avatarTitle.textContent = 'Avatar';
        avatarSection.appendChild(avatarTitle);
        var grid = document.createElement('div');
        grid.className = 'rk-avatar-grid';
        avatarSection.appendChild(grid);

        var editSection = document.createElement('section');
        editSection.className = 'rk-customize-section';
        content.appendChild(editSection);

        function colorCatalog(kind) {
            if (kind === 'skin') return RK.CHAR_SKIN_TONES || {};
            if (kind === 'hair') return RK.CHAR_HAIR_COLORS || {};
            return RK.CHAR_TINTS || {};
        }

        function sectionTitle(text, parent) {
            var h = document.createElement('h3');
            h.textContent = text;
            parent.appendChild(h);
            return h;
        }

        function row(labelText, parent) {
            var r = document.createElement('div');
            r.className = 'rk-customize-row';
            var label = document.createElement('div');
            label.className = 'rk-row-label';
            label.textContent = labelText;
            r.appendChild(label);
            var opts = document.createElement('div');
            opts.className = 'rk-row-options';
            r.appendChild(opts);
            parent.appendChild(r);
            return opts;
        }

        function optionButton(label, selected, onclick, canvas) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'rk-equip-option' + (selected ? ' is-selected' : '');
            if (canvas) b.appendChild(canvas);
            var t = document.createElement('div');
            t.className = 'rk-option-label';
            t.textContent = label;
            b.appendChild(t);
            b.onclick = onclick;
            return b;
        }

        function swatchButton(item, selected, onclick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'rk-swatch' + (selected ? ' is-selected' : '');
            var dot = document.createElement('span');
            dot.className = 'rk-swatch-dot' + (!item.color ? ' rk-none-dot' : '');
            if (item.color) dot.style.background = item.color;
            b.appendChild(dot);
            var text = document.createElement('div');
            text.className = 'rk-option-label';
            text.textContent = item.label || item.id;
            b.appendChild(text);
            b.onclick = onclick;
            return b;
        }

        function packLabel(id) {
            var pack = RK.pack && RK.pack(id);
            return (pack && pack.label) || 'premium pack';
        }

        function modeLockedTitle(mode) {
            var label = mode && mode.label ? mode.label : 'Mode';
            if (mode && mode.pack) return label + ' is locked. Buy any credits or unlock ' + packLabel(mode.pack) + '.';
            return label + ' is locked. Buy any credits to unlock premium modes.';
        }

        function modeStatus(mode, unlocked) {
            if (!mode || !mode.premium) return 'Included';
            if (unlocked && RK.renderModeTestUnlocks && RK.renderModeTestUnlocks()) return 'Test';
            return unlocked ? 'Unlocked' : 'Locked';
        }

        function markRenderMode() {
            for (var id in modeCards) {
                if (id === selectedMode) modeCards[id].classList.add('is-selected');
                else modeCards[id].classList.remove('is-selected');
            }
        }

        function selectRenderMode(mode) {
            if (RK.canUseMode && !RK.canUseMode(mode.id)) return;
            selectedMode = mode.id;
            if (RK.saveMode) RK.saveMode(mode.id);
            markRenderMode();
            buildAvatarGrid();
            renderEditor();
            redrawAll();
        }

        function buildRenderModes() {
            if (!renderModeGrid || !RK.RENDER_MODES) return;
            renderModeGrid.innerHTML = '';
            modeCards = {};
            RK.RENDER_MODES.forEach(function (mode) {
                var unlocked = !RK.canUseMode || RK.canUseMode(mode.id);
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'rk-mode-card' + (unlocked ? '' : ' is-locked');
                b.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
                b.title = unlocked ? ('Use ' + mode.label) : modeLockedTitle(mode);
                var label = document.createElement('span');
                label.className = 'rk-mode-label';
                label.textContent = mode.label + (mode.premium ? ' *' : '');
                b.appendChild(label);
                var status = document.createElement('span');
                status.className = 'rk-mode-status';
                status.textContent = modeStatus(mode, unlocked);
                b.appendChild(status);
                b.onclick = function () { selectRenderMode(mode); };
                renderModeGrid.appendChild(b);
                modeCards[mode.id] = b;
            });
            markRenderMode();
        }

        function setColor(slot, id) {
            ensureCharDraft();
            draft.colors[slot] = id;
            if (slot === 'base') draft.tint = id;
            renderEditor();
            redrawAll();
        }

        function renderColorRow(label, slot, catalogKind, parent) {
            var opts = row(label, parent);
            var catalog = colorCatalog(catalogKind);
            for (var id in catalog) {
                (function (item) {
                    opts.appendChild(swatchButton(item, draft.colors && draft.colors[slot] === item.id, function () {
                        setColor(slot, item.id);
                    }));
                })(catalog[id]);
            }
        }

        function equipmentColorable(item) {
            return !!(item && item.frame != null && item.colorable === true);
        }

        function renderEditor() {
            editSection.innerHTML = '';
            equipRedrawers = [];
            if (!supportsColorDraft()) return;
            if (isCharDraft()) ensureCharDraft();
            else ensureColorDraft();

            var projection = activeProjection();
            if (projection === 'iso' && isCharDraft()) {
                sectionTitle('Color', editSection);
                renderColorRow('Skin', 'skin', 'skin', editSection);
                return;
            }
            if (projection !== 'topdown' || !isCharDraft()) {
                sectionTitle('Color', editSection);
                renderColorRow('Color', 'base', 'tint', editSection);
                return;
            }

            // Sprite tinting (cloth / skin / hair / gear colour) is disabled for the top-down
            // Tiles view — characters render in native Kenney art. Only equipment PIECE selection
            // remains here; the '@' colour for ASCII mode is still pickable in the ascii/colour
            // branch above.
            sectionTitle('Equipment', editSection);
            (RK.CHAR_EQUIPMENT_SLOTS || []).forEach(function (slot) {
                var catalog = RK.CHAR_EQUIPMENT[slot] || {};
                var opts = row(slot.charAt(0).toUpperCase() + slot.slice(1), editSection);
                for (var id in catalog) {
                    (function (item) {
                        opts.appendChild(optionButton(item.label, draft.equipment[slot] === item.id, function () {
                            draft.equipment[slot] = item.id;
                            renderEditor();
                            redrawAll();
                        }, optionTileCanvas(slot, item, draft, equipRedrawers)));
                    })(catalog[id]);
                }
            });
        }

        function selectAvatar(a) {
            if (RK.canUseAppearance && !RK.canUseAppearance(a)) return;
            draft.avatar = a.id;
            if (RK.isChar && RK.isChar(draft.avatar)) {
                ensureCharDraft();
            } else if (draftKind() === 'model3d') {
                ensureColorDraft();
                draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
            } else {
                draft.tint = 'none';
                draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
                delete draft.colors;
            }
            mark();
            renderEditor();
            redrawAll();
        }

        function visibleAppearances() {
            var projection = activeProjection();
            return RK.appearances().filter(function (a) {
                return appearanceVisibleInProjection(a, projection);
            });
        }

        function appearanceForId(list, id) {
            for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
            return null;
        }

        function ensureVisibleAvatar() {
            var list = visibleAppearances();
            if (appearanceForId(list, draft.avatar)) return;
            if (!list.length) return;
            draft.avatar = list[0].id;
            if (RK.isChar && RK.isChar(draft.avatar)) ensureCharDraft();
            else if (draftKind() === 'model3d') {
                ensureColorDraft();
                draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
            } else {
                draft.tint = 'none';
                draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
                delete draft.colors;
            }
        }

        function buildAvatarGrid() {
            // Don't auto-switch the avatar when the render mode changes — only an explicit
            // click on a different avatar card should change the saved identity. If the current
            // avatar isn't native to this projection, it stays selected (the resolver handles
            // fallback rendering) so browsing render modes never silently mutates the identity.
            grid.innerHTML = '';
            cards = {};
            redrawers = [];
            visibleAppearances().forEach(function (a) {
                var card = document.createElement('button');
                var locked = !!(RK.canUseAppearance && !RK.canUseAppearance(a));
                card.type = 'button';
                card.className = 'rk-option-card' + (locked ? ' is-locked' : '');
                if (locked) card.title = 'Premium pack - buy credits to unlock';
                card.appendChild(thumbCanvas(a, function () {
                    var d = {};
                    for (var dk in draft) d[dk] = draft[dk];
                    d.__projection = activeProjection();
                    return d;
                }, redrawers));
                var lab = document.createElement('div');
                lab.className = 'rk-option-label';
                lab.textContent = a.label + (a.premium ? ' *' : '');
                card.appendChild(lab);
                card.onclick = function () { selectAvatar(a); };
                grid.appendChild(card);
                cards[a.id] = card;
            });
            mark();
        }

        function drawPreview() {
            pctx.clearRect(0, 0, preview.width, preview.height);
            var base = baseAppearance(draft.avatar);
            var projection = activeProjection();
            if (projection !== 'topdown') {
                var temp = document.createElement('canvas');
                temp.width = 72;
                temp.height = 80;
                drawProjectionThumb(temp.getContext('2d'), base, draft, projection, redrawAll);
                pctx.imageSmoothingEnabled = projection !== 'ascii';
                pctx.drawImage(temp, 0, 0, 72, 80, 21, 12, 108, 120);
            } else if (base.kind === 'color') {
                pctx.beginPath(); pctx.arc(75, 86, 34, 0, Math.PI * 2);
                pctx.fillStyle = base.color; pctx.fill();
                pctx.lineWidth = 3; pctx.strokeStyle = 'rgba(255,255,255,0.35)'; pctx.stroke();
            } else if (base.kind === 'char') {
                if (!RK.drawCharCompositeCanvas || !RK.drawCharCompositeCanvas(pctx, draft, 15, 12, 120)) RK.loadCharAtlas(redrawAll);
            } else if (base.kind === 'model3d') {
                pctx.beginPath(); pctx.arc(75, 86, 34, 0, Math.PI * 2);
                pctx.fillStyle = '#64748b'; pctx.fill();
                pctx.fillStyle = '#d7dbe0'; pctx.font = '26px monospace'; pctx.textAlign = 'center'; pctx.fillText('3D', 75, 95);
            } else if (base.kind === 'skin') {
                var rec = RK.skinSheet(base.id);
                if (!rec) {
                    var r = RK.loadSkin(base.id);
                    if (r && r.cbs) r.cbs.push(redrawAll);
                    pctx.fillStyle = '#666'; pctx.font = '13px monospace'; pctx.textAlign = 'center'; pctx.fillText('...', 75, 88);
                } else {
                    var s = RK.SKINS[base.id];
                    var row = (s.dirRows && s.dirRows.down) || 0;
                    var dh = 142, dw = dh * (s.frameW / s.frameH);
                    pctx.imageSmoothingEnabled = true;
                    pctx.drawImage(rec.img, 0, row * s.frameH, s.frameW, s.frameH, 75 - dw / 2, 158 - dh, dw, dh);
                }
            } else {
                drawBaseThumb(pctx, base, draft, 'topdown', redrawAll);
            }
            var visible = appearanceVisibleInProjection(base, projection);
            previewName.textContent = base.label || base.id;
            var metaParts = [];
            if (projection !== 'topdown') metaParts.push(projection.toUpperCase() + ' view');
            if (!visible && projection !== 'topdown') metaParts.push('fallback render');
            if (base.premium) metaParts.push('Premium pack');
            else if (base.kind === 'char') metaParts.push('Customizable');
            else if (base.kind === 'color') metaParts.push('Free');
            previewMeta.textContent = metaParts.join(' · ') || 'Free';
        }

        function redrawAll() {
            drawPreview();
            redrawers.forEach(function (fn) { try { fn(); } catch (_) { /* ignore */ } });
            equipRedrawers.forEach(function (fn) { try { fn(); } catch (_) { /* ignore */ } });
        }

        function mark() {
            for (var id in cards) {
                if (id === draft.avatar) cards[id].classList.add('is-selected');
                else cards[id].classList.remove('is-selected');
            }
        }

        save.onclick = function () {
            var saved = RK.normalizeAppearance(draft);
            RK.saveIdentity(saved);
            document.body.removeChild(wrap);
            if (onSave) onSave(saved);
        };
        cancel.onclick = function () { document.body.removeChild(wrap); };

        document.body.appendChild(wrap);
        buildRenderModes();
        buildAvatarGrid();
        renderEditor();
        redrawAll();
    };
})(window);
