/**
 * Verify page OpenGraph/Twitter card meta (share-a-win unfurl).
 * The /verify/:id page must render social-card meta so shared links preview nicely, while
 * staying backward compatible with the old `renderVerifyPage(id, record, gameName)` signature.
 */

const { renderVerifyPage } = require('../src/views/verifyPage');

describe('renderVerifyPage social card meta', () => {
    test('emits OG + Twitter tags with an absolute image when opts provided', () => {
        const html = renderVerifyPage('seedABC', null, {
            gameName: 'Monero Roguelike',
            baseUrl: 'https://monerogue.app',
            ogImage: 'og-card-xmr.png'
        });
        expect(html).toContain('property="og:title"');
        expect(html).toContain('Monero Roguelike — Dungeon Layout Verification');
        expect(html).toContain('<meta property="og:image" content="https://monerogue.app/og-card-xmr.png">');
        expect(html).toContain('content="summary_large_image"');
        expect(html).toContain('<meta property="og:url" content="https://monerogue.app/verify/seedABC">');
    });

    test('uses the result in the description when a game record is present', () => {
        const html = renderVerifyPage('seedXYZ', {
            status: 'won', treasure_found: true, moves_made: 42, duration_seconds: 30, created_at: 'now'
        }, { gameName: 'X', baseUrl: 'https://h', ogImage: 'og-card-wow.png' });
        expect(html).toMatch(/Escaped the dungeon with the treasure bag in 42 moves/);
    });

    test('falls back to summary card (no image) and stays valid without opts', () => {
        const html = renderVerifyPage('seed1', null, 'Wownerogue'); // legacy string arg
        expect(html).toContain('Wownerogue - Game Verification');
        expect(html).toContain('content="summary"');
        expect(html).not.toContain('og:image');
    });

    test('escapes interpolated values in meta', () => {
        const html = renderVerifyPage('s', null, { gameName: '"><script>x', baseUrl: 'https://h', ogImage: 'a.png' });
        expect(html).not.toContain('<script>x');
        expect(html).toContain('&quot;&gt;&lt;script&gt;x');
    });

    test('renders API verification results with text nodes, not dynamic innerHTML', () => {
        const html = renderVerifyPage('seed-safe', null, { gameName: 'Wownerogue' });
        expect(html).not.toMatch(/result\.innerHTML\s*=/);
        expect(html).toMatch(/code\.textContent\s*=/);
        expect(html).toMatch(/showFailure\(data\.message \|\| data\.error/);
    });

    test('states the proof scope without claiming to replay outcomes or payouts', () => {
        const html = renderVerifyPage('seed-scope', null, { gameName: 'Wownerogue' });
        expect(html).toContain('recorded dungeon layouts');
        expect(html).toContain('does not replay player input, block timing, monster turns, the reported outcome, or payout delivery');
    });
});
