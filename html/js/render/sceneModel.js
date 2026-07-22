// Shared scene model + adapters for the render kit (RK).
//
// A Scene is a renderer-agnostic description of a grid world + entities. Any renderer
// (ASCII / tiled / fancy) draws the same Scene, and any surface (tavern / main game) can
// produce one via an adapter. This file is DOM-free so the adapters stay unit-testable.
(function (root) {
    'use strict';

    // Tile kinds and how each renderer treats them (glyph for ASCII, colour for tiled/fancy).
    // `over` names the ground tile an object sits on, so the renderer composites the object over it
    // (its transparent areas show the floor/wall, not the dark canvas). Ground tiles (wall/floor/rug)
    // have no `over` — they fill the cell.
    var TAVERN_LEGEND = {
        wall:   { char: '#', color: '#3a3f4b', solid: true },
        window: { char: 'W', color: '#4a6a8a', solid: true,  over: 'wall' },
        floor:  { char: '·', color: '#6b4d33', solid: false },  // warm wood, not the old dark green
        rug:    { char: 'r', color: '#7a3b39', solid: false, over: 'floor' },
        bar:    { char: '=', color: '#6a4a2a', solid: true,  over: 'floor' },
        keg:    { char: 'k', color: '#5a4028', solid: true,  over: 'floor' },
        shelf:  { char: 'h', color: '#4a3a28', solid: true,  over: 'floor' },
        table:  { char: 'T', color: '#6a4a2a', solid: true,  over: 'floor' },
        chair:  { char: 'c', color: '#5a4028', solid: false, over: 'floor' },  // walkable — stand on it to "sit"
        barrel: { char: 'B', color: '#5a4028', solid: true,  over: 'floor' },
        crate:  { char: 'C', color: '#7a5a38', solid: true,  over: 'floor' },
        door:   { char: 'D', color: '#3fb950', solid: false, over: 'floor' },
        // Fire fixtures — the base tile is floor; RK.fx paints the animated flame + glow on top.
        torch:  { char: 'i', color: '#d29922', solid: true,  over: 'floor', fx: 'fire', fxScale: 0.34 },
        hearth: { char: 'F', color: '#e0742a', solid: true,  over: 'floor', fx: 'fire', fxScale: 0.7 }
    };

    // Layout character -> tile kind.
    var TAVERN_TILE_OF = {
        '#': 'wall', 'W': 'window', '.': 'floor', '@': 'floor', 'r': 'rug',
        '=': 'bar', 'k': 'keg', 'h': 'shelf', 'T': 'table', 'c': 'chair',
        'B': 'barrel', 'C': 'crate', 'D': 'door', 'i': 'torch', 'F': 'hearth'
    };

    var AVATAR_COLORS = { 'default': '#9aa4b2', green: '#3fb950', amber: '#d29922', red: '#f85149' };

    // Build a Scene from a tavern room state ({ layout, cols, rows, occupants }).
    function sceneFromTavern(state, youId) {
        state = state || {};
        var layout = state.layout || [];
        var walkable = state.walkable || null;
        var rows = state.rows || layout.length;
        var cols = state.cols || (layout[0] ? layout[0].length : 0);

        var grid = [];
        for (var y = 0; y < rows; y++) {
            var srcRow = layout[y] || '';
            var row = [];
            for (var x = 0; x < cols; x++) {
                if (layout[y]) row.push(TAVERN_TILE_OF[srcRow[x]] || 'wall');
                else if (walkable && walkable[y]) row.push(walkable[y][x] ? 'floor' : 'wall');
                else row.push('wall');
            }
            grid.push(row);
        }

        var occ = state.occupants || [];
        var entities = occ.map(function (o) {
            var appearance = o.appearance || (o.avatar ? { avatar: o.avatar } : null);
            var avatar = (appearance && appearance.avatar) || o.avatar;
            return {
                id: o.id,
                x: o.x,
                y: o.y,
                kind: 'avatar',
                avatar: avatar,   // preserved so renderers can detect premium skins
                appearance: appearance,
                color: AVATAR_COLORS[avatar] || AVATAR_COLORS.default,
                char: '@',
                facing: o.facing || 'down',
                label: o.name || null,
                you: !!youId && o.id === youId
            };
        });

        return {
            cols: cols,
            rows: rows,
            grid: grid,
            legend: TAVERN_LEGEND,
            entities: entities,
            background: '#0a0c0f'
        };
    }

    var api = {
        sceneFromTavern: sceneFromTavern,
        TAVERN_LEGEND: TAVERN_LEGEND,
        AVATAR_COLORS: AVATAR_COLORS
    };

    // ---- Dungeon game-state adapter ------------------------------------------------
    // Converts a game state (from the server's game_start/game_update/spectator_update) into a
    // renderer-agnostic Scene, so the render kit can draw the dungeon just like the tavern.
    // This is the bridge for milestone R1 (main game → render kit) and T2b (tavern spectator).

    var DUNGEON_LEGEND = {
    wall:     { char: '#',  color: '#2a2f38', solid: true },
    floor:    { char: '·',  color: '#15191f', solid: false },
    floor2:   { char: '·',  color: '#181c22', solid: false },
    entrance: { char: '<',  color: '#3fb950', solid: false },
    exit:     { char: '>',  color: '#d29922', solid: false },
    treasure: { char: '$',  color: '#fbbf24', solid: false },
    // The generator only places torches on WALL cells adjacent to floor, so the fixture is
    // wall-mounted: base on `wall`, draw the torch sprite over it, then RK.fx animates the flame.
    torch:    { char: 'i',  color: '#d29922', solid: false, over: 'wall', fx: 'fire', fxScale: 0.34 },
    // Hazard zones. The base tile stays walkable/ground; RK.fx paints the pulsing overlay. These
    // render as soon as the dungeon generator emits their chars (L/P/^) in the tile stream.
    lava:     { char: '≈',  color: '#7a2a0e', solid: false, hazard: 'lava' },
    poison:   { char: '≈',  color: '#1c4a24', solid: false, hazard: 'poison' },
    spikes:   { char: '^',  color: '#3a3f48', solid: false, hazard: 'spikes' },
    dark:     { char: ' ',  color: '#0a0c0f', solid: true }
};

// Map dungeon tile characters to scene tile kinds.
function dungeonTileKind(ch) {
    if (ch === '#') return 'wall';
    if (ch === 'torch' || ch === 'i') return 'torch';
    if (ch === 'L') return 'lava';
    if (ch === 'P') return 'poison';
    if (ch === '^') return 'spikes';
    if (ch === "'1" || ch === 0) return 'floor';
    if (ch === "'2") return 'floor2';
    if (ch === '<') return 'entrance';
    if (ch === '>') return 'exit';
    if (ch === '$' || ch === '$W' || ch === '$M') return 'treasure';
    return 'floor';
}

// Grid dimensions from array grids OR sparse {y:{x:v}} maps (the single-player client uses the
// latter). Returns the max seen index + 1 across every supplied map.
function maxDims(maps) {
    var rows = 0, cols = 0;
    for (var i = 0; i < maps.length; i++) {
        var m = maps[i];
        if (!m || typeof m !== 'object') continue;
        for (var yk in m) {
            if (!Object.prototype.hasOwnProperty.call(m, yk)) continue;
            var yi = parseInt(yk, 10);
            if (!isFinite(yi)) continue;
            if (yi + 1 > rows) rows = yi + 1;
            var r = m[yk];
            if (r && typeof r === 'object') {
                for (var xk in r) {
                    if (!Object.prototype.hasOwnProperty.call(r, xk)) continue;
                    var xi = parseInt(xk, 10);
                    if (isFinite(xi) && xi + 1 > cols) cols = xi + 1;
                }
            }
        }
    }
    return { rows: rows, cols: cols };
}

function normalizeGameStateOpts(opts) {
    // Older multiplayer callers passed a socket id directly. Keep that path working while the
    // public API moves to an options object (`{ viewerId, playerAppearance, cryptoType }`).
    if (typeof opts === 'string') return { viewerId: opts };
    return (opts && typeof opts === 'object') ? opts : {};
}

function pickCameraPlayer(players, state, opts) {
    if (!players || !players.length) return null;
    var viewerId = opts.viewerId || opts.socketId || null;
    var focusId = opts.focusPlayerId || null;
    var i, p;

    // Match ticks are broadcast once, so the client socket id is the authoritative local marker
    // when the server cannot include a recipient-specific `you` flag.
    if (viewerId) {
        for (i = 0; i < players.length; i++) {
            p = players[i];
            if (p && p.id === viewerId) return p;
        }
    }
    for (i = 0; i < players.length; i++) {
        p = players[i];
        if (p && p.you === true) return p;
    }
    for (i = 0; i < players.length; i++) {
        p = players[i];
        if (p && focusId && p.id === focusId) return p;
    }
    for (i = 0; i < players.length; i++) {
        p = players[i];
        if (p && state.winnerId && p.id === state.winnerId) return p;
    }
    // Spectators follow a live contender by default, then gracefully fall back to the first racer.
    for (i = 0; i < players.length; i++) {
        p = players[i];
        if (p && p.alive !== false && !p.finished) return p;
    }
    return players[0] || null;
}

function pointOf(value) {
    if (!value) return null;
    if (Array.isArray(value)) return { x: value[0], y: value[1] };
    if (typeof value.x === 'number' && typeof value.y === 'number') return { x: value.x, y: value.y };
    return null;
}

function racerColor(player, index, isYou) {
    if (isYou) return '#67e8f9';
    if (player && player.alive === false) return '#6b7280';
    if (player && (player.finished || player.escaped)) return '#fbbf24';
    var palette = ['#9aa4b2', '#a78bfa', '#4ade80', '#fb7185', '#60a5fa', '#f97316'];
    var raw = String((player && player.id) || index), hash = 0;
    for (var i = 0; i < raw.length; i++) hash = ((hash * 31) + raw.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
}

function sceneFromGameState(state, opts) {
    state = state || {};
    opts = normalizeGameStateOpts(opts);
    var visible = state.visibleTiles || {};
    var explored = state.exploredTiles || {};
    var lighting = state.lighting || {};
    // Array grids expose .length; the SP client uses sparse {y:{x:v}} maps — fall back to the max
    // seen index. Explicit dungeonRows/Cols (server) always win.
    var dims = maxDims([visible, explored, state.map]);
    var rows = state.dungeonRows || visible.length || dims.rows;
    var cols = state.dungeonCols || dims.cols;

    var matchPlayers = Array.isArray(state.players) ? state.players : [];
    var cameraPlayer = pickCameraPlayer(matchPlayers, state, opts);

    // Player cell — explored MEMORY fades to black with distance from here (see below). Multiplayer
    // states use `players[]`, while the original single-player protocol uses singular `player`.
    var _pl = state.player || cameraPlayer || {};
    var _plx = typeof _pl.x === 'number' ? _pl.x : (cols / 2);
    var _ply = typeof _pl.y === 'number' ? _pl.y : (rows / 2);

    var grid = [];
    var lightGrid = [];
    for (var y = 0; y < rows; y++) {
        var row = [];
        var lrow = [];
        for (var x = 0; x < cols; x++) {
            var ch = null;
            var isVisible = visible[y] && visible[y][x] !== undefined;
            if (isVisible) {
                ch = visible[y][x];
            } else if (explored[y] && explored[y][x] !== undefined) {
                ch = explored[y][x];
            }
            if (ch === null || ch === undefined || ch === ' ') {
                row.push('dark');
                lrow.push(0);
            } else if (isVisible) {
                row.push(dungeonTileKind(ch));
                // Lighting: 0 = fully lit, higher = darker. Convert to brightness (1 = lit).
                var la = (lighting[y] && lighting[y][x]) || 0;
                lrow.push(Math.max(0.15, 1 - Math.min(la, 0.8)));
            } else {
                // Explored MEMORY (seen before, not currently visible): dim, and fading toward black
                // with distance from the player, so the remembered area melts into the dark instead
                // of forming a hard-edged grey block that outlines the map's shape/edge (a FoW leak).
                row.push(dungeonTileKind(ch));
                var _dx = x - _plx, _dy = y - _ply;
                lrow.push(Math.max(0, 0.26 - Math.sqrt(_dx * _dx + _dy * _dy) * 0.019));
            }
        }
        grid.push(row);
        lightGrid.push(lrow);
    }

    var entities = [];

    // Fog of war: a cell is `seen` once explored (grid isn't 'dark'); `inView` only while currently
    // visible. Features (exit/treasure/entrance) show once discovered; the monster only shows while
    // in view — otherwise the exit stairs leak through the fog before you've found them.
    function seen(x, y) { return !!(grid[y] && grid[y][x] && grid[y][x] !== 'dark'); }
    function inView(x, y) { return !!(visible[y] && visible[y][x] !== undefined); }

    // Entrance / exit / treasure as entities (so they layer above tiles) — only once explored.
    // Solo uses `[x,y]`; match state uses `{x,y}` for treasure, so accept both point shapes.
    var entrance = pointOf(state.entrance);
    var exit = pointOf(state.exit);
    var treasure = pointOf(state.treasure);
    if (entrance && seen(entrance.x, entrance.y)) {
        entities.push({ id: 'entrance', x: entrance.x, y: entrance.y, kind: 'feature', char: '<', color: '#3fb950', label: null });
    }
    if (exit && seen(exit.x, exit.y)) {
        entities.push({ id: 'exit', x: exit.x, y: exit.y, kind: 'feature', char: '>', color: '#d29922', label: null });
    }
    if (treasure && seen(treasure.x, treasure.y) && !(state.treasure && state.treasure.carrierId)) {
        var tChar = opts.cryptoType === 'XMR' ? '$M' : '$W';
        entities.push({ id: 'treasure', x: treasure.x, y: treasure.y, kind: 'feature', char: tChar, color: '#fbbf24', label: null });
    }

    // Items — only once explored.
    if (state.items) {
        for (var key in state.items) {
            if (state.items.hasOwnProperty(key)) {
                var item = state.items[key];
                if (item && typeof item.x === 'number' && seen(item.x, item.y)) {
                    entities.push({ id: 'item:' + key, x: item.x, y: item.y, kind: 'item', char: '$', color: '#fbbf24', label: null });
                }
            }
        }
    }

    // Monster — only while it's actually in view.
    if (state.monster && inView(state.monster.x, state.monster.y)) {
        entities.push({
            id: 'monster', x: state.monster.x, y: state.monster.y,
            kind: 'monster', char: '~', color: '#f85149', label: null
        });
    }

    // Multiplayer racers. Preserve public status fields useful to HUD/render extensions while
    // keeping the shared entity contract identical to solo (`kind: player`, appearance, facing).
    if (matchPlayers.length) {
        var viewerId = opts.viewerId || opts.socketId || null;
        for (var pi = 0; pi < matchPlayers.length; pi++) {
            var rp = matchPlayers[pi];
            if (!rp || typeof rp.x !== 'number' || typeof rp.y !== 'number') continue;
            var isYou = viewerId ? rp.id === viewerId : rp.you === true;
            var appearance = rp.appearance || (rp.avatar ? { avatar: rp.avatar } : null) || { avatar: 'default' };
            entities.push({
                id: rp.id || ('player:' + pi), x: rp.x, y: rp.y,
                kind: 'player', char: '@', color: racerColor(rp, pi, isYou),
                facing: rp.facing || null, label: rp.name || null,
                avatar: appearance.avatar || rp.avatar || 'default', appearance: appearance,
                you: isYou, cameraTarget: rp === cameraPlayer,
                alive: rp.alive !== false, finished: !!rp.finished, escaped: !!rp.escaped,
                hasTreasure: !!rp.hasTreasure, placement: rp.placement == null ? null : rp.placement
            });
        }
    // Original single-player protocol.
    } else if (state.player) {
        var playerEntity = {
            id: 'player', x: state.player.x, y: state.player.y,
            kind: 'player', char: '@', color: '#9aa4b2',
            // No bogus default: the SP server doesn't send facing, so leave it null and let the iso/3D
            // renderers INFER facing from movement. A hardcoded 'down' made them always face down/SW.
            facing: state.player.facing || null, label: null,
            you: !state.isSpectating, cameraTarget: true
        };
        // Attach the player's appearance if available (for render-kit character rendering).
        if (opts.playerAppearance) {
            playerEntity.avatar = opts.playerAppearance.avatar || 'default';
            playerEntity.appearance = opts.playerAppearance;
        } else {
            playerEntity.avatar = 'default';
            playerEntity.appearance = { avatar: 'default', tint: 'none', equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' } };
        }
        entities.push(playerEntity);
    }

    return {
        cols: cols,
        rows: rows,
        grid: grid,
        legend: DUNGEON_LEGEND,
        entities: entities,
        lightGrid: lightGrid,
        background: '#0a0c0f',
        isDungeon: true
    };
}

    api.sceneFromGameState = sceneFromGameState;
    api.DUNGEON_LEGEND = DUNGEON_LEGEND;

    root.RK = root.RK || {};
    root.RK.scene = api;
    // Convenience aliases on RK directly — several callers (matchClient, tavern spectator, the SP
    // render bridge) reference RK.sceneFromGameState / RK.sceneFromTavern; without these they were
    // silently undefined (guarded → no-op). Expose them so those paths actually render.
    root.RK.sceneFromGameState = root.RK.sceneFromGameState || sceneFromGameState;
    if (api.sceneFromTavern) root.RK.sceneFromTavern = root.RK.sceneFromTavern || api.sceneFromTavern;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
