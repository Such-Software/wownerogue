/**
 * MatchManager — Socket.IO transport and lifecycle for match mode.
 *
 * Owns active MatchRooms, their MatchEngines, socket/user-to-match mappings, broadcasts, the
 * real pre-race countdown, and end-of-match finalization (payout, persistence, leaderboard,
 * broadcast). Also handles reconnect grace: a disconnected player can rejoin the same match
 * within a short window and is re-mapped across ALL room state.
 *
 * Server-authoritative throughout: every move is validated, occupancy is solid, and the room
 * stays in 'starting' (moves rejected) until the countdown elapses so an honest client and a
 * modified client always start together.
 */

const MatchState = require('../multiplayer/MatchState');
const MatchPayoutService = require('./matchPayoutService');
const MatchLeaderboard = require('./matchLeaderboard');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

const RECONNECT_GRACE_MS = 30000; // 30s to reconnect during an active match before AFK-kill
const DEFAULT_COUNTDOWN_MS = 3000;
const FINALIZE_CLEANUP_MS = 30000; // keep mappings this long after finish for late reconnects

class MatchManager {
    constructor({ io, db, debugManager, identityService = null, gameModeManager = null, chatProvider = null } = {}) {
        this.io = io;
        this.db = db;
        this.debugManager = debugManager;
        this.identityService = identityService;
        this.chatProvider = chatProvider;
        this.gameModeManager = gameModeManager; // socketHandlers injects this so payouts/entry-fee reads work
        this.enabled = process.env.MATCH_ENABLED === 'true';

        this.rooms = new Map();        // matchId -> MatchRoom
        this.engines = new Map();      // matchId -> MatchEngine
        this.socketToMatch = new Map(); // socketId -> matchId
        this.userToMatch = new Map();   // userId  -> matchId
        this.disconnectTimeouts = new Map(); // `${matchId}:${socketId}` -> timeout id
        this._pendingCleanups = new Set();   // grace-cleanup timers awaiting fire

        this.matchLeaderboard = new MatchLeaderboard({ db: this.db, io: this.io, debugManager: this.debugManager });
        this.matchPayoutService = new MatchPayoutService({
            db: this.db,
            walletService: this.gameModeManager?.walletService || null,
            gameModeManager: this.gameModeManager,
            debugManager: this.debugManager
        });

        // Last-known movement per socket for flood control.
        this._lastMoveAt = new Map();
        this.moveCooldownMs = 60;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING || CONSOLE_LOGGING) console.log(...args);
    }

    /**
     * Optional init hook (socketHandlers calls it after MatchQueue.initialize()). In-memory
     * state is empty on boot; abandoned in-flight matches are recovered and refunded by
     * MatchQueue.initialize() (the money authority), so there is nothing to rebuild here.
     */
    initialize() { /* no-op: boot recovery lives in MatchQueue.initialize() */ }

    /**
     * Attach a MatchRoom that MatchScheduler just created and (for crypto) already collected
     * the pot for. Notifies entrants, runs the real countdown, and owns all lifecycle timers.
     * @param {MatchRoom} room
     * @param {Array<{userId:number, socketId:string, sessionToken:string}>} entrants
     */
    attach(room, entrants, { tickMs = 250, minDurationMs = 20000, hardCeilingMs = 240000, countdownMs = DEFAULT_COUNTDOWN_MS, db = null, gameModeManager = null } = {}) {
        if (!this.enabled || !room) return;
        if (db) this.db = db;
        if (gameModeManager) this.gameModeManager = gameModeManager;
        // Keep the payout service pointed at the live db + gameModeManager.
        if (this.matchPayoutService) {
            if (this.db) this.matchPayoutService.db = this.db;
            if (this.gameModeManager) this.matchPayoutService.gameModeManager = this.gameModeManager;
        }
        if (this.matchLeaderboard && this.db) this.matchLeaderboard.db = this.db;

        this.rooms.set(room.id, room);
        for (const e of (entrants || [])) {
            this.socketToMatch.set(e.socketId, room.id);
            this.userToMatch.set(e.userId, room.id);
        }

        // Resolve display names and appearances from identity service (best-effort).
        this._hydrateEntrants(room, entrants).catch(err => this._log('[MatchManager] hydrate error', err.message));

        this._log(`[MatchManager] attached match ${room.id} with ${(entrants || []).length} entrants`);

        // Notify players (they will render a countdown; the server enforces it authoritatively).
        for (const e of (entrants || [])) {
            const socket = this.io?.sockets?.sockets?.get(e.socketId);
            if (socket) {
                socket.join(this._channel(room.id));
                socket.emit('match_joined', {
                    matchId: room.id,
                    economy: room.economy,
                    seedHash: room.seedHash,
                    players: Array.from(room.occupants.values()).map(o => o.getState()),
                    countdownMs
                });
            }
        }

        // MP-H6: REAL countdown. The room stays in 'starting' (moves rejected) until this
        // fires; only then does the engine begin ticking, so honest and modified clients start
        // together — no head-start cheat is possible.
        const startTimer = setTimeout(() => {
            const r = this.rooms.get(room.id);
            if (!r || r.status !== 'starting') return; // expired/finalized during the countdown
            const engine = this.engines.get(room.id);
            if (engine && typeof engine.start === 'function') engine.start(); // activates room + ticks
            else r.start();
            // Reflect the now-live race in the DB (was left 'starting' during the countdown). This
            // lets boot recovery distinguish a genuinely-running race from an abandoned one, and it
            // stamps started_at so the age-guarded (multi-instance) recovery path won't reclaim a
            // race that is legitimately in flight.
            if (this.db) {
                this.db.query(
                    `UPDATE matches SET status = 'active', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'starting'`,
                    [room.id]
                ).catch(err => this._log('[MatchManager] mark-active error', err.message));
            }
            this._broadcast(room.id, 'match_start', { matchId: room.id, tickMs, seedHash: r.seedHash });
        }, countdownMs);

        // Minimum-duration watchdog: prevents a next-block expiry before the floor.
        const floorTimeout = setTimeout(() => { const r = this.rooms.get(room.id); if (r) r._minDurationMet = true; }, minDurationMs);

        // Hard-ceiling watchdog: absolute max match length. Single owner (the scheduler no
        // longer sets its own ceiling timer), cleared by _finalize so it never fires on a
        // finished/removed room.
        const ceilingTimeout = setTimeout(() => this.expire(room.id, 'hard_ceiling'), hardCeilingMs);

        room._watchdogs = [startTimer, floorTimeout, ceilingTimeout];
    }

    async _hydrateEntrants(room, entrants) {
        if (!this.identityService) return;
        for (const e of (entrants || [])) {
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
     * Called when a match ends naturally (engine detected finished).
     */
    async onFinish(room) {
        await this._finalize(room);
    }

    /**
     * Force-end a match (block deadline, hard ceiling, admin abort). Idempotent.
     */
    expire(matchId, reason) {
        const room = this.rooms.get(matchId);
        if (!room || room._finalized) return;
        const engine = this.engines.get(matchId);
        if (engine) {
            engine.expire(reason); // room.expire + finalize + onFinish -> _finalize
        } else {
            room.expire(reason);
            room.finalize();
            this._finalize(room).catch(err => this._log('[MatchManager] finalize error', err.message));
        }
    }

    /**
     * End a match immediately from a manager-side trigger (forfeit / AFK wipeout). Idempotent
     * via room._finalized.
     */
    _endNow(room, reason) {
        if (!room || room._finalized) return;
        const engine = this.engines.get(room.id);
        if (room.status !== 'finished') room.expire(reason);
        if (engine) { try { engine.stop(); } catch (_) {} }
        room.finalize();
        this._finalize(room).catch(err => this._log('[MatchManager] endNow finalize error', err.message));
    }

    async _finalize(room) {
        if (!room || room._finalized) return;
        room._finalized = true;

        // Clear lifecycle watchdogs (countdown, floor, hard ceiling) so none fire post-finish.
        if (room._watchdogs) { room._watchdogs.forEach(id => clearTimeout(id)); room._watchdogs = null; }
        // Clear any pending AFK timers for this match.
        this._clearDisconnectTimers(room.id);
        // Stop the engine if it is still ticking.
        const engine = this.engines.get(room.id);
        if (engine) { try { engine.stop(); } catch (_) {} }

        // Each step is isolated in its OWN try/catch so a failure in one NEVER prevents the
        // winner payout or the match_end broadcast. The winner PAYOUT runs FIRST.
        // 1. Winner payout (crypto only).
        if (room.economy === 'crypto_race') {
            try { await this.matchPayoutService.payoutWinner(room); }
            catch (err) { this._log('[MatchManager] payout error', err.message); }
        }
        // 2. Persist match + entrant results.
        if (this.db) {
            try { await this._persistFinish(room); }
            catch (err) { this._log('[MatchManager] persist error', err.message); }
        }
        // 3. Leaderboard integration.
        try { await this.matchLeaderboard.postMatch(room); }
        catch (err) { this._log('[MatchManager] leaderboard error', err.message); }
        // 4. Broadcast the result (always attempted).
        try {
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
        } catch (err) { this._log('[MatchManager] broadcast error', err.message); }

        // 5. Drop all mappings after a grace period so late reconnects still resolve the result.
        const cleanupTimer = setTimeout(() => {
            this._pendingCleanups.delete(cleanupTimer);
            this._cleanup(room.id);
        }, FINALIZE_CLEANUP_MS);
        this._pendingCleanups.add(cleanupTimer);
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

    _clearDisconnectTimers(matchId) {
        const prefix = `${matchId}:`;
        for (const [key, t] of this.disconnectTimeouts.entries()) {
            if (key.startsWith(prefix)) {
                clearTimeout(t);
                this.disconnectTimeouts.delete(key);
            }
        }
    }

    /**
     * Drop every mapping owned by a finished match. Previously the userToMatch loop was a
     * no-op; it now actually deletes by userId, and socketToMatch / _lastMoveAt are cleared for
     * every occupant (including re-keyed ones).
     */
    _cleanup(matchId) {
        const room = this.rooms.get(matchId);
        if (room) {
            for (const occ of room.occupants.values()) {
                this.socketToMatch.delete(occ.id);
                this._lastMoveAt.delete(occ.id);
            }
            for (const state of room.playerStates.values()) {
                if (state.userId != null && this.userToMatch.get(state.userId) === matchId) {
                    this.userToMatch.delete(state.userId);
                }
            }
        }
        // Belt-and-suspenders: remove any lingering maps that still point at this match.
        for (const [sid, mid] of this.socketToMatch.entries()) {
            if (mid === matchId) this.socketToMatch.delete(sid);
        }
        for (const [uid, mid] of this.userToMatch.entries()) {
            if (mid === matchId) this.userToMatch.delete(uid);
        }
        this._clearDisconnectTimers(matchId);
        this.rooms.delete(matchId);
        this.engines.delete(matchId);
    }

    /**
     * Socket.IO handler: move request. Null-safe; a benign no-op when match mode is disabled,
     * the socket isn't in a match, or the room hasn't reached 'active' yet (MP-H6 countdown).
     */
    move(socket, data) {
        if (!this.enabled || !socket) return;

        const now = Date.now();
        const last = this._lastMoveAt.get(socket.id) || 0;
        if (now - last < this.moveCooldownMs) return;
        this._lastMoveAt.set(socket.id, now);

        const matchId = this.socketToMatch.get(socket.id);
        if (!matchId) return;
        const room = this.rooms.get(matchId);
        if (!room) return;
        // Reject moves until the countdown elapses and the room is active (no head-start cheat).
        if (room.status !== 'active') return;

        const d = (data && typeof data === 'object') ? data : {};
        const dx = Math.sign(Number(d.dx) || 0);
        const dy = Math.sign(Number(d.dy) || 0);
        if (Math.abs(dx) + Math.abs(dy) !== 1) return;

        room.queueMove(socket.id, dx, dy);
    }

    /**
     * Socket.IO handler: leave an active match (forfeit).
     */
    leave(socket) {
        if (!this.enabled || !socket) return;
        const matchId = this.socketToMatch.get(socket.id);
        if (!matchId) return;
        const room = this.rooms.get(matchId);
        if (!room) return;

        const state = room.playerStates.get(socket.id);
        if (!state || !state.alive || state.finished) return; // nothing to forfeit

        room._killPlayer(socket.id, 'forfeit');
        this._broadcast(matchId, 'player_forfeit', { id: socket.id });

        // Clear any pending AFK timer for this socket.
        const key = `${matchId}:${socket.id}`;
        const t = this.disconnectTimeouts.get(key);
        if (t) { clearTimeout(t); this.disconnectTimeouts.delete(key); }

        // _killPlayer flips the room to 'finished' when it was the last active player.
        if (room.status === 'finished') {
            this._endNow(room, room.endReason || 'all_forfeit');
        }
    }

    /**
     * Handle disconnect: start a grace timer, then AFK-kill only if the player never reconnects.
     * Takes the live socket (identity is resolved from the connection, never the client).
     */
    handleDisconnect(socket) {
        if (!this.enabled || !socket) return;
        const socketId = socket.id;
        const matchId = this.socketToMatch.get(socketId);
        if (!matchId) return;

        const key = `${matchId}:${socketId}`;
        if (this.disconnectTimeouts.has(key)) return;

        // Only arm the AFK timer for a player still in the race.
        const room0 = this.rooms.get(matchId);
        const st0 = room0?.playerStates.get(socketId);
        if (!st0 || !st0.alive || st0.finished) return;

        const timeout = setTimeout(() => {
            this.disconnectTimeouts.delete(key);
            const room = this.rooms.get(matchId);
            if (!room || room.status !== 'active') return;
            const state = room.playerStates.get(socketId);
            if (state && state.alive && !state.finished) {
                room._killPlayer(socketId, 'afk');
                this._broadcast(matchId, 'player_death', { id: socketId, killedBy: 'afk' });
                if (room.status === 'finished') {
                    this._endNow(room, room.endReason || 'all_dead');
                }
            }
        }, RECONNECT_GRACE_MS);

        this.disconnectTimeouts.set(key, timeout);
    }

    /**
     * Handle reconnect: re-map a player from their OLD socket id to the new one across ALL room
     * state (occupants, playerStates, moveQueue, treasure carrier, winner) and manager maps,
     * clear the AFK timeout keyed by the OLD id, and never AFK-kill a reconnected player.
     * Ownership is verified: the reconnecting session must own the racer it attaches to.
     * @param {object} socket   live socket (socket.id is the NEW id)
     * @param {{userId:number, sessionToken?:string, socketId?:string}} session
     * @returns {boolean}
     */
    handleReconnect(socket, session) {
        if (!this.enabled || !socket || !session) return false;
        const userId = session.userId;
        if (userId == null) return false;
        const newId = socket.id;

        // Find the match this user belongs to (user map first — socket id has changed).
        let matchId = this.userToMatch.get(userId);
        if (!matchId) matchId = this.socketToMatch.get(newId) || null;
        if (!matchId) return false;

        const room = this.rooms.get(matchId);
        if (!room) return false;

        // Locate the OLD state key for this user and verify ownership. Matching by userId (the
        // stable DB id resolved from the connection) means a client can NEVER attach to another
        // player's racer.
        let oldId = null;
        for (const [id, state] of room.playerStates.entries()) {
            if (state.userId === userId) { oldId = id; break; }
        }
        if (oldId == null) return false;
        const ownerState = room.playerStates.get(oldId);
        if (!ownerState || ownerState.userId !== userId) return false;

        // Clear the AFK disconnect timeout keyed by the OLD id (and defensively the new id).
        for (const k of [`${matchId}:${oldId}`, `${matchId}:${newId}`]) {
            const t = this.disconnectTimeouts.get(k);
            if (t) { clearTimeout(t); this.disconnectTimeouts.delete(k); }
        }

        // Re-key ALL room + manager state from old -> new when the socket id changed.
        if (oldId !== newId) {
            const occ = room.occupants.get(oldId);
            if (occ) {
                room.occupants.delete(oldId);
                occ.id = newId;
                room.occupants.set(newId, occ);
            }
            const st = room.playerStates.get(oldId);
            if (st) {
                room.playerStates.delete(oldId);
                room.playerStates.set(newId, st);
            }
            if (room.moveQueue && room.moveQueue.has(oldId)) {
                const mv = room.moveQueue.get(oldId);
                room.moveQueue.delete(oldId);
                room.moveQueue.set(newId, mv);
            }
            if (room.treasure && room.treasure.carrierId === oldId) room.treasure.carrierId = newId;
            if (room.winnerId === oldId) room.winnerId = newId;
            this.socketToMatch.delete(oldId);
            this._lastMoveAt.delete(oldId);
        }

        this.socketToMatch.set(newId, matchId);
        this.userToMatch.set(userId, matchId);
        socket.join(this._channel(matchId));

        socket.emit('match_rejoined', {
            matchId,
            state: room.toGameState(newId)
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
        for (const [, timeout] of this.disconnectTimeouts.entries()) clearTimeout(timeout);
        this.disconnectTimeouts.clear();
        for (const t of this._pendingCleanups) clearTimeout(t);
        this._pendingCleanups.clear();
        for (const [id, room] of this.rooms.entries()) {
            if (room._watchdogs) { room._watchdogs.forEach(t => clearTimeout(t)); room._watchdogs = null; }
            const engine = this.engines.get(id);
            if (engine) { try { engine.stop(); } catch (_) {} }
        }
        this.rooms.clear();
        this.engines.clear();
        this.socketToMatch.clear();
        this.userToMatch.clear();
        this._lastMoveAt.clear();
    }
}

module.exports = MatchManager;
