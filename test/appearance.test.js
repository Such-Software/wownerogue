const Appearance = require('../src/multiplayer/appearance');

describe('appearance catalog normalization', () => {
    test('normalizes character colors and equipment slots', () => {
        expect(Appearance.normalizeAppearance({
            avatar: 'char-ranger',
            tint: 'moss',
            equipment: { body: 'mail', head: 'helm', shield: 'bad', weapon: 'bow' },
            colors: { base: 'teal', skin: 'warm', hair: 'silver', body: 'gold', head: 'bad', shield: 'rose', weapon: 'ash' }
        })).toEqual({
            avatar: 'char-ranger',
            tint: 'teal',
            equipment: { body: 'mail', head: 'helm', shield: 'none', weapon: 'bow' },
            colors: { base: 'teal', skin: 'warm', hair: 'silver', body: 'gold', head: 'none', shield: 'rose', weapon: 'ash' }
        });
    });

    test('uses legacy tint as the default character color ramp', () => {
        expect(Appearance.normalizeAppearance({
            avatar: 'char-ranger',
            tint: 'moss'
        })).toEqual({
            avatar: 'char-ranger',
            tint: 'moss',
            equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' },
            colors: { base: 'moss', skin: 'natural', hair: 'copper', body: 'moss', head: 'moss', shield: 'moss', weapon: 'moss' }
        });
    });

    test('strips character-only fields from color and premium skin avatars', () => {
        expect(Appearance.normalizeAppearance({
            avatar: 'monero-knight',
            tint: 'teal',
            equipment: { body: 'mail' }
        })).toEqual({
            avatar: 'monero-knight',
            tint: 'none',
            equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' }
        });
    });

    test('falls back unknown avatars to default', () => {
        expect(Appearance.normalizeAppearance('rainbow')).toEqual({
            avatar: 'default',
            tint: 'none',
            equipment: { body: 'none', head: 'none', shield: 'none', weapon: 'none' }
        });
    });
});
