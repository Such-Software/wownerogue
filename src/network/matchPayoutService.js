/**
 * MatchPayoutService — crypto-race pot accounting and winner payout.
 *
 * On match start: commit each entrant's held ticket to the match and lock the pot (the ACTUAL
 * atomic amount collected), computing the house fee with exact integer math.
 * On match end: create ONE pending payout for the winner, capped at the true collected pot
 * minus the house fee, then hand it to the existing GameModeManager batch/retry machinery.
 *
 * This service does not send on-chain transactions itself; it reuses the existing payout retry
 * / batching path in GameModeManager. All pot/fee arithmetic is BigInt — no float precision
 * loss on large atomic amounts.
 */

const { normalizeError } = require('../utils/errors');

// Sentinel address for a winner who has not set a payout address yet. The payout row is stored
// as 'needs_review' so the pot is a durable, queryable liability the winner can claim once they
// provide an address — the house never silently keeps it, and the batcher never sends to this.
const NO_ADDRESS_SENTINEL = 'PENDING_NO_ADDRESS';
const DEFAULT_ENTRY_FEE_ATOMIC = 5000000000n; // 0.05 WOW at 11 decimals; only a last-resort default

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
     * Called by MatchScheduler BEFORE a crypto_race match is announced/started. Commits each
     * entrant's held queue-join ticket to this match, records the ACTUAL collected pot, and
     * computes the house fee via exact integer (BigInt) math. Throws on DB failure so the
     * caller can abort + refund (the transaction rolls back — no tickets are consumed).
     */
    async collectEntryTickets(room, entrants) {
        if (!this.db || !room || room.economy !== 'crypto_race') return;

        const entryFee = this._entryFeeAtomic();          // BigInt atomic units per entry
        const houseFeeBp = this._houseFeeBasisPoints();     // integer basis points (0..10000)
        const count = BigInt((entrants && entrants.length) || 0);
        const pot = entryFee * count;                       // ACTUAL collected pot (BigInt)
        const houseFee = (pot * BigInt(houseFeeBp)) / 10000n; // floor via integer math — no float
        const housePercent = houseFeeBp / 100;              // for the DECIMAL(5,2) audit column

        await this.db.withTransaction(async (client) => {
            for (const entrant of (entrants || [])) {
                // Commit the held ticket to this match (delta 0 — it was already deducted at
                // queue-join; this row records the commitment for the audit trail).
                await client.query(`
                    INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, match_id)
                    VALUES ($1, 0, (
                        SELECT race_entries FROM users WHERE id = $1
                    ), 'match_start', $2)
                `, [entrant.userId, room.id]);

                await client.query(`
                    UPDATE match_entrants
                    SET entry_consumed = TRUE
                    WHERE match_id = $1 AND user_id = $2
                `, [room.id, entrant.userId]);
            }

            // Lock the true pot / house fee on the match row (BigInt passed as strings so the
            // BIGINT columns are exact).
            await client.query(`
                UPDATE matches
                SET entry_fee_atomic = $1,
                    pot_atomic = $2,
                    house_fee_atomic = $3,
                    house_fee_percent = $4
                WHERE id = $5
            `, [entryFee.toString(), pot.toString(), houseFee.toString(), housePercent, room.id]);
        });

        // In-memory bookkeeping (informational). The authoritative amounts live on the match
        // row and are re-read (as BigInt) at payout time.
        room.entryFeeAtomic = Number(entryFee);
        room.potAtomic = Number(pot);
        room.houseFeeAtomic = Number(houseFee);
        room.houseFeePercent = housePercent;

        this._log(`[MatchPayoutService] locked pot ${pot} (house fee ${houseFee}, ${housePercent}%) for match ${room.id}`);
    }

    /**
     * Called by MatchManager when a crypto_race match finishes. Creates ONE pending payout for
     * the winner capped at (pot − house fee). If the winner has no payout address the payout is
     * still recorded (status 'needs_review', a claimable liability) so the house never keeps it.
     */
    async payoutWinner(room) {
        if (!this.db || !room || room.economy !== 'crypto_race' || !room.winnerId) return;

        const winnerState = room.playerStates.get(room.winnerId);
        if (!winnerState || winnerState.userId == null) return;

        // Authoritative pot / fee from the match row (locked at collectEntryTickets).
        const matchRow = await this.db.query(`
            SELECT pot_atomic, house_fee_atomic
            FROM matches
            WHERE id = $1
        `, [room.id]);
        if (!matchRow.rows || matchRow.rows.length === 0) return;

        let pot, houseFee;
        try {
            pot = BigInt(matchRow.rows[0].pot_atomic ?? 0);
            houseFee = BigInt(matchRow.rows[0].house_fee_atomic ?? 0);
        } catch (_) {
            return;
        }
        if (houseFee < 0n) houseFee = 0n;
        if (houseFee > pot) houseFee = pot;                 // never pay a negative amount
        const winnerAmount = pot - houseFee;                // capped at true collected pot − fee

        if (winnerAmount <= 0n) {
            this._log(`[MatchPayoutService] no winner payout for match ${room.id} (pot=${pot} fee=${houseFee})`);
            return;
        }

        // Resolve payout address from the user record (may be absent).
        const userResult = await this.db.query(`
            SELECT id, payout_address
            FROM users
            WHERE id = $1
            LIMIT 1
        `, [winnerState.userId]);
        const user = userResult.rows[0];
        if (!user) return;

        const hasAddress = typeof user.payout_address === 'string' && user.payout_address.trim().length > 0;
        const address = hasAddress ? user.payout_address.trim() : NO_ADDRESS_SENTINEL;
        const status = hasAddress ? 'pending' : 'needs_review';
        const reason = hasAddress ? 'match_winner' : 'match_winner_no_address';

        try {
            await this.db.withTransaction(async (client) => {
                // Guard against a double payout for this match (includes the deferred
                // no-address row so we never insert two).
                const existing = await client.query(`
                    SELECT id FROM payouts
                    WHERE match_id = $1 AND status IN ('pending', 'processing', 'completed', 'needs_review')
                    FOR UPDATE
                `, [room.id]);
                if (existing.rows.length > 0) {
                    throw Object.assign(new Error('Payout already exists for this match'), { code: 'PAYOUT_EXISTS' });
                }

                await client.query(`
                    INSERT INTO payouts (user_id, match_id, payout_address, amount, multiplier, reason, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                `, [user.id, room.id, address, winnerAmount.toString(), 0, reason, status]);
            });

            if (hasAddress) {
                // Trigger the existing batch payout processor (5s debounce).
                if (this.gameModeManager && typeof this.gameModeManager._scheduleBatchPayout === 'function') {
                    this.gameModeManager._scheduleBatchPayout();
                }
                this._log(`[MatchPayoutService] queued winner payout ${winnerAmount} for match ${room.id}`);
            } else {
                this._log(`[MatchPayoutService] winner ${user.id} has no payout address; recorded ${winnerAmount} as a claimable 'needs_review' payout for match ${room.id}`);
            }
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to queue match payout');
            this._log('[MatchPayoutService] payout error:', normalized.message);
        }
    }

    /**
     * Entry fee (atomic units, BigInt). Does NOT assume entryFee == singleGamePrice: an explicit
     * MATCH_ENTRY_FEE_ATOMIC (or a gameModeManager.matchEntryFeeAtomic) wins; singleGamePrice is
     * only a fallback, then a hard default.
     */
    _entryFeeAtomic() {
        const raw = (process.env.MATCH_ENTRY_FEE_ATOMIC != null && process.env.MATCH_ENTRY_FEE_ATOMIC !== '')
            ? process.env.MATCH_ENTRY_FEE_ATOMIC
            : (this.gameModeManager?.matchEntryFeeAtomic
                ?? this.gameModeManager?.singleGamePrice
                ?? null);
        if (raw == null) return DEFAULT_ENTRY_FEE_ATOMIC;
        try {
            // Atomic units are integers; strip any fractional part defensively before BigInt.
            const s = String(raw).trim().split('.')[0];
            const b = BigInt(s);
            return b > 0n ? b : DEFAULT_ENTRY_FEE_ATOMIC;
        } catch (_) {
            return DEFAULT_ENTRY_FEE_ATOMIC;
        }
    }

    /**
     * House fee as integer basis points (percent × 100), so a fractional percent like 5.5%
     * survives with no float precision loss in the pot math.
     */
    _houseFeeBasisPoints() {
        const pct = parseFloat(process.env.MATCH_HOUSE_FEE_PERCENT);
        const p = Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : 5;
        return Math.round(p * 100);
    }
}

module.exports = MatchPayoutService;
