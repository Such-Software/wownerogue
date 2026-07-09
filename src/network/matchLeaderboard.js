/**
 * MatchLeaderboard — post-race leaderboard integration.
 *
 * At the end of every match, this module decides which leaderboard each entrant's score
 * belongs to:
 *   • free races            → Pleb board (game_mode = 'FREE')
 *   • credits_prestige races → Prestige board (prestige_leaderboard view)
 *   • crypto_race races     → Hall of Champions (games-like paid board)
 *
 * For free and crypto_race we insert a synthetic `games` row if the instance wants those
 * scores surfaced on the existing boards. For prestige we rely on the `prestige_leaderboard`
 * view driven directly from `match_entrants`.
 */

class MatchLeaderboard {
    constructor({ db, io = null, debugManager = null } = {}) {
        this.db = db;
        this.io = io;
        this.debugManager = debugManager;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    /**
     * Persist scores and emit leaderboard_update where appropriate.
     * @param {MatchRoom} room
     */
    async postMatch(room) {
        if (!this.db || room.status !== 'finished') return;

        const economy = room.economy;

        if (economy === 'free') {
            await this._postFreeToPleb(room);
        } else if (economy === 'credits_prestige') {
            await this._postPrestige(room);
        } else if (economy === 'crypto_race') {
            await this._postCryptoRace(room);
        }
    }

    async _postFreeToPleb(room) {
        // Insert synthetic solo-style records so free races show up on the Pleb board.
        // Columns are the REAL games columns (treasure_found, moves_made); dungeon_seed is the
        // match UUID (36 chars, fits VARCHAR(50)) — never the 64-char seedHash which overflows.
        await this.db.withTransaction(async (client) => {
            for (const [socketId, state] of room.playerStates.entries()) {
                if (!state.userId || state.score <= 0) continue;
                await client.query(`
                    INSERT INTO games (user_id, socket_id, game_mode, status, outcome, treasure_found, moves_made, duration_seconds, score, dungeon_seed, created_at, completed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
                `, [
                    state.userId,
                    socketId,
                    'FREE',
                    state.escaped ? 'won' : 'lost',
                    state.escaped ? 'escaped' : (state.killedBy || 'timeout'),
                    state.hasTreasure,
                    state.moves,
                    Math.max(1, Math.round(((room.endedAt || Date.now()) - (room.startedAt || room.createdAt)) / 1000)),
                    state.score,
                    room.id
                ]);

                await client.query(`
                    UPDATE users SET high_score = GREATEST(COALESCE(high_score, 0), $1) WHERE id = $2
                `, [state.score, state.userId]);
            }
        });

        this._broadcastUpdate('pleb');
    }

    async _postPrestige(room) {
        // Scores are already persisted to match_entrants. The prestige_leaderboard view reads
        // them directly, so we just broadcast an update so open leaderboards refresh.
        this._broadcastUpdate('prestige');
    }

    async _postCryptoRace(room) {
        // Insert synthetic paid records for the Hall of Champions board. Real columns
        // (treasure_found, moves_made); dungeon_seed is the match UUID, not the 64-char seedHash.
        await this.db.withTransaction(async (client) => {
            for (const [socketId, state] of room.playerStates.entries()) {
                if (!state.userId || state.score <= 0) continue;
                await client.query(`
                    INSERT INTO games (user_id, socket_id, game_mode, status, outcome, treasure_found, moves_made, duration_seconds, score, dungeon_seed, created_at, completed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
                `, [
                    state.userId,
                    socketId,
                    'PAID_CREDITS',
                    state.escaped ? 'won' : 'lost',
                    state.escaped ? 'escaped' : (state.killedBy || 'timeout'),
                    state.hasTreasure,
                    state.moves,
                    Math.max(1, Math.round(((room.endedAt || Date.now()) - (room.startedAt || room.createdAt)) / 1000)),
                    state.score,
                    room.id
                ]);

                await client.query(`
                    UPDATE users SET high_score = GREATEST(COALESCE(high_score, 0), $1) WHERE id = $2
                `, [state.score, state.userId]);
            }
        });

        this._broadcastUpdate('champions');
    }

    _broadcastUpdate(board) {
        if (!this.io) return;
        this.io.emit('leaderboard_update', { board, at: Date.now() });
    }
}

module.exports = MatchLeaderboard;
