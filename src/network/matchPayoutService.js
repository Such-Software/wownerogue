/**
 * MatchPayoutService — crypto-race pot accounting and winner payout.
 *
 * On match start: convert held tickets to consumed entries and lock the pot.
 * On match end: calculate house fee, create one pending payout for the winner,
 * then schedule batch processing via the existing GameModeManager path.
 *
 * This service does not send on-chain transactions itself; it reuses the existing
 * payout retry / batching machinery in GameModeManager.
 */

const { normalizeError } = require('../utils/errors');

class MatchPayoutService {
    constructor({ db, walletService, gameModeManager, debugManager } = {}) {
        this.db = db;
        this.walletService = walletService;
        this.gameModeManager = gameModeManager;
        this.debugManager = debugManager;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    /**
     * Called by MatchScheduler when a crypto_race match is created.
     * Atomically converts each entrant's queue_join ticket into a consumed match ticket,
     * computes pot/house fee, and stores it on the match row.
     */
    async collectEntryTickets(room, entrants) {
        if (!this.db || room.economy !== 'crypto_race') return;

        const entryFee = this._entryFee();
        const houseFeePercent = this._houseFeePercent();
        const pot = entryFee * entrants.length;
        const houseFee = Math.floor((pot * houseFeePercent) / 100);

        await this.db.withTransaction(async (client) => {
            for (const entrant of entrants) {
                // Convert the held ticket to consumed.
                await client.query(`
                    INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, match_id)
                    VALUES ($1, 0, (
                        SELECT race_entries FROM users WHERE id = $1
                    ), 'match_start', $2)
                `, [entrant.userId, room.id]);

                // Update match_entrant to consumed.
                await client.query(`
                    UPDATE match_entrants
                    SET entry_consumed = TRUE
                    WHERE match_id = $1 AND user_id = $2
                `, [room.id, entrant.userId]);
            }

            // Lock pot/house fee on the match row.
            await client.query(`
                UPDATE matches
                SET entry_fee_atomic = $1,
                    pot_atomic = $2,
                    house_fee_atomic = $3,
                    house_fee_percent = $4
                WHERE id = $5
            `, [entryFee, pot, houseFee, houseFeePercent, room.id]);
        });

        room.entryFeeAtomic = entryFee;
        room.potAtomic = pot;
        room.houseFeeAtomic = houseFee;
        room.houseFeePercent = houseFeePercent;

        this._log(`[MatchPayoutService] locked pot ${pot} (house fee ${houseFee}) for match ${room.id}`);
    }

    /**
     * Called by MatchManager when a crypto_race match finishes.
     * Creates one pending payout for the winner and hands it to the batch processor.
     */
    async payoutWinner(room) {
        if (!this.db || room.economy !== 'crypto_race' || !room.winnerId) return;

        const winnerState = room.playerStates.get(room.winnerId);
        if (!winnerState || !winnerState.userId) return;

        const matchRow = await this.db.query(`
            SELECT pot_atomic, house_fee_atomic
            FROM matches
            WHERE id = $1
        `, [room.id]);
        if (matchRow.rows.length === 0) return;

        const pot = BigInt(matchRow.rows[0].pot_atomic || 0);
        const houseFee = BigInt(matchRow.rows[0].house_fee_atomic || 0);
        const winnerAmount = pot - houseFee;

        if (winnerAmount <= 0) {
            this._log(`[MatchPayoutService] no winner payout for match ${room.id} (pot=${pot} fee=${houseFee})`);
            return;
        }

        // Resolve payout address from user record.
        const userResult = await this.db.query(`
            SELECT id, payout_address
            FROM users
            WHERE id = $1
            LIMIT 1
        `, [winnerState.userId]);
        const user = userResult.rows[0];
        if (!user || !user.payout_address) {
            this._log(`[MatchPayoutService] winner has no payout address; match ${room.id} payout deferred`);
            return;
        }

        try {
            await this.db.withTransaction(async (client) => {
                // Guard against double payout.
                const existing = await client.query(`
                    SELECT id FROM payouts
                    WHERE match_id = $1 AND status IN ('pending', 'processing', 'completed')
                    FOR UPDATE
                `, [room.id]);
                if (existing.rows.length > 0) {
                    throw Object.assign(new Error('Payout already exists for this match'), { code: 'PAYOUT_EXISTS' });
                }

                await client.query(`
                    INSERT INTO payouts (user_id, match_id, payout_address, amount, multiplier, reason, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                `, [user.id, room.id, user.payout_address, winnerAmount.toString(), 0, 'match_winner', 'pending']);
            });

            // Trigger the existing batch payout processor.
            if (this.gameModeManager && typeof this.gameModeManager._scheduleBatchPayout === 'function') {
                this.gameModeManager._scheduleBatchPayout();
            }

            this._log(`[MatchPayoutService] queued winner payout ${winnerAmount} for match ${room.id}`);
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to queue match payout');
            this._log('[MatchPayoutService] payout error:', normalized.message);
        }
    }

    _entryFee() {
        const fee = this.gameModeManager?.singleGamePrice || process.env.MATCH_ENTRY_FEE_ATOMIC || 5000000000;
        const parsed = Number(fee);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    _houseFeePercent() {
        const v = parseFloat(process.env.MATCH_HOUSE_FEE_PERCENT);
        return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 5;
    }
}

module.exports = MatchPayoutService;
