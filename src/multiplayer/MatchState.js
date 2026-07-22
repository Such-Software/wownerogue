/**
 * MatchState — serialization helpers for MatchRoom.
 *
 * Produces renderer-agnostic and broadcast-safe state objects. The render kit already
 * understands the `gameState` shape from `sceneModel.js`, so the primary job here is to
 * wrap a MatchRoom into that shape and add match-specific metadata.
 */

class MatchState {
    /**
     * Build a spectator/client-friendly game-state object from a MatchRoom.
     * Compatible with `RK.sceneFromGameState()` in `html/js/render/sceneModel.js`.
     * @param {MatchRoom} room
     * @param {string} [viewerId] — if provided, that player is marked `you`
     * @returns {object}
     */
    static toGameState(room, viewerId = null) {
        if (!room) return null;
        return room.toGameState(viewerId);
    }

    /**
     * Build the shared-world snapshot used by Socket.IO broadcasts.
     * @param {MatchRoom} room
     * @returns {object}
     */
    static snapshot(room) {
        if (!room) return null;
        return room.snapshot();
    }

    /**
     * Full state for a joining or reconnecting player.
     * @param {MatchRoom} room
     * @param {string} [viewerId]
     * @returns {object}
     */
    static fullState(room, viewerId = null) {
        if (!room) return null;
        return room.fullState(viewerId);
    }

    /**
     * Flatten a MatchRoom into the persistence shape for `match_events`.
     * @param {MatchRoom} room
     * @param {Array} events — events from the last tick (or full match)
     * @returns {Array}
     */
    static toEventRows(room, events = []) {
        return events.map(ev => ({
            match_id: room.id,
            tick: ev.tick ?? room.tickCount,
            type: ev.type,
            payload: ev
        }));
    }

    /**
     * Flatten a MatchRoom into the persistence shape for `match_entrants` after finalize().
     * @param {MatchRoom} room
     * @returns {Array}
     */
    static toEntrantRows(room) {
        const rows = [];
        for (const [id, state] of room.playerStates.entries()) {
            rows.push({
                match_id: room.id,
                user_id: state.userId,
                socket_id: id,
                placement: state.placement,
                escaped: state.escaped,
                has_treasure: state.hasTreasure,
                killed_by: state.killedBy,
                score: state.score
            });
        }
        return rows;
    }

    /**
     * Build the persistence row for `matches` after the race ends.
     * @param {MatchRoom} room
     * @returns {object}
     */
    static toMatchRow(room) {
        return {
            id: room.id,
            status: room.status,
            economy: room.economy,
            variant: room.variant,
            ruleset_id: room.ruleset?.id || 'race',
            difficulty_preset: room.difficultyPreset,
            max_players: room.maxPlayers,
            seed_hash: room.seedHash,
            seed: room.status === 'finished' ? room.seed : null,
            dungeon: room.seedDerivation
                ? { ...room.dungeon, match_fairness: room.seedDerivation }
                : room.dungeon,
            start_block_height: room.startBlockHeight,
            started_at: room.startedAt ? new Date(room.startedAt) : null,
            ended_at: room.endedAt ? new Date(room.endedAt) : null,
            entry_fee_atomic: room.economy === 'crypto_race' ? room.entryFeeAtomic || 0 : 0,
            pot_atomic: room.economy === 'crypto_race' ? room.potAtomic || 0 : 0,
            house_fee_atomic: room.economy === 'crypto_race' ? room.houseFeeAtomic || 0 : 0,
            house_fee_percent: room.houseFeePercent || 0,
            winner_user_id: room.winnerId ? room.playerStates.get(room.winnerId)?.userId : null
        };
    }
}

module.exports = MatchState;
