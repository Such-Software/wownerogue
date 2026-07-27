'use strict';

const {
    normalizeLeaderboardBoard,
    normalizeLeaderboardPeriod,
    queryPrestigeLeaderboard,
    querySoloLeaderboard
} = require('../network/prestigeLeaderboard');
const { ValidationError } = require('../utils/errors');

const ALLOWED_BOARDS = Object.freeze(['pleb', 'champions', 'prestige']);

function createLeaderboardHandler({
    db,
    getOperatedProductProfileId = () => null,
    now = () => new Date()
} = {}) {
    if (!db || typeof db.query !== 'function') {
        throw new TypeError('Leaderboard handler requires a database query interface');
    }

    return async function leaderboardHandler(req, res) {
        const period = normalizeLeaderboardPeriod(req.query.period);
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(requestedLimit, 50))
            : 20;
        const board = normalizeLeaderboardBoard(req.query.board);

        if (!board) {
            throw new ValidationError(
                'board must be one of pleb, champions, or prestige; omit it to request pleb',
                {
                    code: 'INVALID_LEADERBOARD_BOARD',
                    details: {
                        allowedBoards: ALLOWED_BOARDS,
                        missingBoardDefault: 'pleb'
                    }
                }
            );
        }

        const queryOptions = { period, limit, now: now() };
        const result = board === 'prestige'
            ? await queryPrestigeLeaderboard(db, queryOptions)
            : await querySoloLeaderboard(db, {
                ...queryOptions,
                board,
                profileId: getOperatedProductProfileId()
            });

        return res.json({ leaderboard: result.rows, period, board });
    };
}

module.exports = {
    ALLOWED_BOARDS,
    createLeaderboardHandler
};
