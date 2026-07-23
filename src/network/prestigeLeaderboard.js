'use strict';

const {
    OPERATED_PRODUCT_PROFILE_IDS
} = require('../config/operatedProductProfiles');

const PERIOD_MS = Object.freeze({
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
});
const LEADERBOARD_BOARDS = new Set(['pleb', 'champions', 'prestige']);

function normalizeLeaderboardPeriod(value) {
    const period = String(value || 'all').toLowerCase();
    return Object.prototype.hasOwnProperty.call(PERIOD_MS, period) ? period : 'all';
}

function normalizeLeaderboardBoard(value) {
    // A request that omits the board gets the no-entry-cost board. Explicit legacy `all`, blank,
    // and unknown values are invalid: silently translating them would conceal an API contract
    // change and could make a caller believe it received a mixed board.
    if (value === undefined || value === null) return 'pleb';
    const board = String(value).trim().toLowerCase();
    return LEADERBOARD_BOARDS.has(board) ? board : null;
}

function prestigeCutoff(period, now = new Date()) {
    const normalized = normalizeLeaderboardPeriod(period);
    if (normalized === 'all') return null;
    return new Date(now.getTime() - PERIOD_MS[normalized]);
}

async function queryPrestigeLeaderboard(db, { period = 'all', limit = 20, now = new Date() } = {}) {
    const cutoff = prestigeCutoff(period, now);
    return db.query(`
      SELECT
        u.id,
        COALESCE(u.display_name, 'Anon#' || u.id) AS name,
        MAX(me.score) AS best_score,
        COUNT(*) FILTER (
          WHERE me.placement = 1
            AND m.winner_user_id = me.user_id
        ) AS wins,
        COUNT(*) AS games_played
      FROM match_entrants me
      JOIN matches m ON me.match_id = m.id
      JOIN users u ON me.user_id = u.id
      WHERE m.economy = 'credits_prestige'
        AND m.status = 'finished'
        AND m.ruleset_id <> 'coop-escape'
        AND me.score > 0
        AND ($1::timestamptz IS NULL OR m.ended_at > $1::timestamptz)
      GROUP BY u.id, u.display_name
      ORDER BY best_score DESC
      LIMIT $2
    `, [cutoff, limit]);
}

function soloLeaderboardPolicy(profileId, board) {
    if (board === 'pleb') {
        // Free competitive matches intentionally create durable FREE rows for this board.
        return Object.freeze({
            gameModes: Object.freeze(['FREE']),
            excludeMatchGenerated: false
        });
    }
    if (board !== 'champions') {
        throw new TypeError(`Unsupported solo leaderboard board: ${board}`);
    }

    if (profileId === OPERATED_PRODUCT_PROFILE_IDS.WOW_PRESTIGE) {
        return Object.freeze({
            // The operated Wownero product is credits-only. Historical PAID_SINGLE rows are not
            // part of its current Hall of Champions.
            gameModes: Object.freeze(['PAID_CREDITS']),
            excludeMatchGenerated: true
        });
    }
    if (profileId === OPERATED_PRODUCT_PROFILE_IDS.XMR_STAGENET) {
        return Object.freeze({
            gameModes: Object.freeze(['PAID_SINGLE', 'PAID_CREDITS']),
            excludeMatchGenerated: true
        });
    }

    // Independent MIT deployments retain the generic historical mapping, including an explicitly
    // enabled crypto_race whose synthetic row is represented as PAID_CREDITS.
    return Object.freeze({
        gameModes: Object.freeze(['PAID_SINGLE', 'PAID_CREDITS']),
        excludeMatchGenerated: false
    });
}

async function querySoloLeaderboard(db, {
    profileId = null,
    board = 'pleb',
    period = 'all',
    limit = 20,
    now = new Date()
} = {}) {
    const policy = soloLeaderboardPolicy(profileId, board);
    const cutoff = prestigeCutoff(period, now);
    return db.query(`
      SELECT
        u.id,
        COALESCE(u.display_name,
          CASE WHEN u.payout_address IS NOT NULL
            THEN LEFT(u.payout_address, 4) || '...' || RIGHT(u.payout_address, 4)
            ELSE 'Anon#' || u.id
          END
        ) AS name,
        MAX(g.score) AS best_score,
        COUNT(*) FILTER (WHERE g.status = 'won') AS wins,
        COUNT(*) AS games_played
      FROM games g
      JOIN users u ON g.user_id = u.id
      WHERE g.status IN ('won', 'lost')
        AND g.score > 0
        AND ($1::timestamptz IS NULL OR g.completed_at > $1::timestamptz)
        AND g.game_mode = ANY($2::varchar[])
        AND (
          $3::boolean = FALSE
          OR (
            LEFT(COALESCE(g.outcome, ''), 6) <> 'match_'
            AND NOT EXISTS (
              SELECT 1
              FROM matches source_match
              WHERE source_match.id::text = g.dungeon_seed
            )
          )
        )
      GROUP BY u.id, u.display_name, u.payout_address
      ORDER BY best_score DESC
      LIMIT $4
    `, [cutoff, policy.gameModes, policy.excludeMatchGenerated, limit]);
}

module.exports = {
    normalizeLeaderboardBoard,
    normalizeLeaderboardPeriod,
    prestigeCutoff,
    queryPrestigeLeaderboard,
    querySoloLeaderboard,
    soloLeaderboardPolicy
};
