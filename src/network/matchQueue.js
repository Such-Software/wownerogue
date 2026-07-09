/**
 * MatchQueue — persisted, per-economy queue for match mode.
 *
 * Responsibilities:
 *   • Enqueue/leave a queue for each economy (free, credits_prestige, crypto_race).
 *   • Atomically deduct credits or tickets into escrow on join; REFUND on EVERY cancellation
 *     path (leave, stale cleanup, drain abort, shutdown, boot recovery), always writing a
 *     ledger row — never a status flip alone.
 *   • Drain a full economy bucket into a match at block time (memory only mutated after the DB
 *     commit succeeds, so a failed drain leaves the queue intact).
 *
 * Backed by `match_queue_entries` so state survives restarts. In-memory maps are rebuilt on
 * initialize(), which also refunds abandoned queue rows and recovers in-flight `matches`.
 *
 * No Socket.IO coupling; MatchManager owns transport.
 */

const { normalizeError } = require('../utils/errors');

const ECONOMIES = Object.freeze(['free', 'credits_prestige', 'crypto_race']);
const MATCH_ECONOMY_SET = new Set(ECONOMIES);
// race_entry_transactions.reason is CHECK-constrained; map any cancellation reason into it.
const RACE_LEDGER_REASONS = new Set(['queue_leave', 'match_cancel', 'refund']);

class MatchQueue {
    constructor({ db, gameModeManager = null, debugManager = null } = {}) {
        this.db = db;
        this.gameModeManager = gameModeManager;
        this.debugManager = debugManager;
        this.enabled = process.env.MATCH_ENABLED === 'true';

        // In-memory hot state: economy -> array of queue entries (for fast scheduling).
        // Rebuilt from DB on initialize().
        this._queues = { free: [], credits_prestige: [], crypto_race: [] };
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    async initialize() {
        if (!this.enabled || !this.db) return;

        // MP-H3: refund + cancel abandoned entries and recover in-flight matches BEFORE
        // rebuilding memory, so escrow is never silently lost across a restart/crash.
        await this._recoverStaleQueueEntries();
        await this._recoverAbandonedMatches();

        // Rebuild in-memory state from the surviving 'queued' rows.
        const result = await this.db.query(`
            SELECT id, user_id, economy, socket_id, session_token, created_at
            FROM match_queue_entries
            WHERE status = 'queued'
            ORDER BY created_at ASC
        `);

        for (const row of result.rows || []) {
            if (!this._queues[row.economy]) continue;
            this._queues[row.economy].push({
                queueEntryId: row.id,
                userId: row.user_id,
                socketId: row.socket_id,
                sessionToken: row.session_token,
                createdAt: new Date(row.created_at).getTime()
            });
        }

        this._log(`[MatchQueue] Initialized: ${this.length('free')} free, ${this.length('credits_prestige')} prestige, ${this.length('crypto_race')} crypto`);
    }

    /**
     * Refund + cancel queue rows abandoned by a crash: 'matched' rows that never became a
     * running match (older than 5 min), and 'queued' rows older than 24h. Each refund is
     * written to the ledger; the row is only cancelled in the same transaction as its refund.
     */
    async _recoverStaleQueueEntries() {
        let stale = [];
        try {
            const res = await this.db.query(`
                SELECT user_id, economy FROM match_queue_entries
                WHERE (status = 'matched' AND created_at < NOW() - INTERVAL '5 minutes')
                   OR (status = 'queued'  AND created_at < NOW() - INTERVAL '24 hours')
            `);
            stale = res.rows || [];
        } catch (err) {
            this._log('[MatchQueue] stale scan error', err.message);
            return;
        }
        for (const row of stale) {
            try {
                await this.db.withTransaction(async (client) => {
                    const upd = await client.query(`
                        UPDATE match_queue_entries
                        SET status = 'cancelled', match_id = NULL
                        WHERE user_id = $1 AND economy = $2 AND status IN ('queued', 'matched')
                        RETURNING id
                    `, [row.user_id, row.economy]);
                    if (upd.rowCount > 0) {
                        await this._applyRefund(client, row.user_id, row.economy, 'match_cancel');
                    }
                });
            } catch (err) {
                this._log('[MatchQueue] stale recovery error', err.message);
            }
        }
    }

    /**
     * Boot recovery for in-flight `matches` rows left 'starting'/'active' by a crash. If a
     * payout was already recorded for the match, let it stand (finalize the status); otherwise
     * cancel the match and refund every entrant so escrow is never stranded.
     */
    async _recoverAbandonedMatches() {
        // Single-instance (default, this deployment's model): a boot means all in-memory match
        // state is gone, so every in-flight row is abandoned — reclaim them all immediately.
        // Multi-instance (MATCH_SINGLE_INSTANCE=false): a sibling instance may be actively running
        // a recent race, so only reclaim rows older than the maximum possible match duration
        // (hard ceiling + buffer). Anything younger is left for its owner (its own ceiling watchdog
        // finalizes it) or a later boot. This is a lock-free age guard; true cross-instance
        // ownership would use a heartbeat/lease column.
        const singleInstance = String(process.env.MATCH_SINGLE_INSTANCE || 'true').toLowerCase() !== 'false';
        const ceilingMs = parseInt(process.env.MATCH_HARD_CEILING_MS, 10) || 240000;
        const minAgeSec = singleInstance ? 0 : Math.ceil((ceilingMs + 60000) / 1000);
        let rows = [];
        try {
            const res = await this.db.query(
                `SELECT id, economy FROM matches
                 WHERE status IN ('starting', 'active')
                   AND COALESCE(started_at, created_at) <= NOW() - ($1::int * INTERVAL '1 second')`,
                [minAgeSec]
            );
            rows = res.rows || [];
        } catch (err) {
            // matches table may not exist in a minimal test DB — non-fatal.
            this._log('[MatchQueue] abandoned match scan error', err.message);
            return;
        }
        for (const m of rows) {
            try {
                await this.db.withTransaction(async (client) => {
                    // If a payout already exists, the race effectively completed — don't refund
                    // (that would double-pay the winner); just finalize the match status so the
                    // batcher/retry can settle the payout.
                    const pay = await client.query(`SELECT id FROM payouts WHERE match_id = $1 LIMIT 1`, [m.id]);
                    if (pay.rows.length > 0) {
                        await client.query(`
                            UPDATE matches SET status = 'finished', ended_at = COALESCE(ended_at, NOW())
                            WHERE id = $1 AND status IN ('starting', 'active')
                        `, [m.id]);
                        return;
                    }

                    const cancel = await client.query(`
                        UPDATE matches SET status = 'cancelled', ended_at = NOW()
                        WHERE id = $1 AND status IN ('starting', 'active')
                        RETURNING id
                    `, [m.id]);
                    if (cancel.rowCount === 0) return; // already handled by another process

                    const ent = await client.query(`SELECT user_id FROM match_entrants WHERE match_id = $1`, [m.id]);
                    for (const e of ent.rows || []) {
                        if (m.economy === 'crypto_race' || m.economy === 'credits_prestige') {
                            await this._applyRefund(client, e.user_id, m.economy, 'match_cancel');
                        }
                    }
                    await client.query(`
                        UPDATE match_queue_entries SET status = 'cancelled'
                        WHERE match_id = $1 AND status IN ('queued', 'matched')
                    `, [m.id]);
                });
                this._log(`[MatchQueue] recovered abandoned match ${m.id} (${m.economy})`);
            } catch (err) {
                this._log('[MatchQueue] abandoned match recovery error', err.message);
            }
        }
    }

    _validateEconomy(economy) {
        return MATCH_ECONOMY_SET.has(economy) ? economy : null;
    }

    isEnabled() {
        return this.enabled;
    }

    length(economy) {
        return this._queues[economy]?.length || 0;
    }

    snapshot(economy) {
        if (!this._validateEconomy(economy)) return [];
        return this._queues[economy].slice();
    }

    /**
     * socketHandlers-facing API: enqueue a resolved session into a match queue. Identity comes
     * from the (server-resolved) session; the economy is explicit.
     * @param {{userId:number, socketId:string, sessionToken?:string, economy?:string}} session
     * @param {{economy?:string}} [opts]
     */
    async enqueue(session, opts = {}) {
        const economy = (opts && opts.economy) || session?.economy;
        return this.join({
            userId: session?.userId,
            socketId: session?.socketId,
            sessionToken: session?.sessionToken,
            economy
        });
    }

    /**
     * Join a queue. For paid economies the cost is held in escrow.
     * @param {object} entry
     * @returns {Promise<{success:boolean, reason?:string, position?:number}>}
     */
    async join(entry) {
        if (!this.enabled) return { success: false, reason: 'match_disabled' };
        if (!entry || entry.userId == null) return { success: false, reason: 'invalid_user' };
        const economy = this._validateEconomy(entry.economy);
        if (!economy) return { success: false, reason: 'invalid_economy' };

        // session_token is NOT NULL in the schema; coerce a missing token to a stable-ish
        // string (reconnect matches on userId anyway).
        const normalized = {
            ...entry,
            economy,
            sessionToken: entry.sessionToken != null ? String(entry.sessionToken) : String(entry.userId)
        };

        try {
            if (economy === 'free') {
                return await this._joinFree(normalized);
            }
            if (economy === 'credits_prestige') {
                return await this._joinCreditsPrestige(normalized);
            }
            return await this._joinCryptoRace(normalized);
        } catch (err) {
            const normErr = normalizeError(err, 'Failed to join match queue');
            this._log('[MatchQueue] join error:', normErr.message);
            return { success: false, reason: normErr.safeMessage || 'join_failed' };
        }
    }

    async _insertQueueEntry(client, entry, economy) {
        const result = await client.query(`
            INSERT INTO match_queue_entries (user_id, economy, socket_id, session_token, status)
            VALUES ($1, $2, $3, $4, 'queued')
            ON CONFLICT (user_id, economy) WHERE status = 'queued'
            DO UPDATE SET socket_id = EXCLUDED.socket_id,
                          session_token = EXCLUDED.session_token,
                          created_at = NOW()
            RETURNING id, created_at
        `, [entry.userId, economy, entry.socketId, entry.sessionToken]);
        return result.rows[0];
    }

    async _joinFree(entry) {
        await this.db.withTransaction(async (client) => {
            const dbRow = await this._insertQueueEntry(client, entry, 'free');
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
        });
        this._addToMemory('free', entry);
        const position = this._queues.free.length;
        this._log(`[MatchQueue] free join user=${entry.userId} pos=${position}`);
        return { success: true, position };
    }

    async _joinCreditsPrestige(entry) {
        const cost = this._creditsCost();

        await this.db.withTransaction(async (client) => {
            // 1. Deduct credits atomically.
            const creditResult = await client.query(`
                UPDATE users
                SET credits = credits - $1
                WHERE id = $2 AND credits >= $1
                RETURNING credits
            `, [cost, entry.userId]);

            if (creditResult.rowCount === 0) {
                throw Object.assign(new Error('Insufficient credits'), { code: 'INSUFFICIENT_CREDITS' });
            }

            const balanceAfter = creditResult.rows[0].credits;

            // 2. Log credit transaction (escrow).
            await client.query(`
                INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type, metadata)
                VALUES ($1, $2, 'match_queue_join', $3, 'match', $4)
            `, [entry.userId, -cost, balanceAfter, JSON.stringify({ economy: 'credits_prestige' })]);

            // 3. Insert queue entry.
            const dbRow = await this._insertQueueEntry(client, entry, 'credits_prestige');
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
            entry.cost = cost;
        });

        this._addToMemory('credits_prestige', entry);
        const position = this._queues.credits_prestige.length;
        this._log(`[MatchQueue] credits_prestige join user=${entry.userId} pos=${position}`);
        return { success: true, position };
    }

    async _joinCryptoRace(entry) {
        await this.db.withTransaction(async (client) => {
            // 1. Consume one race entry ticket atomically (escrow).
            const ticketResult = await client.query(`
                UPDATE users
                SET race_entries = race_entries - 1
                WHERE id = $1 AND race_entries >= 1
                RETURNING race_entries
            `, [entry.userId]);

            if (ticketResult.rowCount === 0) {
                throw Object.assign(new Error('No race entry ticket'), { code: 'NO_RACE_TICKET' });
            }

            const balanceAfter = ticketResult.rows[0].race_entries;

            // 2. Log ticket transaction.
            await client.query(`
                INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, metadata)
                VALUES ($1, -1, $2, 'queue_join', $3)
            `, [entry.userId, balanceAfter, JSON.stringify({ economy: 'crypto_race' })]);

            // 3. Insert queue entry.
            const dbRow = await this._insertQueueEntry(client, entry, 'crypto_race');
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
        });

        this._addToMemory('crypto_race', entry);
        const position = this._queues.crypto_race.length;
        this._log(`[MatchQueue] crypto_race join user=${entry.userId} pos=${position}`);
        return { success: true, position };
    }

    _addToMemory(economy, entry) {
        const q = this._queues[economy];
        const idx = q.findIndex(e => e.userId === entry.userId);
        if (idx !== -1) q[idx] = entry;
        else q.push(entry);
        q.sort((a, b) => a.createdAt - b.createdAt);
    }

    _creditsCost() {
        const v = parseInt(process.env.MATCH_CREDITS_COST, 10);
        return Number.isFinite(v) && v > 0 ? v : 1;
    }

    /**
     * Apply a refund for one entrant within an open transaction. Amounts are DB-derived
     * (MP-H4): the credit refund reads the exact deducted amount from the ledger, so it is
     * correct even after a restart cleared the in-memory entry. Always writes a ledger row.
     */
    async _applyRefund(client, userId, economy, ledgerReason = 'queue_leave') {
        if (economy === 'credits_prestige') {
            const amount = await this._creditsJoinAmount(client, userId);
            if (amount <= 0) return 0;
            const r = await client.query(`
                UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits
            `, [amount, userId]);
            const bal = r.rows[0]?.credits ?? 0;
            await client.query(`
                INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type, metadata)
                VALUES ($1, $2, 'match_queue_refund', $3, 'match', $4)
            `, [userId, amount, bal, JSON.stringify({ economy, refunded: true, reason: ledgerReason })]);
            return amount;
        }
        if (economy === 'crypto_race') {
            const reason = RACE_LEDGER_REASONS.has(ledgerReason) ? ledgerReason : 'queue_leave';
            const r = await client.query(`
                UPDATE users SET race_entries = race_entries + 1 WHERE id = $1 RETURNING race_entries
            `, [userId]);
            const bal = r.rows[0]?.race_entries ?? 0;
            await client.query(`
                INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, metadata)
                VALUES ($1, 1, $2, $3, $4)
            `, [userId, bal, reason, JSON.stringify({ economy, refunded: true, source: ledgerReason })]);
            return 1;
        }
        return 0; // free: nothing to refund
    }

    /**
     * The exact credit amount deducted at join, read from the ledger so refunds survive
     * restarts (MP-H4). Falls back to the configured cost if no ledger row is found.
     */
    async _creditsJoinAmount(client, userId) {
        try {
            const r = await client.query(`
                SELECT amount FROM credit_transactions
                WHERE user_id = $1 AND reason = 'match_queue_join'
                  AND (metadata->>'economy') = 'credits_prestige'
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `, [userId]);
            if (r.rows.length > 0) {
                const amt = Math.abs(parseInt(r.rows[0].amount, 10));
                if (Number.isFinite(amt) && amt > 0) return amt;
            }
        } catch (_) { /* fall through to configured cost */ }
        return this._creditsCost();
    }

    /**
     * Leave a queue before a match starts, refunding credits/tickets. Accepts either a resolved
     * session object ({ userId, economy }) — the socketHandlers form — or the legacy
     * (userId, economy) pair. When no economy is supplied, leaves every economy the user is in.
     */
    async leave(sessionOrUserId, maybeEconomy) {
        if (!this.enabled) return { success: false, reason: 'match_disabled' };

        let userId, economy;
        if (sessionOrUserId && typeof sessionOrUserId === 'object') {
            userId = sessionOrUserId.userId;
            economy = sessionOrUserId.economy || maybeEconomy;
        } else {
            userId = sessionOrUserId;
            economy = maybeEconomy;
        }
        if (userId == null) return { success: false, reason: 'invalid_user' };

        // No economy given → leave every economy the user is queued in.
        if (!economy) {
            const results = [];
            for (const eco of ECONOMIES) {
                results.push(await this._leaveOne(userId, eco));
            }
            const ok = results.some(r => r && r.success);
            return { success: ok, reason: ok ? undefined : 'not_queued' };
        }

        economy = this._validateEconomy(economy);
        if (!economy) return { success: false, reason: 'invalid_economy' };
        return this._leaveOne(userId, economy);
    }

    async _leaveOne(userId, economy) {
        try {
            await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    DELETE FROM match_queue_entries
                    WHERE user_id = $1 AND economy = $2 AND status = 'queued'
                    RETURNING id
                `, [userId, economy]);

                if (result.rowCount === 0) {
                    throw Object.assign(new Error('Not in queue'), { code: 'NOT_QUEUED' });
                }

                // MP-H4: refund is DB-derived inside _applyRefund, not read from volatile memory.
                await this._applyRefund(client, userId, economy, 'queue_leave');
            });

            const memIdx = this._queues[economy].findIndex(e => e.userId === userId);
            if (memIdx >= 0) this._queues[economy].splice(memIdx, 1);
            this._log(`[MatchQueue] leave user=${userId} economy=${economy}`);
            return { success: true };
        } catch (err) {
            const norm = normalizeError(err, 'Failed to leave match queue');
            if (norm.code === 'NOT_QUEUED') {
                // Keep memory consistent even if the DB row was already gone.
                const memIdx = this._queues[economy].findIndex(e => e.userId === userId);
                if (memIdx >= 0) this._queues[economy].splice(memIdx, 1);
                return { success: false, reason: 'not_queued' };
            }
            return { success: false, reason: norm.safeMessage || 'leave_failed' };
        }
    }

    /**
     * Refund a set of drained entrants (used when a race is aborted after drain marked them
     * 'matched', e.g. pot-collection failure or a <2-player defensive drain). Each refund is
     * written to the ledger and the queue row is cancelled in the same transaction, only when
     * the row was actually still queued/matched (so it can never double-refund).
     */
    async refundEntries(entries, economy, reason = 'match_cancel') {
        if (!this.db || !Array.isArray(entries) || entries.length === 0) return;
        economy = this._validateEconomy(economy);
        if (!economy) return;

        for (const e of entries) {
            const userId = e?.userId;
            if (userId == null) continue;
            try {
                await this.db.withTransaction(async (client) => {
                    const upd = await client.query(`
                        UPDATE match_queue_entries
                        SET status = 'cancelled', match_id = NULL
                        WHERE user_id = $1 AND economy = $2 AND status IN ('queued', 'matched')
                        RETURNING id
                    `, [userId, economy]);
                    if (upd.rowCount > 0) {
                        await this._applyRefund(client, userId, economy, reason);
                    }
                });
            } catch (err) {
                this._log('[MatchQueue] refundEntries error', err.message);
            }
            const idx = this._queues[economy].findIndex(q => q.userId === userId);
            if (idx >= 0) this._queues[economy].splice(idx, 1);
        }
    }

    /**
     * Drain queued players for an economy into a match. Marks the DB rows 'matched' and returns
     * the entrants. The in-memory queue is only mutated AFTER the DB commit succeeds, so a
     * failed drain leaves the queue intact for the next block.
     * @returns {Promise<{entries:Array}|null>}
     */
    async drain(economy, maxPlayers) {
        economy = this._validateEconomy(economy);
        if (!economy || this._queues[economy].length < 2) return null;

        const count = Math.min(maxPlayers, this._queues[economy].length);
        const candidates = this._queues[economy].slice(0, count);
        const userIds = candidates.map(e => e.userId);

        try {
            await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    UPDATE match_queue_entries
                    SET status = 'matched', matched_at = NOW()
                    WHERE user_id = ANY($1::int[]) AND economy = $2 AND status = 'queued'
                    RETURNING id, user_id
                `, [userIds, economy]);

                if (result.rowCount !== userIds.length) {
                    // Memory/DB out of sync — abort without mutating memory; retry next block.
                    throw Object.assign(
                        new Error(`Queue drain mismatch: expected ${userIds.length}, got ${result.rowCount}`),
                        { code: 'DRAIN_MISMATCH' }
                    );
                }
            });
        } catch (err) {
            this._log('[MatchQueue] drain error', err.message);
            return null;
        }

        // DB commit succeeded — now remove them from the in-memory queue.
        const idSet = new Set(userIds);
        this._queues[economy] = this._queues[economy].filter(e => !idSet.has(e.userId));
        this._log(`[MatchQueue] drained ${candidates.length} players for ${economy}`);
        return { entries: candidates };
    }

    /**
     * Reattach an in-memory entry after a socket reconnect while still IN THE QUEUE (not in a
     * running match). The DB row is keyed on user_id + economy.
     */
    async reattach(userId, economy, newSocketId, sessionToken) {
        economy = this._validateEconomy(economy);
        if (!economy) return { inQueue: false };

        const token = sessionToken != null ? String(sessionToken) : String(userId);
        const result = await this.db.query(`
            UPDATE match_queue_entries
            SET socket_id = $1, session_token = $2
            WHERE user_id = $3 AND economy = $4 AND status = 'queued'
            RETURNING id, created_at
        `, [newSocketId, token, userId, economy]);

        if (result.rowCount === 0) return { inQueue: false };

        const memIdx = this._queues[economy].findIndex(e => e.userId === userId);
        if (memIdx >= 0) {
            this._queues[economy][memIdx].socketId = newSocketId;
            this._queues[economy][memIdx].sessionToken = token;
            return { inQueue: true, position: memIdx + 1 };
        }

        const row = result.rows[0];
        this._addToMemory(economy, {
            queueEntryId: row.id,
            userId,
            socketId: newSocketId,
            sessionToken: token,
            createdAt: new Date(row.created_at).getTime()
        });
        return { inQueue: true, position: this._queues[economy].findIndex(e => e.userId === userId) + 1 };
    }

    /**
     * Cancel all queues (e.g. server shutdown). Refunds paid entries via _leaveOne (ledger row
     * written for each).
     */
    async shutdown() {
        if (!this.enabled || !this.db) return;
        for (const economy of ECONOMIES) {
            const entries = this._queues[economy].slice();
            for (const e of entries) {
                await this._leaveOne(e.userId, economy).catch(() => {});
            }
        }
    }
}

module.exports = MatchQueue;
