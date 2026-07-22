const fs = require('fs');
const path = require('path');

describe('match client durable finish and fairness messaging', () => {
    const source = fs.readFileSync(path.join(__dirname, '../html/js/matchClient.js'), 'utf8');

    test('does not treat a settlement-pending event as a final result', () => {
        const pending = source.match(/socket\.on\('match_settlement_pending',[\s\S]*?\n    \}\);/);
        expect(pending).toBeTruthy();
        expect(pending[0]).toContain('not final yet');
        expect(pending[0]).not.toContain('inRace = false');
    });

    test('checks the revealed seed against the published SHA-256 commitment', () => {
        expect(source).toContain("subtle.digest('SHA-256'");
        expect(source).toContain("actual === String(fairness.seedHash).toLowerCase()");
        expect(source).toContain('seed proof ✓');
    });
});
