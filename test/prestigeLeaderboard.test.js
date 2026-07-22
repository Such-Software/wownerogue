const {
    normalizeLeaderboardPeriod,
    prestigeCutoff,
    queryPrestigeLeaderboard
} = require('../src/network/prestigeLeaderboard');

describe('prestige leaderboard periods', () => {
    const now = new Date('2026-07-21T16:00:00.000Z');

    test.each([
        ['week', '2026-07-14T16:00:00.000Z'],
        ['month', '2026-06-21T16:00:00.000Z'],
        ['all', null],
        ['unexpected', null]
    ])('%s resolves to the exact cutoff', (period, expected) => {
        const cutoff = prestigeCutoff(period, now);
        expect(cutoff?.toISOString() || null).toBe(expected);
    });

    test('unknown periods normalize to all', () => {
        expect(normalizeLeaderboardPeriod('YEAR')).toBe('all');
    });

    test.each(['week', 'month', 'all'])('queries match rows with a strict boundary for %s', async (period) => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await queryPrestigeLeaderboard(db, { period, limit: 17, now });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("m.economy = 'credits_prestige'");
        expect(sql).toContain('me.placement = 1');
        expect(sql).toContain('m.winner_user_id = me.user_id');
        expect(sql).toContain("m.ruleset_id <> 'coop-escape'");
        expect(sql).not.toContain('me.escaped');
        expect(sql).toContain('m.ended_at > $1::timestamptz');
        expect(params[0]?.toISOString() || null).toBe(prestigeCutoff(period, now)?.toISOString() || null);
        expect(params[1]).toBe(17);
    });
});
