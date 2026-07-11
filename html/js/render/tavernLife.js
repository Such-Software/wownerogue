// TavernLife — client-side NPCs (bartender, patrons, cat) + speech bubbles that make the
// tavern feel alive. NPCs are decorative: they wander, sit, and chat. They're client-side
// only (no server round-trips), so each client sees its own lively room — the real players
// come from the server snapshot. Speech bubbles pop above any occupant (NPC or real player)
// when they speak.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    // roundRect polyfill for older browsers.
    if (!root.CanvasRenderingContext2D.prototype.roundRect) {
        root.CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            if (w < 2 * r) r = w / 2;
            if (h < 2 * r) r = h / 2;
            this.beginPath();
            this.moveTo(x + r, y);
            this.arcTo(x + w, y, x + w, y + h, r);
            this.arcTo(x + w, y + h, x, y + h, r);
            this.arcTo(x, y + h, x, y, r);
            this.arcTo(x, y, x + w, y, r);
            this.closePath();
            return this;
        };
    }

    // ---- Speech lines -----------------------------------------------------------
    var BARTENDER_LINES = [
        "What'll it be, traveler?", "Ale's fresh today.", "Tab's full, friend.",
        "Watch the monsters out there.", "Block's coming — hurry back.",
        "I've seen braver than you not return.", "House special: liquid courage.",
        "No credit — coin on the barrel.", "Heard someone found treasure last block.",
        "The dungeon's hungry tonight.", "Keep your wits about you.", "One ale, coming up."
    ];
    var PATRON_LINES = [
        "Another round!", "I almost made it out...", "The dungeon claims another.",
        "Heard someone found the bag!", "Cheers!", "This ale is questionable.",
        "Anyone seen my shield?", "Last time I swear it was right there...",
        "The monster was RIGHT behind me.", "Need more credits...", "One more run.",
        "I used to be an adventurer too.", "Bloody hell, that was close.", "Pour me another.",
        "You new here?", "Don't go in unprepared.", "The exit was so close..."
    ];
    var CAT_LINES = ["meow", "mrrrow", "prrrrp", "hisss", "...", "mew"];
    var WELCOME_LINES = ["Welcome!", "Pull up a stool.", "New face — nice.", "Come in, sit down."];

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    // ---- NPC definitions --------------------------------------------------------
    // NPCs are identified by a prefix so they don't collide with real socket ids.
    var NPC_PREFIX = 'npc:';

    function makeNPC(id, kind, avatar, x, y, opts) {
        opts = opts || {};
        return {
            id: NPC_PREFIX + id,
            kind: kind,
            avatar: avatar,
            appearance: { avatar: avatar, tint: 'none', equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' } },
            x: x, y: y, facing: 'down',
            targetX: x, targetY: y,
            moveCooldown: 0,
            sitTimer: 0,
            speechTimer: 0,
            speech: null, speechUntil: 0,
            color: opts.color || '#d7dbe0',
            label: opts.label || null,
            role: opts.role || 'patron',
            roamArea: opts.roamArea || null
        };
    }

    function bartendersArea(cols, rows) {
        // Behind the bar: the row between the top wall and the counter (y=1). Sealed off by the
        // counter, so the bartender stays back there and never wanders onto the customer floor.
        return { minY: 1, maxY: 1, minX: 3, maxX: Math.max(5, cols - 5) };
    }
    function patronsArea(cols, rows) {
        // Patrons roam the middle/lower floor.
        return { minY: 3, maxY: rows - 2, minX: 1, maxX: cols - 2 };
    }
    function catArea(cols, rows) {
        return { minY: 1, maxY: rows - 1, minX: 1, maxX: cols - 2 };
    }

    // ---- Speech bubbles ---------------------------------------------------------
    var BUBBLE_FONT = '12px ui-monospace, Menlo, Consolas, monospace';
    var BUBBLE_PADDING = 8;
    var BUBBLE_RADIUS = 6;
    var BUBBLE_TAIL = 7;
    var BUBBLE_DURATION = 4200;
    var BUBBLE_FADE = 500;

    function measureBubble(ctx, text) {
        ctx.font = BUBBLE_FONT;
        var metrics = ctx.measureText(text);
        var w = Math.ceil(metrics.width) + BUBBLE_PADDING * 2;
        var h = 22 + BUBBLE_PADDING * 2;
        return { w: w, h: h };
    }

    function drawBubble(ctx, x, y, text, alpha) {
        if (alpha <= 0 || !text) return;
        var dim = measureBubble(ctx, text);
        var bw = dim.w, bh = dim.h;
        // Clamp so the bubble stays on screen.
        var bx = Math.max(4, Math.min(x - bw / 2, ctx.canvas.width - bw - 4));
        var by = y - bh - BUBBLE_TAIL;
        if (by < 4) by = y + BUBBLE_TAIL + 4; // flip below if no room above

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = BUBBLE_FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        // Bubble body (rounded rect).
        ctx.fillStyle = 'rgba(18,24,32,0.94)';
        ctx.strokeStyle = 'rgba(120,140,165,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, BUBBLE_RADIUS);
        ctx.fill();
        ctx.stroke();

        // Tail pointer.
        var tailX = Math.max(bx + 12, Math.min(x, bx + bw - 12));
        ctx.fillStyle = 'rgba(18,24,32,0.94)';
        ctx.beginPath();
        ctx.moveTo(tailX - 5, by + bh);
        ctx.lineTo(tailX + 5, by + bh);
        ctx.lineTo(tailX, by + bh + (by < y ? BUBBLE_TAIL : -BUBBLE_TAIL));
        ctx.closePath();
        ctx.fill();

        // Text.
        ctx.fillStyle = '#e8edf3';
        ctx.fillText(text, bx + bw / 2, by + bh / 2);
        ctx.restore();
    }

    // ---- The TavernLife controller ----------------------------------------------
    function TavernLife(host, getScene, getCell) {
        this.host = host;
        this.getScene = getScene;
        this.getCell = getCell || function () { return 24; };
        this.npcs = [];
        this.bubbles = {};      // occupantId -> { text, until, born }
        this._overlay = null;
        this._octx = null;
        this._raf = null;
        this._lastTick = 0;
        this._spawned = false;
        this._realBubbles = {}; // socketId -> { text, until } from real chat
    }

    TavernLife.prototype._ensureOverlay = function () {
        if (this._overlay && this._overlay.parentNode) return this._octx;
        var cv = root.document.createElement('canvas');
        cv.className = 'tavern-life-overlay';
        cv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;';
        this.host.style.position = this.host.style.position || 'relative';
        this.host.appendChild(cv);
        this._overlay = cv;
        this._octx = cv.getContext('2d');
        return this._octx;
    };

    TavernLife.prototype._syncOverlaySize = function (w, h) {
        var ctx = this._ensureOverlay();
        if (!ctx) return;
        if (this._overlay.width !== w) this._overlay.width = w;
        if (this._overlay.height !== h) this._overlay.height = h;
        return ctx;
    };

    TavernLife.prototype.spawn = function () {
        if (this._spawned) return;
        this._spawned = true;
        var scene = this.getScene();
        if (!scene) return;
        var cols = scene.cols, rows = scene.rows;
        var grid = scene.grid;

        // Find walkable tiles for spawning.
        function isFloor(x, y) {
            return y >= 0 && y < rows && x >= 0 && x < cols && grid[y] && grid[y][x] === 'floor';
        }
        function findFloor(cx, cy) {
            for (var r = 1; r < 8; r++) {
                for (var dy = -r; dy <= r; dy++) {
                    for (var dx = -r; dx <= r; dx++) {
                        var x = cx + dx, y = cy + dy;
                        if (isFloor(x, y)) return { x: x, y: y };
                    }
                }
            }
            return { x: 1, y: 1 };
        }

        // Bartender BEHIND the bar (row 1, between the top wall and the counter).
        var barSpot = findFloor(Math.floor(cols / 2), 1);
        var bartender = makeNPC('bartender', 'bartender', 'char-merchant', barSpot.x, barSpot.y, {
            label: 'Bartender', color: '#c9a25e', role: 'bartender',
            roamArea: bartendersArea(cols, rows)
        });
        this.npcs.push(bartender);

        // 2-3 patrons near tables (middle area).
        var patronAvatars = ['char-villager', 'char-elder', 'char-bard', 'char-wizard', 'char-ranger', 'char-rogue'];
        var patronColors = ['#7eb6c9', '#c9a0d4', '#a0c97e', '#d4b0a0', '#8fa0d4'];
        var numPatrons = 2 + Math.floor(Math.random() * 2);
        for (var i = 0; i < numPatrons; i++) {
            var px = 4 + Math.floor(Math.random() * (cols - 8));
            var py = 5 + Math.floor(Math.random() * (rows - 8));
            var spot = findFloor(px, py);
            this.npcs.push(makeNPC('patron' + i, 'patron', patronAvatars[i % patronAvatars.length],
                spot.x, spot.y, {
                    label: 'Patron', color: patronColors[i % patronColors.length],
                    roamArea: patronsArea(cols, rows),
                    sitTimer: 2000 + Math.random() * 4000
                }));
        }

        // (No "cat": it used the char-goblin sprite, which read as a green monster stuck in the
        // wall. Left out until there's an actual pet/critter sprite.)
    };

    TavernLife.prototype._pickTarget = function (npc, scene) {
        var area = npc.roamArea;
        if (!area) return;
        var grid = scene.grid;
        var cols = scene.cols, rows = scene.rows;
        for (var tries = 0; tries < 12; tries++) {
            var tx = area.minX + Math.floor(Math.random() * (area.maxX - area.minX + 1));
            var ty = area.minY + Math.floor(Math.random() * (area.maxY - area.minY + 1));
            if (ty >= 0 && ty < rows && tx >= 0 && tx < cols && grid[ty] && grid[ty][tx] === 'floor') {
                npc.targetX = tx;
                npc.targetY = ty;
                return;
            }
        }
    };

    TavernLife.prototype._moveNPC = function (npc, scene, dt) {
        if (npc.sitTimer > 0) {
            npc.sitTimer -= dt;
            return;
        }
        npc.moveCooldown -= dt;
        if (npc.moveCooldown > 0) return;

        // Arrived at target?
        if (npc.x === npc.targetX && npc.y === npc.targetY) {
            var sitTime = npc.role === 'cat' ? 1000 + Math.random() * 2000 : 3000 + Math.random() * 5000;
            npc.sitTimer = sitTime;
            this._pickTarget(npc, scene);
            return;
        }

        // Step toward target (one tile, cardinal only).
        var dx = npc.targetX - npc.x;
        var dy = npc.targetY - npc.y;
        var stepX = 0, stepY = 0;
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) stepX = Math.sign(dx);
        else if (dy !== 0) stepY = Math.sign(dy);
        else if (dx !== 0) stepX = Math.sign(dx);

        var nx = npc.x + stepX, ny = npc.y + stepY;
        var grid = scene.grid;
        if (ny >= 0 && ny < scene.rows && nx >= 0 && nx < scene.cols && grid[ny] && grid[ny][nx] === 'floor') {
            npc.x = nx; npc.y = ny;
            if (stepX < 0) npc.facing = 'left';
            else if (stepX > 0) npc.facing = 'right';
            else if (stepY < 0) npc.facing = 'up';
            else if (stepY > 0) npc.facing = 'down';
        } else {
            // Blocked — pick a new target.
            this._pickTarget(npc, scene);
        }
        // Cat moves faster; bartender slower.
        npc.moveCooldown = npc.role === 'cat' ? 280 : npc.role === 'bartender' ? 500 : 380;
    };

    TavernLife.prototype._maybeSpeak = function (npc, now) {
        if (npc.speech && now < npc.speechUntil) return;
        npc.speechTimer -= 16;
        if (npc.speechTimer > 0) return;
        var lines;
        if (npc.role === 'bartender') lines = BARTENDER_LINES;
        else if (npc.role === 'cat') lines = CAT_LINES;
        else lines = PATRON_LINES;
        npc.speech = pick(lines);
        npc.speechUntil = now + BUBBLE_DURATION;
        npc.speechTimer = 8000 + Math.random() * 12000; // next speech gap
        if (npc.role === 'cat') npc.speechTimer = 6000 + Math.random() * 10000;
    };

    // Inject NPC entities into a scene so the renderer draws them.
    TavernLife.prototype.injectInto = function (scene) {
        if (!scene || !this._spawned) return scene;
        if (!scene._npcInjected) {
            for (var i = 0; i < this.npcs.length; i++) {
                var npc = this.npcs[i];
                scene.entities.push({
                    id: npc.id,
                    x: npc.x, y: npc.y,
                    kind: 'avatar',
                    avatar: npc.avatar,
                    appearance: npc.appearance,
                    color: npc.color,
                    char: npc.role === 'cat' ? 'c' : '@',
                    facing: npc.facing,
                    label: npc.label,
                    you: false,
                    _npc: true
                });
            }
            scene._npcInjected = true;
        }
        return scene;
    };

    // Show a speech bubble for a real player (called on chat_broadcast).
    TavernLife.prototype.showPlayerBubble = function (socketId, text) {
        this._realBubbles[socketId] = { text: text, until: Date.now() + BUBBLE_DURATION };
    };

    // Get the screen position of an entity for a given renderer/cell size.
    // This is renderer-agnostic: top-down uses grid coords * cell; iso uses projection.
    TavernLife.prototype._entityScreenPos = function (e, scene, cell, mode) {
        if (mode === 'iso') {
            // Match IsoRenderer._project: originX = margin + rows * tileW/2 + tileW; originY = margin + imageH
            var tileW = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.w) || 84;
            var tileH = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.h) || 42;
            var imageH = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.imageH) || 184;
            var margin = 28;
            var originX = margin + scene.rows * tileW / 2 + tileW;
            var originY = margin + imageH;
            return {
                x: originX + (e.x - e.y) * tileW / 2,
                y: originY + (e.x + e.y) * tileH / 2
            };
        }
        if (mode === '3d') {
            // 3D renderer uses Three.js — we can't easily get screen coords.
            // Skip speech bubbles for 3D mode.
            return null;
        }
        // top-down / ascii / fancy: grid coords * cell
        return { x: e.x * cell + cell / 2, y: e.y * cell + cell / 2 };
    };

    TavernLife.prototype._drawBubbles = function (scene, cell, mode, now) {
        var ctx = this._octx;
        if (!ctx || !scene) return;
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height);

        // NPC bubbles.
        for (var i = 0; i < this.npcs.length; i++) {
            var npc = this.npcs[i];
            if (!npc.speech || now >= npc.speechUntil) continue;
            var alpha = 1;
            var remaining = npc.speechUntil - now;
            if (remaining < BUBBLE_FADE) alpha = remaining / BUBBLE_FADE;
            var pos = this._entityScreenPos(npc, scene, cell, mode);
            if (pos) drawBubble(ctx, pos.x, pos.y - cell * 0.3, npc.speech, alpha);
        }

        // Real player bubbles (from chat).
        var occupants = scene.entities;
        for (var j = 0; j < occupants.length; j++) {
            var e = occupants[j];
            if (e._npc) continue;
            var bubble = this._realBubbles[e.id];
            if (!bubble || now >= bubble.until) {
                if (bubble) delete this._realBubbles[e.id];
                continue;
            }
            var rAlpha = 1;
            var rRemaining = bubble.until - now;
            if (rRemaining < BUBBLE_FADE) rAlpha = rRemaining / BUBBLE_FADE;
            var rPos = this._entityScreenPos(e, scene, cell, mode);
            if (rPos) drawBubble(ctx, rPos.x, rPos.y - cell * 0.3, bubble.text, rAlpha);
        }
    };

    // Main update — called every frame via rAF.
    TavernLife.prototype.update = function (scene, cell, mode) {
        if (!scene || !this._spawned) return;
        var now = Date.now();
        var dt = now - (this._lastTick || now);
        this._lastTick = now;

        // Update NPC movement and speech.
        for (var i = 0; i < this.npcs.length; i++) {
            this._moveNPC(this.npcs[i], scene, dt);
            this._maybeSpeak(this.npcs[i], now);
        }

        // Update NPC entity positions in the scene.
        for (var j = 0; j < this.npcs.length; j++) {
            var npc = this.npcs[j];
            for (var k = 0; k < scene.entities.length; k++) {
                if (scene.entities[k].id === npc.id) {
                    scene.entities[k].x = npc.x;
                    scene.entities[k].y = npc.y;
                    scene.entities[k].facing = npc.facing;
                    break;
                }
            }
        }

        // Draw speech bubbles on the overlay.
        var rendererCanvas = this.host.querySelector('.rk-canvas');
        if (rendererCanvas) {
            this._syncOverlaySize(rendererCanvas.width, rendererCanvas.height);
        }
        this._drawBubbles(scene, cell, mode, now);
    };

    TavernLife.prototype.start = function () {
        var self = this;
        function loop() {
            var scene = self.getScene();
            if (scene) {
                var cell = self.getCell();
                // Re-inject NPCs if the scene was rebuilt.
                if (!scene._npcInjected) self.injectInto(scene);
                self.update(scene, cell, self._mode || 'tiles');
            }
            self._raf = root.requestAnimationFrame(loop);
        }
        this._raf = root.requestAnimationFrame(loop);
    };

    TavernLife.prototype.setMode = function (mode) { this._mode = mode; };

    TavernLife.prototype.stop = function () {
        if (this._raf) root.cancelAnimationFrame(this._raf);
        this._raf = null;
        if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
        this._overlay = null;
        this._octx = null;
    };

    TavernLife.prototype.welcomeBubbles = function () {
        // Make the bartender greet when the player joins.
        if (this.npcs.length > 0 && this.npcs[0].role === 'bartender') {
            var now = Date.now();
            this.npcs[0].speech = pick(WELCOME_LINES);
            this.npcs[0].speechUntil = now + BUBBLE_DURATION;
            this.npcs[0].speechTimer = 5000;
        }
    };

    RK.TavernLife = TavernLife;
})(window);
