// Shared scene model + adapters for the render kit (RK).
//
// A Scene is a renderer-agnostic description of a grid world + entities. Any renderer
// (ASCII / tiled / fancy) draws the same Scene, and any surface (tavern / main game) can
// produce one via an adapter. This file is DOM-free so the adapters stay unit-testable.
(function (root) {
    'use strict';

    // Tile kinds and how each renderer treats them (glyph for ASCII, colour for tiled/fancy).
    var TAVERN_LEGEND = {
        wall:  { char: '#', color: '#20262e', solid: true },
        floor: { char: '·', color: '#0c1410', solid: false },
        bar:   { char: '=', color: '#5a4632', solid: true },
        table: { char: 'o', color: '#4a3a28', solid: true }
    };

    // Layout character -> tile kind.
    var TAVERN_TILE_OF = { '#': 'wall', '.': 'floor', '@': 'floor', '=': 'bar', 'o': 'table' };

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

    root.RK = root.RK || {};
    root.RK.scene = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
