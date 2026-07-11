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

        // Consume the server-authoritative catalog (migration 024). This retires the hardcoded
        // client pack list as the source of truth: operator-added packs appear, and existing packs
        // pick up server definitions (label/projection/tier). Merged (not replaced) so any client
        // fallback a render mode relies on is preserved if the operator's catalog omits it.
        if (Array.isArray(data.catalog) && data.catalog.length) {
            var merged = {};
            for (var k in RK.PACKS) merged[k] = RK.PACKS[k];
            for (var ci = 0; ci < data.catalog.length; ci++) {
                var c = data.catalog[ci];
                if (!c || !c.id) continue;
                var ex = merged[c.id] || {};
                merged[c.id] = {
                    id: c.id,
                    label: c.label || ex.label || c.id,
                    premium: c.premium != null ? !!c.premium : !!ex.premium,
                    projection: c.projection || ex.projection || null,
                    tier: c.tier != null ? c.tier : ex.tier,
                    unlockMinCredits: c.unlockMinCredits != null ? c.unlockMinCredits : ex.unlockMinCredits,
                    unlock: ex.unlock
                };
            }
            RK.PACKS = merged;
        }
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
        // Production QA switch: when enabled, all premium packs are available for testing.
        if (RK.renderModeTestUnlocks && RK.renderModeTestUnlocks()) return true;
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
            tileset: { url: 'assets/kenney/roguelikeSheet.png', tile: 16, spacing: 1 },
            // Default tile picks from the sheet metadata ( roguelikeSheet_meta.json).
            // The tile-picker overlay can override these per-user via localStorage.
            // Each kind maps to a single [col,row] on the sheet (cols = 57). Per-cell "variant"
            // arrays were tried but mixing wood/stone/plank tiles per cell read as noise, so we
            // keep one coherent tile per kind. (TileRenderer still accepts an array here if a
            // future theme wants subtle, same-material variation.)
            tiles: {
                floor: [5, 2],      // 119 — wood floor
                floor2: [6, 2],     // 120 — stone floor (accent)
                wall: [13, 12],     // 697 — stone masonry
                // Tavern furnishings (coords from roguelikeSheet_meta.json labels: index -> [i%57, i/57]).
                window: [42, 2],    // 156 — window (in the wall)
                bar: [29, 0],       // 29  — bar counter
                keg: [23, 0],       // 23  — barrel / beer keg (behind the bar)
                shelf: [30, 1],     // 87  — shelf of bottles (behind the bar)
                table: [20, 3],     // 191 — table (191 reads wooden; 312 rendered green)
                chair: [19, 3],     // 190 — chair
                barrel: [23, 0],    // 23  — barrel (decor)
                crate: [25, 0],     // 25  — crate (decor)
                rug: [11, 16],      // 923 — rug
                door: [37, 9],      // 550 — door
                // Dungeon features drawn as real tiles instead of monospace glyphs.
                entrance: [37, 9],  // 550 — door
                exit: [37, 9],      // 550 — door
                treasure: [42, 15], // 897 — item
                torch: [50, 10]     // 620 — rubble / prop
            }
        },
        // Second topdown pack — same sheet, a DUNGEON palette (stone floors, barrels/crates instead
        // of the wood-interior furniture). A distinct look with zero new assets, and it's the
        // "interchangeable dungeon" style (the tiled renderer's lighting/shadows are the built-in FX).
        'roguelike-dungeon': {
            id: 'roguelike-dungeon',
            label: 'Roguelike Dungeon',
            tileset: { url: 'assets/kenney/roguelikeSheet.png', tile: 16, spacing: 1 },
            fx: true,
            tiles: {
                floor: [6, 2],      // 120 — stone floor
                floor2: [13, 17],   // 982 — plank accent
                wall: [13, 12],     // 697 — masonry
                window: [42, 2],    // 156 — window
                bar: [23, 0],       // barrels (a dungeon has no bar)
                keg: [23, 0],
                shelf: [25, 0],     // crate
                table: [25, 0],     // crate as a table
                chair: [23, 0],     // barrel as a stool
                barrel: [23, 0],
                crate: [25, 0],
                rug: [6, 2],        // stone (no rug)
                door: [37, 9],
                entrance: [37, 9], exit: [37, 9], treasure: [42, 15], torch: [50, 10]
            }
        }
    };
    RK.activeThemeId = 'roguelike-interior';

    RK.theme = function (id) {
        // With no explicit id, use the active topdown pack (registry-selected + entitlement-gated).
        if (!id && RK.activePackId) {
            var ap = RK.activePackId('topdown');
            if (ap && RK.THEMES[ap]) return RK.THEMES[ap];
        }
        return RK.THEMES[id || RK.activeThemeId] || null;
    };

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

    function isoMale(n) {
        var base = 'assets/kenney/iso-dungeon/characters/male' + n + '/Male_' + n + '_';
        var run = [];
        for (var i = 0; i < 10; i++) run.push(base + 'Run' + i + '.png');
        return {
            idle: base + 'Idle0.png',
            run: run,
            imageW: 48,
            imageH: 92
        };
    }

    RK.isoAssets = {
        pack: 'iso-dungeon',
        avatar: 'char-villager',
        tile: { w: 84, h: 42, imageW: 92, imageH: 184 },
        tiles: {
            // Floors / ground
            floor:  'assets/kenney/iso-dungeon/tiles/planks_S.png',     // wood — tavern interior
            floor2: 'assets/kenney/iso-dungeon/tiles/stone_S.png',      // stone — dungeon
            dirt:   'assets/kenney/iso-dungeon/tiles/dirt_S.png',
            rug:    'assets/kenney/iso-dungeon/tiles/planks_S.png',
            // Architecture (full-height tiles). Iso walls have a facing: a wall running along the
            // grid-x axis needs the _S rotation, one running along grid-y needs the perpendicular
            // _W rotation, and true corners get the corner tile. The renderer picks per-cell from
            // neighbours, choosing `<kind>Y` for y-running segments (that's what fixes the "thin
            // slabs" look on the top-left / bottom-right edges).
            wall:    'assets/kenney/iso-dungeon/tiles/stoneWall_S.png',
            wallY:   'assets/kenney/iso-dungeon/tiles/stoneWall_W.png',
            wallCorner: 'assets/kenney/iso-dungeon/tiles/stoneWallCorner_S.png',
            window:  'assets/kenney/iso-dungeon/tiles/stoneWallWindow_S.png',
            windowY: 'assets/kenney/iso-dungeon/tiles/stoneWallWindow_W.png',
            door:    'assets/kenney/iso-dungeon/tiles/stoneWallDoorOpen_S.png',
            doorY:   'assets/kenney/iso-dungeon/tiles/stoneWallDoorOpen_W.png',
            archway: 'assets/kenney/iso-dungeon/tiles/stoneWallArchway_S.png',
            // Floor variety — the renderer sprinkles these deterministically so the ground isn't a
            // flat sea of identical planks.
            floorAlt:  'assets/kenney/iso-dungeon/tiles/planksBroken_S.png',
            floor2Alt: 'assets/kenney/iso-dungeon/tiles/stoneUneven_S.png',
            stoneTile: 'assets/kenney/iso-dungeon/tiles/stoneTile_S.png',
            column: 'assets/kenney/iso-dungeon/tiles/stoneColumnWood_S.png',
            stairs: 'assets/kenney/iso-dungeon/tiles/stairs_S.png',
            // Furniture props (drawn over a floor base) — each kind now has distinct art.
            bar:    'assets/kenney/iso-dungeon/tiles/barrelsStacked_S.png',   // stacked barrels = the bar counter
            keg:    'assets/kenney/iso-dungeon/tiles/barrel_S.png',
            barrel: 'assets/kenney/iso-dungeon/tiles/barrel_S.png',
            table:  'assets/kenney/iso-dungeon/tiles/tableShortChairs_S.png', // real table + chairs
            shelf:  'assets/kenney/iso-dungeon/tiles/woodenCrates_S.png',
            crate:  'assets/kenney/iso-dungeon/tiles/woodenCrate_S.png',
            chair:  'assets/kenney/iso-dungeon/tiles/chair_S.png',
            chest:  'assets/kenney/iso-dungeon/tiles/chestClosed_S.png',
            fallback: 'assets/kenney/iso-dungeon/tiles/planks_S.png'
        },
        // The Kenney files named Male_0..Male_7 are directional renders of the same body,
        // not different character classes. The customizer exposes one honest Iso body for now.
        // These sprites are angled CLOCKWISE from NE: 0=NE, 2=SE, 4=SW, 6=NW (verified against live
        // movement). In this iso projection a grid step moves visually up->NE, down->SW, left->NW,
        // right->SE, so each facing uses the sprite pointing that way — face the way you move.
        character: isoMale(3),          // idle faces roughly toward the camera (S)
        directions: {
            up:    isoMale(0),   // NE (up-right)
            down:  isoMale(4),   // SW (down-left)
            left:  isoMale(6),   // NW (up-left)
            right: isoMale(2)    // SE (down-right)
        },
        characters: {
            fallback: isoMale(3),
            'char-villager': isoMale(3)
        }
    };

    // Second iso pack — Kenney Isometric Medieval Town (a coherent, DIFFERENT environment). Strong on
    // architecture (floor/walls/door/window/banner); no medieval furniture at this scale, so furniture
    // kinds fall back to floor for now. Reuses the dungeon-pack characters. Its tiles are shorter
    // (210x244) than the dungeon set, so its own tile geometry.
    RK.isoMedievalAssets = {
        pack: 'iso-medieval',
        avatar: 'char-villager',
        tile: { w: 84, h: 42, imageW: 84, imageH: 98 },
        tiles: {
            floor:  'assets/kenney/iso-medieval/floor.png',
            floor2: 'assets/kenney/iso-medieval/floor2.png',
            wall:   'assets/kenney/iso-medieval/wall.png',
            window: 'assets/kenney/iso-medieval/window.png',
            door:   'assets/kenney/iso-medieval/door.png',
            banner: 'assets/kenney/iso-medieval/banner.png',
            fallback: 'assets/kenney/iso-medieval/floor.png'
        },
        character: RK.isoAssets.character,
        directions: RK.isoAssets.directions,
        characters: RK.isoAssets.characters
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

    // Register the built-in RENDER packs in the pack registry (packRegistry.js) so iso/3D become
    // multi-pack like topdown themes already are. Each maps to its catalog id; the active pack per
    // projection is entitlement-gated + user-selectable. Adding a pack later = registerPack(...) +
    // assets + a catalog row. Backward-compatible: one pack per projection resolves to these.
    if (RK.registerPack) {
        RK.registerPack({ id: 'roguelike-interior', label: 'Roguelike Interior', projection: 'topdown', kind: 'tiles', assets: RK.THEMES['roguelike-interior'] });
        RK.registerPack({ id: 'roguelike-dungeon', label: 'Roguelike Dungeon', projection: 'topdown', kind: 'tiles', assets: RK.THEMES['roguelike-dungeon'] });
        RK.registerPack({ id: 'iso-dungeon', label: 'Isometric Dungeon', projection: 'iso', kind: 'tiles', assets: RK.isoAssets });
        RK.registerPack({ id: 'iso-medieval', label: 'Medieval Town', projection: 'iso', kind: 'tiles', assets: RK.isoMedievalAssets });
        RK.registerPack({ id: 'kenney-3d-characters', label: 'Animated 3D', projection: '3d', kind: 'skin', assets: RK.threeAssets });
    }
    // Active-pack resolvers the renderers read (fall back to the single default if the registry is absent).
    RK.activeIsoAssets = function () { return (RK.activePackAssets && RK.activePackAssets('iso')) || RK.isoAssets; };
    RK.activeThreeAssets = function () { return (RK.activePackAssets && RK.activePackAssets('3d')) || RK.threeAssets; };

    RK.packForProjection = function (projection) {
        for (var id in RK.PACKS) {
            if (RK.PACKS[id].projection === projection) return RK.PACKS[id];
        }
        return null;
    };

    RK.resolveAppearance = function (entity, projection) {
        entity = entity || {};
        var baseAppearance = entity.appearance || { avatar: entity.avatar || 'default', tint: 'none', equipment: FREE_EQUIPMENT };
        if (RK.avatarVisuals && RK.avatarVisuals.resolve) {
            return RK.avatarVisuals.resolve(baseAppearance, {
                projection: projection || 'topdown',
                context: 'room-entity',
                entity: entity
            });
        }
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
