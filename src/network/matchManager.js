/**
 * MatchManager — Socket.IO transport and lifecycle for match mode.
 *
 * Owns active MatchRooms, their MatchEngines, socket-to-match mapping, and broadcasts.
 * Also handles reconnect grace (a disconnected player can rejoin the same match within a
 * short window).
 */

const { v4: uuidv4 } = require('uuid');
const MatchRoom = require('../multiplayer/MatchRoom');
const MatchEngine = require('../multiplayer/MatchEngine');
const MatchState = require('../multiplayer/MatchState');
const MatchPayoutService = require('./matchPayoutService');
const MatchLeaderboard = require('./matchLeaderboard');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

const RECONNECT_GRACE_MS = 30000; // 30s to reconnect during an active match

class MatchManager {
    constructor({ io, db, debugManager, identityService = null, chatProvider = null } = {}) {
        this.io = io;
        this.db = db;
        this.debugManager = debugManager;
        this.identityService = identityService;
        this.chatProvider = chatProvider;
        this.enabled = process.env.MATCH_ENABLED === 'true';

        this.rooms = new Map();        // matchId -> MatchRoom
        this.engines = new Map();      // matchId -> MatchEngine
        this.socketToMatch = new Map(); // socketId -> matchId
        this.userToMatch = new Map();   // userId -> matchId
        this.disconnectTimeouts = new Map(); // matchId:socketId -> timeout id
        this.matchLeaderboard = new MatchLeaderboard({ db: this.db, io: this.io, debugManager: this.debugManager });
        this.matchPayoutService = new MatchPayoutService({
            db: this.db,
            walletService: null,
            gameModeManager: null,
            debugManager: this.debugManager
        });
        this.gameModeManager = null; // set via attach options

        // Last-known movement per socket for flood control.
        this._lastMoveAt = new Map();
        this.moveCooldownMs = 60;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING || CONSOLE_LOGGING) console.log(...args);
    }

    /**
     * Attach a MatchRoom that was just created by MatchScheduler. The entrants array
     * contains { userId, socketId, sessionToken } objects from the queue.
     */
    attach(room, entrants, { tickMs = 250, minDurationMs = 20000, hardCeilingMs = 240000, db = null, gameModeManager = null } = {}) {
        if (!this.enabled) return;
        if (db) this.db = db;
        this.gameModeManager = gameModeManager;
        if (gameModeManager && this.matchPayoutService) this.matchPayoutService.gameModeManager = gameModeManager;
        this.rooms.set(room.id, room);
        for (const e of entrants) {
            this.socketToMatch.set(e.socketId, room.id);
            this.userToMatch.set(e.userId, room.id);
        }

        // Resolve display names and appearances from identity service (best-effort).
        this._hydrateEntrants(room, entrants).catch(err => this._log('[MatchManager] hydrate error', err.message));

        this._log(`[MatchManager] attached match ${room.id} with ${entrants.length} entrants`);

        // Notify players.
        for (const e of entrants) {
            const socket = this.io.sockets.sockets.get(e.socketId);
            if (socket) {
                socket.join(this._channel(room.id));
                socket.emit('match_joined', {
                    matchId: room.id,
                    economy: room.economy,
                    seedHash: room.seedHash,
                    players: Array.from(room.occupants.values()).map(o => o.getState()),
                    countdownMs: 3000
                });
            }
        }

        // Start countdown before first tick.
        setTimeout(() => {
            room.start();
            this._broadcast(room.id, 'match_start', { matchId: room.id, tickMs, seedHash: room.seedHash });
        }, 3000);

        // Minimum-duration watchdog: prevent next-block expiry before floor.
        const floorTimeout = setTimeout(() => {
            room._minDurationMet = true;
        }, minDurationMs);

        // Hard ceiling watchdog.
        const ceilingTimeout = setTimeout(() => this.expire(room.id, 'hard_ceiling'), hardCeilingMs);

        room._watchdogs = [floorTimeout, ceilingTimeout];
    }

    async _hydrateEntrants(room, entrants) {
        if (!this.identityService) return;
        for (const e of entrants) {
            try {
                const user = await this.identityService.userForId(e.userId);
                if (user) {
                    const entitlements = await this.identityService.entitlementsForUser(user);
                    const appearance = require('../multiplayer/entitlements').normalizeAppearance(
                        require('../multiplayer/appearance').parseAppearance(user.appearance),
                        entitlements
                    );
                    const occ = room.occupants.get(e.socketId);
                    if (occ) {
                        occ.name = user.display_name || user.username || null;
                        occ.avatar = appearance.avatar;
                        occ.appearance = appearance;
                    }
                }
            } catch (err) {
                this._log('[MatchManager] hydrate entrant error', err.message);
            }
        }
    }

    setEngine(matchId, engine) {
        this.engines.set(matchId, engine);
    }

    _channel(matchId) {
        return `match:${matchId}`;
    }

    _broadcast(matchId, event, payload) {
        if (!this.io) return;
        this.io.to(this._channel(matchId)).emit(event, payload);
    }

    /**
     * Called by MatchEngine every tick.
     */
    onTick(matchId, result) {
        const room = this.rooms.get(matchId);
        if (!room) return;
        this._broadcast(matchId, 'match_tick', {
            matchId,
            tick: result.tick,
            events: result.events,
            state: room.toGameState()
        });
    }

    /**
     * Called when a match ends naturally.
     */
    async onFinish(room) {
        await this._finalize(room);
    }

    /**
     * Force-end a match (block deadline, hard ceiling, admin abort).
     */
    expire(matchId, reason) {
        const engine = this.engines.get(matchId);
        const room = this.rooms.get(matchId);
        if (!room) return;
        if (engine) {
            engine.expire(reason);
        } else {
            room.expire(reason);
            room.finalize();
            this._finalize(room).catch(err => this._log('[MatchManager] finalize error', err.message));
        }
    }

    async _finalize(room) {
        if (room._finalized) return;
        room._finalized = true;

        // Clear watchdogs.
        if (room._watchdogs) room._watchdogs.forEach(id => clearTimeout(id));

        // Persist results.
        if (this.db) {
            await this._persistFinish(room);
        }
        await this.matchLeaderboard.postMatch(room);
        if (room.economy === 'crypto_race') {
            await this.matchPayoutService.payoutWinner(room);
        }

        // Notify clients.
        this._broadcast(room.id, 'match_end', {
            matchId: room.id,
            reason: room.endReason,
            winnerId: room.winnerId,
            players: Array.from(room.playerStates.entries()).map(([id, state]) => {
                const occ = room.occupants.get(id);
                return {
                    id,
                    name: occ?.name || null,
                    placement: state.placement,
                    escaped: state.escaped,
                    hasTreasure: state.hasTreasure,
                    score: state.score,
                    killedBy: state.killedBy
                };
            })
        });

        // Clean up mappings after a grace period so late reconnects still get the result.
        setTimeout(() => this._cleanup(room.id), 30000);
    }

    async _persistFinish(room) {
        await this.db.withTransaction(async (client) => {
            await client.query(`
                UPDATE matches
                SET status = 'finished',
                    seed = $1,
                    end_block_height = $2,
                    started_at = COALESCE(started_at, $3),
                    ended_at = NOW(),
                    winner_user_id = $4
                WHERE id = $5
            `, [
                room.seed,
                room.endBlockHeight || null,
                room.startedAt ? new Date(room.startedAt) : null,
                room.winnerId ? room.playerStates.get(room.winnerId)?.userId : null,
                room.id
            ]);

            for (const [socketId, state] of room.playerStates.entries()) {
                await client.query(`
                    UPDATE match_entrants
                    SET placement = $1,
                        escaped = $2,
                        has_treasure = $3,
                        killed_by = $4,
                        score = $5,
                        entry_consumed = TRUE
                    WHERE match_id = $6 AND socket_id = $7
                `, [state.placement, state.escaped, state.hasTreasure, state.killedBy, state.score, room.id, socketId]);
            }

            // Persist event log.
            const rows = MatchState.toEventRows(room, room.events);
            for (const row of rows) {
                await client.query(`
                    INSERT INTO match_events (match_id, tick, type, payload)
                    VALUES ($1, $2, $3, $4)
                `, [row.match_id, row.tick, row.type, JSON.stringify(row.payload)]);
            }
        });
    }

    _cleanup(matchId) {
        const room = this.rooms.get(matchId);
        if (room) {
            for (const occ of room.occupants.values()) {
                this.socketToMatch.delete(occ.id);
            }
            for (const [uid] of room.playerStates.entries()) {
                // userToMatch is keyed by socketId today; cleanup is best-effort.
            }
        }
        this.rooms.delete(matchId);
        this.engines.delete(matchId);
    }

    /**
     * Socket.IO handler: move request.
     */
    move(socket, data) {
        if (!this.enabled) return;
        if (db) this.db = db;
        this.gameModeManager = gameModeManager;
        if (gameModeManager && this.matchPayoutService) this.matchPayoutService.gameModeManager = gameModeManager;
        const now = Date.now();
        const last = this._lastMoveAt.get(socket.id) || 0;
        if (now - last < this.moveCooldownMs) return;
        this._lastMoveAt.set(socket.id, now);

        const matchId = this.socketToMatch.get(socket.id);
        if (!matchId) return;
        const room = this.rooms.get(matchId);
        if (!room) return;

        const dx = Math.sign(Number(data.dx) || 0);
        const dy = Math.sign(Number(data.dy) || 0);
        if (Math.abs(dx) + Math.abs(dy) !== 1) return;

        room.queueMove(socket.id, dx, dy);
    }

    /**
     * Socket.IO handler: leave an active match (forfeit).
     */
    leave(socket) {
        const matchId = this.socketToMatch.get(socket.id);
        if (!matchId) return;
        const room = this.rooms.get(matchId);
        if (!room) return;

        room._killPlayer(socket.id, 'forfeit');
        this._broadcast(matchId, 'player_forfeit', { id: socket.id });

        if (room.activePlayerCount === 0 && room.finishCount === 0 && room.status === 'active') {
            room.expire('all_forfeit');
            const engine = this.engines.get(matchId);
            if (engine) engine.stop();
            room.finalize();
            this._finalize(room).catch(err => this._log('[MatchManager] forfeit finalize error', err.message));
        }
    }

    /**
     * Handle disconnect: start grace timer, then mark AFK-dead if not reconnected.
     */
    handleDisconnect(socketId, userId) {
        const matchId = this.socketToMatch.get(socketId);
        if (!matchId) return;

        const key = `${matchId}:${socketId}`;
        if (this.disconnectTimeouts.has(key)) return;

        const timeout = setTimeout(() => {
            this.disconnectTimeouts.delete(key);
            const room = this.rooms.get(matchId);
            if (!room) return;
            const state = room.playerStates.get(socketId);
            if (state && state.alive && !state.finished) {
                room._killPlayer(socketId, 'afk');
                this._broadcast(matchId, 'player_death', { id: socketId, killedBy: 'afk' });
                if (room.activePlayerCount === 0 && room.finishCount === 0 && room.status === 'active') {
                    room.expire('all_dead');
                    const engine = this.engines.get(matchId);
                    if (engine) engine.stop();
                    room.finalize();
                    this._finalize(room).catch(err => this._log('[MatchManager] afk finalize error', err.message));
                }
            }
        }, RECONNECT_GRACE_MS);

        this.disconnectTimeouts.set(key, timeout);
    }

    /**
     * Handle reconnect: reattach socket to active match.
     */
    handleReconnect(socket, userId, sessionToken) {
        let matchId = this.socketToMatch.get(socket.id);
        if (!matchId) {
            // Old socket gone; try user-to-match map.
            matchId = this.userToMatch.get(userId);
        }
        if (!matchId) return false;

        const room = this.rooms.get(matchId);
        if (!room) return false;

        // Cancel disconnect timeout.
        const oldKey = `${matchId}:${socket.id}`;
        const timeout = this.disconnectTimeouts.get(oldKey);
        if (timeout) {
            clearTimeout(timeout);
            this.disconnectTimeouts.delete(oldKey);
        }

        // Update mappings if the socket id changed.
        this.socketToMatch.set(socket.id, matchId);
        socket.join(this._channel(matchId));

        // Update occupant id if it differs (e.g. socket reconnect).
        const occ = room.occupants.get(socket.id);
        if (!occ) {
            // The old socket id may be the key in the room. Try to migrate by userId.
            for (const [oldId, state] of room.playerStates.entries()) {
                if (state.userId === userId) {
                    const oldOcc = room.occupants.get(oldId);
                    if (oldOcc) {
                        room.occupants.delete(oldId);
                        room.occupants.set(socket.id, oldOcc);
                        this.socketToMatch.delete(oldId);
                        this.socketToMatch.set(socket.id, matchId);
                    }
                    break;
                }
            }
        }

        // Send full state.
        socket.emit('match_rejoined', {
            matchId,
            state: room.toGameState(socket.id)
        });

        return true;
    }

    /**
     * Public stats for admin/health endpoints.
     */
    getStats() {
        const active = [];
        for (const [id, room] of this.rooms.entries()) {
            active.push({
                id,
                economy: room.economy,
                status: room.status,
                tick: room.tickCount,
                players: room.occupants.size,
                active: room.activePlayerCount,
                finished: room.finishCount
            });
        }
        return { activeMatches: active.length, matches: active };
    }

    shutdown() {
        for (const [key, timeout] of this.disconnectTimeouts.entries()) {
            clearTimeout(timeout);
        }
        this.disconnectTimeouts.clear();
        for (const [id, room] of this.rooms.entries()) {
            if (room._watchdogs) room._watchdogs.forEach(t => clearTimeout(t));
            const engine = this.engines.get(id);
            if (engine) engine.stop();
        }
        this.rooms.clear();
        this.engines.clear();
    }
}

module.exports = MatchManager;
