const {
    normalizeLeaderboardBoard,
    normalizeLeaderboardPeriod,
    prestigeCutoff,
    queryPrestigeLeaderboard,
    querySoloLeaderboard,
    soloLeaderboardPolicy
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

    test.each([
        ['pleb', 'pleb'],
        ['CHAMPIONS', 'champions'],
        [' prestige ', 'prestige'],
        [undefined, 'pleb'],
        [null, 'pleb'],
        ['', null],
        ['all', null],
        ['unexpected', null]
    ])('leaderboard board %p has an explicit, non-mixing API interpretation', (input, expected) => {
        expect(normalizeLeaderboardBoard(input)).toBe(expected);
    });

    test('operated profile policies classify Champions from server identity', () => {
        expect(soloLeaderboardPolicy('such-play-wow-prestige', 'champions')).toEqual({
            gameModes: ['PAID_CREDITS'],
            excludeMatchGenerated: true
        });
        expect(soloLeaderboardPolicy('such-monerogue-stagenet', 'champions')).toEqual({
            gameModes: ['PAID_SINGLE'],
            excludeMatchGenerated: true
        });
        expect(soloLeaderboardPolicy(null, 'champions')).toEqual({
            gameModes: ['PAID_SINGLE', 'PAID_CREDITS'],
            excludeMatchGenerated: false
        });
        expect(soloLeaderboardPolicy('such-play-wow-prestige', 'pleb')).toEqual({
            gameModes: ['FREE'],
            excludeMatchGenerated: false
        });
    });

    test('operated solo query excludes both durable match markers', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        await querySoloLeaderboard(db, {
            profileId: 'such-play-wow-prestige',
            board: 'champions',
            period: 'week',
            limit: 17,
            now
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain("LEFT(COALESCE(g.outcome, ''), 6) <> 'match_'");
        expect(sql).toContain('source_match.id::text = g.dungeon_seed');
        expect(sql).toContain('g.game_mode = ANY($2::varchar[])');
        expect(params[0].toISOString()).toBe('2026-07-14T16:00:00.000Z');
        expect(params[1]).toEqual(['PAID_CREDITS']);
        expect(params[2]).toBe(true);
        expect(params[3]).toBe(17);
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
