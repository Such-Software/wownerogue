const Appearance = require('../src/multiplayer/appearance');

describe('appearance normalization for 3D avatars', () => {
    test('preserves base colors for model avatars', () => {
        const ap = Appearance.normalizeAppearance({
            avatar: 'kenney-survivor-male',
            tint: 'gold',
            colors: { base: 'teal', skin: 'umber', hair: 'silver' },
            equipment: { body: 'mail', head: 'helm' }
        });

        expect(ap).toMatchObject({
            avatar: 'kenney-survivor-male',
            tint: 'teal',
            equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' },
            colors: expect.objectContaining({ base: 'teal', skin: 'umber', hair: 'silver' })
        });
    });
});
