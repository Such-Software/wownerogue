/**
 * TavernMatchBridge — connects active match rooms to tavern spectators.
 *
 * Subscribes to MatchManager match events and forwards a lightweight, public-only
 * snapshot of each active race to the tavern Socket.IO room. Tavern clients can then
 * list active races and watch one without leaving the tavern.
 *
 * No game secrets (seed, player input) are forwarded; only public state (positions,
 * standings, winnerId, economy) is broadcast.
 */

class TavernMatchBridge {
    constructor({ matchManager, tavernManager, io, debugManager = null } = {}) {
        this.matchManager = matchManager;
        this.tavernManager = tavernManager;
        this.io = io;
        this.debugManager = debugManager;
        this.enabled = process.env.TAVERN_ENABLED === 'true' && process.env.MATCH_ENABLED === 'true';
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    initialize() {
        if (!this.enabled || !this.matchManager) return;
        // Wrap MatchManager's broadcast method so every match_tick also emits a public
        // summary to the tavern channel.
        const originalOnTick = this.matchManager.onTick.bind(this.matchManager);
        this.matchManager.onTick = (matchId, result) => {
            originalOnTick(matchId, result);
            this._forwardTick(matchId);
        };

        const originalOnFinish = this.matchManager.onFinish.bind(this.matchManager);
        this.matchManager.onFinish = async (room) => {
            await originalOnFinish(room);
            this._forwardEnd(room);
        };

        this._log('[TavernMatchBridge] initialized');
    }

    _forwardTick(matchId) {
        const room = this.matchManager.rooms.get(matchId);
        if (!room) return;
        const payload = this._publicSnapshot(room);
        this.io?.to('tavern:main').emit('tavern_match_tick', payload);
    }

    _forwardEnd(room) {
        const payload = {
            matchId: room.id,
            economy: room.economy,
            status: room.status,
            winnerId: room.winnerId,
            endReason: room.endReason,
            players: Array.from(room.playerStates.entries()).map(([id, state]) => ({
                id,
                placement: state.placement,
                escaped: state.escaped,
                hasTreasure: state.hasTreasure,
                score: state.score
            }))
        };
        this.io?.to('tavern:main').emit('tavern_match_end', payload);
    }

    _publicSnapshot(room) {
        // Use the same renderer contract as a player match tick, but copy only explicitly public
        // fields. In particular, the committed seed hash is public while the unrevealed seed and
        // internal event/input state never cross into the tavern feed.
        const renderState = typeof room.toGameState === 'function' ? room.toGameState() : null;
        const fallbackMap = room.dungeon?.map || [];
        const players = renderState?.players || Array.from(room.occupants.values()).map(o => {
            const s = room.playerStates.get(o.id);
            return {
                id: o.id,
                x: o.x,
                y: o.y,
                name: o.name || null,
                avatar: o.avatar,
                appearance: o.appearance,
                facing: o.facing,
                alive: s ? s.alive : true,
                finished: s ? s.finished : false,
                escaped: s ? s.escaped : false,
                hasTreasure: s ? s.hasTreasure : false,
                placement: s ? s.placement : null
            };
        });
        return {
            matchId: room.id,
            economy: room.economy,
            variant: room.variant || renderState?.variant || 'race',
            rulesetId: room.ruleset?.id || room.variant || 'race',
            ruleset: renderState?.ruleset || (room._rulesetSummary?.() || null),
            status: room.status,
            tick: room.tickCount,
            visibleTiles: renderState?.visibleTiles || fallbackMap,
            exploredTiles: renderState?.exploredTiles || fallbackMap,
            lighting: renderState?.lighting || {},
            dungeonRows: renderState?.dungeonRows || room.rows || fallbackMap.length,
            dungeonCols: renderState?.dungeonCols || room.cols || fallbackMap[0]?.length || 0,
            players,
            monster: renderState?.monster || (room.monster ? { x: room.monster.x, y: room.monster.y } : null),
            treasure: renderState?.treasure || room.treasure,
            entrance: renderState?.entrance || room.dungeon?.entrance || null,
            exit: renderState?.exit || room.dungeon?.exit || null,
            winnerId: room.winnerId,
            endReason: room.endReason || null,
            seedHash: room.seedHash
        };
    }

    /**
     * Return a list of currently active matches for the tavern game-list UI.
     */
    getActiveMatches() {
        if (!this.matchManager) return [];
        const list = [];
        for (const [id, room] of this.matchManager.rooms.entries()) {
            list.push(this._publicSnapshot(room));
        }
        return list;
    }
}

module.exports = TavernMatchBridge;
