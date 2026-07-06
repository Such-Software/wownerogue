// AvatarVisuals is the render-kit resolver for turning a saved appearance identity into a
// drawable visual for a specific projection/context. Legacy ROT screens can use fallback tiles;
// canvas-capable renderers can draw the same identity as a composed character or premium skin.
(function (root) {
    'use strict';

    var RK = root.RK = root.RK || {};
    var DEFAULT_EQUIPMENT = { body: 'none', head: 'none', shield: 'none', weapon: 'none' };
    var DEFAULT_APPEARANCE = { avatar: 'default', tint: 'none', equipment: DEFAULT_EQUIPMENT };
    var loading = {};

    function normalize(appearance) {
        if (RK.normalizeAppearance) return RK.normalizeAppearance(appearance || DEFAULT_APPEARANCE);
        return DEFAULT_APPEARANCE;
    }

    function topdownPackFor(appearance, kind) {
        if (kind === 'skin') {
            var skin = RK.SKINS && RK.SKINS[appearance.avatar];
            return (skin && skin.pack) || 'generated-skins';
        }
        if (kind === 'model3d') return 'kenney-3d-characters';
        return 'roguelike-interior';
    }

    function kindFor(appearance, projection) {
        if (!appearance) return 'legacy';
        if (projection === 'iso') return 'iso';
        if (projection === '3d') return 'model3d';
        if (RK.isChar && RK.isChar(appearance.avatar)) return 'char';
        if (RK.isSkin && RK.isSkin(appearance.avatar)) return 'skin';
        if (appearance.avatar && /^kenney-/.test(appearance.avatar)) return 'model3d';
        return 'legacy';
    }

    function fallbackTile(opts) {
        opts = opts || {};
        if (opts.fallbackTile) return opts.fallbackTile;
        if (root.GameTiles && root.GameTiles.getPlayerTile) return root.GameTiles.getPlayerTile();
        return '@';
    }

    function labelFor(appearance) {
        if (RK.appearance) {
            var info = RK.appearance(appearance);
            if (info && info.label) return info.label;
        }
        return 'Character';
    }

    function packFor(appearance, kind, projection) {
        if (projection === 'iso') return 'iso-dungeon';
        if (projection === '3d') return 'kenney-3d-characters';
        return topdownPackFor(appearance, kind);
    }

    function canUsePack(id) {
        return !id || !RK.canUsePack || RK.canUsePack(id);
    }

    function isoCharacterFor(appearance) {
        var assets = RK.isoAssets || {};
        var chars = assets.characters || {};
        return chars[appearance.avatar] || chars.fallback || assets.character || null;
    }

    function modelFor(appearance) {
        var assets = RK.threeAssets || {};
        var models = assets.models || {};
        return models[appearance.avatar] || models.fallback || null;
    }

    function resolve(appearance, opts) {
        opts = opts || {};
        var ap = normalize(appearance);
        var projection = opts.projection || 'legacy-rot';
        var kind = kindFor(ap, projection);
        var pack = packFor(ap, kind, projection);
        var visual = {
            appearance: ap,
            kind: kind,
            projection: projection,
            context: opts.context || 'player',
            label: labelFor(ap),
            pack: pack,
            allowed: canUsePack(pack),
            fallbackTile: fallbackTile(opts),
            canvas: kind === 'char' || kind === 'skin',
            entity: opts.entity || null
        };
        if (projection === 'iso') {
            visual.assets = RK.isoAssets || null;
            visual.character = isoCharacterFor(ap);
            visual.canvas = false;
        } else if (projection === '3d') {
            visual.assets = RK.threeAssets || null;
            visual.model = modelFor(ap);
            visual.canvas = false;
            visual.three = true;
        }
        return visual;
    }

    function rememberLoad(key, start, onReady) {
        if (loading[key]) {
            if (onReady) loading[key].push(onReady);
            return;
        }
        loading[key] = onReady ? [onReady] : [];
        start(function () {
            var cbs = loading[key] || [];
            delete loading[key];
            cbs.forEach(function (cb) { try { cb(); } catch (_) { /* ignore */ } });
        });
    }

    function ensureCanvasReady(visual, onReady) {
        visual = visual && visual.appearance ? visual : resolve(visual);
        if (!visual.allowed) return false;
        if (visual.kind === 'char') {
            if (RK.charAtlas && RK.charAtlas()) return true;
            if (!RK.loadCharAtlas) return false;
            rememberLoad('char-atlas', function (done) { RK.loadCharAtlas(done); }, onReady);
            return false;
        }
        if (visual.kind === 'skin') {
            if (RK.skinSheet && RK.skinSheet(visual.appearance.avatar)) return true;
            if (!RK.loadSkin) return false;
            rememberLoad('skin:' + visual.appearance.avatar, function (done) {
                var rec = RK.loadSkin(visual.appearance.avatar);
                if (rec && rec.cbs) rec.cbs.push(done);
            }, onReady);
            return false;
        }
        return false;
    }

    function drawCharIcon(ctx, visual, x, y, size) {
        if (!RK.drawCharCompositeCanvas) return false;
        return RK.drawCharCompositeCanvas(ctx, visual.appearance, x, y, size);
    }

    function drawSkinIcon(ctx, visual, x, y, size) {
        var rec = RK.skinSheet && RK.skinSheet(visual.appearance.avatar);
        var skin = RK.SKINS && RK.SKINS[visual.appearance.avatar];
        if (!rec || !skin) return false;
        var row = (skin.dirRows && skin.dirRows.down) || 0;
        var dh = size;
        var dw = dh * (skin.frameW / skin.frameH);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(rec.img, 0, row * skin.frameH, skin.frameW, skin.frameH, x + (size - dw) / 2, y, dw, dh);
        return true;
    }

    function drawIcon(ctx, visual, rect, opts) {
        opts = opts || {};
        visual = visual && visual.appearance ? visual : resolve(visual, opts);
        if (!ctx || !rect || !ensureCanvasReady(visual, opts.onReady)) return false;
        var size = Math.min(rect.w || rect.size || 32, rect.h || rect.size || 32);
        var x = rect.x + Math.max(0, ((rect.w || size) - size) / 2);
        var y = rect.y + Math.max(0, ((rect.h || size) - size) / 2);
        ctx.clearRect(rect.x, rect.y, rect.w || size, rect.h || size);
        if (visual.kind === 'char') return drawCharIcon(ctx, visual, x, y, size);
        if (visual.kind === 'skin') return drawSkinIcon(ctx, visual, x, y, size);
        return false;
    }

    function drawTopdownChar(ctx, visual, entity, viewport, opts) {
        opts = opts || {};
        var ch = RK.CHARS && RK.CHARS[visual.appearance.avatar];
        if (!ch || !RK.charFrame || !RK.drawCharTileCanvas) return false;
        var cell = viewport.cell || 32;
        var e = {
            id: entity.id || 'avatar',
            x: entity.x || 0,
            y: entity.y || 0,
            facing: entity.facing || 'down'
        };
        var frame = RK.charFrame(ch, e, opts.now || Date.now());
        var dw = cell * (opts.scale || 1.8);
        var dh = dw * frame.squash;
        var cx = viewport.screenX * cell + cell / 2;
        var dy = (viewport.screenY * cell + cell) - dh + frame.bob;
        var ap = RK.charAppearance({ avatar: visual.appearance.avatar, appearance: visual.appearance });

        ctx.imageSmoothingEnabled = false;
        if (entity.you) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cx, viewport.screenY * cell + cell - 2, dw * 0.3, cell * 0.16, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        function drawComposite(dx, dy2) {
            RK.drawCharTileCanvas(ctx, ch.frame, ap.tint, dx, dy2, dw, dh, ap.colors, 'base');
            RK.charOverlayParts(ap).forEach(function (part) {
                RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy2, dw, dh, part.colorable ? ap.colors : null, part.slot);
            });
        }
        if (frame.flip) {
            ctx.save();
            ctx.translate(cx + dw / 2, dy);
            ctx.scale(-1, 1);
            drawComposite(0, 0);
            ctx.restore();
        } else {
            drawComposite(cx - dw / 2, dy);
        }
        if (entity.label) {
            ctx.fillStyle = '#d7dbe0';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(entity.label, cx, dy - 2);
        }
        return true;
    }

    function drawTopdownSkin(ctx, visual, entity, viewport, opts) {
        opts = opts || {};
        var rec = RK.skinSheet && RK.skinSheet(visual.appearance.avatar);
        var skin = RK.SKINS && RK.SKINS[visual.appearance.avatar];
        if (!rec || !skin || !RK.skinFrame) return false;
        var cell = viewport.cell || 32;
        var e = {
            id: entity.id || 'avatar-skin',
            x: entity.x || 0,
            y: entity.y || 0,
            facing: entity.facing || 'down'
        };
        var frame = RK.skinFrame(skin, e, opts.now || Date.now());
        var dh = cell * (skin.scale || 1.7);
        var dw = dh * (skin.frameW / skin.frameH);
        var cx = viewport.screenX * cell + cell / 2;
        var dx = cx - dw / 2;
        var dy = (viewport.screenY * cell + cell) - dh;
        ctx.imageSmoothingEnabled = true;
        var midY = dy + dh * 0.45;
        var halo = ctx.createRadialGradient(cx, midY, 0, cx, midY, dw * 0.8);
        halo.addColorStop(0, 'rgba(255,226,180,0.30)');
        halo.addColorStop(1, 'rgba(255,226,180,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(cx, midY, dw * 0.8, 0, Math.PI * 2);
        ctx.fill();
        if (entity.you) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cx, viewport.screenY * cell + cell - 2, dw * 0.3, cell * 0.16, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.drawImage(rec.img, frame.col * skin.frameW, frame.row * skin.frameH, skin.frameW, skin.frameH, dx, dy, dw, dh);
        if (entity.label) {
            ctx.fillStyle = '#d7dbe0';
            ctx.font = '11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(entity.label, cx, dy - 2);
        }
        return true;
    }

    function drawTopdownWorld(ctx, visual, entity, viewport, opts) {
        opts = opts || {};
        visual = visual && visual.appearance ? visual : resolve(visual, opts);
        if (!ctx || !entity || !viewport || !visual.allowed || !ensureCanvasReady(visual, opts.onReady)) return false;
        if (visual.kind === 'char') return drawTopdownChar(ctx, visual, entity, viewport, opts);
        if (visual.kind === 'skin') return drawTopdownSkin(ctx, visual, entity, viewport, opts);
        return false;
    }

    RK.avatarVisuals = {
        DEFAULT_APPEARANCE: DEFAULT_APPEARANCE,
        normalize: normalize,
        kindFor: kindFor,
        resolve: resolve,
        ensureCanvasReady: ensureCanvasReady,
        drawIcon: drawIcon,
        drawTopdownWorld: drawTopdownWorld
    };
    RK.resolveAvatarVisual = resolve;
})(window);
