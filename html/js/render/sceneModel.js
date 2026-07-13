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

function sceneFromGameState(state, opts) {
    state = state || {};
    opts = opts || {};
    var visible = state.visibleTiles || {};
    var explored = state.exploredTiles || {};
    var lighting = state.lighting || {};
    // Array grids expose .length; the SP client uses sparse {y:{x:v}} maps — fall back to the max
    // seen index. Explicit dungeonRows/Cols (server) always win.
    var dims = maxDims([visible, explored, state.map]);
    var rows = state.dungeonRows || visible.length || dims.rows;
    var cols = state.dungeonCols || dims.cols;

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
            } else {
                row.push(dungeonTileKind(ch));
                // Lighting: 0 = fully lit, higher = darker. Convert to brightness (1 = lit).
                var la = (lighting[y] && lighting[y][x]) || 0;
                lrow.push(isVisible ? Math.max(0.15, 1 - Math.min(la, 0.8)) : 0.25);
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
    if (state.entrance && seen(state.entrance[0], state.entrance[1])) {
        entities.push({ id: 'entrance', x: state.entrance[0], y: state.entrance[1], kind: 'feature', char: '<', color: '#3fb950', label: null });
    }
    if (state.exit && seen(state.exit[0], state.exit[1])) {
        entities.push({ id: 'exit', x: state.exit[0], y: state.exit[1], kind: 'feature', char: '>', color: '#d29922', label: null });
    }
    if (state.treasure && seen(state.treasure[0], state.treasure[1])) {
        var tChar = opts.cryptoType === 'XMR' ? '$M' : '$W';
        entities.push({ id: 'treasure', x: state.treasure[0], y: state.treasure[1], kind: 'feature', char: tChar, color: '#fbbf24', label: null });
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

    // Player.
    if (state.player) {
        var playerEntity = {
            id: 'player', x: state.player.x, y: state.player.y,
            kind: 'player', char: '@', color: '#9aa4b2',
            facing: state.player.facing || 'down', label: null,
            you: !state.isSpectating
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
