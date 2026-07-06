// Character customization -- a persistent "appearance identity" the player picks once and carries
// across the tavern (and, next, single-player / PvP / dead-kernel). The saved shape is structured
// so premium character packs can add their own tint/equipment catalogs without changing join flow.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var DEFAULT_EQUIPMENT = { body: 'none', head: 'none', shield: 'none', weapon: 'none' };

    function cloneEquipment(eq) {
        eq = eq || {};
        var out = {};
        var slots = (RK.CHAR_EQUIPMENT_SLOTS || ['body', 'head', 'shield', 'weapon']);
        slots.forEach(function (slot) { out[slot] = eq[slot] || 'none'; });
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
        if (isChar) {
            if (RK.CHAR_TINTS && RK.CHAR_TINTS[input.tint]) tint = input.tint;
            equipment = RK.normalizeCharEquipment ? RK.normalizeCharEquipment(input.equipment) : cloneEquipment(input.equipment);
        }
        return { avatar: avatar, tint: tint, equipment: equipment };
    };

    RK.appearance = function (input) {
        var ap = RK.normalizeAppearance(input);
        var base = baseAppearance(ap.avatar);
        var label = base.label || base.id;
        if (base.kind === 'char' && ap.tint && ap.tint !== 'none' && RK.CHAR_TINTS && RK.CHAR_TINTS[ap.tint]) {
            label += ' / ' + RK.CHAR_TINTS[ap.tint].label;
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
            var ap = RK.normalizeAppearance(draft || { avatar: a.id });
            ap.avatar = a.id;
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
            var tint = item.tint === false ? 'none' : draft.tint;
            if (!RK.drawCharTileCanvas || !RK.drawCharTileCanvas(ctx, item.frame, tint, 2, 2, 48, 48)) {
                RK.loadCharAtlas(draw);
                ctx.fillStyle = '#666'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText('...', 26, 30);
            }
        }
        draw();
        if (redraw) redraw.push(draw);
        return cv;
    }

    RK.openCustomize = function (current, onSave) {
        var draft = RK.normalizeAppearance(current);
        var redrawers = [];

        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;overflow:auto;padding:20px;font-family:ui-monospace,monospace;color:#d7dbe0;';

        var h = document.createElement('div');
        h.textContent = 'Customize your character';
        h.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:12px;';
        wrap.appendChild(h);

        var preview = document.createElement('canvas');
        preview.width = 92; preview.height = 100;
        preview.style.cssText = 'display:block;margin:0 0 14px;image-rendering:pixelated;background:#0a0c0f;border:1px solid #2a313a;border-radius:6px;';
        var pctx = preview.getContext('2d');
        wrap.appendChild(preview);

        var grid = document.createElement('div');
        grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;max-width:820px;';
        var cards = {};
        RK.appearances().forEach(function (a) {
            var card = document.createElement('div');
            var locked = !!(RK.canUseAppearance && !RK.canUseAppearance(a));
            card.style.cssText = 'width:108px;padding:8px;border:2px solid #2a313a;border-radius:8px;background:#0f1216;cursor:pointer;text-align:center;';
            if (locked) card.style.cssText += 'opacity:0.55;';
            if (locked) card.title = 'Premium pack - buy credits to unlock';
            card.appendChild(thumbCanvas(a, function () { return draft; }, redrawers));
            var lab = document.createElement('div');
            lab.textContent = a.label + (a.premium ? ' *' : '');
            lab.style.cssText = 'font-size:11px;margin-top:6px;color:#c7ccd4;';
            card.appendChild(lab);
            card.onclick = function () {
                if (RK.canUseAppearance && !RK.canUseAppearance(a)) return;
                draft.avatar = a.id;
                if (!(RK.isChar && RK.isChar(draft.avatar))) {
                    draft.tint = 'none';
                    draft.equipment = cloneEquipment(DEFAULT_EQUIPMENT);
                }
                mark();
                renderRows();
                redrawAll();
            };
            grid.appendChild(card);
            cards[a.id] = card;
        });
        wrap.appendChild(grid);

        var rows = document.createElement('div');
        rows.style.cssText = 'max-width:820px;margin-top:14px;';
        wrap.appendChild(rows);

        function optionButton(label, selected, onclick, canvas) {
            var b = document.createElement('button');
            b.type = 'button';
            b.style.cssText = 'width:86px;min-height:78px;border:2px solid ' + (selected ? '#3fb950' : '#2a313a') + ';border-radius:6px;background:#0f1216;color:#c7ccd4;cursor:pointer;padding:6px;font:inherit;font-size:11px;';
            if (canvas) b.appendChild(canvas);
            var t = document.createElement('div');
            t.textContent = label;
            b.appendChild(t);
            b.onclick = onclick;
            return b;
        }

        function renderRows() {
            rows.innerHTML = '';
            if (!(RK.isChar && RK.isChar(draft.avatar))) return;

            var tintRow = document.createElement('div');
            tintRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;';
            var tintLabel = document.createElement('div');
            tintLabel.textContent = 'Tint';
            tintLabel.style.cssText = 'width:68px;font-size:12px;color:#8b949e;';
            tintRow.appendChild(tintLabel);
            for (var tid in (RK.CHAR_TINTS || {})) {
                (function (tint) {
                    var sw = document.createElement('span');
                    sw.style.cssText = 'display:block;width:28px;height:28px;margin:2px auto 5px;border-radius:50%;background:' + (tint.color || '#9aa4b2') + ';border:1px solid rgba(255,255,255,0.35);';
                    var b = optionButton(tint.label, draft.tint === tint.id, function () {
                        draft.tint = tint.id;
                        renderRows();
                        redrawAll();
                    }, sw);
                    b.style.minHeight = '64px';
                    tintRow.appendChild(b);
                })(RK.CHAR_TINTS[tid]);
            }
            rows.appendChild(tintRow);

            (RK.CHAR_EQUIPMENT_SLOTS || []).forEach(function (slot) {
                var catalog = RK.CHAR_EQUIPMENT[slot] || {};
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;';
                var label = document.createElement('div');
                label.textContent = slot.charAt(0).toUpperCase() + slot.slice(1);
                label.style.cssText = 'width:68px;font-size:12px;color:#8b949e;';
                row.appendChild(label);
                for (var id in catalog) {
                    (function (item) {
                        row.appendChild(optionButton(item.label, draft.equipment[slot] === item.id, function () {
                            draft.equipment[slot] = item.id;
                            renderRows();
                            redrawAll();
                        }, optionTileCanvas(slot, item, draft, redrawers)));
                    })(catalog[id]);
                }
                rows.appendChild(row);
            });
        }

        function drawPreview() {
            pctx.clearRect(0, 0, preview.width, preview.height);
            var base = baseAppearance(draft.avatar);
            if (base.kind === 'color') {
                pctx.beginPath(); pctx.arc(46, 52, 24, 0, Math.PI * 2);
                pctx.fillStyle = base.color; pctx.fill();
                pctx.lineWidth = 2; pctx.strokeStyle = 'rgba(255,255,255,0.35)'; pctx.stroke();
            } else if (base.kind === 'char') {
                if (!RK.drawCharCompositeCanvas || !RK.drawCharCompositeCanvas(pctx, draft, 6, 8, 80)) RK.loadCharAtlas(redrawAll);
            } else if (base.kind === 'model3d') {
                pctx.beginPath(); pctx.arc(46, 52, 24, 0, Math.PI * 2);
                pctx.fillStyle = '#64748b'; pctx.fill();
                pctx.fillStyle = '#d7dbe0'; pctx.font = '20px monospace'; pctx.textAlign = 'center'; pctx.fillText('3D', 46, 59);
            } else {
                drawBaseThumb(pctx, base, draft, redrawAll);
            }
        }

        function redrawAll() {
            drawPreview();
            redrawers.forEach(function (fn) { try { fn(); } catch (_) { /* ignore */ } });
        }

        function mark() {
            for (var id in cards) cards[id].style.borderColor = (id === draft.avatar) ? '#3fb950' : '#2a313a';
        }

        var bar = document.createElement('div');
        bar.style.cssText = 'margin-top:16px;display:flex;gap:8px;';
        var save = document.createElement('button');
        save.textContent = 'Save';
        save.style.cssText = 'font:inherit;padding:8px 16px;border:0;border-radius:6px;background:#3fb950;color:#08130a;font-weight:600;cursor:pointer;';
        save.onclick = function () {
            var saved = RK.normalizeAppearance(draft);
            RK.saveIdentity(saved);
            document.body.removeChild(wrap);
            if (onSave) onSave(saved);
        };
        var cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'font:inherit;padding:8px 16px;border:1px solid #2a313a;border-radius:6px;background:#0f1216;color:#d7dbe0;cursor:pointer;';
        cancel.onclick = function () { document.body.removeChild(wrap); };
        bar.appendChild(save); bar.appendChild(cancel);
        wrap.appendChild(bar);

        document.body.appendChild(wrap);
        mark();
        renderRows();
        redrawAll();
    };
})(window);
