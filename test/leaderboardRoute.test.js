'use strict';

const createErrorMiddleware = require('../src/middleware/errorHandler');
const { createLeaderboardHandler } = require('../src/routes/leaderboard');

const SOURCE_MATCH = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT = '2026-07-20T12:00:00.000Z';

function fixtureDatabase() {
    const users = new Map([
        [1, { id: 1, display_name: 'CreditSolo', payout_address: null }],
        [2, { id: 2, display_name: 'LegacyDirect', payout_address: null }],
        [3, { id: 3, display_name: 'MatchOutcome', payout_address: null }],
        [4, { id: 4, display_name: 'MatchLink', payout_address: null }],
        [5, { id: 5, display_name: 'FreeSolo', payout_address: null }],
        [6, { id: 6, display_name: 'FreeMatch', payout_address: null }]
    ]);
    const games = [
        {
            user_id: 1, game_mode: 'PAID_CREDITS', status: 'won', outcome: 'escaped',
            score: 500, dungeon_seed: 'solo-credit', completed_at: COMPLETED_AT
        },
        {
            user_id: 2, game_mode: 'PAID_SINGLE', status: 'lost', outcome: 'caught_by_monster',
            score: 450, dungeon_seed: 'legacy-direct', completed_at: COMPLETED_AT
        },
        {
            user_id: 3, game_mode: 'PAID_CREDITS', status: 'won', outcome: 'match_winner',
            score: 990, dungeon_seed: 'legacy-match-without-link', completed_at: COMPLETED_AT
        },
        {
            user_id: 4, game_mode: 'PAID_CREDITS', status: 'won', outcome: 'escaped',
            score: 980, dungeon_seed: SOURCE_MATCH, completed_at: COMPLETED_AT
        },
        {
            user_id: 5, game_mode: 'FREE', status: 'lost', outcome: 'caught_by_monster',
            score: 300, dungeon_seed: 'solo-free', completed_at: COMPLETED_AT
        },
        {
            user_id: 6, game_mode: 'FREE', status: 'won', outcome: 'match_winner',
            score: 350, dungeon_seed: SOURCE_MATCH, completed_at: COMPLETED_AT
        }
    ];
    const calls = [];

    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            const [cutoff, gameModes, excludeMatchGenerated, limit] = params;
            const rows = games.filter(game => {
                if (!gameModes.includes(game.game_mode)) return false;
                if (!['won', 'lost'].includes(game.status) || game.score <= 0) return false;
                if (cutoff && new Date(game.completed_at) <= cutoff) return false;
                if (excludeMatchGenerated
                    && (String(game.outcome || '').startsWith('match_')
                        || game.dungeon_seed === SOURCE_MATCH)) return false;
                return true;
            });
            const aggregate = new Map();
            for (const game of rows) {
                const user = users.get(game.user_id);
                const current = aggregate.get(user.id) || {
                    id: user.id,
                    name: user.display_name || `Anon#${user.id}`,
                    best_score: 0,
                    wins: 0,
                    games_played: 0
                };
                current.best_score = Math.max(current.best_score, game.score);
                current.wins += game.status === 'won' ? 1 : 0;
                current.games_played += 1;
                aggregate.set(user.id, current);
            }
            return {
                rows: Array.from(aggregate.values())
                    .sort((a, b) => b.best_score - a.best_score)
                    .slice(0, limit)
            };
        }
    };
}

async function invokeLeaderboardRoute(profileId, query = {}) {
    const db = fixtureDatabase();
    const handler = createLeaderboardHandler({
        db,
        getOperatedProductProfileId: () => profileId,
        now: () => new Date('2026-07-21T12:00:00.000Z')
    });
    const req = { query, path: '/api/leaderboard', method: 'GET' };
    const response = { status: 200, body: null };
    const res = {
        status(status) {
            response.status = status;
            return this;
        },
        json(body) {
            response.body = body;
            return this;
        }
    };
    try {
        await handler(req, res);
    } catch (error) {
        createErrorMiddleware({ logger: { error: jest.fn() } })(error, req, res, () => {});
    }
    return { response, db };
}

describe('GET /api/leaderboard operated-product integrity', () => {
    test('Wownero Champions includes credit-entry solo only', async () => {
        const { response, db } = await invokeLeaderboardRoute('such-play-wow-prestige', {
            board: 'champions',
            period: 'all'
        });
        expect(response.status).toBe(200);
        expect(response.body.board).toBe('champions');
        expect(response.body.leaderboard.map(row => row.name)).toEqual(['CreditSolo']);
        expect(db.calls[0].params.slice(1, 3)).toEqual([['PAID_CREDITS'], true]);
    });

    test('Monerogue Champions includes direct and credit solo, never match-generated rows', async () => {
        const { response, db } = await invokeLeaderboardRoute('such-monerogue-stagenet', {
            board: 'champions',
            period: 'all'
        });
        expect(response.status).toBe(200);
        expect(response.body.leaderboard.map(row => row.name))
            .toEqual(['CreditSolo', 'LegacyDirect']);
        expect(db.calls[0].params.slice(1, 3))
            .toEqual([['PAID_SINGLE', 'PAID_CREDITS'], true]);
    });

    test('independent deployments retain the generic opt-in crypto-match mapping', async () => {
        const { response, db } = await invokeLeaderboardRoute(null, {
            board: 'champions',
            period: 'all'
        });
        expect(response.status).toBe(200);
        expect(response.body.leaderboard.map(row => row.name)).toEqual([
            'MatchOutcome',
            'MatchLink',
            'CreditSolo',
            'LegacyDirect'
        ]);
        expect(db.calls[0].params.slice(1, 3))
            .toEqual([['PAID_SINGLE', 'PAID_CREDITS'], false]);
    });

    test('missing board defaults to Pleb and preserves free competitive rows', async () => {
        const { response, db } = await invokeLeaderboardRoute('such-play-wow-prestige', {
            period: 'all'
        });
        expect(response.status).toBe(200);
        expect(response.body.board).toBe('pleb');
        expect(response.body.leaderboard.map(row => row.name))
            .toEqual(['FreeMatch', 'FreeSolo']);
        expect(db.calls[0].params.slice(1, 3)).toEqual([['FREE'], false]);
    });

    test.each(['all', 'unknown', ''])(
        'explicit deprecated or invalid board %p returns 400 without querying',
        async board => {
            const { response, db } = await invokeLeaderboardRoute(
                'such-play-wow-prestige',
                { board }
            );
            expect(response.status).toBe(400);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'INVALID_LEADERBOARD_BOARD',
                details: expect.objectContaining({
                    allowedBoards: ['pleb', 'champions', 'prestige'],
                    missingBoardDefault: 'pleb'
                })
            }));
            expect(db.calls).toHaveLength(0);
        }
    );
});
