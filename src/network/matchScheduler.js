/**
 * MatchScheduler — block-cadence match maker.
 *
 * Subscribes to the same block event as the solo queue handler. On every new block, it drains
 * each enabled economy's queue into a MatchRoom (if ≥2 players are queued). Single players
 * carry over to the next block and can leave at any time.
 *
 * MatchScheduler creates MatchRooms but does not own Socket.IO broadcasting; it delegates the
 * started room to MatchManager for transport, the real countdown, persistence, and finish
 * handling. It does NOT start the engine directly — the manager's countdown does — so honest
 * and modified clients always start together.
 */

const MatchRoom = require('../multiplayer/MatchRoom');
const MatchEngine = require('../multiplayer/MatchEngine');
const MatchState = require('../multiplayer/MatchState');

const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_TICK_MS = 250;
const DEFAULT_MIN_DURATION_MS = 20000;
const DEFAULT_HARD_CEILING_MS = 240000;
const DEFAULT_COUNTDOWN_MS = 3000;

class MatchScheduler {
    constructor({
        matchQueue,
        matchManager,
        debugManager,
        maxPlayers = null,
        tickMs = null,
        minDurationMs = null,
        hardCeilingMs = null,
        countdownMs = null
    } = {}) {
        this.matchQueue = matchQueue;
        this.matchManager = matchManager;
        this.debugManager = debugManager;
        this.enabled = process.env.MATCH_ENABLED === 'true';

        this.maxPlayers = Math.max(2, Math.min(32, maxPlayers || parseInt(process.env.MATCH_MAX_PLAYERS, 10) || DEFAULT_MAX_PLAYERS));
        this.tickMs = tickMs || parseInt(process.env.MATCH_TICK_MS, 10) || DEFAULT_TICK_MS;
        this.minDurationMs = minDurationMs || parseInt(process.env.MATCH_MIN_DURATION_MS, 10) || DEFAULT_MIN_DURATION_MS;
        this.hardCeilingMs = hardCeilingMs || parseInt(process.env.MATCH_HARD_CEILING_MS, 10) || DEFAULT_HARD_CEILING_MS;
        this.countdownMs = countdownMs || parseInt(process.env.MATCH_COUNTDOWN_MS, 10) || DEFAULT_COUNTDOWN_MS;

        // Retained for interface stability; the scheduler no longer owns any long-lived timers
        // (the hard-ceiling watchdog is owned solely by MatchManager, cleared on finalize).
        this._timeoutIds = [];
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    /**
     * Hook this into the existing DebugManager.onNewBlockCallback().
     * @param {number} blockHeight
     */
    async onBlock(blockHeight) {
        if (!this.enabled || !this.matchQueue || !this.matchManager) return;

        for (const economy of ['free', 'credits_prestige', 'crypto_race']) {
            try {
                await this._drainEconomy(economy, blockHeight);
            } catch (err) {
                // One economy failing must never block the others (or single-player blocks).
                this._log(`[MatchScheduler] drain ${economy} error`, err.message);
            }
        }
    }

    async _drainEconomy(economy, blockHeight) {
        const drain = await this.matchQueue.drain(economy, this.maxPlayers);
        if (!drain) return;

        const { entries } = drain;
        if (!entries || entries.length < 2) {
            // Defensive: drain() already marked these 'matched'; refund them so a race that did
            // not start never consumes credits/tickets.
            if (entries && entries.length) {
                await this._refund(entries, economy, 'match_cancel');
            }
            return;
        }

        this._log(`[MatchScheduler] Starting ${economy} race with ${entries.length} players at block ${blockHeight}`);

        // Build entrants map for MatchRoom.
        const entrants = {};
        for (const e of entries) {
            entrants[e.socketId] = {
                userId: e.userId,
                name: null, // resolved later by MatchManager
                socketId: e.socketId,
                sessionToken: e.sessionToken
            };
        }

        const room = new MatchRoom({
            economy,
            variant: 'race',
            difficultyPreset: 'race',
            maxPlayers: this.maxPlayers,
            entrants,
            startBlockHeight: blockHeight,
            cryptoType: process.env.CRYPTO_TYPE || 'WOW'
        });
        room.minDurationMs = this.minDurationMs;
        room.hardCeilingMs = this.hardCeilingMs;

        // Persist match + entrants BEFORE any money movement or notification so a crash mid-race
        // is recoverable from the DB on next boot.
        try {
            await this._persistMatch(room, entries, economy);
        } catch (err) {
            this._log('[MatchScheduler] persist failed; refunding entrants', err.message);
            await this._refund(entries, economy, 'match_cancel');
            return;
        }

        // MP-C4: collect the crypto pot / commit entry tickets BEFORE notifying players or
        // starting the engine. If collection fails, ABORT and REFUND every entrant — never
        // consume tickets for a race that did not start.
        if (economy === 'crypto_race') {
            const payoutService = this.matchManager?.matchPayoutService;
            try {
                if (!payoutService || typeof payoutService.collectEntryTickets !== 'function') {
                    throw new Error('matchPayoutService unavailable');
                }
                await payoutService.collectEntryTickets(room, entries);
            } catch (err) {
                this._log('[MatchScheduler] pot collection failed; aborting + refunding', err.message);
                await this._abortMatch(room, entries, economy);
                return;
            }
        }

        // Create the engine and hand it to the manager, but DO NOT start it here — the manager's
        // countdown starts it once the pre-race timer elapses (server-authoritative start).
        const engine = new MatchEngine({
            room,
            tickMs: this.tickMs,
            onTick: (result) => this.matchManager.onTick(room.id, result),
            onFinish: (finishedRoom) => this.matchManager.onFinish(finishedRoom)
        });
        this.matchManager.setEngine(room.id, engine);

        // Hand off to MatchManager for transport, the real countdown, reconnect mapping, all
        // watchdog timers, and finish handling.
        this.matchManager.attach(room, entries, {
            db: this.matchManager.db,
            gameModeManager: this.matchManager.gameModeManager,
            tickMs: this.tickMs,
            minDurationMs: this.minDurationMs,
            hardCeilingMs: this.hardCeilingMs,
            countdownMs: this.countdownMs
        });
    }

    /**
     * Refund a set of drained entrants (credits/tickets) and cancel their queue rows. Delegates
     * to MatchQueue which owns the money ledger; falls back to per-user leave if the batch
     * method is unavailable (older queue implementations).
     */
    async _refund(entries, economy, reason) {
        if (!this.matchQueue) return;
        try {
            if (typeof this.matchQueue.refundEntries === 'function') {
                await this.matchQueue.refundEntries(entries, economy, reason);
                return;
            }
            for (const e of entries) {
                await this.matchQueue.leave(e.userId, economy).catch(() => {});
            }
        } catch (err) {
            this._log('[MatchScheduler] refund error', err.message);
        }
    }

    /**
     * Abort a match whose pot could not be collected: mark it cancelled and refund everyone.
     */
    async _abortMatch(room, entries, economy) {
        if (this.matchManager?.db) {
            try {
                await this.matchManager.db.query(
                    `UPDATE matches SET status = 'cancelled', ended_at = NOW() WHERE id = $1`,
                    [room.id]
                );
            } catch (err) {
                this._log('[MatchScheduler] abort mark-cancelled error', err.message);
            }
        }
        await this._refund(entries, economy, 'match_cancel');
    }

    async _persistMatch(room, entries, economy) {
        if (!this.matchManager?.db) return;

        const matchRow = MatchState.toMatchRow(room);
        // Override row defaults with the actual queued economy and status.
        matchRow.status = 'starting';
        matchRow.economy = economy;

        await this.matchManager.db.withTransaction(async (client) => {
            await client.query(`
                INSERT INTO matches (
                    id, status, economy, variant, difficulty_preset, max_players,
                    seed_hash, dungeon, start_block_height, entry_fee_atomic,
                    pot_atomic, house_fee_atomic, house_fee_percent, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13, NOW()
                )
            `, [
                matchRow.id,
                matchRow.status,
                matchRow.economy,
                matchRow.variant,
                matchRow.difficulty_preset,
                matchRow.max_players,
                matchRow.seed_hash,
                JSON.stringify(matchRow.dungeon),
                matchRow.start_block_height,
                matchRow.entry_fee_atomic,
                matchRow.pot_atomic,
                matchRow.house_fee_atomic,
                matchRow.house_fee_percent
            ]);

            for (const entrant of entries) {
                await client.query(`
                    INSERT INTO match_entrants (match_id, user_id, socket_id)
                    VALUES ($1, $2, $3)
                `, [room.id, entrant.userId, entrant.socketId]);
            }
        });
    }

    shutdown() {
        for (const id of this._timeoutIds) clearTimeout(id);
        this._timeoutIds = [];
    }
}

module.exports = MatchScheduler;
