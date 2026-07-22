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
const { createFinancialRecoveryError } = require('../utils/financialRecoveryError');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

const RECONNECT_GRACE_MS = 30000; // 30s to reconnect during an active match before AFK-kill
const DEFAULT_COUNTDOWN_MS = 3000;
const FINALIZE_CLEANUP_MS = 30000; // keep mappings this long after finish for late reconnects
const FINALIZE_RETRY_MS = 5000; // retry a nondurable finish without publishing a winner

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
        this.financialRecoveryReady = false;
        this._liabilityReconcileTimer = null;
        this._liabilityReconcileRunning = false;

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
    async initialize() {
        // Queue recovery resolves abandoned in-flight escrow first. Finished matches already
        // have a durable winner + accepted liability snapshot, so reconstruct any payout row
        // that a crash/transient DB error prevented us from inserting after completion.
        // MATCH_ENABLED controls new rooms only. Reconciliation must run even when operators
        // disable the entire match surface, because an already-finished accepted liability is
        // still owed and may have crashed before its payout row was inserted.
        if (!this.db || !this.matchPayoutService) {
            throw createFinancialRecoveryError('finished_match_liabilities', {
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            });
        }
        await this._reconcileFinishedLiabilities({ failClosed: true });

        // A payout insert can fail after a match finish has already committed. Re-scan in
        // bounded batches so a transient runtime failure is retried without duplicating payout
        // rows (the database's match_id uniqueness remains the exactly-once anchor).
        const configuredMs = Number(process.env.MATCH_LIABILITY_RECONCILE_MS);
        const intervalMs = Math.max(5000, Math.min(
            300000,
            Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : 30000
        ));
        this._liabilityReconcileTimer = setInterval(() => {
            this._reconcileFinishedLiabilities({ failClosed: false }).catch(error => {
                this._log('[MatchManager] liability reconciliation timer error', error.message);
            });
        }, intervalMs);
        this._liabilityReconcileTimer.unref?.();
    }

    async _reconcileFinishedLiabilities({ failClosed = false, batchSize = 100, maxBatches = 100 } = {}) {
        if (this._liabilityReconcileRunning) {
            if (failClosed) {
                throw createFinancialRecoveryError('finished_match_liabilities', {
                    scanned: 0,
                    resolved: 0,
                    unresolved: [{ type: 'reconciliation', id: 'already_running' }]
                });
            }
            return { ok: false, skipped: true, scanned: 0, created: 0, failed: 0, unresolved: [] };
        }

        const limit = Math.max(1, Math.min(1000, parseInt(batchSize, 10) || 100));
        const batchLimit = Math.max(1, Math.min(1000, parseInt(maxBatches, 10) || 100));
        const total = { ok: true, scanned: 0, created: 0, failed: 0, unresolved: [] };
        this._liabilityReconcileRunning = true;
        try {
            for (let batch = 0; batch < batchLimit; batch += 1) {
                let result;
                try {
                    result = await this.matchPayoutService.reconcileFinishedLiabilities({ limit });
                } catch (error) {
                    throw createFinancialRecoveryError('finished_match_liabilities', {
                        scanFailed: true,
                        scanned: total.scanned,
                        resolved: total.created,
                        unresolved: total.unresolved
                    }, error);
                }
                total.scanned += Number(result.scanned) || 0;
                total.created += Number(result.created) || 0;
                total.failed += Number(result.failed) || 0;
                if (Array.isArray(result.unresolved)) total.unresolved.push(...result.unresolved);

                if (total.failed > 0 || result.ok === false) {
                    if (total.unresolved.length === 0) {
                        total.unresolved.push({ type: 'match_liability', id: 'unknown' });
                    }
                    throw createFinancialRecoveryError('finished_match_liabilities', {
                        scanned: total.scanned,
                        resolved: total.created,
                        unresolved: total.unresolved
                    });
                }
                if ((Number(result.scanned) || 0) < limit) {
                    this.financialRecoveryReady = true;
                    if (total.created > 0) {
                        this._log(`[MatchManager] liability reconciliation: ${total.created} created, 0 failed`);
                    }
                    return total;
                }
            }

            throw createFinancialRecoveryError('finished_match_liabilities', {
                scanned: total.scanned,
                resolved: total.created,
                unresolved: [{ type: 'reconciliation_backlog', id: `>${limit * batchLimit}` }]
            });
        } catch (error) {
            this.financialRecoveryReady = false;
            total.ok = false;
            if (failClosed) throw error;
            this._log('[MatchManager] liability reconciliation incomplete', error.message);
            return total;
        } finally {
            this._liabilityReconcileRunning = false;
        }
    }

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

        room.minDurationMs = Math.max(0, Number(minDurationMs) || 0);
        room.hardCeilingMs = Math.max(1, Number(hardCeilingMs) || 1);
        room._minDurationMet = room.minDurationMs === 0;

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
                    ruleset: room._rulesetSummary?.() || null,
                    seedHash: room.seedHash,
                    fairness: room.fairnessProof?.(false) || null,
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
            this._broadcast(room.id, 'match_start', {
                matchId: room.id,
                tickMs,
                seedHash: r.seedHash,
                fairness: r.fairnessProof?.(false) || null,
                ruleset: r._rulesetSummary?.() || null
            });

            // The floor is active-play time, not queue/countdown time. The block handler also
            // checks startedAt directly, avoiding a timer-order race when a block arrives exactly
            // as the floor elapses.
            if (!r._minDurationMet) {
                const floorTimeout = setTimeout(() => {
                    const live = this.rooms.get(room.id);
                    if (live) live._minDurationMet = true;
                }, r.minDurationMs);
                if (Array.isArray(r._watchdogs)) r._watchdogs.push(floorTimeout);
            }
        }, countdownMs);

        // Hard-ceiling watchdog: absolute max match length. Single owner (the scheduler no
        // longer sets its own ceiling timer), cleared by _finalize so it never fires on a
        // finished/removed room.
        const ceilingTimeout = setTimeout(() => this.expire(room.id, 'hard_ceiling'), room.hardCeilingMs);

        room._watchdogs = [startTimer, ceilingTimeout];
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
     * End active block-bounded rooms on the first advancing header after their active-play floor.
     * Rooms created by the same header are protected by the strict height comparison.
     * @returns {number} number of rooms expired
     */
    expireBlockDeadlines(blockHeight) {
        const height = Number(blockHeight);
        if (!Number.isSafeInteger(height) || height < 0) return 0;

        let expired = 0;
        for (const room of Array.from(this.rooms.values())) {
            if (!room || room.status !== 'active' || room._finalized) continue;
            if (room.ruleset?.timing?.blockDeadline !== true) continue;
            const startHeight = Number(room.startBlockHeight);
            if (!Number.isSafeInteger(startHeight) || height <= startHeight) continue;

            const floorMs = Math.max(0, Number(room.minDurationMs) || 0);
            const activeForMs = Number.isFinite(room.startedAt) ? Date.now() - room.startedAt : -1;
            const floorMet = room._minDurationMet === true || activeForMs >= floorMs;
            if (!floorMet) continue;

            room._minDurationMet = true;
            room.endBlockHeight = height;
            this.expire(room.id, 'block_deadline');
            expired += 1;
        }
        return expired;
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
        // Engine callbacks, watchdogs, and disconnect handling can converge here together. Share
        // one attempt so persistence/payout/leaderboard work never runs concurrently.
        if (room._finalizePromise) return room._finalizePromise;
        const attempt = this._finalizeAttempt(room);
        room._finalizePromise = attempt;
        try {
            return await attempt;
        } finally {
            if (room._finalizePromise === attempt) room._finalizePromise = null;
        }
    }

    async _finalizeAttempt(room) {

        // Clear lifecycle watchdogs (countdown, floor, hard ceiling) so none fire post-finish.
        if (room._watchdogs) { room._watchdogs.forEach(id => clearTimeout(id)); room._watchdogs = null; }
        // Clear any pending AFK timers for this match.
        this._clearDisconnectTimers(room.id);
        // Stop the engine if it is still ticking.
        const engine = this.engines.get(room.id);
        if (engine) { try { engine.stop(); } catch (_) {} }

        // Persist the winner first. Once that transaction commits, the accepted liability is
        // fully reconstructable from SQL even if payout insertion fails or the process crashes.
        let finishPersisted = !this.db;
        if (this.db) {
            try {
                await this._persistFinish(room);
                finishPersisted = true;
            }
            catch (err) { this._log('[MatchManager] persist error', err.message); }
        }
        if (!finishPersisted) {
            // This is deliberately not `match_end`: clients must not publish a winner which the
            // authoritative database cannot prove. Keep the room mapped and retry the idempotent
            // finish transaction; boot recovery remains the final fallback if the process exits.
            try {
                this._broadcast(room.id, 'match_settlement_pending', {
                    matchId: room.id,
                    code: 'MATCH_FINISH_NOT_DURABLE',
                    retrying: true
                });
            } catch (err) { this._log('[MatchManager] pending broadcast error', err.message); }
            this._scheduleFinalizeRetry(room);
            return;
        }

        room._finalized = true;
        if (room._finalizeRetryTimer) {
            clearTimeout(room._finalizeRetryTimer);
            this._pendingCleanups.delete(room._finalizeRetryTimer);
            room._finalizeRetryTimer = null;
        }
        // Insert from the immutable admission snapshot, not current MATCH_PAYOUTS_ENABLED. A
        // failure is retried by initialize() reconciliation because the finished winner is now
        // durable. Never create a payout when the finish itself did not persist.
        if (room.economy === 'crypto_race' && finishPersisted) {
            try { await this.matchPayoutService.payoutWinner(room); }
            catch (err) {
                // The match result and accepted liability are already durable. Close every paid
                // admission surface immediately, then attempt the idempotent SQL reconstruction;
                // the bounded timer remains the fallback if this immediate pass also fails.
                this.financialRecoveryReady = false;
                this._log('[MatchManager] payout error', err.message);
                await this._reconcileFinishedLiabilities({ failClosed: false });
            }
        }
        // Leaderboard rows are derived from the durable match result. Never create synthetic
        // `games` rows (or announce a prestige refresh) when the finish transaction failed: that
        // would publish a result which the authoritative matches tables do not contain.
        if (finishPersisted) {
            try { await this.matchLeaderboard.postMatch(room); }
            catch (err) { this._log('[MatchManager] leaderboard error', err.message); }
        }
        // Only a durable result is announced as final.
        try {
            this._broadcast(room.id, 'match_end', this._terminalPayload(room));
        } catch (err) { this._log('[MatchManager] broadcast error', err.message); }

        // Drop all mappings after a grace period so late reconnects still resolve the result.
        const cleanupTimer = setTimeout(() => {
            this._pendingCleanups.delete(cleanupTimer);
            this._cleanup(room.id);
        }, FINALIZE_CLEANUP_MS);
        this._pendingCleanups.add(cleanupTimer);
    }

    _scheduleFinalizeRetry(room) {
        if (!room || room._finalized || room._finalizeRetryTimer) return;
        const retryTimer = setTimeout(() => {
            this._pendingCleanups.delete(retryTimer);
            if (room._finalizeRetryTimer === retryTimer) room._finalizeRetryTimer = null;
            if (!this.rooms.has(room.id) || room._finalized) return;
            this._finalize(room).catch(err => this._log('[MatchManager] finalize retry error', err.message));
        }, FINALIZE_RETRY_MS);
        room._finalizeRetryTimer = retryTimer;
        this._pendingCleanups.add(retryTimer);
    }

    _terminalPayload(room) {
        return {
            matchId: room.id,
            reason: room.endReason,
            winnerId: room.winnerId,
            ruleset: room._rulesetSummary?.() || null,
            fairness: room.fairnessProof?.(true) || null,
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
        };
    }

    _emitTerminalToReconnect(socket, room) {
        if (!socket || !room?._finalized) return false;
        if (!room._terminalDeliveredSocketIds) room._terminalDeliveredSocketIds = new Set();
        if (room._terminalDeliveredSocketIds.has(socket.id)) return false;
        socket.emit('match_end', this._terminalPayload(room));
        room._terminalDeliveredSocketIds.add(socket.id);
        return true;
    }

    async _persistFinish(room) {
        await this.db.withTransaction(async (client) => {
            const finished = await client.query(`
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
            if (finished.rowCount !== 1) {
                throw new Error(`Match finish persistence missed row ${room.id}`);
            }

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

        // A finalized room is retained briefly precisely so a reconnecting player can recover its
        // result. Deliver the same terminal payload immediately, once per socket. If persistence
        // is still retrying, withhold the winner and tell this socket settlement is pending.
        if (room.status === 'finished') {
            if (room._finalized) this._emitTerminalToReconnect(socket, room);
            else {
                socket.emit('match_settlement_pending', {
                    matchId: room.id,
                    code: 'MATCH_FINISH_NOT_DURABLE',
                    retrying: true
                });
            }
        }

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
        this.financialRecoveryReady = false;
        if (this._liabilityReconcileTimer) {
            clearInterval(this._liabilityReconcileTimer);
            this._liabilityReconcileTimer = null;
        }
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
