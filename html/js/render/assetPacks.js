// Themes / packs / entitlement policy for the render kit. Packs are resolved by capability
// (top-down, isometric, 3D) so the same `appearance` identity can render through different
// visual projections without changing Room state or join flow.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    RK.TILE_KINDS = ['floor', 'wall', 'bar', 'table'];
    var FREE_EQUIPMENT = { body: 'none', head: 'none', shield: 'none', weapon: 'none' };
    var FREE_COLORS = { base: 'none', skin: 'natural', hair: 'copper', body: 'none', head: 'none', shield: 'none', weapon: 'none' };

    RK.PACKS = {
        'roguelike-interior': {
            id: 'roguelike-interior',
            label: 'Kenney Roguelike Interior',
            premium: false,
            projection: 'topdown'
        },
        'iso-dungeon': {
            id: 'iso-dungeon',
            label: 'Kenney Isometric Dungeon',
            premium: true,
            projection: 'iso',
            unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
        },
        'kenney-3d-characters': {
            id: 'kenney-3d-characters',
            label: 'Kenney Animated 3D Characters',
            premium: true,
            projection: '3d',
            unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
        },
        'generated-skins': {
            id: 'generated-skins',
            label: 'Premium Generated Skins',
            premium: true,
            projection: 'topdown',
            unlock: { kind: 'credits_purchase', minTotalCreditsPurchased: 1 }
        }
    };

    RK.entitlements = RK.entitlements || { premium: false, level: 'free', packs: {}, credits: 0, totalCreditsPurchased: 0 };

    RK.setEntitlementSnapshot = function (data) {
        data = data || {};
        var prev = RK.entitlements || {};
        var hasTotal = data.totalCreditsPurchased != null || data.total_credits_purchased != null;
        var hasPremium = data.premium != null;
        var hasPacks = !!data.packs;
        var hasCredits = data.credits != null || data.balance != null;
        var total = hasTotal
            ? Number(data.totalCreditsPurchased || data.total_credits_purchased || 0)
            : Number(prev.totalCreditsPurchased || 0);
        var credits = hasCredits
            ? Number(data.credits != null ? data.credits : data.balance)
            : Number(prev.credits || 0);
        var premium = hasPremium ? !!data.premium : (hasTotal ? total > 0 : !!prev.premium);
        var packs = {};
        for (var id in RK.PACKS) {
            var p = RK.PACKS[id];
            if (!p.premium) {
                packs[id] = true;
            } else if (hasPacks && Object.prototype.hasOwnProperty.call(data.packs, id)) {
                packs[id] = !!data.packs[id];
            } else if (!hasTotal && !hasPacks && prev.packs && Object.prototype.hasOwnProperty.call(prev.packs, id)) {
                packs[id] = !!prev.packs[id];
            } else {
                packs[id] = premium;
            }
        }
        for (var pid in packs) {
            if (packs[pid] && RK.PACKS[pid] && RK.PACKS[pid].premium) premium = true;
        }
        RK.entitlements = {
            premium: premium,
            level: data.level || (premium ? ((prev.level && prev.level !== 'free') ? prev.level : 'credits') : 'free'),
            packs: packs,
            credits: credits,
            totalCreditsPurchased: total
        };
        try { localStorage.setItem('rk_entitlements', JSON.stringify(RK.entitlements)); } catch (_) {}
        return RK.entitlements;
    };

    RK.loadEntitlements = function () {
        try {
            var raw = JSON.parse(localStorage.getItem('rk_entitlements') || 'null');
            if (raw) return RK.setEntitlementSnapshot(raw);
        } catch (_) {}
        return RK.entitlements;
    };
    RK.loadEntitlements();

    RK.pack = function (id) { return RK.PACKS[id] || null; };
    RK.canUsePack = function (id) {
        var p = RK.pack(id);
        if (!p) return false;
        if (!p.premium) return true;
        return !!(RK.entitlements && RK.entitlements.packs && RK.entitlements.packs[id]);
    };
    RK.canUseAppearance = function (a) {
        if (!a || !a.premium) return true;
        return a.pack ? RK.canUsePack(a.pack) : !!(RK.entitlements && RK.entitlements.premium);
    };

    RK.THEMES = {
        'roguelike-interior': {
            id: 'roguelike-interior',
            label: 'Kenney Roguelike Interior',
            tileset: { url: 'assets/kenney/roguelikeIndoor.png', tile: 16, spacing: 1 },
            // Defaults are null until mapped via the tile-picker (localStorage overrides win).
            tiles: { floor: null, wall: null, bar: null, table: null }
        }
    };
    RK.activeThemeId = 'roguelike-interior';

    RK.theme = function (id) { return RK.THEMES[id || RK.activeThemeId] || null; };

    // Effective tile map = theme defaults merged with localStorage overrides from the picker.
    RK.tileMap = function (id) {
        var t = RK.theme(id); if (!t) return {};
        var map = {};
        for (var k in t.tiles) map[k] = t.tiles[k];
        try {
            var ov = JSON.parse(localStorage.getItem('rk_tilemap_' + t.id) || '{}');
            for (var kk in ov) map[kk] = ov[kk];
        } catch (_) { /* ignore */ }
        return map;
    };
    RK.setTile = function (id, kind, col, row) {
        var t = RK.theme(id); if (!t) return;
        var key = 'rk_tilemap_' + t.id, ov = {};
        try { ov = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
        ov[kind] = [col, row];
        try { localStorage.setItem(key, JSON.stringify(ov)); } catch (_) {}
    };

    // Lazy tileset atlas per theme.
    var atlases = {};
    RK.themeAtlas = function (id) {
        var t = RK.theme(id); if (!t || !t.tileset) return null;
        if (!atlases[t.id]) {
            atlases[t.id] = new RK.TilesetAtlas(t.tileset.url, { tile: t.tileset.tile, spacing: t.tileset.spacing });
        }
        return atlases[t.id];
    };
    RK.loadTheme = function (id, cb) {
        var a = RK.themeAtlas(id);
        if (!a) { if (cb) cb(null); return; }
        a.onReady(function () { if (cb) cb(a); });
    };

    RK.EXTRA_APPEARANCES = {
        'kenney-survivor-male': {
            id: 'kenney-survivor-male',
            label: 'Survivor',
            kind: 'model3d',
            premium: true,
            pack: 'kenney-3d-characters'
        },
        'kenney-survivor-female': {
            id: 'kenney-survivor-female',
            label: 'Survivor Scout',
            kind: 'model3d',
            premium: true,
            pack: 'kenney-3d-characters'
        }
    };

    function normalizeEquipment(eq) {
        eq = eq || {};
        var out = {};
        for (var k in FREE_EQUIPMENT) out[k] = eq[k] || 'none';
        return out;
    }

    function normalizeColors(colors, tint) {
        if (RK.normalizeCharColors) return RK.normalizeCharColors(colors, tint);
        colors = colors || {};
        var out = {};
        for (var k in FREE_COLORS) out[k] = colors[k] || (k === 'base' ? (tint || FREE_COLORS[k]) : FREE_COLORS[k]);
        return out;
    }

    RK.packAppearances = function () {
        var out = [];
        for (var id in RK.EXTRA_APPEARANCES) out.push(RK.EXTRA_APPEARANCES[id]);
        return out;
    };

    RK.isoAssets = {
        pack: 'iso-dungeon',
        tile: { w: 84, h: 42, imageW: 92, imageH: 184 },
        tiles: {
            floor: 'assets/kenney/iso-dungeon/tiles/stone_S.png',
            wall: 'assets/kenney/iso-dungeon/tiles/stoneWall_S.png',
            bar: 'assets/kenney/iso-dungeon/tiles/barrelsStacked_S.png',
            table: 'assets/kenney/iso-dungeon/tiles/chestClosed_S.png',
            fallback: 'assets/kenney/iso-dungeon/tiles/planks_S.png'
        },
        character: {
            idle: 'assets/kenney/iso-dungeon/characters/male0/Male_0_Idle0.png',
            run: [
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run0.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run1.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run2.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run3.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run4.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run5.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run6.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run7.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run8.png',
                'assets/kenney/iso-dungeon/characters/male0/Male_0_Run9.png'
            ],
            imageW: 74,
            imageH: 148
        }
    };

    RK.threeAssets = {
        pack: 'kenney-3d-characters',
        models: {
            'kenney-survivor-male': {
                url: 'assets/generated/3d/kenney-animated-characters/survivorMaleB.glb',
                clips: { idle: 'idle', run: 'run', jump: 'jump' }
            },
            'kenney-survivor-female': {
                url: 'assets/generated/3d/kenney-animated-characters/survivorFemaleA.glb',
                clips: { idle: 'idle', run: 'run', jump: 'jump' }
            },
            fallback: {
                url: 'assets/generated/3d/kenney-animated-characters/survivorMaleB.glb',
                clips: { idle: 'idle', run: 'run', jump: 'jump' }
            }
        }
    };

    RK.resolveAppearance = function (entity, projection) {
        entity = entity || {};
        var appearance = entity.appearance || { avatar: entity.avatar || 'default', tint: 'none', equipment: FREE_EQUIPMENT };
        var avatar = appearance.avatar || entity.avatar || 'default';
        if (projection === 'iso') {
            return {
                projection: 'iso',
                pack: 'iso-dungeon',
                avatar: avatar,
                tint: appearance.tint || 'none',
                equipment: normalizeEquipment(appearance.equipment),
                colors: normalizeColors(appearance.colors, appearance.tint),
                character: RK.isoAssets.character
            };
        }
        if (projection === '3d') {
            return {
                projection: '3d',
                pack: 'kenney-3d-characters',
                avatar: avatar,
                model: RK.threeAssets.models[avatar] || RK.threeAssets.models.fallback,
                tint: appearance.tint || 'none',
                equipment: normalizeEquipment(appearance.equipment),
                colors: normalizeColors(appearance.colors, appearance.tint)
            };
        }
        return { projection: 'topdown', avatar: avatar, appearance: appearance };
    };
})(window);
