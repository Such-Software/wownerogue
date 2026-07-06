const Appearance = require('../src/multiplayer/appearance');

describe('appearance catalog normalization', () => {
    test('normalizes character tint and equipment slots', () => {
        expect(Appearance.normalizeAppearance({
            avatar: 'char-ranger',
            tint: 'moss',
            equipment: { body: 'mail', head: 'helm', shield: 'bad', weapon: 'bow' }
        })).toEqual({
            avatar: 'char-ranger',
            tint: 'moss',
            equipment: { body: 'mail', head: 'helm', shield: 'none', weapon: 'bow' }
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
