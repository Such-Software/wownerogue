// Character customization -- a persistent "appearance identity" the player picks once and carries
// across the tavern (and, next, single-player / PvP / dead-kernel). The saved shape is structured
// so premium character packs can add their own tint/equipment catalogs without changing join flow.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var DEFAULT_EQUIPMENT = { body: 'none', head: 'none', shield: 'none', weapon: 'none' };
    var DEFAULT_COLORS = { base: 'none', skin: 'natural', hair: 'copper', body: 'none', head: 'none', shield: 'none', weapon: 'none' };

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

        var isChar = !!(RK.isChar && RK.isChar(avatar));
        var tint = 'none';
        var equipment = cloneEquipment(DEFAULT_EQUIPMENT);
        var colors = null;
        if (isChar) {
            colors = cloneColors(input.colors, input.tint);
            tint = colors.base;
            equipment = RK.normalizeCharEquipment ? RK.normalizeCharEquipment(input.equipment) : cloneEquipment(input.equipment);
        }
        var out = { avatar: avatar, tint: tint, equipment: equipment };
        if (isChar) out.colors = colors;
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

    function drawBaseThumb(ctx, a, draft, onReady) {
        ctx.clearRect(0, 0, 72, 80);
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
        function draw() { drawBaseThumb(ctx, a, getDraft && getDraft(), draw); }
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
            var tint = item.tint === false ? 'none' : ((draft.colors && draft.colors[slot]) || draft.tint);
            var colors = item.tint === false ? null : draft.colors;
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
            '.rk-customize-shell{height:100%;max-width:1180px;margin:0 auto;padding:16px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:14px;}',
            '.rk-customize-top{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #202832;padding-bottom:12px;}',
            '.rk-customize-title{font-size:16px;font-weight:700;color:#f0f3f6;overflow-wrap:anywhere;}',
            '.rk-customize-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}',
            '.rk-customize-body{min-height:0;display:grid;grid-template-columns:190px minmax(0,1fr);gap:16px;}',
            '.rk-customize-preview{align-self:start;position:sticky;top:0;border:1px solid #26303b;background:#0b0f14;border-radius:8px;padding:12px;}',
            '.rk-customize-preview canvas{display:block;width:100%;height:auto;image-rendering:pixelated;background:#090c10;border:1px solid #2a313a;border-radius:6px;}',
            '.rk-customize-name{font-size:13px;font-weight:700;color:#f0f3f6;margin-top:10px;overflow-wrap:anywhere;}',
            '.rk-customize-meta{font-size:11px;color:#8b949e;margin-top:4px;overflow-wrap:anywhere;}',
            '.rk-customize-content{min-width:0;overflow:auto;padding-right:4px;}',
            '.rk-customize-section{margin-bottom:18px;}',
            '.rk-customize-section h3{margin:0 0 8px;font-size:12px;line-height:1.2;color:#9aa4b2;font-weight:700;text-transform:uppercase;}',
            '.rk-avatar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;}',
            '.rk-option-card{min-width:0;min-height:112px;border:2px solid #2a313a;border-radius:8px;background:#11161c;color:#c7ccd4;cursor:pointer;padding:7px;font:inherit;font-size:11px;text-align:center;}',
            '.rk-option-card:hover{border-color:#566274;background:#151b22;}',
            '.rk-option-card.is-selected{border-color:#3fb950;box-shadow:0 0 0 1px rgba(63,185,80,.3) inset;}',
            '.rk-option-card.is-locked{opacity:.48;cursor:not-allowed;}',
            '.rk-option-card canvas{max-width:72px;width:100%;height:auto;}',
            '.rk-option-label{margin-top:5px;line-height:1.2;overflow-wrap:anywhere;color:#d0d6de;}',
            '.rk-customize-row{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;align-items:start;margin-bottom:10px;}',
            '.rk-row-label{font-size:12px;color:#9aa4b2;padding-top:9px;overflow-wrap:anywhere;}',
            '.rk-row-options{display:flex;gap:7px;flex-wrap:wrap;min-width:0;}',
            '.rk-swatch,.rk-equip-option{border:2px solid #2a313a;border-radius:8px;background:#11161c;color:#c7ccd4;cursor:pointer;font:inherit;font-size:11px;}',
            '.rk-swatch{width:70px;min-height:58px;padding:6px;}',
            '.rk-equip-option{width:78px;min-height:76px;padding:5px;}',
            '.rk-swatch:hover,.rk-equip-option:hover{border-color:#566274;background:#151b22;}',
            '.rk-swatch.is-selected,.rk-equip-option.is-selected{border-color:#3fb950;box-shadow:0 0 0 1px rgba(63,185,80,.3) inset;}',
            '.rk-swatch-dot{display:block;width:24px;height:24px;margin:0 auto 5px;border-radius:50%;border:1px solid rgba(255,255,255,.35);}',
            '.rk-none-dot{background:linear-gradient(135deg,#171c22 0,#171c22 45%,#9aa4b2 47%,#9aa4b2 53%,#171c22 55%,#171c22 100%);}',
            '.rk-button{font:inherit;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:700;}',
            '.rk-save{border:0;background:#3fb950;color:#071109;}',
            '.rk-cancel{border:1px solid #2a313a;background:#10151b;color:#d7dbe0;}',
            '@media (max-width:760px){.rk-customize-shell{padding:10px;}.rk-customize-top{align-items:flex-start;}.rk-customize-body{grid-template-columns:1fr;overflow:auto;}.rk-customize-content{overflow:visible;padding-right:0;}.rk-customize-preview{position:relative;display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;}.rk-customize-preview canvas{width:96px;}.rk-customize-row{grid-template-columns:1fr;gap:6px;}.rk-row-label{padding-top:0;}.rk-avatar-grid{grid-template-columns:repeat(auto-fill,minmax(84px,1fr));}.rk-option-card{min-height:104px;}.rk-customize-actions{width:100%;justify-content:flex-start;}}'
        ].join('');
        document.head.appendChild(style);
    }

    RK.openCustomize = function (current, onSave) {
        ensureCustomizeStyle();

        var draft = RK.normalizeAppearance(current);
        var redrawers = [];
        var cards = {};

        function isCharDraft() {
            return !!(RK.isChar && RK.isChar(draft.avatar));
        }

        function ensureCharDraft() {
            if (!draft.colors) draft.colors = cloneColors(null, draft.tint);
            if (!draft.equipment) draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
            draft.tint = draft.colors.base;
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

        function renderEditor() {
            editSection.innerHTML = '';
            if (!isCharDraft()) return;
            ensureCharDraft();

            sectionTitle('Color', editSection);
            renderColorRow('Cloth', 'base', 'tint', editSection);
            renderColorRow('Skin', 'skin', 'skin', editSection);
            renderColorRow('Hair', 'hair', 'hair', editSection);

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
                        }, optionTileCanvas(slot, item, draft, null)));
                    })(catalog[id]);
                }
                renderColorRow(slot.charAt(0).toUpperCase() + slot.slice(1) + ' color', slot, 'tint', editSection);
            });
        }

        function selectAvatar(a) {
            if (RK.canUseAppearance && !RK.canUseAppearance(a)) return;
            draft.avatar = a.id;
            if (RK.isChar && RK.isChar(draft.avatar)) {
                ensureCharDraft();
            } else {
                draft.tint = 'none';
                draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
                delete draft.colors;
            }
            mark();
            renderEditor();
            redrawAll();
        }

        RK.appearances().forEach(function (a) {
            var card = document.createElement('button');
            var locked = !!(RK.canUseAppearance && !RK.canUseAppearance(a));
            card.type = 'button';
            card.className = 'rk-option-card' + (locked ? ' is-locked' : '');
            if (locked) card.title = 'Premium pack - buy credits to unlock';
            card.appendChild(thumbCanvas(a, function () { return draft; }, redrawers));
            var lab = document.createElement('div');
            lab.className = 'rk-option-label';
            lab.textContent = a.label + (a.premium ? ' *' : '');
            card.appendChild(lab);
            card.onclick = function () { selectAvatar(a); };
            grid.appendChild(card);
            cards[a.id] = card;
        });

        function drawPreview() {
            pctx.clearRect(0, 0, preview.width, preview.height);
            var base = baseAppearance(draft.avatar);
            if (base.kind === 'color') {
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
                drawBaseThumb(pctx, base, draft, redrawAll);
            }
            previewName.textContent = base.label || base.id;
            previewMeta.textContent = base.premium ? 'Premium pack' : (base.kind === 'char' ? 'Customizable' : 'Free');
        }

        function redrawAll() {
            drawPreview();
            redrawers.forEach(function (fn) { try { fn(); } catch (_) { /* ignore */ } });
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
        mark();
        renderEditor();
        redrawAll();
    };
})(window);
