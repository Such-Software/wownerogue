// TavernLife: client-side NPCs (bartender, patrons, cat) + speech bubbles that make the
// tavern feel alive. NPCs are decorative: they wander, sit, and chat. They're client-side
// only (no server round-trips), so each client sees its own lively room; the real players
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
        "Watch the monsters out there.", "Block's coming, hurry back.",
        "I've seen braver than you not return.", "House special: liquid courage.",
        "No credit: coin on the barrel.", "Heard someone found treasure last block.",
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
    var WELCOME_LINES = ["Welcome!", "Pull up a stool.", "New face, nice.", "Come in, sit down."];

    function pick(arr, random) { return arr[Math.floor((random || Math.random)() * arr.length)]; }
    function between(random, min, max) { return min + random() * (max - min); }

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
            homeX: x, homeY: y,
            targetX: x, targetY: y,
            moveCooldown: 0,
            phase: opts.phase || 'idle',
            phaseUntil: opts.phaseUntil || 0,
            speechTimer: opts.speechTimer == null ? 1800 : opts.speechTimer,
            speech: null, speechUntil: 0,
            color: opts.color || '#d7dbe0',
            label: opts.label || null,
            role: opts.role || 'patron',
            roleArea: opts.roleArea || null,
            serviceStops: opts.serviceStops || null,
            serviceIndex: opts.serviceIndex || 0,
            excursionTarget: null
        };
    }

    var CARDINAL_STEPS = [
        { x: 0, y: -1, facing: 'up' },
        { x: -1, y: 0, facing: 'left' },
        { x: 1, y: 0, facing: 'right' },
        { x: 0, y: 1, facing: 'down' }
    ];

    function tileAt(scene, x, y) {
        if (!scene || x < 0 || y < 0 || x >= scene.cols || y >= scene.rows || !scene.grid || !scene.grid[y]) return null;
        return scene.grid[y][x];
    }

    function isWalkable(scene, x, y) {
        var tile = tileAt(scene, x, y);
        if (tile == null) return false;
        var definition = scene.legend && scene.legend[tile];
        if (definition && typeof definition.solid === 'boolean') return !definition.solid;
        return tile === 'floor' || tile === 'chair' || tile === 'door' || tile === 'rug';
    }

    function cellsFor(scene, predicate) {
        var cells = [];
        for (var y = 0; y < scene.rows; y++) {
            for (var x = 0; x < scene.cols; x++) {
                if (predicate(x, y, tileAt(scene, x, y))) cells.push({ x: x, y: y });
            }
        }
        return cells;
    }

    function semanticBarArea(scene) {
        var best = null;
        for (var y = 0; y < scene.rows; y++) {
            var x = 0;
            while (x < scene.cols) {
                if (tileAt(scene, x, y) !== 'bar') { x++; continue; }
                var start = x;
                while (x + 1 < scene.cols && tileAt(scene, x + 1, y) === 'bar') x++;
                var end = x;
                if (end > start && y > 0) {
                    var candidate = { minX: start + 1, maxX: end - 1, minY: y - 1, maxY: y - 1, counterY: y };
                    var lane = cellsFor(scene, function (cx, cy) {
                        return cx >= candidate.minX && cx <= candidate.maxX && cy === candidate.minY
                            && tileAt(scene, cx, cy) === 'floor';
                    });
                    if (lane.length && (!best || end - start > best.length)) {
                        best = { area: candidate, length: end - start, cells: lane };
                    }
                }
                x++;
            }
        }
        return best;
    }

    function semanticTablesAndSeats(scene) {
        var tables = cellsFor(scene, function (x, y, tile) { return tile === 'table'; });
        var pairs = [];
        for (var i = 0; i < tables.length; i++) {
            var table = tables[i];
            var seat = { x: table.x, y: table.y + 1 };
            if (tileAt(scene, seat.x, seat.y) === 'chair') pairs.push({ table: table, seat: seat });
        }
        return pairs;
    }

    function tableServiceStops(scene, tables) {
        var stops = [];
        for (var i = 0; i < tables.length; i++) {
            var table = tables[i].table;
            var candidates = [
                { x: table.x, y: table.y - 1 },
                { x: table.x - 1, y: table.y },
                { x: table.x + 1, y: table.y }
            ];
            for (var j = 0; j < candidates.length; j++) {
                var point = candidates[j];
                if (!isWalkable(scene, point.x, point.y) || tileAt(scene, point.x, point.y) !== 'floor') continue;
                if (!stops.some(function (existing) { return existing.x === point.x && existing.y === point.y; })) {
                    stops.push(point);
                    break;
                }
            }
        }
        return stops;
    }

    // ---- Speech bubbles ---------------------------------------------------------
    var BUBBLE_FONT = '12px ui-monospace, Menlo, Consolas, monospace';
    var BUBBLE_PADDING = 8;
    var BUBBLE_RADIUS = 6;
    var BUBBLE_TAIL = 7;
    var BUBBLE_DURATION = 4200;
    var BUBBLE_FADE = 500;

    function measureBubble(ctx, text) {
        var key = ctx.canvas.width + ':' + ctx.canvas.height + ':' + text;
        var cache = ctx._tavernBubbleLayouts || (ctx._tavernBubbleLayouts = new Map());
        if (cache.has(key)) return cache.get(key);
        ctx.font = BUBBLE_FONT;
        var lineHeight = 16;
        var width = Math.max(1, Math.min(320, ctx.canvas.width - 8) - BUBBLE_PADDING * 2);
        var lines = [], current = '';
        Array.from(text).forEach(function (letter) {
            if (letter === '\n') { lines.push(current); current = ''; return; }
            if (current && ctx.measureText(current + letter).width > width) {
                lines.push(current); current = '';
            }
            current += letter;
        });
        if (current || !lines.length) lines.push(current);
        var maxLines = Math.max(1, Math.floor((ctx.canvas.height - 8 - BUBBLE_PADDING * 2) / lineHeight));
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            var last = lines.pop();
            while (last && ctx.measureText(last + '…').width > width) last = Array.from(last).slice(0, -1).join('');
            lines.push(last + '…');
        }
        var widest = Math.max.apply(null, lines.map(function (line) { return ctx.measureText(line).width; }));
        var layout = { w: Math.min(width, Math.ceil(widest)) + BUBBLE_PADDING * 2,
            h: lines.length * lineHeight + BUBBLE_PADDING * 2, lines: lines, lineHeight: lineHeight };
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(key, layout);
        return layout;
    }

    function drawBubble(ctx, x, y, text, alpha) {
        if (alpha <= 0 || !text || x < 0 || y < 0 || x > ctx.canvas.width || y > ctx.canvas.height) return;
        var dim = measureBubble(ctx, text);
        var bw = dim.w, bh = dim.h;
        var bx = Math.max(4, Math.min(x - bw / 2, ctx.canvas.width - bw - 4));
        var by = y - bh - BUBBLE_TAIL;
        if (by < 4) by = y + BUBBLE_TAIL + 4;
        by = Math.max(4, Math.min(by, ctx.canvas.height - bh - 4));
        var above = by + bh <= y;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = BUBBLE_FONT;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(18,24,32,0.94)';
        ctx.strokeStyle = 'rgba(120,140,165,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, BUBBLE_RADIUS);
        ctx.fill();
        ctx.stroke();

        var tailX = Math.max(bx + 5, Math.min(x, bx + bw - 5));
        var edgeY = above ? by + bh : by;
        ctx.beginPath();
        ctx.moveTo(tailX - 5, edgeY);
        ctx.lineTo(tailX + 5, edgeY);
        ctx.lineTo(tailX, edgeY + (above ? BUBBLE_TAIL : -BUBBLE_TAIL));
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#e8edf3';
        dim.lines.forEach(function (line, index) {
            ctx.fillText(line, bx + BUBBLE_PADDING,
                by + BUBBLE_PADDING + dim.lineHeight * (index + 0.5));
        });
        ctx.restore();
    }

    // ---- The TavernLife controller ----------------------------------------------
    function TavernLife(host, getScene, getCell, options) {
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
        this._realBubbles = Object.create(null); // socketId -> { text, until } from real chat
        options = options || {};
        this._now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
        this._random = typeof options.random === 'function' ? options.random : function () { return Math.random(); };
        this._projectEntityHead = typeof options.projectEntityHead === 'function' ? options.projectEntityHead : null;
        this._barCells = [];
        this._excursionOwner = null;
        this._nextExcursionAt = 0;
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
        var scene = this.getScene();
        if (!scene || !scene.grid || !scene.cols || !scene.rows) return;

        // A designed room is opt-in for ambient actors. Without both semantic bar and
        // table/chair structure, do not invent coordinates or fall back onto arbitrary floor.
        var bar = semanticBarArea(scene);
        var tablePairs = semanticTablesAndSeats(scene);
        if (!bar || !tablePairs.length) return;

        var now = this._now();
        this._barCells = bar.cells;
        var barStart = bar.cells[Math.floor(bar.cells.length / 2)];
        var bartender = makeNPC('bartender', 'bartender', 'char-merchant', barStart.x, barStart.y, {
            label: 'Barkeep', color: '#c9a25e', role: 'bartender', roleArea: bar.area,
            phase: 'stationed', phaseUntil: now + between(this._random, 9000, 17000),
            speechTimer: between(this._random, 9000, 17000)
        });
        bartender.barCells = bar.cells;
        this.npcs.push(bartender);

        // Four guests begin on actual chairs below actual tables. Their seats are stable
        // home coordinates, not random floor tiles that merely look like sitting.
        var patronAvatars = ['char-villager', 'char-elder', 'char-bard', 'char-wizard', 'char-ranger', 'char-rogue'];
        var patronColors = ['#7eb6c9', '#c9a0d4', '#a0c97e', '#d4b0a0', '#8fa0d4'];
        var desiredPatrons = Math.min(4, tablePairs.length);
        var selectedSeats = [];
        for (var p = 0; p < desiredPatrons; p++) {
            var seatIndex = desiredPatrons === 1 ? 0 : Math.floor(p * (tablePairs.length - 1) / (desiredPatrons - 1));
            var pair = tablePairs[seatIndex];
            if (selectedSeats.some(function (seat) { return seat.x === pair.seat.x && seat.y === pair.seat.y; })) continue;
            selectedSeats.push(pair.seat);
            this.npcs.push(makeNPC('patron' + p, 'patron', patronAvatars[p % patronAvatars.length], pair.seat.x, pair.seat.y, {
                label: 'Patron', color: patronColors[p % patronColors.length],
                role: 'patron', roleArea: { minX: 1, maxX: scene.cols - 2, minY: 3, maxY: scene.rows - 2 },
                phase: 'seated', phaseUntil: now + between(this._random, 90000, 180000),
                speechTimer: between(this._random, 9000, 22000)
            }));
        }

        // The server-authoritative layout supplies table waypoints. The server remains
        // unaware of these client-only decorative actors.
        var stops = tableServiceStops(scene, tablePairs);
        if (stops.length) {
            var waitressStart = stops[0];
            var waitress = makeNPC('waitress', 'waitress', 'char-villager', waitressStart.x, waitressStart.y, {
                label: 'Waitress', color: '#e1c17a', role: 'waitress',
                roleArea: { minX: 1, maxX: scene.cols - 2, minY: 3, maxY: scene.rows - 2 },
                serviceStops: stops, serviceIndex: 0,
                phase: 'serving', phaseUntil: now + between(this._random, 4500, 7000),
                speechTimer: between(this._random, 14000, 26000)
            });
            this.npcs.push(waitress);
        }

        // Keep the existing cat, but give it long rests and short paths so it reads as
        // occasional background life instead of another continuously roaming guest.
        var catCells = cellsFor(scene, function (x, y, tile) {
            return tile === 'floor' && x > 1 && x < scene.cols - 2 && y >= 4 && y < scene.rows - 2;
        }).filter(function (point) { return !this._occupiedByOther(null, point.x, point.y); }, this);
        if (catCells.length) {
            var catSpot = catCells[Math.floor(this._random() * catCells.length)];
            var cat = makeNPC('cat', 'cat', null, catSpot.x, catSpot.y, {
                label: null, color: '#e8a060', role: 'cat',
                roleArea: { minX: 2, maxX: scene.cols - 3, minY: 4, maxY: scene.rows - 3 },
                phase: 'resting', phaseUntil: now + between(this._random, 9000, 17000),
                speechTimer: between(this._random, 18000, 30000)
            });
            cat.catSprite = (RK.randomCatId ? RK.randomCatId() : 'cat3');
            this.npcs.push(cat);
        }
        this._spawned = true;
    };

    TavernLife.prototype._isRoleCell = function (npc, scene, x, y) {
        if (!isWalkable(scene, x, y)) return false;
        var area = npc.roleArea;
        if (area && (x < area.minX || x > area.maxX || y < area.minY || y > area.maxY)) return false;
        if (npc.role === 'patron') {
            return Math.abs(x - npc.homeX) + Math.abs(y - npc.homeY) <= 3;
        }
        if (npc.role === 'bartender') return tileAt(scene, x, y) === 'floor';
        if (npc.role === 'waitress') return tileAt(scene, x, y) === 'floor';
        if (npc.role === 'cat') return tileAt(scene, x, y) === 'floor';
        return false;
    };

    TavernLife.prototype._occupiedByOther = function (npc, x, y) {
        return this.npcs.some(function (other) {
            return other !== npc && other.x === x && other.y === y;
        });
    };

    TavernLife.prototype._findPath = function (npc, scene, target) {
        if (!target || !this._isRoleCell(npc, scene, target.x, target.y) || this._occupiedByOther(npc, target.x, target.y)) return null;
        if (npc.x === target.x && npc.y === target.y) return [];
        var startKey = npc.x + ',' + npc.y;
        var queue = [{ x: npc.x, y: npc.y }];
        var visited = new Set([startKey]);
        var previous = new Map();
        while (queue.length) {
            var point = queue.shift();
            for (var i = 0; i < CARDINAL_STEPS.length; i++) {
                var step = CARDINAL_STEPS[i];
                var nx = point.x + step.x, ny = point.y + step.y;
                var key = nx + ',' + ny;
                if (visited.has(key) || !this._isRoleCell(npc, scene, nx, ny) || this._occupiedByOther(npc, nx, ny)) continue;
                visited.add(key);
                previous.set(key, { from: point.x + ',' + point.y, step: step });
                if (nx === target.x && ny === target.y) {
                    var path = [];
                    var cursor = key;
                    while (cursor !== startKey) {
                        var entry = previous.get(cursor);
                        var parts = cursor.split(',');
                        path.unshift({ x: Number(parts[0]), y: Number(parts[1]), facing: entry.step.facing });
                        cursor = entry.from;
                    }
                    return path;
                }
                queue.push({ x: nx, y: ny });
            }
        }
        return null;
    };

    TavernLife.prototype._setTarget = function (npc, target) {
        if (!target) return false;
        npc.targetX = target.x;
        npc.targetY = target.y;
        return true;
    };

    TavernLife.prototype._stepTowardTarget = function (npc, scene, dt) {
        if (npc.x === npc.targetX && npc.y === npc.targetY) return true;
        npc.moveCooldown = Math.max(0, npc.moveCooldown - dt);
        if (npc.moveCooldown > 0) return false;
        var path = this._findPath(npc, scene, { x: npc.targetX, y: npc.targetY });
        if (!path || !path.length) return false;
        var next = path[0];
        // Recheck immediately before moving: actors may have changed occupancy this frame.
        if (!this._isRoleCell(npc, scene, next.x, next.y) || this._occupiedByOther(npc, next.x, next.y)) return false;
        npc.x = next.x;
        npc.y = next.y;
        npc.facing = next.facing;
        npc.moveCooldown = npc.role === 'waitress' ? 850 : npc.role === 'bartender' ? 1200 : npc.role === 'cat' ? 1400 : 1000;
        return npc.x === npc.targetX && npc.y === npc.targetY;
    };

    TavernLife.prototype._startPatronExcursion = function (npc, scene, now) {
        var candidates = cellsFor(scene, function (x, y, tile) {
            return tile === 'floor' && Math.abs(x - npc.homeX) + Math.abs(y - npc.homeY) > 0 &&
                Math.abs(x - npc.homeX) + Math.abs(y - npc.homeY) <= 3 &&
                x > 1 && x < scene.cols - 2 && y >= 3 && y < scene.rows - 2;
        });
        var reachable = candidates.filter(function (point) {
            return !this._occupiedByOther(npc, point.x, point.y) && !!this._findPath(npc, scene, point);
        }, this);
        if (!reachable.length) {
            npc.phaseUntil = now + between(this._random, 30000, 50000);
            return false;
        }
        var target = reachable[Math.floor(this._random() * reachable.length)];
        npc.excursionTarget = target;
        npc.phase = 'outbound';
        npc.phaseUntil = 0;
        this._setTarget(npc, target);
        this._excursionOwner = npc.id;
        return true;
    };

    TavernLife.prototype._updatePatron = function (npc, scene, now) {
        if (npc.phase === 'seated') {
            if (now >= npc.phaseUntil && !this._excursionOwner && now >= this._nextExcursionAt) {
                this._startPatronExcursion(npc, scene, now);
            }
            return;
        }
        if (npc.phase === 'outbound' && npc.x === npc.targetX && npc.y === npc.targetY) {
            npc.phase = 'pausing';
            npc.phaseUntil = now + between(this._random, 2500, 5000);
        } else if (npc.phase === 'pausing' && now >= npc.phaseUntil) {
            npc.phase = 'returning';
            this._setTarget(npc, { x: npc.homeX, y: npc.homeY });
        } else if (npc.phase === 'returning' && npc.x === npc.homeX && npc.y === npc.homeY) {
            npc.phase = 'seated';
            npc.excursionTarget = null;
            npc.phaseUntil = now + between(this._random, 90000, 180000);
            this._excursionOwner = null;
            this._nextExcursionAt = now + between(this._random, 45000, 90000);
        }
    };

    TavernLife.prototype._updateWaitress = function (npc, now) {
        if (npc.phase === 'walking' && npc.x === npc.targetX && npc.y === npc.targetY) {
            npc.phase = 'serving';
            npc.phaseUntil = now + between(this._random, 5000, 9000);
            return;
        }
        if (npc.phase !== 'serving' || now < npc.phaseUntil || !npc.serviceStops || !npc.serviceStops.length) return;
        npc.serviceIndex = (npc.serviceIndex + 1) % npc.serviceStops.length;
        this._setTarget(npc, npc.serviceStops[npc.serviceIndex]);
        npc.phase = 'walking';
    }


    TavernLife.prototype._updateBartender = function (npc, now) {
        if (npc.phase === 'stationed' && now >= npc.phaseUntil) {
            var cells = (npc.barCells || []).filter(function (point) {
                return !(point.x === npc.x && point.y === npc.y) && !this._occupiedByOther(npc, point.x, point.y) && !!this._findPath(npc, this.getScene(), point);
            }, this);
            if (cells.length) {
                // Walk to a nearby point along the counter, then pause to serve.
                cells.sort(function (a, b) {
                    return Math.abs(a.x - npc.x) - Math.abs(b.x - npc.x);
                });
                var near = cells.slice(0, Math.min(4, cells.length));
                this._setTarget(npc, near[Math.floor(this._random() * near.length)]);
                npc.phase = 'working';
            } else {
                npc.facing = npc.facing === 'left' ? 'right' : 'left';
                npc.phaseUntil = now + between(this._random, 7000, 14000);
            }
        }
        if (npc.phase === 'working' && npc.x === npc.targetX && npc.y === npc.targetY) {
            npc.phase = 'stationed';
            npc.phaseUntil = now + between(this._random, 9000, 18000);
        }
    };

    TavernLife.prototype._updateCat = function (npc, scene, now) {
        if (npc.phase === 'resting' && now >= npc.phaseUntil) {
            var candidates = cellsFor(scene, function (x, y, tile) {
                return tile === 'floor' && Math.abs(x - npc.x) + Math.abs(y - npc.y) > 0 &&
                    Math.abs(x - npc.x) + Math.abs(y - npc.y) <= 2 && this._isRoleCell(npc, scene, x, y);
            }.bind(this)).filter(function (point) {
                return !this._occupiedByOther(npc, point.x, point.y) && !!this._findPath(npc, scene, point);
            }, this);
            if (candidates.length) {
                this._setTarget(npc, candidates[Math.floor(this._random() * candidates.length)]);
                npc.phase = 'walking';
            } else npc.phaseUntil = now + between(this._random, 8000, 14000);
        }
        if (npc.phase === 'walking' && npc.x === npc.targetX && npc.y === npc.targetY) {
            npc.phase = 'resting';
            npc.phaseUntil = now + between(this._random, 9000, 18000);
        }
    };

    TavernLife.prototype._maybeSpeak = function (npc, now, dt) {
        if (npc.speech && now < npc.speechUntil) return;
        npc.speechTimer -= dt;
        if (npc.speechTimer > 0) return;
        var lines;
        if (npc.role === 'bartender') lines = BARTENDER_LINES;
        else if (npc.role === 'cat') lines = CAT_LINES;
        else lines = PATRON_LINES;
        npc.speech = pick(lines, this._random);
        npc.speechUntil = now + BUBBLE_DURATION;
        npc.speechTimer = between(this._random, 18000, 32000);
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
                    kind: npc.role === 'cat' ? 'cat' : 'avatar',
                    avatar: npc.avatar,
                    appearance: npc.appearance,
                    catSprite: npc.catSprite || null,
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

    // Show a speech bubble for a real player (called by the explicit tavern_speech mapping).
    TavernLife.prototype.showPlayerBubble = function (socketId, text) {
        if (typeof socketId !== 'string' || typeof text !== 'string' || !text.trim()) return;
        this._realBubbles[socketId] = { text: text.slice(0, 200), until: this._now() + BUBBLE_DURATION };
    };

    // Project the top of an entity, before the viewport transform scales its rendered size.
    TavernLife.prototype._entityScreenPos = function (e, scene, cell, mode) {
        var pos;
        if (mode === '3d' && this._projectEntityHead) {
            var projected = this._projectEntityHead(e);
            if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
            // The 3D callback returns viewport-relative pixels, so do not apply the 2D
            // canvas transform again.
            return { x: projected.x, y: projected.y };
        }
        var humanoid = e.role !== 'cat' && (!e.kind || e.kind === 'avatar' || e.kind === 'player');
        var visual = (mode === 'iso' || humanoid) && RK.avatarVisuals && RK.avatarVisuals.resolve(e.appearance || { avatar: e.avatar }, {
            projection: mode === 'iso' ? 'iso' : 'topdown', entity: e
        });
        if (mode === 'iso') {
            // Match IsoRenderer._project: originX = margin + rows * tileW/2 + tileW; originY = margin + imageH
            var tileW = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.w) || 84;
            var tileH = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.h) || 42;
            var imageH = (RK.isoAssets && RK.isoAssets.tile && RK.isoAssets.tile.imageH) || 184;
            var margin = 28;
            var originX = margin + scene.rows * tileW / 2 + tileW;
            var originY = margin + imageH;
            pos = {
                x: originX + (e.x - e.y) * tileW / 2,
                y: originY + (e.x + e.y) * tileH / 2
            };
            // Iso character images are anchored at their feet, above the floor diamond.
            var character = visual && visual.allowed && visual.character;
            pos.y += character ? tileH * 0.95 - (character.imageH || 92) : -8;
        } else if (mode === '3d') {
            return null;
        } else {
            var head = 0.2;
            if (mode === 'ascii') head = 0;
            else if (visual && visual.allowed && visual.kind === 'char') head = -0.9;
            else if (visual && visual.allowed && visual.kind === 'skin') {
                var skin = RK.SKINS && RK.SKINS[visual.appearance.avatar];
                head = RK.skinSheetFailed && RK.skinSheetFailed(visual.appearance.avatar)
                    ? -0.9 : 1 - ((skin && skin.scale) || 1.7);
            }
            pos = { x: (e.x + 0.5) * cell, y: (e.y + head) * cell };
        }
        var view = this._viewTransform;
        if (view) return { x: view.left + pos.x * view.scaleX, y: view.top + pos.y * view.scaleY };
        return pos;
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
            if (pos) drawBubble(ctx, pos.x, pos.y, npc.speech, alpha);
        }

        // Remove departed visits as well as expired messages, even when no NPC can spawn.
        var present = new Set(scene.entities.filter(function (entity) { return !entity._npc; })
            .map(function (entity) { return entity.id; }));
        var bubbles = this._realBubbles;
        Object.keys(bubbles).forEach(function (id) {
            if (!present.has(id) || now >= bubbles[id].until) delete bubbles[id];
        });
        // Real player bubbles (from accepted room speech).
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
            if (rPos) drawBubble(ctx, rPos.x, rPos.y, bubble.text, rAlpha);
        }
    };

    // Main update: called every frame via rAF.
    TavernLife.prototype.update = function (scene, cell, mode) {
        if (!scene) return;
        var now = this._now();
        var dt = this._lastTick ? Math.max(0, Math.min(1000, now - this._lastTick)) : 0;
        this._lastTick = now;

        // Update role-specific schedules before taking at most one cardinal path step.
        for (var i = 0; i < this.npcs.length; i++) {
            var actor = this.npcs[i];
            if (actor.role === 'patron') this._updatePatron(actor, scene, now);
            else if (actor.role === 'waitress') this._updateWaitress(actor, now);
            else if (actor.role === 'bartender') this._updateBartender(actor, now);
            else if (actor.role === 'cat') this._updateCat(actor, scene, now);
            if (actor.phase === 'outbound' || actor.phase === 'returning' || actor.phase === 'walking' || actor.phase === 'working') {
                this._stepTowardTarget(actor, scene, dt);
            }
            this._maybeSpeak(actor, now, dt);
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
            this._syncOverlaySize(this.host.clientWidth || rendererCanvas.width, this.host.clientHeight || rendererCanvas.height);
            // Keep the overlay at viewport scale (so chat remains readable), but project each
            // world-space head position through the camera-transformed canvas rectangle.
            var hostRect = this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : { left: 0, top: 0 };
            var canvasRect = rendererCanvas.getBoundingClientRect ? rendererCanvas.getBoundingClientRect() : {
                left: 0, top: 0, width: rendererCanvas.width, height: rendererCanvas.height
            };
            this._viewTransform = {
                left: canvasRect.left - hostRect.left,
                top: canvasRect.top - hostRect.top,
                scaleX: canvasRect.width / (rendererCanvas.width || 1),
                scaleY: canvasRect.height / (rendererCanvas.height || 1)
            };
            this._overlay.style.inset = '0';
            this._overlay.style.left = '0';
            this._overlay.style.top = '0';
            this._overlay.style.maxWidth = 'none';
            this._overlay.style.maxHeight = 'none';
            this._overlay.style.transform = '';
            this._overlay.style.transition = '';
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
            var now = this._now();
            this.npcs[0].speech = pick(WELCOME_LINES, this._random);
            this.npcs[0].speechUntil = now + BUBBLE_DURATION;
            this.npcs[0].speechTimer = 5000;
        }
    };

    RK.TavernLife = TavernLife;
})(window);
