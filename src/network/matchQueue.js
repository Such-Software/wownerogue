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
const { createFinancialRecoveryError } = require('../utils/financialRecoveryError');
const { matchPayoutAdmissionPolicy } = require('./matchEconomyPolicy');
const crypto = require('crypto');
const { PAID_FREEZE_VERSION, buildPaidEntrantFreeze } = require('./matchFairness');

const ECONOMIES = Object.freeze(['free', 'credits_prestige', 'crypto_race']);
const MATCH_ECONOMY_SET = new Set(ECONOMIES);
// race_entry_transactions.reason is CHECK-constrained; map any cancellation reason into it.
const RACE_LEDGER_REASONS = new Set(['queue_leave', 'match_cancel', 'refund']);

class MatchQueue {
    constructor({ db, gameModeManager = null, debugManager = null, isFinancialRecoveryReady = null } = {}) {
        this.db = db;
        this.gameModeManager = gameModeManager;
        this.debugManager = debugManager;
        this.isFinancialRecoveryReady = typeof isFinancialRecoveryReady === 'function'
            ? isFinancialRecoveryReady
            : () => true;
        this.enabled = process.env.MATCH_ENABLED === 'true';
        this.initialized = false;

        // In-memory hot state: economy -> array of queue entries (for fast scheduling).
        // Rebuilt from DB on initialize().
        this._queues = { free: [], credits_prestige: [], crypto_race: [] };
        this._availabilityTimer = null;
        this._reconcileRunning = false;
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    async initialize() {
        if (!this.db) return;
        this.initialized = false;

        // MP-H3: refund + cancel abandoned entries and recover in-flight matches BEFORE
        // rebuilding memory, so escrow is never silently lost across a restart/crash.
        await this._recoverAbandonedMatches();
        await this._recoverStaleQueueEntries();
        await this.cancelUnverifiedPaidFreezes('match_cancel', { failOnError: true });

        // Rebuild in-memory state from the surviving 'queued' rows.
        let result;
        try {
            result = await this.db.query(`
                SELECT id, user_id, economy, socket_id, session_token, created_at
                FROM match_queue_entries
                WHERE status = 'queued'
                ORDER BY created_at ASC, id ASC
            `);
        } catch (error) {
            throw createFinancialRecoveryError('match_queue_rebuild', {
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }, error);
        }

        for (const row of result.rows || []) {
            if (!this._queues[row.economy]) continue;
            // Configuration may have changed while the process was down. Never revive an
            // unavailable paid queue (especially crypto_race while payouts are disabled): cancel
            // it transactionally and return the held credit/ticket instead.
            if (!this.enabled || !this._isEconomyAvailable(row.economy)) {
                const refunded = await this._leaveOne(row.user_id, row.economy);
                // A transient refund failure leaves the durable row queued. Retain a volatile
                // retry handle so the reconciliation timer below keeps trying without requiring
                // another restart; `not_queued` means another actor already resolved it.
                if (!refunded.success && refunded.reason !== 'not_queued') {
                    this._queues[row.economy].push({
                        queueEntryId: row.id,
                        userId: row.user_id,
                        socketId: row.socket_id,
                        sessionToken: row.session_token,
                        createdAt: new Date(row.created_at).getTime()
                    });
                }
                continue;
            }
            this._queues[row.economy].push({
                queueEntryId: row.id,
                userId: row.user_id,
                socketId: row.socket_id,
                sessionToken: row.session_token,
                createdAt: new Date(row.created_at).getTime()
            });
        }

        // Pending paid entrant freezes are deliberately not stale queue rows: they wait for the
        // exact later entropy block and survive a crash. If admission is now disabled, however,
        // claim and refund each whole freeze before the scheduler becomes ready.
        await this.refundUnavailableQueues('match_cancel', { failOnError: true });

        // Do not depend on a new block arriving after an operator flips a kill switch. Poll the
        // admission policy and transactionally return any now-disabled paid queue escrow.
        const reconcileMs = Math.max(1000, parseInt(process.env.MATCH_AVAILABILITY_RECONCILE_MS, 10) || 5000);
        this._availabilityTimer = setInterval(async () => {
            if (this._reconcileRunning) return;
            this._reconcileRunning = true;
            try {
                // Also retry unlinked matched holds left by a failed persist/refund attempt.
                // The exact-row anchor below refuses a row once a match has linked it.
                await this._recoverStaleQueueEntries({
                    matchedMinAgeSec: Math.max(
                        5,
                        parseInt(process.env.MATCH_STALE_RECONCILE_AGE_SEC, 10) || 30
                    )
                });
                await this.refundUnavailableQueues('match_cancel', { failOnError: true });
                this.initialized = true;
            } catch (err) {
                // This status feeds readiness and every paid-admission predicate. Keep the
                // periodic retry alive, but do not accept more value while durable escrow is
                // known to be unresolved.
                this.initialized = false;
                this._log('[MatchQueue] availability reconciliation error', err.message);
            } finally {
                this._reconcileRunning = false;
            }
        }, reconcileMs);
        this._availabilityTimer.unref?.();

        // Blocks can arrive while database migrations/recovery are still running. Do not let
        // the scheduler drain a partially rebuilt queue until every recovery step has committed.
        this.initialized = true;

        this._log(`[MatchQueue] Initialized: ${this.length('free')} free, ${this.length('credits_prestige')} prestige, ${this.length('crypto_race')} crypto`);
    }

    /**
     * Refund + cancel queue rows abandoned by a crash: in single-instance mode every unlinked
     * 'matched' row is from the dead process; multi-instance deployments retain a five-minute
     * grace for a sibling to link it. Queued rows age out after 24h. Each refund is
     * written to the ledger; the row is only cancelled in the same transaction as its refund.
     */
    async _recoverStaleQueueEntries({ matchedMinAgeSec = null } = {}) {
        const singleInstance = String(process.env.MATCH_SINGLE_INSTANCE || 'true').toLowerCase() !== 'false';
        const matchedAge = matchedMinAgeSec == null
            ? (singleInstance ? 0 : 300)
            : Math.max(0, Math.min(3600, parseInt(matchedMinAgeSec, 10) || 0));
        let stale = [];
        try {
            const res = await this.db.query(`
                SELECT id, user_id, economy, escrow_amount, race_entry_lot_id FROM match_queue_entries
                WHERE (status = 'matched' AND match_id IS NULL
                       AND COALESCE(matched_at, created_at) <= NOW() - ($1::int * INTERVAL '1 second'))
                   OR (status = 'queued'  AND created_at < NOW() - INTERVAL '24 hours')
            `, [matchedAge]);
            stale = res.rows || [];
        } catch (err) {
            this._log('[MatchQueue] stale scan error', err.message);
            throw createFinancialRecoveryError('stale_match_queue_entries', {
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }, err);
        }
        const summary = { ok: true, scanned: stale.length, resolved: 0, unresolved: [] };
        for (const row of stale) {
            let recovered = false;
            try {
                await this.db.withTransaction(async (client) => {
                    const upd = await client.query(`
                        UPDATE match_queue_entries
                        SET status = 'cancelled', match_id = NULL
                        WHERE id = $1 AND user_id = $2 AND economy = $3
                          AND (
                              status = 'queued'
                              OR (status = 'matched' AND match_id IS NULL)
                          )
                        RETURNING id, escrow_amount, race_entry_lot_id
                    `, [row.id, row.user_id, row.economy]);
                    if (upd.rowCount > 0) {
                        await this._applyRefund(
                            client,
                            row.user_id,
                            row.economy,
                            'match_cancel',
                            upd.rows[0].escrow_amount,
                            upd.rows[0].race_entry_lot_id
                        );
                        recovered = true;
                    }
                });
                if (recovered && this._queues[row.economy]) {
                    this._queues[row.economy] = this._queues[row.economy]
                        .filter(entry => String(entry.queueEntryId) !== String(row.id));
                }
                // A zero-row update means another actor already resolved the row under lock.
                summary.resolved += 1;
            } catch (err) {
                this._log('[MatchQueue] stale recovery error', err.message);
                summary.unresolved.push({ type: 'queue_entry', id: row.id });
            }
        }
        if (summary.unresolved.length > 0) {
            summary.ok = false;
            throw createFinancialRecoveryError('stale_match_queue_entries', summary);
        }
        return summary;
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
            this._log('[MatchQueue] abandoned match scan error', err.message);
            throw createFinancialRecoveryError('abandoned_matches', {
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }, err);
        }
        const summary = { ok: true, scanned: rows.length, resolved: 0, unresolved: [] };
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

                    const ent = await client.query(`
                        SELECT id, user_id, queue_entry_id
                        FROM match_entrants
                        WHERE match_id = $1
                    `, [m.id]);
                    for (const e of ent.rows || []) {
                        if (m.economy === 'crypto_race' || m.economy === 'credits_prestige') {
                            // The queue row is the primary exactly-once refund anchor. New rows
                            // are linked by match_id; the unlinked branch safely recovers legacy
                            // rows created before migration 033.
                            let anchor;
                            if (e.queue_entry_id != null) {
                                anchor = await client.query(`
                                    UPDATE match_queue_entries
                                    SET status = 'cancelled'
                                    WHERE id = $1 AND match_id = $2 AND user_id = $3
                                      AND status IN ('matched', 'consumed')
                                    RETURNING id, escrow_amount, race_entry_lot_id
                                `, [e.queue_entry_id, m.id, e.user_id]);
                            } else {
                                anchor = await client.query(`
                                    UPDATE match_queue_entries
                                    SET status = 'cancelled'
                                    WHERE match_id = $1 AND user_id = $2
                                      AND status IN ('matched', 'consumed')
                                    RETURNING id, escrow_amount, race_entry_lot_id
                                `, [m.id, e.user_id]);
                            }
                            if (anchor.rowCount === 0) {
                                anchor = await client.query(`
                                    UPDATE match_queue_entries
                                    SET status = 'cancelled'
                                    WHERE id = (
                                        SELECT id FROM match_queue_entries
                                        WHERE match_id IS NULL AND user_id = $1 AND economy = $2
                                          AND status = 'matched'
                                        ORDER BY matched_at ASC NULLS LAST, id ASC
                                        LIMIT 1 FOR UPDATE
                                    )
                                    RETURNING id, escrow_amount, race_entry_lot_id
                                `, [e.user_id, m.economy]);
                            }
                            if (anchor.rowCount > 1) {
                                throw new Error(`Multiple queue escrow anchors for match ${m.id}, user ${e.user_id}`);
                            }
                            if (anchor.rowCount > 0) {
                                await this._applyRefund(
                                    client,
                                    e.user_id,
                                    m.economy,
                                    'match_cancel',
                                    anchor.rows[0].escrow_amount,
                                    anchor.rows[0].race_entry_lot_id
                                );
                                await client.query(`
                                    UPDATE match_entrants
                                    SET entry_refunded_at = COALESCE(entry_refunded_at, NOW())
                                    WHERE id = $1
                                `, [e.id]);
                            } else {
                                // Last-resort legacy anchor when the old process never linked or
                                // retained a queue row. entry_refunded_at makes the fallback
                                // idempotent across repeated boots.
                                const claimedEntrant = await client.query(`
                                    UPDATE match_entrants SET entry_refunded_at = NOW()
                                    WHERE id = $1 AND entry_refunded_at IS NULL
                                    RETURNING id
                                `, [e.id]);
                                if (claimedEntrant.rowCount > 0) {
                                    await this._applyRefund(client, e.user_id, m.economy, 'match_cancel');
                                }
                            }
                        }
                    }
                });
                this._log(`[MatchQueue] recovered abandoned match ${m.id} (${m.economy})`);
                summary.resolved += 1;
            } catch (err) {
                this._log('[MatchQueue] abandoned match recovery error', err.message);
                summary.unresolved.push({ type: 'match', id: m.id });
            }
        }
        if (summary.unresolved.length > 0) {
            summary.ok = false;
            throw createFinancialRecoveryError('abandoned_matches', summary);
        }
        return summary;
    }

    _validateEconomy(economy) {
        return MATCH_ECONOMY_SET.has(economy) ? economy : null;
    }

    _isEconomyAvailable(economy) {
        if (!this.enabled || !this._validateEconomy(economy)) return false;
        if (economy === 'crypto_race') {
            // Never let an injected/legacy queue bypass the crypto admission contract. This is
            // evaluated on every join/drain so a hot kill-switch takes effect immediately.
            const policy = matchPayoutAdmissionPolicy({
                env: process.env,
                gameModeManager: this.gameModeManager
            });
            if (!policy.enabled) return false;
        }
        if (this.gameModeManager && typeof this.gameModeManager._getMatchEconomies === 'function') {
            return this.gameModeManager._getMatchEconomies()[economy] === true;
        }
        return true; // free/prestige injected users retain the historical contract
    }

    isEnabled() {
        return this.enabled;
    }

    isEconomyAvailable(economy) {
        return this._isEconomyAvailable(economy);
    }

    length(economy) {
        return this._queues[economy]?.length || 0;
    }

    snapshot(economy) {
        if (!this._validateEconomy(economy)) return [];
        return this._queues[economy].slice();
    }

    /**
     * Atomically freeze one FIFO paid entrant set before its entropy block exists. The pending
     * matches row is a durable freeze envelope, not a playable match: seed_hash temporarily holds
     * the deterministic entrant-freeze commitment and dungeon contains only the freeze inputs.
     * A later scheduler block replaces both with the future-block-derived room in one transaction.
     */
    async freezePaidMatch({
        economy,
        maxPlayers,
        minPlayers = 2,
        freezeBlockHeight,
        targetBlockHeight,
        rulesetId,
        variant = 'race',
        difficultyPreset = 'race',
        freezeId = crypto.randomUUID()
    } = {}) {
        economy = this._validateEconomy(economy);
        const minimum = Math.max(2, Math.min(32, parseInt(minPlayers, 10) || 2));
        const maximum = Math.max(minimum, Math.min(32, parseInt(maxPlayers, 10) || minimum));
        if (economy === 'free'
            || !economy
            || !this.isFinancialRecoveryReady()
            || !this._isEconomyAvailable(economy)
            || this._queues[economy].length < minimum) return null;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(freezeId))) {
            throw new Error('Paid entrant freeze requires a canonical UUID');
        }
        if (!['race', 'pvp'].includes(variant)) throw new Error('Paid entrant freeze variant is invalid');
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(difficultyPreset))) {
            throw new Error('Paid entrant freeze difficulty is invalid');
        }

        const candidates = this._queues[economy].slice(0, Math.min(maximum, this._queues[economy].length));
        const userIds = candidates.map(entry => String(entry.userId));
        const socketIds = candidates.map(entry => String(entry.socketId || ''));
        if (new Set(userIds).size !== candidates.length
            || socketIds.some(id => id.length === 0)
            || new Set(socketIds).size !== candidates.length) {
            this._log('[MatchQueue] paid entrant freeze refused duplicate entrant identity');
            return null;
        }
        const queueEntryIds = candidates.map(entry => entry.queueEntryId);
        const freeze = buildPaidEntrantFreeze({
            freezeBlockHeight,
            targetBlockHeight,
            economy,
            rulesetId,
            queueEntryIds
        });
        const freezeEnvelope = { match_fairness_freeze: freeze };

        let acceptedAfterAmbiguousCommit = null;
        try {
            await this.db.withTransaction(async (client) => {
                const pending = await client.query(`
                    INSERT INTO matches (
                        id, status, economy, variant, ruleset_id, difficulty_preset, max_players,
                        seed_hash, dungeon, start_block_height, entry_fee_atomic,
                        pot_atomic, house_fee_atomic, house_fee_percent, created_at
                    ) VALUES (
                        $1, 'pending', $2, $3, $4, $5, $6,
                        $7, $8::jsonb, $9, 0,
                        0, 0, 0, NOW()
                    )
                    RETURNING id
                `, [
                    freezeId,
                    economy,
                    variant,
                    rulesetId,
                    difficultyPreset,
                    maximum,
                    freeze.freezeCommitment,
                    JSON.stringify(freezeEnvelope),
                    freeze.targetBlockHeight
                ]);
                if (pending.rowCount !== 1) throw new Error('Paid entrant freeze row was not created');

                const linked = await client.query(`
                    UPDATE match_queue_entries
                    SET status = 'matched', matched_at = NOW(), match_id = $1
                    WHERE id = ANY($2::bigint[])
                      AND economy = $3
                      AND status = 'queued'
                      AND match_id IS NULL
                    RETURNING id, user_id
                `, [freezeId, freeze.queueEntryIds, economy]);
                const expectedByQueueId = new Map(candidates.map(entry => [
                    String(entry.queueEntryId), String(entry.userId)
                ]));
                const linksMatch = linked.rowCount === candidates.length
                    && (linked.rows || []).every(row => (
                        expectedByQueueId.get(String(row.id)) === String(row.user_id)
                    ));
                if (!linksMatch) {
                    throw new Error(`Paid entrant freeze mismatch: expected ${candidates.length}, got ${linked.rowCount}`);
                }

                for (const entrant of candidates) {
                    await client.query(`
                        INSERT INTO match_entrants (match_id, user_id, socket_id, queue_entry_id)
                        VALUES ($1, $2, $3, $4)
                    `, [freezeId, entrant.userId, entrant.socketId, entrant.queueEntryId]);
                }
            });
        } catch (err) {
            // COMMIT acknowledgement can fail after PostgreSQL accepted the whole freeze. Never
            // leave those now-matched rows in the volatile queued array and try to freeze them a
            // second time. Prove the exact pending envelope before deciding this attempt failed.
            try {
                const persisted = (await this.listFrozenPaidMatches(null))
                    .find(group => group.id === String(freezeId));
                const expectedUsers = new Map(candidates.map(entry => [
                    String(entry.queueEntryId), String(entry.userId)
                ]));
                const exactEntries = persisted?.entries?.length === candidates.length
                    && persisted.entries.every(entry => (
                        expectedUsers.get(String(entry.queueEntryId)) === String(entry.userId)
                    ));
                const persistedFreeze = persisted?.freeze
                    ? buildPaidEntrantFreeze(persisted.freeze)
                    : null;
                if (persisted
                    && persisted.economy === economy
                    && persisted.rulesetId === String(rulesetId)
                    && persisted.freezeCommitment === freeze.freezeCommitment
                    && persistedFreeze?.freezeCommitment === freeze.freezeCommitment
                    && exactEntries) {
                    acceptedAfterAmbiguousCommit = persisted;
                }
            } catch (_) { /* retain volatile queue; no durable success was provable */ }
            if (!acceptedAfterAmbiguousCommit) {
                this._log('[MatchQueue] paid entrant freeze error', err.message);
                return null;
            }
            this._log(`[MatchQueue] paid entrant freeze ${freezeId} committed despite acknowledgement failure`);
        }

        const idSet = new Set(freeze.queueEntryIds);
        this._queues[economy] = this._queues[economy]
            .filter(entry => !idSet.has(String(entry.queueEntryId)));
        this._log(`[MatchQueue] froze ${candidates.length} ${economy} entrants for future block ${freeze.targetBlockHeight}`);
        return acceptedAfterAmbiguousCommit || Object.freeze({
            id: String(freezeId),
            economy,
            variant,
            rulesetId: String(rulesetId),
            difficultyPreset: String(difficultyPreset),
            maxPlayers: maximum,
            targetBlockHeight: freeze.targetBlockHeight,
            freezeCommitment: freeze.freezeCommitment,
            precommitTipHeight: null,
            precommitVerifiedAt: null,
            freeze,
            entries: candidates
        });
    }

    /**
     * After the freeze transaction commits, durably witness a fresh daemon tip that is still
     * strictly below the committed entropy target. A single conditional UPDATE makes the proof
     * atomic; the follow-up read safely adopts a success whose COMMIT acknowledgement was lost.
     */
    async verifyFrozenPrecommit(matchId, freezeCommitment, observedTipHeight) {
        if (!this.db || !matchId) return { verified: false, reason: 'database_unavailable' };
        const tip = Number(observedTipHeight);
        if (!Number.isSafeInteger(tip) || tip < 0) {
            throw new Error('Paid freeze precommit requires a safe daemon tip height');
        }
        const commitment = String(freezeCommitment || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(commitment)) {
            throw new Error('Paid freeze precommit requires an exact commitment');
        }

        let written = null;
        let acknowledgementError = null;
        try {
            await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    UPDATE matches
                    SET entropy_precommit_tip_height = $3,
                        entropy_precommit_verified_at = NOW()
                    WHERE id = $1
                      AND status = 'pending'
                      AND economy IN ('credits_prestige', 'crypto_race')
                      AND seed_hash = $2
                      AND start_block_height > $3
                      AND entropy_precommit_tip_height IS NULL
                      AND entropy_precommit_verified_at IS NULL
                    RETURNING id, start_block_height, entropy_precommit_tip_height,
                              entropy_precommit_verified_at
                `, [matchId, commitment, tip]);
                written = result.rows?.[0] || null;
            });
        } catch (err) {
            acknowledgementError = err;
        }

        if (!written) {
            let persisted;
            try {
                const result = await this.db.query(`
                    SELECT id, status, seed_hash, start_block_height,
                           entropy_precommit_tip_height, entropy_precommit_verified_at
                    FROM matches
                    WHERE id = $1
                      AND economy IN ('credits_prestige', 'crypto_race')
                    LIMIT 1
                `, [matchId]);
                persisted = result.rows?.[0] || null;
            } catch (readErr) {
                throw acknowledgementError || readErr;
            }
            const adopted = persisted?.status === 'pending'
                && String(persisted.seed_hash || '').toLowerCase() === commitment
                && Number(persisted.entropy_precommit_tip_height) === tip
                && persisted.entropy_precommit_verified_at != null
                && Number(persisted.start_block_height) > tip;
            if (!adopted) {
                if (acknowledgementError) throw acknowledgementError;
                return { verified: false, reason: 'freeze_not_claimable' };
            }
            written = persisted;
        }

        return Object.freeze({
            verified: true,
            matchId: String(written.id),
            targetBlockHeight: Number(written.start_block_height),
            observedTipHeight: Number(written.entropy_precommit_tip_height),
            verifiedAt: written.entropy_precommit_verified_at
        });
    }

    /** Load paid freezes that are due (or all freezes when throughBlockHeight is null). */
    async listFrozenPaidMatches(throughBlockHeight = null) {
        if (!this.db) return [];
        const through = throughBlockHeight == null ? null : Number(throughBlockHeight);
        if (through != null && (!Number.isSafeInteger(through) || through < 0)) {
            throw new Error('Frozen-match scan requires a safe block height');
        }
        const result = await this.db.query(`
            SELECT m.id, m.economy, m.variant, m.ruleset_id, m.difficulty_preset,
                   m.max_players, m.seed_hash, m.start_block_height, m.dungeon,
                   m.entropy_precommit_tip_height, m.entropy_precommit_verified_at,
                   q.id AS queue_entry_id, q.user_id, q.socket_id, q.session_token, q.created_at
            FROM matches m
            LEFT JOIN match_queue_entries q
              ON q.match_id = m.id AND q.status = 'matched'
            WHERE m.status = 'pending'
              AND m.economy IN ('credits_prestige', 'crypto_race')
              AND ($1::bigint IS NULL OR m.start_block_height <= $1)
            ORDER BY m.start_block_height ASC, m.created_at ASC, m.id ASC,
                     q.created_at ASC NULLS LAST, q.id ASC NULLS LAST
        `, [through]);
        const groups = new Map();
        for (const row of result.rows || []) {
            const id = String(row.id);
            if (!groups.has(id)) {
                let dungeon = row.dungeon;
                if (typeof dungeon === 'string') {
                    try { dungeon = JSON.parse(dungeon); } catch (_) { dungeon = null; }
                }
                groups.set(id, {
                    id,
                    economy: row.economy,
                    variant: row.variant,
                    rulesetId: row.ruleset_id,
                    difficultyPreset: row.difficulty_preset,
                    maxPlayers: Number(row.max_players),
                    targetBlockHeight: Number(row.start_block_height),
                    freezeCommitment: String(row.seed_hash || ''),
                    precommitTipHeight: row.entropy_precommit_tip_height == null
                        ? null
                        : Number(row.entropy_precommit_tip_height),
                    precommitVerifiedAt: row.entropy_precommit_verified_at || null,
                    freeze: dungeon?.match_fairness_freeze || null,
                    entries: []
                });
            }
            if (row.queue_entry_id != null) {
                groups.get(id).entries.push({
                    queueEntryId: row.queue_entry_id,
                    userId: row.user_id,
                    socketId: row.socket_id,
                    sessionToken: row.session_token,
                    createdAt: new Date(row.created_at).getTime()
                });
            }
        }
        return [...groups.values()];
    }

    /**
     * Boot-time fail-closed cleanup. A v1, malformed, or unverified pending freeze has no durable
     * proof that its target did not exist at commit time, so its exact escrow anchors are refunded.
     */
    async cancelUnverifiedPaidFreezes(reason = 'match_cancel', { failOnError = true } = {}) {
        let freezes;
        try {
            freezes = await this.listFrozenPaidMatches(null);
        } catch (err) {
            throw createFinancialRecoveryError('unverified_paid_match_freezes', {
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }, err);
        }

        const unsafe = (freezes || []).filter((freeze) => {
            let canonical = null;
            try {
                if (freeze?.freeze?.version === PAID_FREEZE_VERSION) {
                    canonical = buildPaidEntrantFreeze(freeze.freeze);
                }
            } catch (_) { /* malformed freezes are unsafe and must be cancelled */ }
            return !canonical
                || canonical.freezeCommitment !== String(freeze.freezeCommitment || '')
                || freeze.precommitTipHeight == null
                || !Number.isSafeInteger(Number(freeze.precommitTipHeight))
                || Number(freeze.precommitTipHeight) < 0
                || Number(freeze.precommitTipHeight) < canonical.freezeBlockHeight
                || Number(freeze.precommitTipHeight) >= canonical.targetBlockHeight
                || freeze.precommitVerifiedAt == null;
        });
        const summary = {
            ok: true,
            scanned: unsafe.length,
            resolved: 0,
            failed: 0,
            unresolved: []
        };
        for (const freeze of unsafe) {
            const result = await this.cancelFrozenMatch(freeze.id, reason);
            if (result?.resolved) summary.resolved += 1;
            else summary.unresolved.push({ type: 'pending_match', id: freeze.id });
        }
        summary.failed = summary.unresolved.length;
        summary.ok = summary.failed === 0;
        if (failOnError && !summary.ok) {
            throw createFinancialRecoveryError('unverified_paid_match_freezes', summary);
        }
        return summary;
    }

    /**
     * Claim a pending freeze for cancellation and refund every linked escrow anchor in the same
     * transaction. Activation and cancellation serialize on matches.status, so neither can
     * refund an entrant after a match has become starting.
     */
    async cancelFrozenMatch(matchId, reason = 'match_cancel') {
        if (!this.db || !matchId) return { claimed: false, resolved: false, refunded: 0 };
        let refunded = 0;
        let claimed = false;
        try {
            await this.db.withTransaction(async (client) => {
                const cancel = await client.query(`
                    UPDATE matches
                    SET status = 'cancelled', ended_at = NOW()
                    WHERE id = $1
                      AND status = 'pending'
                      AND economy IN ('credits_prestige', 'crypto_race')
                    RETURNING id, economy, dungeon
                `, [matchId]);
                if (cancel.rowCount === 0) return;
                claimed = true;
                const match = cancel.rows[0];
                let dungeon = match.dungeon;
                if (typeof dungeon === 'string') dungeon = JSON.parse(dungeon);
                const frozenIds = (dungeon?.match_fairness_freeze?.queueEntryIds || []).map(String);
                if (frozenIds.length < 2 || new Set(frozenIds).size !== frozenIds.length) {
                    throw new Error(`Paid freeze ${matchId} has no valid entrant commitment`);
                }
                const anchors = await client.query(`
                    UPDATE match_queue_entries
                    SET status = 'cancelled'
                    WHERE match_id = $1
                      AND economy = $2
                      AND status = 'matched'
                    RETURNING id, user_id, escrow_amount, race_entry_lot_id
                `, [matchId, match.economy]);
                const actualIds = (anchors.rows || []).map(row => String(row.id)).sort();
                const expectedIds = [...frozenIds].sort();
                if (anchors.rowCount !== expectedIds.length
                    || actualIds.some((id, index) => id !== expectedIds[index])) {
                    throw new Error(`Paid freeze ${matchId} escrow anchors do not match its entrant commitment`);
                }
                for (const anchor of anchors.rows) {
                    await this._applyRefund(
                        client,
                        anchor.user_id,
                        match.economy,
                        reason,
                        anchor.escrow_amount,
                        anchor.race_entry_lot_id
                    );
                    await client.query(`
                        UPDATE match_entrants
                        SET entry_refunded_at = COALESCE(entry_refunded_at, NOW())
                        WHERE match_id = $1 AND queue_entry_id = $2
                    `, [matchId, anchor.id]);
                    refunded += 1;
                }
            });
        } catch (err) {
            this._log('[MatchQueue] frozen-match cancellation error', err.message);
            return { claimed: false, resolved: false, refunded: 0 };
        }
        return { claimed, resolved: true, refunded };
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
        if (economy !== 'free' && (!this.initialized || !this.isFinancialRecoveryReady())) {
            return { success: false, reason: 'financial_recovery_pending' };
        }
        if (!this._isEconomyAvailable(economy)) {
            return { success: false, reason: 'economy_disabled' };
        }

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

    async _claimQueueEntry(client, entry, economy) {
        // Claim the durable queue row before touching credits/tickets.  The partial unique
        // index on (user_id, economy) serializes concurrent joins; only the transaction that
        // actually INSERTs the row is allowed to debit escrow.  An upsert cannot provide that
        // guarantee because its UPDATE branch looks successful to every duplicate request.
        const inserted = await client.query(`
            INSERT INTO match_queue_entries (user_id, economy, socket_id, session_token, status)
            VALUES ($1, $2, $3, $4, 'queued')
            ON CONFLICT (user_id, economy) WHERE status = 'queued'
            DO NOTHING
            RETURNING id, created_at
        `, [entry.userId, economy, entry.socketId, entry.sessionToken]);
        if (inserted.rows.length > 0) {
            return { row: inserted.rows[0], inserted: true };
        }

        // Duplicate/reconnect: refresh only transport identity, preserving queue age/order.
        const existing = await client.query(`
            UPDATE match_queue_entries
            SET socket_id = $3, session_token = $4
            WHERE user_id = $1 AND economy = $2 AND status = 'queued'
            RETURNING id, created_at
        `, [entry.userId, economy, entry.socketId, entry.sessionToken]);
        if (existing.rows.length === 0) {
            throw Object.assign(new Error('Queue claim was lost'), { code: 'QUEUE_CLAIM_LOST' });
        }
        return { row: existing.rows[0], inserted: false };
    }

    async _joinFree(entry) {
        let newlyQueued = false;
        await this.db.withTransaction(async (client) => {
            const claim = await this._claimQueueEntry(client, entry, 'free');
            const dbRow = claim.row;
            newlyQueued = claim.inserted;
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
        });
        this._addToMemory('free', entry);
        const position = this._queues.free.length;
        this._log(`[MatchQueue] free join user=${entry.userId} pos=${position}`);
        return { success: true, position, alreadyQueued: !newlyQueued };
    }

    async _joinCreditsPrestige(entry) {
        const cost = this._creditsCost();
        let newlyQueued = false;

        await this.db.withTransaction(async (client) => {
            // 1. Claim the one durable queue row. Duplicate joins merely refresh the
            // socket/session and must not hold a second escrow amount.
            const claim = await this._claimQueueEntry(client, entry, 'credits_prestige');
            const dbRow = claim.row;
            newlyQueued = claim.inserted;
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
            entry.cost = cost;
            if (!newlyQueued) return;

            // 2. Deduct credits atomically.
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

            // 3. Log credit transaction (escrow).
            await client.query(`
                INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type, metadata)
                VALUES ($1, $2, 'match_queue_join', $3, 'match', $4)
            `, [entry.userId, -cost, balanceAfter, JSON.stringify({ economy: 'credits_prestige', queueEntryId: dbRow.id })]);

            const escrow = await client.query(`
                UPDATE match_queue_entries SET escrow_amount = $1
                WHERE id = $2 AND status = 'queued'
                RETURNING id
            `, [cost, dbRow.id]);
            if (escrow.rowCount !== 1) {
                throw Object.assign(new Error('Credit escrow row was lost'), { code: 'QUEUE_ESCROW_LOST' });
            }

        });

        this._addToMemory('credits_prestige', entry);
        const position = this._queues.credits_prestige.length;
        this._log(`[MatchQueue] credits_prestige join user=${entry.userId} pos=${position}`);
        return { success: true, position, alreadyQueued: !newlyQueued };
    }

    async _joinCryptoRace(entry) {
        const policy = matchPayoutAdmissionPolicy({
            env: process.env,
            gameModeManager: this.gameModeManager
        });
        if (!policy.enabled) {
            throw Object.assign(new Error(`Crypto match admission disabled: ${policy.reason}`), {
                code: String(policy.reason || 'CRYPTO_MATCH_DISABLED').toUpperCase()
            });
        }
        let newlyQueued = false;
        await this.db.withTransaction(async (client) => {
            // 1. Claim before debiting so retries/concurrent socket events are idempotent.
            const claim = await this._claimQueueEntry(client, entry, 'crypto_race');
            const dbRow = claim.row;
            newlyQueued = claim.inserted;
            entry.queueEntryId = dbRow.id;
            entry.createdAt = new Date(dbRow.created_at).getTime();
            if (!newlyQueued) return;

            // 2. Consume one race entry ticket atomically (escrow).
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

            // Allocate one durably funded ticket lot. Aggregate/admin-granted legacy tickets
            // without a paid lot cannot back an on-chain winner liability.
            const lotResult = await client.query(`
                SELECT id, unit_value_atomic
                FROM race_entry_lots
                WHERE user_id = $1
                  AND remaining_entries > 0
                  AND refunded_at IS NULL
                  AND unit_value_atomic = $2
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                FOR UPDATE
            `, [entry.userId, policy.entryFee.toString()]);
            const lot = lotResult.rows?.[0];
            if (!lot) {
                throw Object.assign(new Error('No funded race entry ticket'), { code: 'NO_FUNDED_RACE_TICKET' });
            }
            const allocated = await client.query(`
                UPDATE race_entry_lots
                SET remaining_entries = remaining_entries - 1
                WHERE id = $1 AND user_id = $2
                  AND remaining_entries > 0
                  AND refunded_at IS NULL
                RETURNING id
            `, [lot.id, entry.userId]);
            if (allocated.rowCount !== 1) {
                throw Object.assign(new Error('Race entry lot allocation was lost'), { code: 'TICKET_LOT_LOST' });
            }

            // 3. Log ticket transaction.
            await client.query(`
                INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, metadata)
                VALUES ($1, -1, $2, 'queue_join', $3)
            `, [entry.userId, balanceAfter, JSON.stringify({
                economy: 'crypto_race',
                queueEntryId: dbRow.id,
                raceEntryLotId: lot.id,
                backingValueAtomic: String(lot.unit_value_atomic)
            })]);

            const escrow = await client.query(`
                UPDATE match_queue_entries
                SET escrow_amount = 1,
                    escrow_value_atomic = $2,
                    race_entry_lot_id = $3
                WHERE id = $1 AND status = 'queued'
                RETURNING id
            `, [dbRow.id, String(lot.unit_value_atomic), lot.id]);
            if (escrow.rowCount !== 1) {
                throw Object.assign(new Error('Ticket escrow row was lost'), { code: 'QUEUE_ESCROW_LOST' });
            }
            entry.backingValueAtomic = String(lot.unit_value_atomic);
            entry.raceEntryLotId = lot.id;

        });

        this._addToMemory('crypto_race', entry);
        const position = this._queues.crypto_race.length;
        this._log(`[MatchQueue] crypto_race join user=${entry.userId} pos=${position}`);
        return { success: true, position, alreadyQueued: !newlyQueued };
    }

    _addToMemory(economy, entry) {
        const q = this._queues[economy];
        const idx = q.findIndex(e => e.userId === entry.userId);
        if (idx !== -1) q[idx] = entry;
        else q.push(entry);
        q.sort((a, b) => {
            const age = a.createdAt - b.createdAt;
            if (age !== 0) return age;
            const left = String(a.queueEntryId || '');
            const right = String(b.queueEntryId || '');
            if (left.length !== right.length) return left.length - right.length;
            return left.localeCompare(right);
        });
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
    async _applyRefund(client, userId, economy, ledgerReason = 'queue_leave', escrowAmount = null, raceEntryLotId = null) {
        if (economy === 'credits_prestige') {
            let amount = Math.abs(parseInt(escrowAmount, 10));
            if (!Number.isSafeInteger(amount) || amount <= 0) {
                amount = await this._creditsJoinAmount(client, userId);
            }
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
            let amount = Math.abs(parseInt(escrowAmount, 10));
            if (!Number.isSafeInteger(amount) || amount <= 0) amount = 1; // migration-022 legacy row
            const reason = RACE_LEDGER_REASONS.has(ledgerReason) ? ledgerReason : 'queue_leave';
            // Match queue allocation and product reversal both lock the user before the lot.
            // Keep refunds on the same order to avoid a user<->lot deadlock; a later lot failure
            // rolls this balance update back with the surrounding transaction.
            const r = await client.query(`
                UPDATE users SET race_entries = race_entries + $1 WHERE id = $2 RETURNING race_entries
            `, [amount, userId]);
            if (r.rowCount !== 1) {
                throw new Error(`Unable to restore race ticket balance for user ${userId}`);
            }
            if (raceEntryLotId != null) {
                const restored = await client.query(`
                    UPDATE race_entry_lots
                    SET remaining_entries = remaining_entries + $1
                    WHERE id = $2 AND user_id = $3
                      AND refunded_at IS NULL
                      AND remaining_entries + $1 <= original_entries
                    RETURNING id
                `, [amount, raceEntryLotId, userId]);
                if (restored.rowCount !== 1) {
                    throw new Error(`Unable to restore race ticket lot ${raceEntryLotId}`);
                }
            }
            const bal = r.rows[0]?.race_entries ?? 0;
            await client.query(`
                INSERT INTO race_entry_transactions (user_id, delta, balance_after, reason, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, [userId, amount, bal, reason, JSON.stringify({
                economy,
                refunded: true,
                source: ledgerReason,
                amount,
                raceEntryLotId
            })]);
            return amount;
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
                    RETURNING id, escrow_amount, race_entry_lot_id
                `, [userId, economy]);

                if (result.rowCount === 0) {
                    throw Object.assign(new Error('Not in queue'), { code: 'NOT_QUEUED' });
                }

                // MP-H4: refund is DB-derived inside _applyRefund, not read from volatile memory.
                await this._applyRefund(
                    client,
                    userId,
                    economy,
                    'queue_leave',
                    result.rows[0].escrow_amount,
                    result.rows[0].race_entry_lot_id
                );
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
        if (!this.db || !Array.isArray(entries) || entries.length === 0) {
            return { attempted: 0, resolved: 0, failed: 0 };
        }
        economy = this._validateEconomy(economy);
        if (!economy) return { attempted: entries.length, resolved: 0, failed: entries.length };

        let attempted = 0;
        let resolvedCount = 0;
        for (const e of entries) {
            const userId = e?.userId;
            if (userId == null) continue;
            attempted += 1;
            let resolved = false;
            try {
                await this.db.withTransaction(async (client) => {
                    const upd = await client.query(`
                        UPDATE match_queue_entries
                        SET status = 'cancelled', match_id = NULL
                        WHERE user_id = $1 AND economy = $2
                          AND ($3::bigint IS NULL OR id = $3)
                          AND status IN ('queued', 'matched')
                        RETURNING id, escrow_amount, race_entry_lot_id
                    `, [userId, economy, e.queueEntryId || null]);
                    if (upd.rowCount > 1) {
                        throw new Error(`Multiple queue escrow anchors for user ${userId}, economy ${economy}`);
                    }
                    if (upd.rowCount > 0) {
                        await this._applyRefund(
                            client,
                            userId,
                            economy,
                            reason,
                            upd.rows[0].escrow_amount,
                            upd.rows[0].race_entry_lot_id
                        );
                        await client.query(`
                            UPDATE match_entrants
                            SET entry_refunded_at = COALESCE(entry_refunded_at, NOW())
                            WHERE queue_entry_id = $1
                        `, [upd.rows[0].id]);
                    }
                });
                // A zero-row update means another actor already resolved this queue row; in
                // either case it is now safe to remove the volatile copy.
                resolved = true;
            } catch (err) {
                this._log('[MatchQueue] refundEntries error', err.message);
            }
            if (resolved) {
                resolvedCount += 1;
                const idx = this._queues[economy].findIndex(q => q.userId === userId);
                if (idx >= 0) this._queues[economy].splice(idx, 1);
            }
        }
        return { attempted, resolved: resolvedCount, failed: attempted - resolvedCount };
    }

    /**
     * Refund queued escrow immediately when a paid economy is hot-disabled. Failed refunds stay
     * in memory and are retried on the next scheduler block; they are never silently forgotten.
     */
    async refundUnavailableQueues(reason = 'match_cancel', { failOnError = false } = {}) {
        let attempted = 0;
        let resolved = 0;
        const unresolved = [];
        for (const economy of ['credits_prestige', 'crypto_race']) {
            if (this._isEconomyAvailable(economy)) continue;
            const entries = this._queues[economy].slice();
            attempted += entries.length;
            const entryResult = await this.refundEntries(entries, economy, reason);
            resolved += entryResult.resolved;
            if (entryResult.failed > 0) {
                const surviving = new Set(this._queues[economy].map(entry => String(entry.queueEntryId)));
                for (const entry of entries) {
                    if (surviving.has(String(entry.queueEntryId))) {
                        unresolved.push({ type: 'queue_entry', id: entry.queueEntryId });
                    }
                }
            }
            let freezes = [];
            try {
                freezes = (await this.listFrozenPaidMatches(null))
                    .filter(freeze => freeze.economy === economy);
            } catch (err) {
                this._log('[MatchQueue] unavailable frozen-match scan error', err.message);
                if (failOnError) {
                    throw createFinancialRecoveryError('unavailable_paid_match_escrow', {
                        scanFailed: true,
                        scanned: attempted,
                        resolved,
                        unresolved
                    }, err);
                }
            }
            for (const freeze of freezes) {
                attempted += freeze.entries.length;
                const result = await this.cancelFrozenMatch(freeze.id, reason);
                if (result.resolved) resolved += freeze.entries.length;
                else unresolved.push({ type: 'pending_match', id: freeze.id });
            }
        }
        const summary = {
            ok: unresolved.length === 0,
            scanned: attempted,
            attempted,
            resolved,
            failed: unresolved.length,
            unresolved
        };
        if (failOnError && unresolved.length > 0) {
            throw createFinancialRecoveryError('unavailable_paid_match_escrow', summary);
        }
        return summary;
    }

    /**
     * Drain queued players for an economy into a match. Marks the DB rows 'matched' and returns
     * the entrants. The in-memory queue is only mutated AFTER the DB commit succeeds, so a
     * failed drain leaves the queue intact for the next block.
     * @returns {Promise<{entries:Array}|null>}
     */
    async drain(economy, maxPlayers, minPlayers = 2) {
        economy = this._validateEconomy(economy);
        const minimum = Math.max(2, Math.min(32, parseInt(minPlayers, 10) || 2));
        const maximum = Math.max(minimum, Math.min(32, parseInt(maxPlayers, 10) || minimum));
        if (!economy
            || (economy !== 'free' && !this.isFinancialRecoveryReady())
            || !this._isEconomyAvailable(economy)
            || this._queues[economy].length < minimum) return null;

        const count = Math.min(maximum, this._queues[economy].length);
        const candidates = this._queues[economy].slice(0, count);
        const queueEntryIds = candidates.map(e => e.queueEntryId);
        if (queueEntryIds.some(id => id == null)
            || new Set(queueEntryIds.map(String)).size !== queueEntryIds.length) {
            this._log('[MatchQueue] drain refused entries without unique durable queue ids');
            return null;
        }

        try {
            await this.db.withTransaction(async (client) => {
                const result = await client.query(`
                    UPDATE match_queue_entries
                    SET status = 'matched', matched_at = NOW()
                    WHERE id = ANY($1::bigint[]) AND economy = $2 AND status = 'queued'
                    RETURNING id, user_id
                `, [queueEntryIds, economy]);

                const expectedById = new Map(candidates.map(entry => [
                    String(entry.queueEntryId),
                    String(entry.userId)
                ]));
                const rowsMatch = result.rowCount === queueEntryIds.length
                    && (result.rows || []).every(row => (
                        expectedById.get(String(row.id)) === String(row.user_id)
                    ));
                if (!rowsMatch) {
                    // Memory/DB out of sync — abort without mutating memory; retry next block.
                    throw Object.assign(
                        new Error(`Queue drain mismatch: expected ${queueEntryIds.length}, got ${result.rowCount}`),
                        { code: 'DRAIN_MISMATCH' }
                    );
                }
            });
        } catch (err) {
            this._log('[MatchQueue] drain error', err.message);
            return null;
        }

        // DB commit succeeded — now remove them from the in-memory queue.
        const idSet = new Set(queueEntryIds.map(String));
        this._queues[economy] = this._queues[economy]
            .filter(e => !idSet.has(String(e.queueEntryId)));
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
        this.initialized = false;
        if (this._availabilityTimer) {
            clearInterval(this._availabilityTimer);
            this._availabilityTimer = null;
        }
        if (!this.db) return;
        for (const economy of ECONOMIES) {
            const entries = this._queues[economy].slice();
            for (const e of entries) {
                await this._leaveOne(e.userId, economy).catch(() => {});
            }
        }
        let freezes = [];
        try {
            freezes = await this.listFrozenPaidMatches(null);
        } catch (err) {
            this._log('[MatchQueue] shutdown frozen-match scan error', err.message);
        }
        for (const freeze of freezes) {
            await this.cancelFrozenMatch(freeze.id, 'match_cancel');
        }
    }
}

module.exports = MatchQueue;
