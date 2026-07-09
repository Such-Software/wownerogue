/**
 * MatchScheduler — block-cadence match maker.
 *
 * Subscribes to the same block event as the solo queue handler. On every new block, it drains
 * each enabled economy's queue into a MatchRoom (if ≥2 players are queued). Single players
 * carry over to the next block and can leave at any time.
 *
 * MatchScheduler creates MatchRooms but does not own Socket.IO broadcasting; it delegates
 * the started room to MatchManager for transport, persistence, and spectator wiring.
 */

const MatchRoom = require('../multiplayer/MatchRoom');
const MatchEngine = require('../multiplayer/MatchEngine');
const MatchState = require('../multiplayer/MatchState');
const MatchPayoutService = require('./matchPayoutService');

const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_TICK_MS = 250;
const DEFAULT_MIN_DURATION_MS = 20000;
const DEFAULT_HARD_CEILING_MS = 240000;

class MatchScheduler {
    constructor({
        matchQueue,
        matchManager,
        debugManager,
        maxPlayers = null,
        tickMs = null,
        minDurationMs = null,
        hardCeilingMs = null
    } = {}) {
        this.matchQueue = matchQueue;
        this.matchManager = matchManager;
        this.debugManager = debugManager;
        this.enabled = process.env.MATCH_ENABLED === 'true';

        this.maxPlayers = Math.max(2, Math.min(32, maxPlayers || parseInt(process.env.MATCH_MAX_PLAYERS, 10) || DEFAULT_MAX_PLAYERS));
        this.tickMs = tickMs || parseInt(process.env.MATCH_TICK_MS, 10) || DEFAULT_TICK_MS;
        this.minDurationMs = minDurationMs || parseInt(process.env.MATCH_MIN_DURATION_MS, 10) || DEFAULT_MIN_DURATION_MS;
        this.hardCeilingMs = hardCeilingMs || parseInt(process.env.MATCH_HARD_CEILING_MS, 10) || DEFAULT_HARD_CEILING_MS;

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
            await this._drainEconomy(economy, blockHeight);
        }
    }

    async _drainEconomy(economy, blockHeight) {
        const drain = await this.matchQueue.drain(economy, this.maxPlayers);
        if (!drain) return;

        const { entries } = drain;
        if (entries.length < 2) {
            // Defensive: should not happen because drain() requires ≥2, but refund just in case.
            for (const e of entries) await this.matchQueue.leave(e.userId, economy).catch(() => {});
            return;
        }

        this._log(`[MatchScheduler] Starting ${economy} race with ${entries.length} players at block ${blockHeight}`);

        // Build entrants map for MatchRoom.
        const entrants = {};
        for (const e of entries) {
            entrants[e.socketId] = {
                userId: e.userId,
                name: null, // name is resolved later by MatchManager
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

        // Configure race-specific durations.
        room.minDurationMs = this.minDurationMs;
        room.hardCeilingMs = this.hardCeilingMs;

        // Persist match and entrants synchronously before starting, so a crash mid-race can
        // be recovered from the DB on next boot.
        await this._persistMatch(room, entries, economy);

        // Hand off to MatchManager for transport, reconnect mapping, and finish handling.
        this.matchManager.attach(room, entries, {
            db: this.matchManager.db,
            gameModeManager: this.matchManager.gameModeManager,
            tickMs: this.tickMs,
            minDurationMs: this.minDurationMs,
            hardCeilingMs: this.hardCeilingMs
        });

        if (room.economy === 'crypto_race') {
            await this.matchPayoutService.collectEntryTickets(room, entries);
        }

        // Start the engine.
        const engine = new MatchEngine({
            room,
            tickMs: this.tickMs,
            onTick: (result) => this.matchManager.onTick(room.id, result),
            onFinish: (finishedRoom) => this.matchManager.onFinish(finishedRoom)
        });
        this.matchManager.setEngine(room.id, engine);
        engine.start();

        // Hard-ceiling watchdog.
        const ceilingId = setTimeout(() => this._expireMatch(room.id, 'hard_ceiling'), this.hardCeilingMs);
        this._timeoutIds.push(ceilingId);
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

    _expireMatch(roomId, reason) {
        this.matchManager?.expire(roomId, reason);
    }

    shutdown() {
        for (const id of this._timeoutIds) clearTimeout(id);
        this._timeoutIds = [];
    }
}

module.exports = MatchScheduler;
