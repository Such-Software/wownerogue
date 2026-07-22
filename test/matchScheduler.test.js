const MatchScheduler = require('../src/network/matchScheduler');
const { deriveBlockMatchSeed } = MatchScheduler;
const MatchQueue = require('../src/network/matchQueue');

describe('MatchScheduler', () => {
    let scheduler = null;
    let manager = null;

    afterEach(() => {
        // Stop the scheduler tail and every handed-off engine so Jest cannot leak handles.
        if (scheduler) scheduler.shutdown();
        if (manager) for (const engine of manager.engines.values()) engine.stop();
        scheduler = null;
        manager = null;
        delete process.env.MATCH_ENABLED;
    });

    function makeQueue() {
        const entries = [];
        let nextId = 1;
        return {
            entries,
            async join(e) {
                e.queueEntryId = nextId++;
                this.entries.push(e);
                return { success: true };
            },
            async drain(economy, max) {
                const filtered = this.entries.filter(e => e.economy === economy);
                if (filtered.length < 2) return null;
                const count = Math.min(max, filtered.length);
                const drained = filtered.slice(0, count);
                this.entries = this.entries.filter(e => !drained.includes(e));
                return { entries: drained };
            },
            length(economy) { return this.entries.length; }
        };
    }

    function makeManager() {
        const attached = [];
        const engines = new Map();
        return {
            attached,
            engines,
            db: null,
            attach(room, entrants, opts) {
                this.attached.push({ room, entrants, opts });
            },
            setEngine(id, engine) { engines.set(id, engine); },
            expireBlockDeadlines: jest.fn(),
            onTick() {},
            onFinish() {},
            expire() {}
        };
    }

    test('does nothing when disabled', async () => {
        process.env.MATCH_ENABLED = 'false';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(0);
    });

    test('does nothing when fewer than 2 players are queued', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(0);
        expect(queue.length('free')).toBe(1);
    });

    test('drains free queue into a match when 2+ players queued', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await queue.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(1);
        const { room, entrants } = manager.attached[0];
        expect(room.economy).toBe('free');
        expect(entrants.length).toBe(2);
        expect(queue.length('free')).toBe(0);
    });

    test('hands off the engine without starting it (real countdown, no head-start)', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager, tickMs: 100 });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await queue.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });
        await scheduler.onBlock(100);
        const { room } = manager.attached[0];
        // MP-H6: the scheduler creates the engine and hands it to the manager (setEngine) but
        // does NOT start it. The room stays in 'starting' — moves are rejected — until the
        // manager's countdown elapses, so honest and modified clients always start together.
        expect(manager.engines.size).toBe(1);
        expect(room.status).toBe('starting');
    });

    test('operator-selected last-alive ruleset creates a real PvP match', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager, rulesetId: 'last-alive' });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await queue.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });

        await scheduler.onBlock(100);

        const { room } = manager.attached[0];
        expect(room.ruleset.id).toBe('last-alive');
        expect(room.pvpCombat).toBe(true);
        expect(room.variant).toBe('pvp');
        expect(room.snapshot().ruleset).toEqual(expect.objectContaining({
            id: 'last-alive',
            winCondition: 'last-alive'
        }));
    });

    test('block-derived match seeds are reproducible and lock the durable entrant set', () => {
        const input = {
            blockHash: 'ab'.repeat(32),
            blockHeight: 123,
            economy: 'crypto_race',
            rulesetId: 'race',
            queueEntryIds: [12, 3]
        };
        const first = deriveBlockMatchSeed(input);
        const reordered = deriveBlockMatchSeed({ ...input, queueEntryIds: [3, 12] });
        const changedEntrant = deriveBlockMatchSeed({ ...input, queueEntryIds: [3, 13] });

        expect(first).toEqual(reordered);
        expect(first.seed).toMatch(/^[0-9a-f]{64}$/);
        expect(first.derivation.queueEntryIds).toEqual(['3', '12']);
        expect(changedEntrant.seed).not.toBe(first.seed);
    });

    test('production paid queues do not drain without a canonical block hash', async () => {
        const oldNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        const drain = jest.spyOn(queue, 'drain');
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        try {
            await scheduler._drainEconomy('credits_prestige', 100, null);
            expect(drain).not.toHaveBeenCalled();
            expect(manager.attached).toHaveLength(0);
        } finally {
            if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = oldNodeEnv;
        }
    });

    test('each advancing block is offered once to active-room deadline processing', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        manager = makeManager();
        scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });

        await scheduler.onBlock(100);
        await scheduler.onBlock(100);
        await scheduler.onBlock(101);

        // getblockcount is normalized to its zero-based canonical header exactly once.
        expect(manager.expireBlockDeadlines.mock.calls).toEqual([[99], [100]]);
    });
});
