'use strict';

const PERIOD_MS = Object.freeze({
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
});

function normalizeLeaderboardPeriod(value) {
    const period = String(value || 'all').toLowerCase();
    return Object.prototype.hasOwnProperty.call(PERIOD_MS, period) ? period : 'all';
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

module.exports = {
    normalizeLeaderboardPeriod,
    prestigeCutoff,
    queryPrestigeLeaderboard
};
