'use strict';

const crypto = require('crypto');
const MatchScheduler = require('../src/network/matchScheduler');
const MatchQueue = require('../src/network/matchQueue');
const SocketHandlers = require('../src/network/socketHandlers');
const {
    PAID_SEED_VERSION,
    buildPaidEntrantFreeze,
    deriveFutureBlockMatchSeed
} = require('../src/network/matchFairness');

const FUTURE_HASH = 'ab'.repeat(32);

function entrant(queueEntryId, userId = queueEntryId) {
    return {
        queueEntryId,
        userId,
        socketId: `socket-${userId}`,
        sessionToken: `session-${userId}`,
        createdAt: queueEntryId
    };
}

class DurablePaidQueueDouble {
    constructor(entries = []) {
        this.initialized = true;
        this.queues = {
            free: [],
            credits_prestige: entries.slice(),
            crypto_race: []
        };
        this.frozen = [];
        this.freezeCalls = [];
        this.cancelled = [];
    }

    async refundUnavailableQueues() {}
    isEconomyAvailable() { return true; }
    isFinancialRecoveryReady() { return true; }

    async freezePaidMatch(spec) {
        const queue = this.queues[spec.economy];
        if (!queue || queue.length < spec.minPlayers) return null;
        const entries = queue.slice(0, spec.maxPlayers);
        const freeze = buildPaidEntrantFreeze({
            freezeBlockHeight: spec.freezeBlockHeight,
            targetBlockHeight: spec.targetBlockHeight,
            economy: spec.economy,
            rulesetId: spec.rulesetId,
            queueEntryIds: entries.map(entry => entry.queueEntryId)
        });
        const group = {
            id: crypto.randomUUID(),
            economy: spec.economy,
            variant: spec.variant,
            rulesetId: spec.rulesetId,
            difficultyPreset: spec.difficultyPreset,
            maxPlayers: spec.maxPlayers,
            targetBlockHeight: spec.targetBlockHeight,
            freezeCommitment: freeze.freezeCommitment,
            precommitTipHeight: null,
            precommitVerifiedAt: null,
            freeze,
            entries,
            status: 'pending'
        };
        this.freezeCalls.push(spec);
        this.frozen.push(group);
        this.queues[spec.economy] = queue.slice(entries.length);
        return group;
    }

    async verifyFrozenPrecommit(id, commitment, tip) {
        const group = this.frozen.find(candidate => candidate.id === id
            && candidate.status === 'pending'
            && candidate.freezeCommitment === commitment
            && candidate.targetBlockHeight > tip);
        if (!group) return { verified: false };
        group.precommitTipHeight = tip;
        group.precommitVerifiedAt = new Date().toISOString();
        return {
            verified: true,
            observedTipHeight: tip,
            verifiedAt: group.precommitVerifiedAt
        };
    }

    async listFrozenPaidMatches(throughBlockHeight) {
        return this.frozen.filter(group => group.status === 'pending'
            && (throughBlockHeight == null || group.targetBlockHeight <= throughBlockHeight));
    }

    noteFrozenStarted(id) {
        const group = this.frozen.find(candidate => candidate.id === id);
        if (group) group.status = 'starting';
    }

    async cancelFrozenMatch(id) {
        const group = this.frozen.find(candidate => candidate.id === id && candidate.status === 'pending');
        if (!group) return { claimed: false, resolved: true, refunded: 0 };
        group.status = 'cancelled';
        this.cancelled.push(...group.entries.map(entry => entry.queueEntryId));
        return { claimed: true, resolved: true, refunded: group.entries.length };
    }

    async refundEntries(entries) {
        const ids = new Set((entries || []).map(entry => String(entry.queueEntryId)));
        const group = this.frozen.find(candidate => candidate.entries.some(
            entry => ids.has(String(entry.queueEntryId))
        ));
        if (group && group.status !== 'cancelled') {
            group.status = 'cancelled';
            this.cancelled.push(...group.entries.map(entry => entry.queueEntryId));
        }
        return { attempted: ids.size, resolved: ids.size, failed: 0 };
    }

    async drain(economy, maxPlayers, minPlayers) {
        const queue = this.queues[economy] || [];
        if (queue.length < minPlayers) return null;
        const entries = queue.slice(0, maxPlayers);
        this.queues[economy] = queue.slice(entries.length);
        return { entries };
    }
}

function managerDouble() {
    return {
        attached: [],
        engines: new Map(),
        db: null,
        attach(room, entries) { this.attached.push({ room, entries }); },
        setEngine(id, engine) { this.engines.set(id, engine); },
        onTick() {},
        onFinish() {}
    };
}

describe('paid PvP future-block entrant freeze', () => {
    const schedulers = [];

    beforeEach(() => {
        process.env.MATCH_ENABLED = 'true';
    });

    afterEach(async () => {
        await Promise.all(schedulers.splice(0).map(scheduler => scheduler.shutdown()));
        delete process.env.MATCH_ENABLED;
    });

    function schedulerFor(queue, manager, provider, countProvider) {
        const scheduler = new MatchScheduler({
            matchQueue: queue,
            matchManager: manager,
            blockEntropyProvider: provider,
            blockCountProvider: countProvider,
            paidEntropyDelayBlocks: 2,
            paidEntropyConfirmations: 2,
            rulesetId: 'last-alive',
            maxPlayers: 2,
            countdownMs: 10 ** 9
        });
        schedulers.push(scheduler);
        return scheduler;
    }

    test('delay=2/conf=2 freezes FIFO at H, reads no hash through target, then starts from the stable exact header', async () => {
        const queue = new DurablePaidQueueDouble([entrant(12), entrant(3), entrant(99)]);
        const manager = managerDouble();
        let daemonCount = 101;
        const entropyCalls = [];
        const scheduler = schedulerFor(queue, manager, async height => {
            entropyCalls.push(height);
            if (height === 100) throw new Error('the freeze-block hash must never be requested');
            return height === 102
                ? { block_header: { height, hash: FUTURE_HASH } }
                : null;
        }, async () => daemonCount);

        // DebugManager emits block count 101, whose actual canonical tip header is height 100.
        await scheduler.onBlock(101);

        expect(entropyCalls).toEqual([]);
        expect(queue.frozen).toHaveLength(1);
        expect(queue.frozen[0].entries.map(entry => entry.queueEntryId)).toEqual([12, 3]);
        expect(queue.frozen[0].freeze.queueEntryIds).toEqual(['3', '12']);
        expect(manager.attached).toHaveLength(0);

        daemonCount = 102;
        await scheduler.onBlock(102); // H+1
        daemonCount = 103;
        await scheduler.onBlock(103); // target exists, but only confirmation one
        expect(entropyCalls).toEqual([]);
        expect(manager.attached).toHaveLength(0);

        daemonCount = 104;
        await scheduler.onBlock(104); // target+1: confirmation two

        expect(entropyCalls).toEqual([102, 102, 102]);
        expect(manager.attached).toHaveLength(1);
        const { room, entries } = manager.attached[0];
        const expected = deriveFutureBlockMatchSeed({
            blockHash: FUTURE_HASH,
            blockHeight: 102,
            freeze: queue.frozen[0].freeze
        });
        expect(entries.map(entry => entry.queueEntryId)).toEqual([12, 3]);
        expect(room.seed).toBe(expected.seed);
        expect(room.seedDerivation).toEqual(expect.objectContaining(expected.derivation));
        expect(room.seedDerivation.version).toBe(PAID_SEED_VERSION);
        expect(room.seedDerivation.blockHash).toBe(FUTURE_HASH);
        expect(room.seedDerivation).toEqual(expect.objectContaining({
            entropyDelayBlocks: 2,
            entropyConfirmations: 2,
            minimumConfirmedTipHeight: 103,
            precommitTipHeight: 100
        }));
        expect(room.fairnessProof(false)).toEqual(expect.objectContaining({
            blockHeight: 102,
            blockHash: FUTURE_HASH,
            freezeBlockHeight: 100,
            targetBlockHeight: 102,
            entropyDelayBlocks: 2,
            entropyConfirmations: 2,
            minimumConfirmedTipHeight: 103,
            precommitTipHeight: 100
        }));
    });

    test('a delayed freeze commit that crosses its target performs zero hash/attach work and refunds once', async () => {
        const queue = new DurablePaidQueueDouble([entrant(1), entrant(2)]);
        const manager = managerDouble();
        manager.matchPayoutService = { collectEntryTickets: jest.fn() };
        const entropy = jest.fn();
        const scheduler = schedulerFor(queue, manager, entropy, async () => 203);

        await scheduler.onBlock(101); // freeze H=100, target=102, post-commit tip already 202

        expect(manager.attached).toHaveLength(0);
        expect(manager.matchPayoutService.collectEntryTickets).not.toHaveBeenCalled();
        expect(entropy).not.toHaveBeenCalled();
        expect(queue.freezeCalls).toHaveLength(1);
        expect(queue.cancelled).toEqual([1, 2]);
        await scheduler.onBlock(101);
        expect(queue.cancelled).toEqual([1, 2]);
    });

    test('strict count failure cannot activate and the due unverified freeze is refunded without a hash read', async () => {
        const queue = new DurablePaidQueueDouble([entrant(21), entrant(22)]);
        const manager = managerDouble();
        const entropy = jest.fn();
        const scheduler = schedulerFor(queue, manager, entropy, async () => {
            throw new Error('daemon unavailable');
        });

        await scheduler.onBlock(301);
        await scheduler.onBlock(302);
        await scheduler.onBlock(303);

        expect(manager.attached).toHaveLength(0);
        expect(entropy).not.toHaveBeenCalled();
        expect(queue.cancelled).toEqual([21, 22]);
    });

    test('a header reorg between the two pre-activation reads refunds without gameplay', async () => {
        const queue = new DurablePaidQueueDouble([entrant(41), entrant(42)]);
        const manager = managerDouble();
        let daemonCount = 201;
        const hashes = [FUTURE_HASH, 'cd'.repeat(32)];
        const entropy = jest.fn(async height => ({
            block_header: { height, hash: hashes.shift() || hashes.at(-1) }
        }));
        const scheduler = schedulerFor(queue, manager, entropy, async () => daemonCount);
        await scheduler.onBlock(201); // H=200, target=202
        daemonCount = 204;
        await scheduler.onBlock(204);

        expect(manager.attached).toHaveLength(0);
        expect(manager.engines.size).toBe(0);
        expect(queue.cancelled).toEqual([41, 42]);
        expect(entropy).toHaveBeenCalledTimes(2);
    });

    test('a daemon response for the wrong height cannot activate the paid freeze', async () => {
        const queue = new DurablePaidQueueDouble([entrant(45), entrant(46)]);
        const manager = managerDouble();
        let daemonCount = 211;
        const entropy = jest.fn(async () => ({
            block_header: { height: 999, hash: FUTURE_HASH }
        }));
        const scheduler = schedulerFor(queue, manager, entropy, async () => daemonCount);
        await scheduler.onBlock(211); // H=210, target=212
        daemonCount = 214;
        await scheduler.onBlock(214);

        expect(manager.attached).toHaveLength(0);
        expect(queue.frozen[0].status).toBe('pending');
        expect(entropy).toHaveBeenCalledTimes(1);
    });

    test('a post-activation reorg aborts/refunds before engine attach', async () => {
        const queue = new DurablePaidQueueDouble([entrant(51), entrant(52)]);
        const manager = managerDouble();
        manager.matchPayoutService = { collectEntryTickets: jest.fn() };
        let daemonCount = 301;
        const hashes = [FUTURE_HASH, FUTURE_HASH, 'ef'.repeat(32)];
        const entropy = jest.fn(async height => ({
            block_header: { height, hash: hashes.shift() }
        }));
        const scheduler = schedulerFor(queue, manager, entropy, async () => daemonCount);
        await scheduler.onBlock(301);
        daemonCount = 304;
        await scheduler.onBlock(304);

        expect(manager.attached).toHaveLength(0);
        expect(manager.matchPayoutService.collectEntryTickets).not.toHaveBeenCalled();
        expect(manager.engines.size).toBe(0);
        expect(queue.cancelled).toEqual([51, 52]);
        expect(entropy).toHaveBeenCalledTimes(3);
    });

    test('legacy v1 pending freezes are cancelled before any target lookup', async () => {
        const queue = new DurablePaidQueueDouble();
        const entries = [entrant(61), entrant(62)];
        queue.frozen.push({
            id: crypto.randomUUID(),
            economy: 'credits_prestige',
            rulesetId: 'last-alive',
            targetBlockHeight: 401,
            freezeCommitment: '0'.repeat(64),
            freeze: {
                version: 'future-block-freeze-v1', freezeBlockHeight: 400,
                targetBlockHeight: 401, economy: 'credits_prestige', rulesetId: 'last-alive',
                queueEntryIds: ['61', '62'], freezeCommitment: '0'.repeat(64)
            },
            entries,
            status: 'pending'
        });
        const entropy = jest.fn();
        const scheduler = schedulerFor(queue, managerDouble(), entropy, async () => 403);

        await scheduler.onBlock(402);

        expect(entropy).not.toHaveBeenCalled();
        expect(queue.cancelled).toEqual([61, 62]);
    });

    test('the default provider fetches the exact canonical header height disclosed in proofs', async () => {
        const rpc = { getBlockByHeight: jest.fn().mockResolvedValue({ hash: FUTURE_HASH }) };
        const scheduler = new MatchScheduler({
            matchQueue: new DurablePaidQueueDouble(),
            matchManager: managerDouble(),
            debugManager: { rpcService: rpc },
            rulesetId: 'last-alive'
        });
        schedulers.push(scheduler);

        await scheduler.blockEntropyProvider(808);

        expect(rpc.getBlockByHeight).toHaveBeenCalledWith(808);
    });
});

describe('MatchQueue durable freeze/refund transactions', () => {
    beforeEach(() => { process.env.MATCH_ENABLED = 'true'; });
    afterEach(() => { delete process.env.MATCH_ENABLED; });

    test('writes pending match, exact queue links, and entrants in one freeze transaction', async () => {
        const calls = [];
        const entries = [entrant(61, 6), entrant(62, 7)];
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        calls.push({ sql, params });
                        if (sql.includes('INSERT INTO matches')) return { rows: [{ id: params[0] }], rowCount: 1 };
                        if (sql.includes('UPDATE match_queue_entries')) {
                            return {
                                rows: entries.map(entry => ({ id: entry.queueEntryId, user_id: entry.userId })),
                                rowCount: entries.length
                            };
                        }
                        return { rows: [{ id: 1 }], rowCount: 1 };
                    }
                });
            }
        };
        const queue = new MatchQueue({ db });
        queue._queues.credits_prestige = entries.slice();

        const frozen = await queue.freezePaidMatch({
            economy: 'credits_prestige',
            minPlayers: 2,
            maxPlayers: 2,
            freezeBlockHeight: 600,
            targetBlockHeight: 601,
            rulesetId: 'last-alive',
            variant: 'pvp',
            difficultyPreset: 'race'
        });

        expect(frozen.entries.map(entry => entry.queueEntryId)).toEqual([61, 62]);
        expect(queue.length('credits_prestige')).toBe(0);
        const pending = calls.find(call => call.sql.includes('INSERT INTO matches'));
        const links = calls.find(call => call.sql.includes('UPDATE match_queue_entries'));
        expect(pending.sql).toContain("'pending'");
        expect(pending.params[6]).toBe(frozen.freeze.freezeCommitment);
        expect(pending.params[8]).toBe(601);
        expect(links.params[1]).toEqual(['61', '62']);
        expect(calls.filter(call => call.sql.includes('INSERT INTO match_entrants'))).toHaveLength(2);
    });

    test('records the fresh post-commit daemon tip only while the target is still future', async () => {
        const calls = [];
        const verifiedAt = new Date('2026-07-21T12:00:00Z');
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        calls.push({ sql, params });
                        return {
                            rows: [{
                                id: params[0], start_block_height: 502,
                                entropy_precommit_tip_height: params[2],
                                entropy_precommit_verified_at: verifiedAt
                            }],
                            rowCount: 1
                        };
                    }
                });
            },
            query: jest.fn()
        };
        const queue = new MatchQueue({ db });

        const proof = await queue.verifyFrozenPrecommit(
            crypto.randomUUID(), 'ab'.repeat(32), 500
        );

        expect(proof).toEqual(expect.objectContaining({
            verified: true, targetBlockHeight: 502, observedTipHeight: 500
        }));
        expect(calls[0].sql).toContain('start_block_height > $3');
        expect(calls[0].sql).toContain('entropy_precommit_tip_height IS NULL');
        expect(calls[0].sql).toContain("status = 'pending'");
        expect(db.query).not.toHaveBeenCalled();
    });

    test('startup cancels v1 and crash-before-verification freezes; a failed cancellation retries', async () => {
        const canonical = buildPaidEntrantFreeze({
            freezeBlockHeight: 800,
            targetBlockHeight: 802,
            economy: 'credits_prestige',
            rulesetId: 'last-alive',
            queueEntryIds: [81, 82]
        });
        const queue = new MatchQueue({ db: {} });
        queue.listFrozenPaidMatches = jest.fn().mockResolvedValue([
            {
                id: 'v2-unverified', freeze: canonical,
                freezeCommitment: canonical.freezeCommitment,
                precommitTipHeight: null, precommitVerifiedAt: null
            },
            {
                id: 'v1-legacy', freeze: { ...canonical, version: 'future-block-freeze-v1' },
                freezeCommitment: canonical.freezeCommitment,
                precommitTipHeight: 800, precommitVerifiedAt: new Date()
            }
        ]);
        const attempts = new Map();
        queue.cancelFrozenMatch = jest.fn(async id => {
            attempts.set(id, (attempts.get(id) || 0) + 1);
            if (id === 'v2-unverified' && attempts.get(id) === 1) {
                return { resolved: false };
            }
            return { resolved: true };
        });

        const first = await queue.cancelUnverifiedPaidFreezes(
            'match_cancel', { failOnError: false }
        );
        const second = await queue.cancelUnverifiedPaidFreezes(
            'match_cancel', { failOnError: false }
        );

        expect(first).toEqual(expect.objectContaining({ ok: false, failed: 1 }));
        expect(second).toEqual(expect.objectContaining({ ok: true, failed: 0 }));
        expect(attempts.get('v2-unverified')).toBe(2);
        expect(attempts.get('v1-legacy')).toBe(2);
    });

    test('a lost freeze COMMIT acknowledgement adopts the exact durable envelope once', async () => {
        const entries = [entrant(63, 9), entrant(64, 10)];
        let pendingParams = null;
        const db = {
            async withTransaction(fn) {
                await fn({
                    async query(sql, params) {
                        if (sql.includes('INSERT INTO matches')) {
                            pendingParams = params;
                            return { rows: [{ id: params[0] }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE match_queue_entries')) {
                            return {
                                rows: entries.map(entry => ({ id: entry.queueEntryId, user_id: entry.userId })),
                                rowCount: entries.length
                            };
                        }
                        return { rows: [{ id: 1 }], rowCount: 1 };
                    }
                });
                throw new Error('commit acknowledgement lost');
            },
            async query(sql) {
                expect(sql).toContain("m.status = 'pending'");
                const dungeon = JSON.parse(pendingParams[7]);
                return {
                    rows: entries.map(entry => ({
                        id: pendingParams[0],
                        economy: 'credits_prestige',
                        variant: 'pvp',
                        ruleset_id: 'last-alive',
                        difficulty_preset: 'race',
                        max_players: 2,
                        seed_hash: pendingParams[6],
                        start_block_height: 611,
                        dungeon,
                        queue_entry_id: entry.queueEntryId,
                        user_id: entry.userId,
                        socket_id: entry.socketId,
                        session_token: entry.sessionToken,
                        created_at: new Date(entry.createdAt).toISOString()
                    })),
                    rowCount: entries.length
                };
            }
        };
        const queue = new MatchQueue({ db });
        queue._queues.credits_prestige = entries.slice();

        const frozen = await queue.freezePaidMatch({
            economy: 'credits_prestige',
            minPlayers: 2,
            maxPlayers: 2,
            freezeBlockHeight: 610,
            targetBlockHeight: 611,
            rulesetId: 'last-alive',
            variant: 'pvp',
            difficultyPreset: 'race'
        });

        expect(frozen).toEqual(expect.objectContaining({
            id: pendingParams[0],
            freezeCommitment: pendingParams[6]
        }));
        expect(queue.length('credits_prestige')).toBe(0);
    });

    test('shutdown cancellation claims a pending freeze and refunds each anchor exactly once', async () => {
        const freeze = buildPaidEntrantFreeze({
            freezeBlockHeight: 700,
            targetBlockHeight: 701,
            economy: 'credits_prestige',
            rulesetId: 'last-alive',
            queueEntryIds: [71, 72]
        });
        let pending = true;
        let creditsRefunded = 0;
        let ledgerRows = 0;
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('UPDATE matches')) {
                            if (!pending) return { rows: [], rowCount: 0 };
                            pending = false;
                            return {
                                rows: [{ economy: 'credits_prestige', dungeon: { match_fairness_freeze: freeze } }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('UPDATE match_queue_entries')) {
                            return {
                                rows: [
                                    { id: 71, user_id: 7, escrow_amount: '1', race_entry_lot_id: null },
                                    { id: 72, user_id: 8, escrow_amount: '1', race_entry_lot_id: null }
                                ],
                                rowCount: 2
                            };
                        }
                        if (sql.includes('UPDATE users')) {
                            creditsRefunded += 1;
                            return { rows: [{ credits: 10 }], rowCount: 1 };
                        }
                        if (sql.includes('INSERT INTO credit_transactions')) {
                            ledgerRows += 1;
                            return { rows: [], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 1 };
                    }
                });
            }
        };
        const queue = new MatchQueue({ db });
        const freezeId = crypto.randomUUID();
        queue.listFrozenPaidMatches = jest.fn().mockResolvedValue([{
            id: freezeId, economy: 'credits_prestige', entries: [entrant(71), entrant(72)]
        }]);

        await queue.shutdown();
        await queue.shutdown();

        expect(queue.listFrozenPaidMatches).toHaveBeenCalledTimes(2);
        expect({ creditsRefunded, ledgerRows }).toEqual({ creditsRefunded: 2, ledgerRows: 2 });
    });

    test('orderly server shutdown waits for scheduler, then refunds freezes, then stops matches', async () => {
        const order = [];
        const context = {
            beginShutdown: jest.fn(),
            debugManager: { CONSOLE_LOGGING: false },
            tavernManager: null,
            matchScheduler: { shutdown: jest.fn(async () => { order.push('scheduler'); }) },
            matchQueue: { shutdown: jest.fn(async () => { order.push('queue'); }) },
            matchManager: { shutdown: jest.fn(() => { order.push('manager'); }) },
            spectatorManager: null,
            chatHandler: null,
            connectionHandler: null,
            rateLimiter: null,
            memoryManager: null,
            sessionManager: null,
            suspendedGameManager: null,
            paymentHandlers: null,
            activeGames: new Map()
        };

        await SocketHandlers.prototype.shutdown.call(context);

        expect(order).toEqual(['scheduler', 'queue', 'manager']);
    });
});
