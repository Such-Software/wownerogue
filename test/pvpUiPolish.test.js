const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMatchCopy() {
    const context = {};
    context.window = context;
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../html/js/ui/matchUiCopy.js'), 'utf8'),
        context
    );
    return context.MatchUiCopy;
}

describe('multiplayer UI copy contract', () => {
    const copy = loadMatchCopy();

    test.each([
        ['race', 'racer', 'Reach the exit'],
        ['last-alive', 'contender', 'Stay alive'],
        ['score-attack', 'delver', 'highest score'],
        ['coop-escape', 'teammate', 'Work together']
    ])('%s exposes its own objective and participant language', (id, participant, objective) => {
        const mode = copy.normalize({ id });
        expect(mode.participant).toBe(participant);
        expect(mode.objective).toContain(objective);
    });

    test.each([
        ['race', '🏆 You escaped first!'],
        ['last-alive', '🏆 You are the last delver standing!'],
        ['score-attack', '🏆 You set the high score!']
    ])('%s renders a mode-specific competitive victory', (id, expected) => {
        const result = copy.finalResult({
            ruleset: { id },
            winnerId: 'me',
            players: [{ id: 'me', placement: 1, score: 812 }]
        }, 'me');
        expect(result.won).toBe(true);
        expect(result.text).toContain(expected);
        if (id === 'score-attack') expect(result.text).toContain('score 812');
    });

    test('co-op reports one team outcome and never promotes placement #1 as an individual winner', () => {
        const result = copy.finalResult({
            ruleset: { id: 'coop-escape' },
            reason: 'all_escaped',
            winnerId: null,
            players: [
                { id: 'me', placement: 2, escaped: true },
                { id: 'ally', placement: 1, escaped: true }
            ]
        }, 'me');

        expect(result.won).toBe(true);
        expect(result.text).toContain('🤝 Team escaped!');
        expect(result.text).toContain('you reached safety');
        expect(result.text).not.toMatch(/placed|winner/i);
    });

    test('live summaries use the active mode rather than race-only placement copy', () => {
        expect(copy.liveSummary({
            ruleset: { id: 'last-alive' },
            players: [{ id: 'me', alive: true }, { id: 'out', alive: false }]
        }, 'me')).toBe('1 contender still in');
        expect(copy.liveSummary({
            ruleset: { id: 'coop-escape' },
            players: [{ id: 'me', escaped: true, finished: true }, { id: 'ally', alive: true }]
        }, 'me')).toBe('1/2 safe · 1 still exploring');
    });
});

describe('public multiplayer controls and boards', () => {
    const matchHtml = fs.readFileSync(path.join(__dirname, '../html/match.html'), 'utf8');
    const tavernHtml = fs.readFileSync(path.join(__dirname, '../html/tavern.html'), 'utf8');
    const matchClient = fs.readFileSync(path.join(__dirname, '../html/js/matchClient.js'), 'utf8');
    const leaderboard = fs.readFileSync(path.join(__dirname, '../html/js/ui/leaderboard.js'), 'utf8');
    const designDoc = fs.readFileSync(path.join(__dirname, '../docs/TAVERN_AND_MULTIPLAYER.md'), 'utf8');

    test('match and Tavern D-pads are named groups activated through native click', () => {
        expect(matchHtml).toMatch(/id="matchDpad"[^>]*role="group"[^>]*aria-label="Match movement controls"/);
        expect(tavernHtml).toMatch(/id="tavernDpad"[^>]*role="group"[^>]*aria-label="Tavern movement controls"/);
        expect(tavernHtml).toMatch(/id="spectatorDpad"[^>]*role="group"[^>]*aria-label="Match movement controls"/);
        expect(matchClient).toContain("b.addEventListener('click'");
        expect(tavernHtml).toContain("b.addEventListener('click'");
    });

    test('Prestige is a distinct public board with an explicit non-mixing disclosure', () => {
        expect(leaderboard).toContain('data-board="prestige"');
        expect(leaderboard).toContain('Credit-entry competitive PvP scores only');
        expect(leaderboard).toContain('never mixed with Free or the Hall of Champions');
    });

    test('operator docs require restart for mode/ruleset changes and do not promise future combat', () => {
        expect(designDoc).toContain('restart the service');
        expect(designDoc).toContain('does not hot-reload match modes or rulesets');
        expect(designDoc).not.toMatch(/PvP combat (?:remains|is planned)/i);
    });
});
