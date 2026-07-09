const MatchScheduler = require('../src/network/matchScheduler');
const MatchQueue = require('../src/network/matchQueue');

describe('MatchScheduler', () => {
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
        return {
            attached,
            db: null,
            attach(room, entrants, opts) {
                this.attached.push({ room, entrants, opts });
            },
            setEngine(id, engine) {},
            onTick() {},
            onFinish() {}
        };
    }

    test('does nothing when disabled', async () => {
        process.env.MATCH_ENABLED = 'false';
        const queue = makeQueue();
        const manager = makeManager();
        const scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(0);
        delete process.env.MATCH_ENABLED;
    });

    test('does nothing when fewer than 2 players are queued', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        const manager = makeManager();
        const scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(0);
        expect(queue.length('free')).toBe(1);
        delete process.env.MATCH_ENABLED;
    });

    test('drains free queue into a match when 2+ players queued', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        const manager = makeManager();
        const scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await queue.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });
        await scheduler.onBlock(100);
        expect(manager.attached.length).toBe(1);
        const { room, entrants } = manager.attached[0];
        expect(room.economy).toBe('free');
        expect(entrants.length).toBe(2);
        expect(queue.length('free')).toBe(0);
        delete process.env.MATCH_ENABLED;
    });

    test('starts the match engine after attach', async () => {
        process.env.MATCH_ENABLED = 'true';
        const queue = makeQueue();
        const manager = makeManager();
        const scheduler = new MatchScheduler({ matchQueue: queue, matchManager: manager, tickMs: 100 });
        await queue.join({ userId: 1, socketId: 's1', sessionToken: 't1', economy: 'free' });
        await queue.join({ userId: 2, socketId: 's2', sessionToken: 't2', economy: 'free' });
        await scheduler.onBlock(100);
        const { room } = manager.attached[0];
        // Engine exists and was started via attach (the actual engine lives in scheduler internals).
        expect(room.status).toBe('active');
        delete process.env.MATCH_ENABLED;
    });
});
