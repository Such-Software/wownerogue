// SinglePlayerAvatar stores the selected identity for the legacy single-player page and manages
// the overlay canvas used by old ROT.js screens. It delegates visual decisions to RK.avatarVisuals.
(function (root) {
    'use strict';

    var DEFAULT_APPEARANCE = { avatar: 'default', tint: 'none', equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' } };

    function normalize(input) {
        if (root.RK && root.RK.normalizeAppearance) return root.RK.normalizeAppearance(input || DEFAULT_APPEARANCE);
        return DEFAULT_APPEARANCE;
    }

    function requestRedraw() {
        if (root.Game && root.Game._gameActive && root.Game._drawGameScreen) {
            root.Game._drawGameScreen();
        } else if (root.ScreenManager && root.DisplayManager && root.DisplayManager.ensureDisplay && root.DisplayManager.ensureDisplay()) {
            if (root.ScreenManager.isShowingWaitingScreen && root.ScreenManager.isShowingWaitingScreen() && root.ScreenManager.drawWaitingScreen) {
                root.ScreenManager.drawWaitingScreen(true);
            } else if (root.ScreenManager.drawWelcomeScreen) {
                root.ScreenManager.drawWelcomeScreen();
            }
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
                }, { projection: 'topdown' });
            });
        },

        setAppearance: function (appearance, opts) {
            opts = opts || {};
            this._appearance = normalize(appearance);
            if (opts.save !== false && root.RK && root.RK.saveIdentity) root.RK.saveIdentity(this._appearance);
            this.updateButton();
            if (opts.redraw !== false) requestRedraw();
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

        resolveVisual: function (opts) {
            opts = opts || {};
            if (!root.RK || !root.RK.avatarVisuals) {
                return { appearance: this.currentAppearance(), kind: 'legacy', fallbackTile: opts.fallbackTile || '@' };
            }
            return root.RK.avatarVisuals.resolve(this.currentAppearance(), opts);
        },

        _ensureVisual: function (visual) {
            if (!root.RK || !root.RK.avatarVisuals || !visual || !visual.canvas) return false;
            return root.RK.avatarVisuals.ensureCanvasReady(visual, requestRedraw);
        },

        canDrawPlayer: function () {
            return this._ensureVisual(this.resolveVisual({ projection: 'legacy-rot', context: 'dungeon-player' }));
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
            var visual = this.resolveVisual({ projection: 'legacy-rot', context: 'dungeon-player' });
            if (!gameState || !gameState.player || !viewport || !this._ensureVisual(visual)) {
                this.clearOverlay();
                return false;
            }
            var ctx = this._syncOverlay();
            if (!ctx) return false;

            this.clearOverlay();
            var player = gameState.player;
            var facing = this._updateFacing(player);
            var drew = root.RK.avatarVisuals.drawTopdownWorld(ctx, visual, {
                id: 'single-player',
                x: player.x,
                y: player.y,
                facing: facing
            }, viewport, { onReady: requestRedraw });
            // After the avatar is drawn, sync the overlay FX layer to the same base
            // canvas and let its warm torch light track the player cell. Fully guarded:
            // no-op when the FX module is absent.
            this._syncFX(viewport);
            return drew;
        },

        // Attach/sync the FX overlay to the same base canvas used by the avatar overlay
        // (mirrors _syncOverlay's sizing) and drive the torch light at the player cell.
        _syncFX: function (viewport) {
            if (!root.FX || !viewport) return;
            var base = this._baseCanvas();
            if (!base) return;
            try {
                root.FX.attach(base);
                var cell = viewport.cell || (root.options && root.options.tileWidth) || 32;
                var px = viewport.screenX * cell + cell / 2;
                var py = viewport.screenY * cell + cell / 2;
                root.FX.renderLighting(px, py, cell);
            } catch (_) { /* FX is purely additive — never let it break the avatar */ }
        },

        drawLegendIcon: function (tileX, tileY, opts) {
            opts = opts || {};
            var visual = this.resolveVisual({ projection: 'legacy-rot', context: 'legend', fallbackTile: opts.fallbackTile || '@2' });
            if (!this._ensureVisual(visual)) return false;
            var ctx = this._syncOverlay();
            if (!ctx || !root.RK || !root.RK.avatarVisuals) return false;
            var cell = opts.cell || (root.options && root.options.tileWidth) || 32;
            var cols = opts.cols || 2;
            return root.RK.avatarVisuals.drawIcon(ctx, visual, {
                x: tileX * cell,
                y: tileY * cell,
                w: cols * cell,
                h: cell
            }, {
                context: 'legend',
                scale: 0.78,
                offsetY: Math.max(1, Math.round(cell * 0.08)),
                onReady: requestRedraw
            });
        }
    };

    root.SinglePlayerAvatar = SinglePlayerAvatar;
    if (typeof module !== 'undefined' && module.exports) module.exports = SinglePlayerAvatar;
})(typeof window !== 'undefined' ? window : globalThis);
