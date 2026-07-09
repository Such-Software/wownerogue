/**
 * MatchQueue — persisted, per-economy queue for match mode.
 *
 * Responsibilities:
 *   • Join/leave a queue for each economy (free, credits_prestige, crypto_race).
 *   • Atomically deduct credits or tickets into escrow on join; refund on leave.
 *   • List queued players for a given economy.
 *   • Drain a full economy bucket into a match at block time.
 *
 * The queue is backed by `match_queue_entries` so state survives server restarts and
 * disconnects. In-memory maps are rebuilt on initialization.
 *
 * This module has no Socket.IO coupling; MatchManager owns transport.
 */

const { normalizeError } = require('../utils/errors');

const ECONOMIES = Object.freeze(['free', 'credits_prestige', 'crypto_race']);
const MATCH_ECONOMY_SET = new Set(ECONOMIES);

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

        // Cancel any stale matched-but-not-started entries (server crashed during drain).
        await this.db.query(`
            UPDATE match_queue_entries
            SET status = 'cancelled', match_id = NULL
            WHERE status = 'matched'
              AND created_at < NOW() - INTERVAL '5 minutes'
        `);

        // Refund queued-but-stale entries older than 24 hours.
        await this.db.query(`
            UPDATE match_queue_entries
            SET status = 'cancelled'
            WHERE status = 'queued'
              AND created_at < NOW() - INTERVAL '24 hours'
        `);

        // Rebuild in-memory state.
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
     * Join a queue. For paid economies the cost is held in escrow.
     * @param {object} entry
     * @param {number} entry.userId
     * @param {string} entry.socketId
     * @param {string} entry.sessionToken
     * @param {string} entry.economy
     * @param {object} [entry.appearance]
     * @returns {Promise<{success:boolean, reason?:string, position?:number}>}
     */
    async join(entry) {
        if (!this.enabled) return { success: false, reason: 'match_disabled' };
        const economy = this._validateEconomy(entry.economy);
        if (!economy) return { success: false, reason: 'invalid_economy' };

        try {
            if (economy === 'free') {
                return await this._joinFree(entry);
            }
            if (economy === 'credits_prestige') {
                return await this._joinCreditsPrestige(entry);
            }
            return await this._joinCryptoRace(entry);
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to join match queue');
            this._log('[MatchQueue] join error:', normalized.message);
            return { success: false, reason: normalized.safeMessage || 'join_failed' };
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

            // 2. Log credit transaction.
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
            // 1. Consume one race entry ticket atomically.
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

            // 2. Log ticket transaction (escrow).
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
     * Leave a queue before a match starts. Refund credits/tickets.
     * @param {number} userId
     * @param {string} economy
     * @returns {Promise<{success:boolean, reason?:string}>}
     */
    async leave(userId, economy) {
        if (!this.enabled) return { success: false, reason: 'match_disabled' };
        economy = this._validateEconomy(economy);
        if (!economy) return { success: false, reason: 'invalid_economy' };

        try {
            const memIdx = this._queues[economy].findIndex(e => e.userId === userId);
            const entry = memIdx >= 0 ? this._queues[economy][memIdx] : null;

            await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    DELETE FROM match_queue_entries
                    WHERE user_id = $1 AND economy = $2 AND status = 'queued'
                    RETURNING id
                `, [userId, economy]);

                if (result.rowCount === 0) {
                    throw Object.assign(new Error('Not in queue'), { code: 'NOT_QUEUED' });
                }

                if (economy === 'credits_prestige' && entry?.cost) {
                    const cost = entry.cost;
                    const creditResult = await client.query(`
                        UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits
                    `, [cost, userId]);
                    await client.query(`
                        INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type, metadata)
                        VALUES ($1, $2, 'match_queue_leave', $3, 'match', $4)
                    `, [userId, cost, creditResult.rows[0].credits, JSON.stringify({ economy: 'credits_prestige', refunded: true })]);
                }

                if (economy === 'crypto_race') {
                    const ticketResult = await client.query(`
                        UPDATE users SET race_entries = race_entries + 1 WHERE id = $1 RETURNING race_entries
                    `, [userId]);
                    await client.query(`
                        INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, metadata)
                        VALUES ($1, 1, $2, 'queue_leave', $3)
                    `, [userId, ticketResult.rows[0].race_entries, JSON.stringify({ economy: 'crypto_race', refunded: true })]);
                }
            });

            if (memIdx >= 0) this._queues[economy].splice(memIdx, 1);
            this._log(`[MatchQueue] leave user=${userId} economy=${economy}`);
            return { success: true };
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to leave match queue');
            if (normalized.code === 'NOT_QUEUED') return { success: false, reason: 'not_queued' };
            return { success: false, reason: normalized.safeMessage || 'leave_failed' };
        }
    }

    /**
     * Drain queued players for an economy into a match. Marks queue entries 'matched' and
     * returns the set of entrants. The caller creates the MatchRoom and starts it.
     * @param {string} economy
     * @param {number} maxPlayers
     * @returns {Promise<{entries:Array}|null>}
     */
    async drain(economy, maxPlayers) {
        economy = this._validateEconomy(economy);
        if (!economy || this._queues[economy].length < 2) return null;

        const count = Math.min(maxPlayers, this._queues[economy].length);
        const drained = this._queues[economy].splice(0, count);
        const userIds = drained.map(e => e.userId);

        await this.db.withTransaction(async (client) => {
            const result = await client.query(`
                UPDATE match_queue_entries
                SET status = 'matched'
                WHERE user_id = ANY($1::int[]) AND economy = $2 AND status = 'queued'
                RETURNING id, user_id
            `, [userIds, economy]);

            if (result.rowCount !== userIds.length) {
                // Should never happen if memory state is in sync; abort.
                throw Object.assign(
                    new Error(`Queue drain mismatch: expected ${userIds.length}, got ${result.rowCount}`),
                    { code: 'DRAIN_MISMATCH' }
                );
            }
        });

        this._log(`[MatchQueue] drained ${drained.length} players for ${economy}`);
        return { entries: drained };
    }

    /**
     * Reattach an in-memory entry after a socket reconnect. The DB row is keyed on user_id +
     * economy, so we just update the socket_id in memory and DB.
     * @param {number} userId
     * @param {string} economy
     * @param {string} newSocketId
     * @param {string} sessionToken
     * @returns {Promise<{inQueue:boolean, position?:number}>}
     */
    async reattach(userId, economy, newSocketId, sessionToken) {
        economy = this._validateEconomy(economy);
        if (!economy) return { inQueue: false };

        const result = await this.db.query(`
            UPDATE match_queue_entries
            SET socket_id = $1, session_token = $2
            WHERE user_id = $3 AND economy = $4 AND status = 'queued'
            RETURNING id, created_at
        `, [newSocketId, sessionToken, userId, economy]);

        if (result.rowCount === 0) return { inQueue: false };

        const memIdx = this._queues[economy].findIndex(e => e.userId === userId);
        if (memIdx >= 0) {
            this._queues[economy][memIdx].socketId = newSocketId;
            this._queues[economy][memIdx].sessionToken = sessionToken;
            return { inQueue: true, position: memIdx + 1 };
        }

        // Memory was stale; rebuild this one from DB row.
        const row = result.rows[0];
        this._addToMemory(economy, {
            queueEntryId: row.id,
            userId,
            socketId: newSocketId,
            sessionToken,
            createdAt: new Date(row.created_at).getTime()
        });
        return { inQueue: true, position: this._queues[economy].findIndex(e => e.userId === userId) + 1 };
    }

    /**
     * Cancel all queues (e.g. server shutdown). Refunds paid entries.
     */
    async shutdown() {
        if (!this.enabled || !this.db) return;
        for (const economy of ECONOMIES) {
            const entries = this._queues[economy].slice();
            for (const e of entries) {
                await this.leave(e.userId, economy).catch(() => {});
            }
        }
    }
}

module.exports = MatchQueue;
