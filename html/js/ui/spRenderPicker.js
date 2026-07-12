// Homepage render picker — render mode (Tiled / ASCII / Iso / 3D) + tile-pack selector for the
// single-player dungeon, gated by entitlements. Free players see Tiled(Original) + ASCII; the credit
// ladder unlocks the richer packs, iso, and 3D. Rebuilds itself whenever entitlements change.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    function doc() { return root.document; }
    function host() { return doc() && doc().getElementById('renderPicker'); }

    function projForMode(mode) {
        if (mode === 'iso') return 'iso';
        if (mode === '3d') return '3d';
        if (mode === 'ascii') return null; // glyphs consume no tile pack
        return 'topdown';
    }

    function ensureStyle() {
        if (doc().getElementById('rp-style')) return;
        var s = doc().createElement('style');
        s.id = 'rp-style';
        s.textContent =
            '#renderPicker{margin-top:6px;display:flex;flex-direction:column;gap:4px;}' +
            '#renderPicker .rp-row{display:flex;gap:4px;flex-wrap:wrap;}' +
            '#renderPicker .rp-btn{font:inherit;font-size:11px;padding:3px 8px;border:1px solid #2a313a;' +
            'border-radius:4px;background:#0a0c0f;color:#d7dbe0;cursor:pointer;}' +
            '#renderPicker .rp-btn.active{background:#3fb950;color:#08130a;border-color:#3fb950;font-weight:600;}' +
            '#renderPicker .rp-btn.locked{opacity:.5;cursor:not-allowed;}' +
            '#renderPicker .rp-pack{font-size:10px;padding:2px 7px;}';
        doc().head.appendChild(s);
    }

    // Disabled until the single-player render-kit path (RK.SPGame) has a camera + entity sprites.
    // Keeping the module wired so re-enabling is a one-line flip.
    var ENABLED = false;

    function build() {
        var h = host();
        if (!ENABLED) { if (h) h.classList.add('hidden'); return; }
        if (!h || !RK.RENDER_MODES || !RK.SPGame) return;
        ensureStyle();
        h.innerHTML = '';
        h.classList.remove('hidden');

        var current = RK.SPGame.mode ? RK.SPGame.mode() : 'tiles';

        var modeRow = doc().createElement('div');
        modeRow.className = 'rp-row';
        RK.RENDER_MODES.forEach(function (m) {
            var usable = !RK.canUseMode || RK.canUseMode(m.id);
            var b = doc().createElement('button');
            b.className = 'rp-btn' + (m.id === current ? ' active' : '') + (usable ? '' : ' locked');
            b.textContent = m.label + (m.premium && !usable ? ' 🔒' : '');
            b.title = usable ? m.label : (m.label + ' — unlock with credits');
            b.onclick = function () {
                if (!usable) return;
                if (RK.SPGame.setMode(m.id)) build();
            };
            modeRow.appendChild(b);
        });
        h.appendChild(modeRow);

        // Pack row — only when the current projection has more than one UNLOCKED pack to pick from.
        var proj = projForMode(current);
        var packs = (proj && RK.unlockedPacks) ? RK.unlockedPacks(proj) : [];
        if (packs.length > 1) {
            var activeId = RK.activePackId ? RK.activePackId(proj) : null;
            var packRow = doc().createElement('div');
            packRow.className = 'rp-row';
            packs.forEach(function (p) {
                var b = doc().createElement('button');
                b.className = 'rp-btn rp-pack' + (p.id === activeId ? ' active' : '');
                b.textContent = p.label || p.id;
                b.onclick = function () {
                    if (RK.setActivePack && RK.setActivePack(p.id)) {
                        if (RK.SPGame.refreshPack) RK.SPGame.refreshPack();
                        build();
                    }
                };
                packRow.appendChild(b);
            });
            h.appendChild(packRow);
        }
    }

    RK.rebuildRenderPicker = build;
    if (doc()) doc().addEventListener('DOMContentLoaded', function () { try { build(); } catch (_) {} });
})(typeof window !== 'undefined' ? window : this);
