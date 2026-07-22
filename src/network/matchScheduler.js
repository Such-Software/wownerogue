/**
 * MatchScheduler — block-cadence match maker.
 *
 * Subscribes to the same block event as the solo queue handler. Free matches may drain and start
 * immediately. Paid matches first persist an exact FIFO entrant freeze, then wait for their
 * configured future header and confirmation depth before deriving a seed and starting. Single
 * players carry over and can leave at any time.
 *
 * MatchScheduler creates MatchRooms but does not own Socket.IO broadcasting; it delegates the
 * started room to MatchManager for transport, the real countdown, persistence, and finish
 * handling. It does NOT start the engine directly — the manager's countdown does — so honest
 * and modified clients always start together.
 */

const MatchRoom = require('../multiplayer/MatchRoom');
const MatchEngine = require('../multiplayer/MatchEngine');
const MatchState = require('../multiplayer/MatchState');
const crypto = require('crypto');
const { resolveMatchRuleset } = require('../game/rulesets');
const { matchPayoutAdmissionPolicy, playerContract } = require('./matchEconomyPolicy');
const {
    PAID_FREEZE_VERSION,
    PAID_SEED_VERSION,
    buildPaidEntrantFreeze,
    deriveFutureBlockMatchSeed
} = require('./matchFairness');

const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_TICK_MS = 250;
const DEFAULT_MIN_DURATION_MS = 20000;
const DEFAULT_HARD_CEILING_MS = 240000;
const DEFAULT_COUNTDOWN_MS = 3000;
const DEFAULT_PAID_ENTROPY_DELAY_BLOCKS = 2;
const DEFAULT_PAID_ENTROPY_CONFIRMATIONS = 2;
const BLOCK_SEED_VERSION = 'chain-block-v1';

function extractBlockHash(block) {
    const value = typeof block === 'string'
        ? block
        : (block?.block_header?.hash || block?.blockHeader?.hash || block?.hash || '');
    const normalized = String(value).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function extractBlockHeight(block) {
    if (!block || typeof block === 'string') return null;
    const value = block?.block_header?.height ?? block?.blockHeader?.height ?? block?.height;
    const height = Number(value);
    return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

function exactCanonicalHeader(block, expectedHeight) {
    const hash = extractBlockHash(block);
    const height = extractBlockHeight(block);
    return hash && height === Number(expectedHeight) ? { hash, height } : null;
}

function boundedBlockSetting(value, fallback, label) {
    if (value == null || String(value).trim() === '') return fallback;
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a canonical integer`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error(`${label} must be an integer from 1 through 100`);
    }
    return parsed;
}

function deriveBlockMatchSeed({ blockHash, blockHeight, economy, rulesetId, queueEntryIds }) {
    const normalizedHash = extractBlockHash(blockHash);
    if (!normalizedHash) throw new Error('A canonical 64-hex block hash is required');
    const ids = (queueEntryIds || []).map(id => String(id)).sort((left, right) => {
        if (left.length !== right.length) return left.length - right.length;
        return left.localeCompare(right);
    });
    if (ids.length < 2 || ids.some(id => !/^\d+$/.test(id))) {
        throw new Error('At least two durable numeric queue entry ids are required');
    }
    const canonical = [
        'wowngeon-match', BLOCK_SEED_VERSION, normalizedHash, String(blockHeight),
        String(economy), String(rulesetId), ids.join(',')
    ].join('|');
    return {
        seed: crypto.createHash('sha256').update(canonical).digest('hex'),
        derivation: {
            version: BLOCK_SEED_VERSION,
            blockHash: normalizedHash,
            blockHeight: Number(blockHeight),
            economy: String(economy),
            rulesetId: String(rulesetId),
            queueEntryIds: ids
        }
    };
}

class MatchScheduler {
    constructor({
        matchQueue,
        matchManager,
        debugManager,
        maxPlayers = null,
        tickMs = null,
        minDurationMs = null,
        hardCeilingMs = null,
        countdownMs = null,
        rulesetId = null,
        blockEntropyProvider = null,
        blockCountProvider = null,
        paidEntropyDelayBlocks = null,
        paidEntropyConfirmations = null
    } = {}) {
        this.matchQueue = matchQueue;
        this.matchManager = matchManager;
        this.debugManager = debugManager;
        this.enabled = process.env.MATCH_ENABLED === 'true';
        this.ruleset = resolveMatchRuleset(rulesetId || process.env.MATCH_RULESET_ID || 'race');

        const requestedMax = maxPlayers ?? process.env.MATCH_MAX_PLAYERS ?? DEFAULT_MAX_PLAYERS;
        const players = playerContract(this.ruleset, requestedMax);
        this.minPlayers = players.minPlayers;
        this.maxPlayers = players.maxPlayers;
        this.tickMs = tickMs || parseInt(process.env.MATCH_TICK_MS, 10) || this.ruleset.timing.tickMs || DEFAULT_TICK_MS;
        this.minDurationMs = minDurationMs || parseInt(process.env.MATCH_MIN_DURATION_MS, 10) || this.ruleset.timing.minDurationMs || DEFAULT_MIN_DURATION_MS;
        this.hardCeilingMs = hardCeilingMs || parseInt(process.env.MATCH_HARD_CEILING_MS, 10) || this.ruleset.timing.hardCeilingMs || DEFAULT_HARD_CEILING_MS;
        this.countdownMs = countdownMs || parseInt(process.env.MATCH_COUNTDOWN_MS, 10) || DEFAULT_COUNTDOWN_MS;
        this.paidEntropyDelayBlocks = boundedBlockSetting(
            paidEntropyDelayBlocks ?? process.env.MATCH_PAID_ENTROPY_DELAY_BLOCKS,
            DEFAULT_PAID_ENTROPY_DELAY_BLOCKS,
            'MATCH_PAID_ENTROPY_DELAY_BLOCKS'
        );
        this.paidEntropyConfirmations = boundedBlockSetting(
            paidEntropyConfirmations ?? process.env.MATCH_PAID_ENTROPY_CONFIRMATIONS,
            DEFAULT_PAID_ENTROPY_CONFIRMATIONS,
            'MATCH_PAID_ENTROPY_CONFIRMATIONS'
        );
        this.blockEntropyProvider = blockEntropyProvider || (async headerHeight => {
            const rpc = this.debugManager?.rpcService;
            // Callers pass an actual zero-based canonical header height. DebugManager's external
            // event is a block count and is normalized exactly once in _processBlock().
            return typeof rpc?.getBlockByHeight === 'function'
                ? rpc.getBlockByHeight(Number(headerHeight))
                : null;
        });
        this.blockCountProvider = blockCountProvider || (async () => {
            const rpc = this.debugManager?.rpcService;
            if (typeof rpc?.getBlockCountStrict === 'function') {
                return rpc.getBlockCountStrict();
            }
            if (typeof rpc?.makeRPCCall === 'function') {
                const result = await rpc.makeRPCCall('getblockcount');
                return result?.count;
            }
            throw new Error('Strict daemon block count is unavailable');
        });

        // Retained for interface stability; the scheduler no longer owns any long-lived timers
        // (the hard-ceiling watchdog is owned solely by MatchManager, cleared on finalize).
        this._timeoutIds = [];
        this._shuttingDown = false;
        this._lastProcessedBlockCount = null;
        // SocketHandlers intentionally does not await match scheduling on the solo block path.
        // Serialize blocks here so a later block can never race ahead of the durable freeze that
        // it is supposed to supply entropy for.
        this._blockTail = Promise.resolve();
    }

    _log(...args) {
        if (this.debugManager?.CONSOLE_LOGGING) console.log(...args);
    }

    async _strictDaemonBlockCount() {
        const response = await this.blockCountProvider();
        const count = Number(response?.count ?? response);
        if (!Number.isSafeInteger(count) || count < 1) {
            throw new Error('Strict daemon block count is invalid');
        }
        return count;
    }

    async _strictDaemonTipHeight() {
        return (await this._strictDaemonBlockCount()) - 1;
    }

    _minimumConfirmedTip(targetBlockHeight) {
        return Number(targetBlockHeight) + this.paidEntropyConfirmations - 1;
    }

    async _readStableConfirmedHeader(targetBlockHeight) {
        const target = Number(targetBlockHeight);
        const minimumTip = this._minimumConfirmedTip(target);
        const firstTip = await this._strictDaemonTipHeight();
        if (firstTip < minimumTip) return { ready: false, reason: 'confirmations_pending' };

        const first = exactCanonicalHeader(await this.blockEntropyProvider(target), target);
        if (!first) throw new Error(`Daemon did not return exact canonical header ${target}`);

        const secondTip = await this._strictDaemonTipHeight();
        if (secondTip < minimumTip) return { ready: false, reason: 'confirmations_pending' };
        const second = exactCanonicalHeader(await this.blockEntropyProvider(target), target);
        if (!second) throw new Error(`Daemon did not re-confirm exact canonical header ${target}`);
        if (first.hash !== second.hash) {
            const error = new Error(`Canonical header ${target} changed during paid activation`);
            error.code = 'PAID_ENTROPY_REORG';
            throw error;
        }
        return { ready: true, hash: second.hash, height: target };
    }

    async _recheckActivatedHeader(seedProof) {
        const target = Number(seedProof?.derivation?.targetBlockHeight
            ?? seedProof?.derivation?.blockHeight);
        const expectedHash = String(seedProof?.derivation?.blockHash || '').toLowerCase();
        try {
            const tip = await this._strictDaemonTipHeight();
            if (tip < this._minimumConfirmedTip(target)) return false;
            const header = exactCanonicalHeader(await this.blockEntropyProvider(target), target);
            return Boolean(header && header.hash === expectedHash);
        } catch (err) {
            this._log(`[MatchScheduler] post-activation header ${target} unavailable`, err.message);
            return false;
        }
    }

    async _cancelFrozen(frozen, reason = 'match_cancel') {
        if (!frozen?.id || typeof this.matchQueue?.cancelFrozenMatch !== 'function') {
            const error = new Error('Exact paid-freeze cancellation API is unavailable');
            error.code = 'PAID_FREEZE_CANCEL_UNRESOLVED';
            throw error;
        }
        const result = await this.matchQueue.cancelFrozenMatch(frozen.id, reason);
        if (!result?.resolved) {
            const error = new Error(`Paid freeze ${frozen.id} cancellation remains unresolved`);
            error.code = 'PAID_FREEZE_CANCEL_UNRESOLVED';
            throw error;
        }
        return true;
    }

    /**
     * Hook this into the existing DebugManager.onNewBlockCallback().
     * @param {number} blockCount Monero-family getblockcount count (tip header height + 1)
     */
    onBlock(blockCount) {
        if (!this.enabled || !this.matchQueue || !this.matchManager || this._shuttingDown) {
            return Promise.resolve();
        }
        const scheduled = this._blockTail.then(() => this._processBlock(blockCount));
        this._blockTail = scheduled.catch(() => {});
        return scheduled;
    }

    async _processBlock(blockCount) {
        if (this._shuttingDown) return;
        const count = Number(blockCount);
        if (!Number.isSafeInteger(count) || count < 1) {
            throw new Error('Match scheduler requires a positive safe block count');
        }
        // getblockcount is the number of blocks, while get_block(height) is zero-based. Every
        // persisted/disclosed fairness height below is the actual header height whose hash is
        // requested—not the count emitted by DebugManager.
        const observedHeaderHeight = count - 1;

        // A hot economy/payout disable must release both queued and already-frozen escrow.
        if (typeof this.matchQueue.refundUnavailableQueues === 'function') {
            await this.matchQueue.refundUnavailableQueues('match_cancel');
        }
        if (this._shuttingDown) return;

        const advancingBlock = this._lastProcessedBlockCount == null
            || count > this._lastProcessedBlockCount;
        if (advancingBlock) this._lastProcessedBlockCount = count;

        // Existing active rooms see this header before any new room is attached. The manager
        // requires a strict height advance beyond each room's start header and its active-play
        // duration floor, so duplicate polls and same-header starts cannot end a match.
        if (advancingBlock && typeof this.matchManager.expireBlockDeadlines === 'function') {
            try {
                await this.matchManager.expireBlockDeadlines(observedHeaderHeight);
            } catch (err) {
                this._log('[MatchScheduler] block-deadline processing error', err.message);
            }
        }
        if (this._shuttingDown) return;

        // Phase 1: commit every currently eligible paid entrant set without reading ANY block
        // hash. Each exact target is H+the configured delay, then a fresh strict daemon count is
        // durably recorded after commit. Both paid economies complete this guard before phase 2.
        let paidPreflightBlocked = false;
        if (advancingBlock) {
            for (const economy of ['credits_prestige', 'crypto_race']) {
                try {
                    await this._freezePaidEconomy(economy, observedHeaderHeight);
                } catch (err) {
                    paidPreflightBlocked = true;
                    this._log(`[MatchScheduler] freeze ${economy} error`, err.message);
                }
            }
        }
        if (this._shuttingDown) return;

        // Phase 2a validates/cancels every due paid freeze without reading a hash. This prevents a
        // verified freeze in one economy from revealing entropy before an unverified freeze in the
        // other economy has been refunded. Phase 2b alone performs exact target-header reads.
        if (typeof this.matchQueue.listFrozenPaidMatches === 'function') {
            let freezes = [];
            try {
                freezes = await this.matchQueue.listFrozenPaidMatches(observedHeaderHeight);
            } catch (err) {
                this._log('[MatchScheduler] frozen-match scan error', err.message);
            }
            const prepared = [];
            for (const freeze of freezes) {
                if (this._shuttingDown) return;
                try {
                    const candidate = await this._prepareFrozenMatch(freeze, observedHeaderHeight);
                    if (candidate) prepared.push(candidate);
                } catch (err) {
                    paidPreflightBlocked = true;
                    this._log(`[MatchScheduler] frozen match ${freeze?.id || 'unknown'} preflight retained`, err.message);
                }
            }
            for (const candidate of paidPreflightBlocked ? [] : prepared) {
                if (this._shuttingDown) return;
                try {
                    await this._resolvePreparedFrozenMatch(candidate);
                } catch (err) {
                    this._log(`[MatchScheduler] frozen match ${candidate?.frozen?.id || 'unknown'} retained`, err.message);
                    if (err?.code === 'PAID_FREEZE_CANCEL_UNRESOLVED') break;
                }
            }
        }

        if (this._shuttingDown) return;
        // Free matches preserve immediate scheduling. Drain first so even their current hash is
        // not learned before this block's paid FIFO sets have been frozen.
        if (advancingBlock) {
            try {
                await this._drainEconomy('free', observedHeaderHeight);
            } catch (err) {
                this._log('[MatchScheduler] drain free error', err.message);
            }
        }
    }

    async _freezePaidEconomy(economy, blockHeight) {
        if (this.matchQueue?.initialized === false || this._shuttingDown) return null;
        if (typeof this.matchQueue?.isFinancialRecoveryReady === 'function'
            && this.matchQueue.isFinancialRecoveryReady() !== true) return null;
        if (typeof this.matchQueue.freezePaidMatch !== 'function') {
            this._log(`[MatchScheduler] retaining ${economy}: durable freeze API unavailable`);
            return null;
        }
        if (economy === 'crypto_race') {
            const policy = matchPayoutAdmissionPolicy({
                env: process.env,
                gameModeManager: this.matchManager?.gameModeManager,
                ruleset: this.ruleset,
                requestedMaxPlayers: this.maxPlayers
            });
            if (!policy.enabled) return null;
        }
        const frozen = await this.matchQueue.freezePaidMatch({
            economy,
            maxPlayers: this.maxPlayers,
            minPlayers: this.minPlayers,
            freezeBlockHeight: blockHeight,
            targetBlockHeight: blockHeight + this.paidEntropyDelayBlocks,
            rulesetId: this.ruleset.id,
            variant: this.ruleset.entities.pvpCombat ? 'pvp' : 'race',
            difficultyPreset: this.ruleset.world.difficultyPreset || 'race'
        });
        if (!frozen) return null;

        // The count must be fetched only after freezePaidMatch's transaction is durably accepted.
        // A delayed COMMIT that crosses the target can therefore never be disguised as a valid
        // precommit; refund it without consulting that target's hash.
        let tip;
        try {
            tip = await this._strictDaemonTipHeight();
        } catch (err) {
            this._log(`[MatchScheduler] paid freeze ${frozen.id} precommit count unavailable`, err.message);
            await this._cancelFrozen(frozen);
            return null; // a crash before this cleanup is caught by startup recovery
        }
        if (tip < Number(frozen.freeze?.freezeBlockHeight)
            || tip >= Number(frozen.targetBlockHeight)) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (typeof this.matchQueue.verifyFrozenPrecommit !== 'function') {
            await this._cancelFrozen(frozen);
            return null;
        }
        let proof;
        try {
            proof = await this.matchQueue.verifyFrozenPrecommit(
                frozen.id,
                frozen.freezeCommitment,
                tip
            );
        } catch (err) {
            this._log(`[MatchScheduler] paid freeze ${frozen.id} precommit write unavailable`, err.message);
            await this._cancelFrozen(frozen);
            return null;
        }
        if (!proof?.verified) {
            await this._cancelFrozen(frozen);
            return null;
        }
        return Object.freeze({
            ...frozen,
            precommitTipHeight: proof.observedTipHeight,
            precommitVerifiedAt: proof.verifiedAt
        });
    }

    async _prepareFrozenMatch(frozen, observedBlockHeight) {
        if (typeof this.matchQueue?.isFinancialRecoveryReady === 'function'
            && this.matchQueue.isFinancialRecoveryReady() !== true) return null;
        if (!frozen || !frozen.freeze) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (frozen.freeze.version !== PAID_FREEZE_VERSION) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (typeof this.matchQueue.isEconomyAvailable === 'function'
            && !this.matchQueue.isEconomyAvailable(frozen.economy)) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (frozen.economy === 'crypto_race') {
            const policy = matchPayoutAdmissionPolicy({
                env: process.env,
                gameModeManager: this.matchManager?.gameModeManager,
                ruleset: this.ruleset,
                requestedMaxPlayers: this.maxPlayers
            });
            if (!policy.enabled) {
                await this._cancelFrozen(frozen);
                return null;
            }
        }
        let verifiedFreeze;
        try {
            verifiedFreeze = buildPaidEntrantFreeze(frozen.freeze);
        } catch (err) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (String(frozen.freezeCommitment || '') !== verifiedFreeze.freezeCommitment) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (verifiedFreeze.targetBlockHeight > observedBlockHeight) return null;
        if (verifiedFreeze.economy !== frozen.economy) {
            await this._cancelFrozen(frozen);
            return null;
        }
        if (verifiedFreeze.rulesetId !== this.ruleset.id) {
            // A legitimate operator ruleset change must not reinterpret an old paid freeze.
            // Its exact queue anchors are safely refundable because activation has not claimed it.
            await this._cancelFrozen(frozen);
            return null;
        }
        const precommitTip = Number(frozen.precommitTipHeight);
        const verifiedAt = new Date(frozen.precommitVerifiedAt).getTime();
        const minimumDelay = String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 2 : 1;
        if (frozen.precommitTipHeight == null
            || !Number.isSafeInteger(precommitTip)
            || precommitTip < verifiedFreeze.freezeBlockHeight
            || precommitTip >= verifiedFreeze.targetBlockHeight
            || !Number.isFinite(verifiedAt)
            || verifiedFreeze.entropyDelayBlocks < minimumDelay) {
            await this._cancelFrozen(frozen);
            return null;
        }
        let exactEntrants;
        try {
            exactEntrants = buildPaidEntrantFreeze({
                ...verifiedFreeze,
                queueEntryIds: (frozen.entries || []).map(entry => entry.queueEntryId)
            });
        } catch (_) {
            await this._cancelFrozen(frozen);
            return null;
        }
        const frozenEntries = frozen.entries || [];
        if (exactEntrants.freezeCommitment !== verifiedFreeze.freezeCommitment
            || new Set(frozenEntries.map(entry => String(entry.userId))).size !== frozenEntries.length
            || frozenEntries.some(entry => !String(entry.socketId || ''))
            || new Set(frozenEntries.map(entry => String(entry.socketId))).size !== frozenEntries.length) {
            await this._cancelFrozen(frozen);
            return null;
        }

        const tip = await this._strictDaemonTipHeight();
        if (tip < this._minimumConfirmedTip(verifiedFreeze.targetBlockHeight)) {
            return null;
        }
        return { frozen, verifiedFreeze };
    }

    async _resolvePreparedFrozenMatch({ frozen, verifiedFreeze }) {
        let canonical;
        try {
            canonical = await this._readStableConfirmedHeader(verifiedFreeze.targetBlockHeight);
        } catch (err) {
            if (err?.code === 'PAID_ENTROPY_REORG') await this._cancelFrozen(frozen);
            else this._log(`[MatchScheduler] future block ${verifiedFreeze.targetBlockHeight} unavailable`, err.message);
            return;
        }
        if (!canonical?.ready) return;
        if (this._shuttingDown) return;
        const derived = deriveFutureBlockMatchSeed({
            blockHash: canonical.hash,
            blockHeight: verifiedFreeze.targetBlockHeight,
            freeze: verifiedFreeze
        });
        // Confirmation depth is activation-safety metadata, not additional seed material. Persist
        // it with the proof so an auditor can evaluate the wait contract after configuration has
        // changed, together with the durable post-commit daemon-tip witness.
        const seedProof = Object.freeze({
            seed: derived.seed,
            derivation: Object.freeze({
                ...derived.derivation,
                entropyConfirmations: this.paidEntropyConfirmations,
                minimumConfirmedTipHeight: this._minimumConfirmedTip(
                    verifiedFreeze.targetBlockHeight
                ),
                precommitTipHeight: Number(frozen.precommitTipHeight),
                precommitVerifiedAt: new Date(frozen.precommitVerifiedAt).toISOString()
            })
        });
        return this._startEntries({
            entries: frozen.entries,
            economy: frozen.economy,
            blockHeight: verifiedFreeze.targetBlockHeight,
            seedProof,
            frozen
        });
    }

    async _resolveFrozenMatch(frozen, observedBlockHeight) {
        const prepared = await this._prepareFrozenMatch(frozen, observedBlockHeight);
        if (prepared) return this._resolvePreparedFrozenMatch(prepared);
        return undefined;
    }

    async _drainEconomy(economy, blockHeight, blockHash = null) {
        // Debug/block polling starts before database recovery completes. The concrete MatchQueue
        // exposes an explicit readiness bit; injected test/legacy queues without it keep working.
        if (this.matchQueue?.initialized === false) return;
        // Paid economies can only enter through the durable future-block freeze path above.
        if (economy !== 'free') return;

        const drain = await this.matchQueue.drain(economy, this.maxPlayers, this.minPlayers);
        if (!drain) return;
        const { entries } = drain;
        if (!extractBlockHash(blockHash)) {
            try {
                blockHash = extractBlockHash(await this.blockEntropyProvider(blockHeight));
            } catch (err) {
                this._log(`[MatchScheduler] free block entropy unavailable at ${blockHeight}`, err.message);
            }
        }
        const seedProof = extractBlockHash(blockHash) ? deriveBlockMatchSeed({
            blockHash,
            blockHeight,
            economy,
            rulesetId: this.ruleset.id,
            queueEntryIds: entries.map(entry => entry.queueEntryId)
        }) : null;
        return this._startEntries({ entries, economy, blockHeight, seedProof, frozen: null });
    }

    async _startEntries({ entries, economy, blockHeight, seedProof = null, frozen = null }) {
        if (this._shuttingDown) return;
        if (!entries || entries.length < this.minPlayers || entries.length > this.maxPlayers) {
            // Defensive: drain() already marked these 'matched'; refund them when the actual
            // entrant count violates the selected ruleset's player contract.
            if (entries && entries.length) {
                if (frozen && typeof this.matchQueue.cancelFrozenMatch === 'function') {
                    await this.matchQueue.cancelFrozenMatch(frozen.id, 'match_cancel');
                } else {
                    await this._refund(entries, economy, 'match_cancel');
                }
            }
            return;
        }

        if (economy !== 'free' && seedProof?.derivation?.version !== PAID_SEED_VERSION) {
            // No environment exception and no server-random fallback for value-bearing matches.
            this._log(`[MatchScheduler] retaining frozen ${economy} entrants: future-block proof missing`);
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
            id: frozen?.id,
            ruleset: this.ruleset,
            economy,
            maxPlayers: this.maxPlayers,
            entrants,
            seed: seedProof?.seed,
            startBlockHeight: blockHeight,
            cryptoType: process.env.CRYPTO_TYPE || 'WOW'
        });
        room.seedDerivation = seedProof?.derivation || {
            version: 'server-random-v1',
            blockHeight: Number(blockHeight),
            economy: String(economy),
            rulesetId: this.ruleset.id,
            queueEntryIds: entries.map(entry => String(entry.queueEntryId)).sort()
        };
        room.minDurationMs = this.minDurationMs;
        room.hardCeilingMs = this.hardCeilingMs;

        // Paid rooms claim an already-durable pending freeze. Free rooms keep the historical
        // create-and-link path. Never refund an ambiguous paid activation: prove it committed or
        // leave the row for crash recovery.
        if (frozen) {
            try {
                await this._activateFrozenMatch(room, entries, frozen);
            } catch (err) {
                const accepted = await this._frozenActivationAccepted(room, frozen).catch(() => false);
                if (!accepted) {
                    this._log(`[MatchScheduler] frozen activation ${room.id} unproven; retaining for recovery`);
                    return;
                }
            }
            // The activation transaction changes the row to `starting` but leaves every queue
            // escrow anchor untouched. Re-read the exact target now, before ticket collection,
            // engine creation, or client notification. A reorg/unavailable daemon therefore
            // takes the normal exact-anchor abort/refund path with no gameplay side effects.
            if (!await this._recheckActivatedHeader(seedProof)) {
                this._log(`[MatchScheduler] canonical target changed after activation of ${room.id}; aborting + refunding`);
                await this._abortMatch(room, entries, economy);
                return;
            }
            if (typeof this.matchQueue.noteFrozenStarted === 'function') {
                this.matchQueue.noteFrozenStarted(frozen.id);
            }
        } else {
            try {
                await this._persistMatch(room, entries, economy);
            } catch (err) {
                this._log('[MatchScheduler] persist failed; refunding entrants', err.message);
                await this._refund(entries, economy, 'match_cancel');
                return;
            }
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
                // COMMIT acknowledgements can fail after PostgreSQL durably accepted the whole
                // ticket/liability transaction. Inspect that immutable snapshot before aborting;
                // cancelling a committed row while leaving consumed tickets would strand value.
                const accepted = (payoutService && typeof payoutService.getAcceptedLiability === 'function')
                    ? await payoutService.getAcceptedLiability(room.id).catch(() => null)
                    : null;
                if (accepted) {
                    room.entryFeeAtomic = String(accepted.entry_fee_atomic);
                    room.potAtomic = String(accepted.pot_atomic);
                    room.houseFeeAtomic = String(accepted.house_fee_atomic);
                    room.houseFeePercent = Number(accepted.house_fee_percent);
                    room.payoutLiabilityAmountAtomic = String(accepted.payout_liability_amount_atomic);
                    room.payoutLiabilityCapAtomic = String(accepted.payout_liability_cap_atomic);
                    room.payoutLiabilityTerms = accepted.payout_liability_terms;
                    this._log(`[MatchScheduler] collection acknowledgement failed but liability ${room.id} is durable; continuing`);
                } else {
                    this._log('[MatchScheduler] pot collection failed; aborting + refunding', err.message);
                    await this._abortMatch(room, entries, economy);
                    return;
                }
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
        if (!this.matchQueue) return { attempted: entries?.length || 0, resolved: 0, failed: entries?.length || 0 };
        try {
            if (typeof this.matchQueue.refundEntries === 'function') {
                return await this.matchQueue.refundEntries(entries, economy, reason);
            }
            let resolved = 0;
            for (const e of entries) {
                const result = await this.matchQueue.leave(e.userId, economy).catch(() => null);
                if (result?.success) resolved += 1;
            }
            return { attempted: entries.length, resolved, failed: entries.length - resolved };
        } catch (err) {
            this._log('[MatchScheduler] refund error', err.message);
            return { attempted: entries?.length || 0, resolved: 0, failed: entries?.length || 0 };
        }
    }

    /**
     * Abort a match whose pot could not be collected: mark it cancelled and refund everyone.
     */
    async _abortMatch(room, entries, economy) {
        // Refund first. Each refund is anchored to its exact queue row and marks the entrant in
        // the same transaction. If the process dies before the match status update, boot recovery
        // sees those anchors already resolved and cannot double-refund them.
        const refundResult = await this._refund(entries, economy, 'match_cancel');
        if (refundResult?.failed > 0) {
            this._log(`[MatchScheduler] leaving match ${room.id} recoverable after ${refundResult.failed} refund failure(s)`);
            return;
        }
        if (this.matchManager?.db) {
            try {
                await this.matchManager.db.query(
                    `UPDATE matches
                     SET status = 'cancelled', ended_at = NOW()
                     WHERE id = $1
                       AND status = 'starting'
                       AND payout_liability_accepted_at IS NULL`,
                    [room.id]
                );
            } catch (err) {
                this._log('[MatchScheduler] abort mark-cancelled error', err.message);
            }
        }
    }

    async _persistMatch(room, entries, economy) {
        if (!this.matchManager?.db) return;

        const queueEntryIds = entries.map(entry => entry?.queueEntryId);
        if (queueEntryIds.some(id => id == null)
            || new Set(queueEntryIds.map(String)).size !== queueEntryIds.length) {
            throw new Error('Cannot persist match without unique durable queue entry ids');
        }

        const matchRow = MatchState.toMatchRow(room);
        // Override row defaults with the actual queued economy and status.
        matchRow.status = 'starting';
        matchRow.economy = economy;

        await this.matchManager.db.withTransaction(async (client) => {
            await client.query(`
                INSERT INTO matches (
                    id, status, economy, variant, ruleset_id, difficulty_preset, max_players,
                    seed_hash, dungeon, start_block_height, entry_fee_atomic,
                    pot_atomic, house_fee_atomic, house_fee_percent, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11,
                    $12, $13, $14, NOW()
                )
            `, [
                matchRow.id,
                matchRow.status,
                matchRow.economy,
                matchRow.variant,
                matchRow.ruleset_id,
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

            const linked = await client.query(`
                UPDATE match_queue_entries
                SET match_id = $1
                WHERE id = ANY($2::bigint[])
                  AND economy = $3
                  AND status = 'matched'
                  AND match_id IS NULL
                RETURNING id, user_id
            `, [room.id, queueEntryIds, economy]);
            const expectedByQueueId = new Map(entries.map(entry => [
                String(entry.queueEntryId),
                String(entry.userId)
            ]));
            const linksMatch = linked.rowCount === queueEntryIds.length
                && (linked.rows || []).every(row => (
                    expectedByQueueId.get(String(row.id)) === String(row.user_id)
                ));
            if (!linksMatch) {
                throw new Error(`Queue-link mismatch for match ${room.id}: expected ${queueEntryIds.length}, got ${linked.rowCount}`);
            }

            for (const entrant of entries) {
                await client.query(`
                    INSERT INTO match_entrants (match_id, user_id, socket_id, queue_entry_id)
                    VALUES ($1, $2, $3, $4)
                `, [room.id, entrant.userId, entrant.socketId, entrant.queueEntryId]);
            }
        });
    }

    async _activateFrozenMatch(room, entries, frozen) {
        if (!this.matchManager?.db) return;
        const queueEntryIds = entries.map(entry => entry?.queueEntryId);
        if (queueEntryIds.some(id => id == null)
            || new Set(queueEntryIds.map(String)).size !== queueEntryIds.length) {
            throw new Error('Cannot activate a freeze without unique durable queue entry ids');
        }
        const matchRow = MatchState.toMatchRow(room);
        await this.matchManager.db.withTransaction(async (client) => {
            // This status claim serializes against MatchQueue.cancelFrozenMatch(). Whichever
            // transaction wins owns every linked escrow anchor; the loser must not touch them.
            const activated = await client.query(`
                UPDATE matches
                SET status = 'starting',
                    variant = $1,
                    ruleset_id = $2,
                    difficulty_preset = $3,
                    max_players = $4,
                    seed_hash = $5,
                    dungeon = $6::jsonb,
                    start_block_height = $7
                WHERE id = $8
                  AND status = 'pending'
                  AND economy = $9
                  AND start_block_height = $7
                  AND seed_hash = $10
                  AND entropy_precommit_tip_height IS NOT NULL
                  AND entropy_precommit_verified_at IS NOT NULL
                  AND entropy_precommit_tip_height < start_block_height
                RETURNING id
            `, [
                matchRow.variant,
                matchRow.ruleset_id,
                matchRow.difficulty_preset,
                matchRow.max_players,
                matchRow.seed_hash,
                JSON.stringify(matchRow.dungeon),
                matchRow.start_block_height,
                room.id,
                room.economy,
                frozen.freezeCommitment
            ]);
            if (activated.rowCount !== 1) {
                throw new Error(`Pending paid freeze ${room.id} was not claimable`);
            }

            const expectedByQueueId = new Map(entries.map(entry => [
                String(entry.queueEntryId), String(entry.userId)
            ]));
            const linked = await client.query(`
                SELECT id, user_id
                FROM match_queue_entries
                WHERE match_id = $1
                  AND economy = $2
                  AND status = 'matched'
                ORDER BY id ASC
                FOR UPDATE
            `, [room.id, room.economy]);
            const linksMatch = linked.rowCount === queueEntryIds.length
                && (linked.rows || []).every(row => (
                    expectedByQueueId.get(String(row.id)) === String(row.user_id)
                ));
            if (!linksMatch) throw new Error(`Frozen queue-link mismatch for match ${room.id}`);

            const entrantRows = await client.query(`
                SELECT user_id, socket_id, queue_entry_id
                FROM match_entrants
                WHERE match_id = $1
                ORDER BY queue_entry_id ASC
                FOR UPDATE
            `, [room.id]);
            const entrantLinksMatch = entrantRows.rowCount === entries.length
                && (entrantRows.rows || []).every(row => (
                    expectedByQueueId.get(String(row.queue_entry_id)) === String(row.user_id)
                ));
            if (!entrantLinksMatch) throw new Error(`Frozen entrant mismatch for match ${room.id}`);
        });
    }

    async _frozenActivationAccepted(room, frozen) {
        if (!this.matchManager?.db) return true;
        const result = await this.matchManager.db.query(`
            SELECT status, economy, seed_hash, start_block_height, dungeon,
                   entropy_precommit_tip_height, entropy_precommit_verified_at
            FROM matches
            WHERE id = $1
            LIMIT 1
        `, [room.id]);
        const row = result.rows?.[0];
        let dungeon = row?.dungeon;
        if (typeof dungeon === 'string') {
            try { dungeon = JSON.parse(dungeon); } catch (_) { return false; }
        }
        const proof = dungeon?.match_fairness;
        return row?.status === 'starting'
            && row.economy === room.economy
            && String(row.seed_hash) === room.seedHash
            && Number(row.start_block_height) === Number(room.startBlockHeight)
            && row.entropy_precommit_tip_height != null
            && Number(row.entropy_precommit_tip_height) < Number(row.start_block_height)
            && row.entropy_precommit_verified_at != null
            && proof?.version === PAID_SEED_VERSION
            && proof?.freezeCommitment === frozen.freezeCommitment;
    }

    async shutdown() {
        this._shuttingDown = true;
        await this._blockTail.catch(() => {});
        for (const id of this._timeoutIds) clearTimeout(id);
        this._timeoutIds = [];
    }
}

module.exports = MatchScheduler;
module.exports.BLOCK_SEED_VERSION = BLOCK_SEED_VERSION;
module.exports.deriveBlockMatchSeed = deriveBlockMatchSeed;
module.exports.deriveFutureBlockMatchSeed = deriveFutureBlockMatchSeed;
module.exports.extractBlockHash = extractBlockHash;
