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

    function kindFor(appearance) {
        if (!appearance) return 'legacy';
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

    function resolve(appearance, opts) {
        opts = opts || {};
        var ap = normalize(appearance);
        var kind = kindFor(ap);
        return {
            appearance: ap,
            kind: kind,
            projection: opts.projection || 'legacy-rot',
            context: opts.context || 'player',
            label: labelFor(ap),
            fallbackTile: fallbackTile(opts),
            canvas: kind === 'char' || kind === 'skin'
        };
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
        ctx.drawImage(rec.img, frame.col * skin.frameW, frame.row * skin.frameH, skin.frameW, skin.frameH, dx, dy, dw, dh);
        return true;
    }

    function drawTopdownWorld(ctx, visual, entity, viewport, opts) {
        opts = opts || {};
        visual = visual && visual.appearance ? visual : resolve(visual, opts);
        if (!ctx || !entity || !viewport || !ensureCanvasReady(visual, opts.onReady)) return false;
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
