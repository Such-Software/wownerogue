// SinglePlayerAvatar bridges the shared character identity/render kit into the legacy ROT.js
// dungeon display. The dungeon still draws through ROT; this module owns a sprite overlay that
// can be cleared safely back to the classic @ tile whenever assets or identity are unavailable.
(function (root) {
    'use strict';

    var DEFAULT_APPEARANCE = { avatar: 'default', tint: 'none', equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' } };

    function normalize(input) {
        if (root.RK && root.RK.normalizeAppearance) return root.RK.normalizeAppearance(input || DEFAULT_APPEARANCE);
        return DEFAULT_APPEARANCE;
    }

    function baseKind(appearance) {
        if (!appearance || !root.RK) return 'color';
        if (root.RK.isChar && root.RK.isChar(appearance.avatar)) return 'char';
        if (root.RK.isSkin && root.RK.isSkin(appearance.avatar)) return 'skin';
        return 'color';
    }

    function requestGameRedraw() {
        if (root.Game && root.Game._gameActive && root.Game._drawGameScreen) {
            root.Game._drawGameScreen();
        }
    }

    var SinglePlayerAvatar = {
        _appearance: null,
        _overlay: null,
        _ctx: null,
        _lastWorld: null,
        _facing: 'down',
        _loading: {},
        _initialized: false,

        init: function () {
            if (this._initialized) return;
            this._initialized = true;
            var identity = root.RK && root.RK.loadIdentity ? root.RK.loadIdentity() : null;
            this.setAppearance(identity && identity.appearance ? identity.appearance : DEFAULT_APPEARANCE, { save: false, redraw: false });
            this._bindButton();
            this.updateButton();
        },

        _bindButton: function () {
            var self = this;
            var btn = root.document && root.document.getElementById('characterButton');
            if (!btn || btn._rkBound) return;
            btn._rkBound = true;
            btn.addEventListener('click', function () {
                if (!root.RK || !root.RK.openCustomize) return;
                root.RK.openCustomize(self._appearance || DEFAULT_APPEARANCE, function (appearance) {
                    var normalized = normalize(appearance);
                    self.setAppearance(normalized, { save: true, redraw: true });
                    if (root.socket && root.socket.emit) {
                        root.socket.emit('identity:update', { appearance: normalized });
                    }
                });
            });
        },

        setAppearance: function (appearance, opts) {
            opts = opts || {};
            this._appearance = normalize(appearance);
            if (opts.save !== false && root.RK && root.RK.saveIdentity) root.RK.saveIdentity(this._appearance);
            this.updateButton();
            if (opts.redraw !== false) requestGameRedraw();
        },

        applyIdentity: function (data) {
            if (!data) return;
            if (data.entitlements && root.RK && root.RK.setEntitlementSnapshot) {
                root.RK.setEntitlementSnapshot(data.entitlements);
            }
            if (data.appearance) this.setAppearance(data.appearance, { save: true, redraw: true });
            else this.updateButton();
        },

        applyEntitlements: function (data) {
            if (data && root.RK && root.RK.setEntitlementSnapshot) {
                root.RK.setEntitlementSnapshot(data);
                this.updateButton();
            }
        },

        updateButton: function () {
            var btn = root.document && root.document.getElementById('characterButton');
            var label = root.document && root.document.getElementById('characterButtonLabel');
            if (!btn || !label) return;
            if (!root.RK || !root.RK.appearance) {
                label.textContent = 'CHARACTER';
                return;
            }
            var info = root.RK.appearance(this._appearance || DEFAULT_APPEARANCE);
            label.textContent = (info && info.label ? info.label : 'CHARACTER').toUpperCase();
            btn.title = info && info.premium ? 'Premium character' : 'Character';
        },

        _baseCanvas: function () {
            if (!root.DisplayManager || !root.DisplayManager.getDisplay()) return null;
            var display = root.DisplayManager.getDisplay();
            return display && display.getContainer ? display.getContainer() : null;
        },

        _syncOverlay: function () {
            var base = this._baseCanvas();
            var host = root.document && root.document.getElementById('game-display');
            if (!base || !host) return null;

            if (!this._overlay) {
                this._overlay = root.document.createElement('canvas');
                this._overlay.className = 'single-player-avatar-overlay';
                this._overlay.style.position = 'absolute';
                this._overlay.style.pointerEvents = 'none';
                this._overlay.style.zIndex = '6';
                this._overlay.style.imageRendering = 'pixelated';
                host.appendChild(this._overlay);
                this._ctx = this._overlay.getContext('2d');
            }

            if (this._overlay.width !== base.width) this._overlay.width = base.width;
            if (this._overlay.height !== base.height) this._overlay.height = base.height;
            this._overlay.style.left = base.offsetLeft + 'px';
            this._overlay.style.top = base.offsetTop + 'px';
            this._overlay.style.width = base.offsetWidth + 'px';
            this._overlay.style.height = base.offsetHeight + 'px';
            this._overlay.style.display = 'block';
            return this._ctx;
        },

        clearOverlay: function () {
            if (this._ctx && this._overlay) this._ctx.clearRect(0, 0, this._overlay.width, this._overlay.height);
        },

        currentAppearance: function () {
            return this._appearance || normalize(DEFAULT_APPEARANCE);
        },

        _ensureAssets: function (appearance) {
            var kind = baseKind(appearance);
            var self = this;
            if (kind === 'char') {
                if (root.RK.charAtlas && root.RK.charAtlas()) return true;
                if (root.RK.loadCharAtlas && !this._loading.char) {
                    this._loading.char = true;
                    root.RK.loadCharAtlas(function () {
                        self._loading.char = false;
                        requestGameRedraw();
                    });
                }
                return false;
            }
            if (kind === 'skin') {
                if (root.RK.skinSheet && root.RK.skinSheet(appearance.avatar)) return true;
                if (root.RK.loadSkin && !this._loading[appearance.avatar]) {
                    this._loading[appearance.avatar] = true;
                    var rec = root.RK.loadSkin(appearance.avatar);
                    if (rec && rec.cbs) rec.cbs.push(function () {
                        self._loading[appearance.avatar] = false;
                        requestGameRedraw();
                    });
                }
                return false;
            }
            return false;
        },

        canDrawPlayer: function () {
            if (!root.RK) return false;
            var appearance = this.currentAppearance();
            var kind = baseKind(appearance);
            if (kind !== 'char' && kind !== 'skin') return false;
            return this._ensureAssets(appearance);
        },

        _updateFacing: function (player) {
            if (!player) return this._facing;
            if (this._lastWorld) {
                var dx = player.x - this._lastWorld.x;
                var dy = player.y - this._lastWorld.y;
                if (dx < 0) this._facing = 'left';
                else if (dx > 0) this._facing = 'right';
                else if (dy < 0) this._facing = 'up';
                else if (dy > 0) this._facing = 'down';
            }
            this._lastWorld = { x: player.x, y: player.y };
            return this._facing;
        },

        drawPlayer: function (gameState, viewport) {
            if (!gameState || !gameState.player || !viewport || !this.canDrawPlayer()) {
                this.clearOverlay();
                return false;
            }
            var ctx = this._syncOverlay();
            if (!ctx) return false;

            this.clearOverlay();
            var appearance = this.currentAppearance();
            var kind = baseKind(appearance);
            var player = gameState.player;
            var facing = this._updateFacing(player);
            var cell = viewport.cell || (root.options && root.options.tileWidth) || 32;
            var now = Date.now();

            if (kind === 'char') return this._drawChar(ctx, appearance, player, viewport.screenX, viewport.screenY, cell, facing, now);
            if (kind === 'skin') return this._drawSkin(ctx, appearance, player, viewport.screenX, viewport.screenY, cell, facing, now);
            return false;
        },

        _drawChar: function (ctx, appearance, player, sx, sy, cell, facing, now) {
            var ch = root.RK.CHARS && root.RK.CHARS[appearance.avatar];
            if (!ch || !root.RK.charFrame || !root.RK.drawCharTileCanvas) return false;
            var e = { id: 'single-player', x: player.x, y: player.y, facing: facing };
            var frame = root.RK.charFrame(ch, e, now);
            var dw = cell * 1.8;
            var dh = dw * frame.squash;
            var cx = sx * cell + cell / 2;
            var dy = (sy * cell + cell) - dh + frame.bob;
            var ap = root.RK.charAppearance({ avatar: appearance.avatar, appearance: appearance });

            ctx.imageSmoothingEnabled = false;
            function drawComposite(dx, dy2) {
                root.RK.drawCharTileCanvas(ctx, ch.frame, ap.tint, dx, dy2, dw, dh, ap.colors, 'base');
                root.RK.charOverlayParts(ap).forEach(function (part) {
                    root.RK.drawCharTileCanvas(ctx, part.frame, part.tint, dx, dy2, dw, dh, part.colorable ? ap.colors : null, part.slot);
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
        },

        _drawSkin: function (ctx, appearance, player, sx, sy, cell, facing, now) {
            var rec = root.RK.skinSheet && root.RK.skinSheet(appearance.avatar);
            var skin = root.RK.SKINS && root.RK.SKINS[appearance.avatar];
            if (!rec || !skin || !root.RK.skinFrame) return false;
            var e = { id: 'single-player-skin', x: player.x, y: player.y, facing: facing };
            var fr = root.RK.skinFrame(skin, e, now);
            var dh = cell * (skin.scale || 1.7);
            var dw = dh * (skin.frameW / skin.frameH);
            var cx = sx * cell + cell / 2;
            var dx = cx - dw / 2;
            var dy = (sy * cell + cell) - dh;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(rec.img, fr.col * skin.frameW, fr.row * skin.frameH, skin.frameW, skin.frameH, dx, dy, dw, dh);
            return true;
        }
    };

    root.SinglePlayerAvatar = SinglePlayerAvatar;
    if (typeof module !== 'undefined' && module.exports) module.exports = SinglePlayerAvatar;
})(typeof window !== 'undefined' ? window : globalThis);
