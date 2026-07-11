// Pack registry — the engine behind "add more 2D tilesets / iso packs / 3D skins as products".
//
// A PACK is a rich, self-contained render environment for a projection (topdown | iso | 3d). Because
// every scene (tavern OR dungeon) is kind-based (floor/wall/table/torch/monster…), the SAME pack
// renders both — packs are interchangeable across town and dungeon. Each pack maps 1:1 to a catalog
// entry (id/tier/threshold), so it's a monetizable product gated by entitlements.
//
// This module makes packs MULTI (like RK.THEMES already is for topdown) and adds active-pack
// selection per projection. Renderers ask for the active pack's assets; a picker lets an unlocked
// user switch. Adding a pack then = register(def) + drop assets + a catalog row.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    // id -> { id, label, projection: 'topdown'|'iso'|'3d', kind, assets }
    // `assets` is the render-kit payload for that projection (theme tiles / iso set / 3d models).
    RK.PACK_REGISTRY = RK.PACK_REGISTRY || {};

    // Storage: localStorage in the browser, an in-memory map under Node/tests.
    var mem = {};
    function store() {
        try { if (root.localStorage) return root.localStorage; } catch (_) {}
        return { getItem: function (k) { return k in mem ? mem[k] : null; }, setItem: function (k, v) { mem[k] = String(v); } };
    }
    function key(projection) { return 'rk_pack_' + projection; }

    RK.registerPack = function (def) {
        if (!def || !def.id || !def.projection) return null;
        RK.PACK_REGISTRY[def.id] = def;
        return def;
    };
    RK.getPackDef = function (id) { return (id && RK.PACK_REGISTRY[id]) || null; };

    RK.packsForProjection = function (projection) {
        var out = [];
        for (var id in RK.PACK_REGISTRY) {
            if (RK.PACK_REGISTRY[id].projection === projection) out.push(RK.PACK_REGISTRY[id]);
        }
        return out;
    };

    // Packs the user can actually use for a projection (free ones + entitlement-unlocked ones).
    RK.unlockedPacks = function (projection) {
        return RK.packsForProjection(projection).filter(function (p) {
            return !RK.canUsePack || RK.canUsePack(p.id);
        });
    };

    // The user's chosen pack if it's registered for this projection AND unlocked; otherwise the
    // first unlocked pack; otherwise null.
    RK.activePackId = function (projection) {
        var saved = store().getItem(key(projection));
        var def = saved && RK.PACK_REGISTRY[saved];
        if (def && def.projection === projection && (!RK.canUsePack || RK.canUsePack(saved))) return saved;
        var unlocked = RK.unlockedPacks(projection);
        return unlocked.length ? unlocked[0].id : null;
    };

    RK.activePack = function (projection) { return RK.getPackDef(RK.activePackId(projection)); };
    RK.activePackAssets = function (projection) {
        var def = RK.activePack(projection);
        return def ? def.assets : null;
    };

    // Select a pack (persisted per projection). Refused if unregistered or locked. Returns success.
    RK.setActivePack = function (id) {
        var def = RK.getPackDef(id);
        if (!def) return false;
        if (RK.canUsePack && !RK.canUsePack(id)) return false;
        store().setItem(key(def.projection), id);
        return true;
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = RK;
})(typeof window !== 'undefined' ? window : this);
