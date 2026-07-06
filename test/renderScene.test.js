const scene = require('../html/js/render/sceneModel');

describe('sceneFromTavern (render kit adapter)', () => {
    test('maps layout chars to tile kinds and occupants to entities', () => {
        const appearance = {
            avatar: 'char-ranger',
            tint: 'teal',
            equipment: { body: 'mail', head: 'hood', shield: 'round', weapon: 'bow' }
        };
        const state = {
            cols: 3, rows: 2,
            layout: ['#=@', 'o..'],
            occupants: [{ id: 'a', x: 2, y: 0, avatar: 'green', appearance, facing: 'left', name: 'Al' }]
        };
        const s = scene.sceneFromTavern(state, 'a');
        expect(s.cols).toBe(3);
        expect(s.rows).toBe(2);
        expect(s.grid[0]).toEqual(['wall', 'bar', 'floor']);   // '@' is walkable floor
        expect(s.grid[1]).toEqual(['table', 'floor', 'floor']);
        expect(s.entities).toHaveLength(1);
        expect(s.entities[0]).toMatchObject({ id: 'a', x: 2, y: 0, kind: 'avatar', avatar: 'char-ranger', appearance, facing: 'left', label: 'Al', you: true });
        expect(s.entities[0].color).toBe(scene.AVATAR_COLORS.default);
    });

    test('you-flag is false for other occupants and unknown avatars fall back to default', () => {
        const s = scene.sceneFromTavern(
            { cols: 1, rows: 1, layout: ['.'], occupants: [{ id: 'b', x: 0, y: 0, avatar: 'zzz' }] },
            'a'
        );
        expect(s.entities[0].you).toBe(false);
        expect(s.entities[0].color).toBe(scene.AVATAR_COLORS.default);
    });

    test('unknown / out-of-legend characters are treated as walls (solid)', () => {
        const s = scene.sceneFromTavern({ cols: 2, rows: 1, layout: ['?~'], occupants: [] });
        expect(s.grid[0]).toEqual(['wall', 'wall']);
    });
});
