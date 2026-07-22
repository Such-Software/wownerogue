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
const { PG_BIGINT_MAX, matchPayoutAdmissionPolicy } = require('./matchEconomyPolicy');
const { reservePayoutCapacity } = require('../services/payoutAdmissionService');

// Sentinel address for a winner who has not set a payout address yet. The payout row is stored
// as 'needs_review' so the pot is a durable, queryable liability the winner can claim once they
// provide an address — the house never silently keeps it, and the batcher never sends to this.
const NO_ADDRESS_SENTINEL = 'PENDING_NO_ADDRESS';

class MatchPayoutService {
    constructor({ db, walletService, gameModeManager, debugManager, env = process.env } = {}) {
        this.db = db;
        this.walletService = walletService;
        this.gameModeManager = gameModeManager;
        this.debugManager = debugManager;
        this.env = env;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    _admissionPolicy(room) {
        return matchPayoutAdmissionPolicy({
            env: this.env,
            gameModeManager: this.gameModeManager,
            ruleset: room?.ruleset,
            requestedMaxPlayers: room?.maxPlayers
        });
    }

    _admissionError(reason) {
        const error = new Error(`Crypto match payout admission rejected: ${reason}`);
        error.code = String(reason || 'match_payout_admission_rejected').toUpperCase();
        return error;
    }

    _validateEntrants(room, entrants, policy) {
        const list = Array.isArray(entrants) ? entrants : [];
        if (list.length < policy.minPlayers || list.length > policy.maxPlayers) {
            throw this._admissionError('invalid_player_count');
        }
        const userIds = list.map(entrant => entrant?.userId);
        if (userIds.some(userId => userId == null) || new Set(userIds.map(String)).size !== userIds.length) {
            throw this._admissionError('invalid_entrants');
        }
        const queueEntryIds = list.map(entrant => entrant?.queueEntryId);
        if (queueEntryIds.some(id => id == null) || new Set(queueEntryIds.map(String)).size !== queueEntryIds.length) {
            throw this._admissionError('invalid_queue_entries');
        }
        if (room?.playerStates && room.playerStates.size !== list.length) {
            throw this._admissionError('entrant_state_mismatch');
        }
    }

    /**
     * Called by MatchScheduler BEFORE a crypto_race match is announced/started. Commits each
     * entrant's held queue-join ticket to this match, records the ACTUAL collected pot, and
     * computes the house fee via exact integer (BigInt) math. Throws on DB failure so the
     * caller can abort + refund (the transaction rolls back — no tickets are consumed).
     */
    async collectEntryTickets(room, entrants) {
        if (!this.db || !room || room.economy !== 'crypto_race') return;

        const policy = this._admissionPolicy(room);
        if (!policy.enabled) throw this._admissionError(policy.reason);
        this._validateEntrants(room, entrants, policy);

        const entryFee = policy.entryFee;                   // required funded value per ticket
        const houseFeeBp = policy.houseFeeBasisPoints;      // integer basis points (0..9999)
        const count = BigInt((entrants && entrants.length) || 0);
        const housePercent = houseFeeBp / 100;              // for the DECIMAL(5,2) audit column

        // Fast outer-bound check before opening the commitment transaction. The authoritative
        // amount below is summed from locked paid ticket lots, never fabricated from this config.
        const configuredPot = entryFee * count;
        const configuredFee = (configuredPot * BigInt(houseFeeBp)) / 10000n;
        const configuredLiability = configuredPot - configuredFee;
        if (configuredPot > PG_BIGINT_MAX) {
            throw this._admissionError('pot_overflow');
        }
        if (configuredPot - configuredFee <= 0n || configuredPot - configuredFee > policy.payoutCap) {
            throw this._admissionError('payout_cap_exceeded');
        }

        const acceptedSnapshot = await this.db.withTransaction(async (client) => {
            // Acquire the shared bankroll-admission lock before any per-match row lock. This
            // preserves one lock order across solo and match starts and prevents concurrent
            // commitments from all passing against the same unlocked wallet snapshot.
            await reservePayoutCapacity({
                client,
                walletService: this.walletService,
                newLiability: configuredLiability,
                gameModeManager: this.gameModeManager,
                env: this.env
            });
            const queueEntryIds = entrants.map(entrant => entrant.queueEntryId);
            const backingResult = await client.query(`
                SELECT id, user_id, race_entry_lot_id, escrow_amount, escrow_value_atomic
                FROM match_queue_entries
                WHERE id = ANY($1::bigint[])
                  AND match_id = $2
                  AND economy = 'crypto_race'
                  AND status = 'matched'
                ORDER BY id ASC
                FOR UPDATE
            `, [queueEntryIds, room.id]);
            if (backingResult.rowCount !== queueEntryIds.length) {
                throw this._admissionError('queue_backing_mismatch');
            }

            const backingById = new Map(backingResult.rows.map(row => [String(row.id), row]));
            let pot = 0n;
            const ticketBacking = [];
            for (const entrant of entrants) {
                const backing = backingById.get(String(entrant.queueEntryId));
                let value;
                try { value = BigInt(backing?.escrow_value_atomic); }
                catch (_) { throw this._admissionError('invalid_ticket_backing'); }
                if (!backing
                    || String(backing.user_id) !== String(entrant.userId)
                    || Number(backing.escrow_amount) !== 1
                    || backing.race_entry_lot_id == null
                    || value !== entryFee) {
                    throw this._admissionError('invalid_ticket_backing');
                }
                pot += value;
                ticketBacking.push({
                    queueEntryId: String(backing.id),
                    raceEntryLotId: String(backing.race_entry_lot_id),
                    valueAtomic: value.toString()
                });
            }
            const houseFee = (pot * BigInt(houseFeeBp)) / 10000n;
            const liabilityAmount = pot - houseFee;
            if (liabilityAmount <= 0n || liabilityAmount > policy.payoutCap) {
                throw this._admissionError('payout_cap_exceeded');
            }

            const terms = {
                version: 2,
                model: 'winner-takes-funded-ticket-pool-minus-house-fee',
                funding: 'confirmed-payment-ticket-lots',
                rulesetId: room.ruleset?.id || 'race',
                winCondition: room.ruleset?.winCondition?.type || 'first-to-exit',
                playerCount: Number(count),
                ticketBacking,
                entryFeeAtomic: entryFee.toString(),
                potAtomic: pot.toString(),
                houseFeeAtomic: houseFee.toString(),
                houseFeeBasisPoints: houseFeeBp,
                payoutAmountAtomic: liabilityAmount.toString(),
                payoutCapAtomic: policy.payoutCap.toString(),
                cryptoType: String(room.cryptoType || this.env.CRYPTO_TYPE || 'WOW').toUpperCase(),
                network: String(this.env.MONERO_NETWORK || 'mainnet').toLowerCase()
            };

            for (const entrant of (entrants || [])) {
                // Commit the held ticket to this match (delta 0 — it was already deducted at
                // queue-join; this row records the commitment for the audit trail).
                await client.query(`
                    INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, match_id)
                    VALUES ($1, 0, (
                        SELECT race_entries FROM users WHERE id = $1
                    ), 'match_start', $2)
                `, [entrant.userId, room.id]);

                const consumed = await client.query(`
                    UPDATE match_entrants
                    SET entry_consumed = TRUE
                    WHERE match_id = $1 AND user_id = $2 AND entry_consumed = FALSE
                    RETURNING id
                `, [room.id, entrant.userId]);
                if (consumed.rowCount !== 1) {
                    throw this._admissionError('entrant_commit_mismatch');
                }

                const queueConsumed = await client.query(`
                    UPDATE match_queue_entries
                    SET status = 'consumed', consumed_at = NOW()
                    WHERE id = $1 AND match_id = $2 AND user_id = $3
                      AND economy = 'crypto_race' AND status = 'matched'
                    RETURNING id
                `, [entrant.queueEntryId, room.id, entrant.userId]);
                if (queueConsumed.rowCount !== 1) {
                    throw this._admissionError('queue_commit_mismatch');
                }
            }

            // Lock the true pot, fee, cap, and accepted liability in the SAME transaction as
            // ticket commitment. The migration makes this snapshot immutable after acceptance.
            const accepted = await client.query(`
                UPDATE matches
                SET entry_fee_atomic = $1,
                    pot_atomic = $2,
                    house_fee_atomic = $3,
                    house_fee_percent = $4,
                    payout_liability_amount_atomic = $5,
                    payout_liability_cap_atomic = $6,
                    payout_liability_terms = $7::jsonb,
                    payout_liability_accepted_at = NOW()
                WHERE id = $8
                  AND economy = 'crypto_race'
                  AND status = 'starting'
                  AND payout_liability_accepted_at IS NULL
                RETURNING id, payout_liability_accepted_at
            `, [
                entryFee.toString(),
                pot.toString(),
                houseFee.toString(),
                housePercent,
                liabilityAmount.toString(),
                policy.payoutCap.toString(),
                JSON.stringify(terms),
                room.id
            ]);
            if (accepted.rowCount !== 1) {
                throw this._admissionError('liability_snapshot_failed');
            }
            return { pot, houseFee, liabilityAmount, terms };
        });

        // Atomic amounts stay decimal strings in memory so persistence/debug snapshots never
        // round values above Number.MAX_SAFE_INTEGER. The authoritative values live in SQL.
        room.entryFeeAtomic = entryFee.toString();
        room.potAtomic = acceptedSnapshot.pot.toString();
        room.houseFeeAtomic = acceptedSnapshot.houseFee.toString();
        room.houseFeePercent = housePercent;
        room.payoutLiabilityAmountAtomic = acceptedSnapshot.liabilityAmount.toString();
        room.payoutLiabilityCapAtomic = policy.payoutCap.toString();
        room.payoutLiabilityTerms = acceptedSnapshot.terms;

        this._log(`[MatchPayoutService] accepted liability ${acceptedSnapshot.liabilityAmount} from funded pool ${acceptedSnapshot.pot} (house fee ${acceptedSnapshot.houseFee}, ${housePercent}%) for match ${room.id}`);
    }

    /**
     * Resolve an ambiguous transaction acknowledgement. A database connection can fail while
     * COMMIT is being acknowledged; the caller must inspect the durable snapshot before deciding
     * to refund/abort, otherwise it could cancel a committed liability without returning tickets.
     */
    async getAcceptedLiability(matchId) {
        if (!this.db || !matchId) return null;
        const result = await this.db.query(`
            SELECT entry_fee_atomic, pot_atomic, house_fee_atomic, house_fee_percent,
                   payout_liability_amount_atomic, payout_liability_cap_atomic,
                   payout_liability_terms, payout_liability_accepted_at
            FROM matches
            WHERE id = $1
              AND economy = 'crypto_race'
              AND status IN ('starting', 'active')
              AND payout_liability_accepted_at IS NOT NULL
            LIMIT 1
        `, [matchId]);
        const row = result.rows?.[0];
        if (!row) return null;
        try {
            const amount = BigInt(row.payout_liability_amount_atomic);
            const cap = BigInt(row.payout_liability_cap_atomic);
            const pot = BigInt(row.pot_atomic);
            const fee = BigInt(row.house_fee_atomic);
            if (amount <= 0n || cap <= 0n || amount > cap || pot <= 0n || fee < 0n || amount !== pot - fee) {
                return null;
            }
        } catch (_) {
            return null;
        }
        return row;
    }

    /**
     * Called by MatchManager when a crypto_race match finishes. Creates ONE pending payout for
     * the winner capped at (pot − house fee). If the winner has no payout address the payout is
     * still recorded (status 'needs_review', a claimable liability) so the house never keeps it.
     */
    async payoutWinner(room) {
        if (!this.db || !room || room.economy !== 'crypto_race' || !room.winnerId) return;
        try {
            const result = await this.db.withTransaction(client => this._createPayoutForMatch(client, room.id));
            if (result.created && result.status === 'pending') {
                // Trigger the existing batch payout processor (5s debounce).
                if (this.gameModeManager && typeof this.gameModeManager._scheduleBatchPayout === 'function') {
                    this.gameModeManager._scheduleBatchPayout();
                }
            }
            return result;
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to queue match payout');
            this._log('[MatchPayoutService] payout error:', normalized.message);
            throw normalized;
        }
    }

    /**
     * Create the payout promised by an accepted snapshot. No current admission flag is read:
     * MATCH_PAYOUTS_ENABLED can stop new matches, but cannot erase an existing liability.
     * The match's finished winner and immutable amount are authoritative, not in-memory values.
     */
    async _createPayoutForMatch(client, matchId) {
        const matchResult = await client.query(`
            SELECT id, economy, status, winner_user_id,
                   payout_liability_amount_atomic, payout_liability_cap_atomic,
                   payout_liability_accepted_at
            FROM matches
            WHERE id = $1
            FOR UPDATE
        `, [matchId]);
        const match = matchResult.rows?.[0];
        if (!match || match.economy !== 'crypto_race' || match.status !== 'finished' || match.winner_user_id == null) {
            return { created: false, reason: 'match_not_settleable' };
        }
        // OFF -> ON must never create a retroactive liability: only the durable admission
        // snapshot, written while tickets were committed, authorizes a payout.
        if (!match.payout_liability_accepted_at) {
            return { created: false, reason: 'liability_not_accepted' };
        }

        let amount, cap;
        try {
            amount = BigInt(match.payout_liability_amount_atomic);
            cap = BigInt(match.payout_liability_cap_atomic);
        } catch (_) {
            throw this._admissionError('invalid_liability_snapshot');
        }
        if (amount <= 0n || cap <= 0n || amount > cap) {
            throw this._admissionError('invalid_liability_snapshot');
        }

        const existing = await client.query(`
            SELECT id, status FROM payouts WHERE match_id = $1 LIMIT 1
        `, [match.id]);
        if (existing.rows?.length) {
            return { created: false, reason: 'payout_exists', payoutId: existing.rows[0].id };
        }

        const userResult = await client.query(`
            SELECT id, payout_address FROM users WHERE id = $1 LIMIT 1
        `, [match.winner_user_id]);
        const user = userResult.rows?.[0];
        if (!user) throw this._admissionError('winner_not_found');

        const hasAddress = typeof user.payout_address === 'string' && user.payout_address.trim().length > 0;
        const address = hasAddress ? user.payout_address.trim() : NO_ADDRESS_SENTINEL;
        const status = hasAddress ? 'pending' : 'needs_review';
        const reason = hasAddress ? 'match_winner' : 'match_winner_no_address';
        const inserted = await client.query(`
            INSERT INTO payouts (user_id, match_id, payout_address, amount, multiplier, reason, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT DO NOTHING
            RETURNING id
        `, [user.id, match.id, address, amount.toString(), 0, reason, status]);
        if (inserted.rowCount !== 1) {
            return { created: false, reason: 'payout_exists' };
        }

        this._log(`[MatchPayoutService] recorded ${status} liability ${amount} for match ${match.id}`);
        return { created: true, status, amount: amount.toString(), payoutId: inserted.rows?.[0]?.id };
    }

    /** Reconcile durable finished liabilities after a crash or transient payout-insert failure. */
    async reconcileFinishedLiabilities({ limit = 100 } = {}) {
        if (!this.db) return { ok: true, scanned: 0, created: 0, failed: 0, unresolved: [] };
        const candidates = await this.db.query(`
            SELECT m.id
            FROM matches m
            WHERE m.economy = 'crypto_race'
              AND m.status = 'finished'
              AND m.winner_user_id IS NOT NULL
              AND m.payout_liability_accepted_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.match_id = m.id)
            ORDER BY m.ended_at ASC NULLS LAST, m.id ASC
            LIMIT $1
        `, [Math.max(1, Math.min(1000, parseInt(limit, 10) || 100))]);

        let created = 0;
        let failed = 0;
        const unresolved = [];
        let pendingCreated = false;
        for (const candidate of candidates.rows || []) {
            try {
                const result = await this.db.withTransaction(client => this._createPayoutForMatch(client, candidate.id));
                if (result.created) {
                    created += 1;
                    if (result.status === 'pending') pendingCreated = true;
                }
            } catch (err) {
                failed += 1;
                unresolved.push({ type: 'match_liability', id: candidate.id });
                this._log(`[MatchPayoutService] reconciliation failed for ${candidate.id}:`, err.message);
            }
        }
        if (pendingCreated && this.gameModeManager && typeof this.gameModeManager._scheduleBatchPayout === 'function') {
            this.gameModeManager._scheduleBatchPayout();
        }
        return {
            ok: failed === 0,
            scanned: candidates.rows?.length || 0,
            created,
            failed,
            unresolved
        };
    }

}

module.exports = MatchPayoutService;
