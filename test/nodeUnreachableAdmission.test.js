/**
 * Admission is refused while no blockchain node is reachable.
 *
 * A run's lifetime is measured in blocks and its entry block comes from the last SUCCESSFUL poll.
 * With every node down that value goes stale silently, so a game admitted during an outage was
 * anchored to an already-past block and killed as a timeout on the first recovered poll: the
 * player lost a run, and in paid mode an entry, to our infrastructure. Refuse up front instead.
 */

const SocketHandlers = require('../src/network/socketHandlers');

function handlers({ chainHealthy, shuttingDown = false }) {
    const h = Object.create(SocketHandlers.prototype);
    h._isShuttingDown = shuttingDown;
    h._admissionsInFlight = new Set();
    h.debugManager = { CONSOLE_LOGGING: false, isChainHealthy: () => chainHealthy };
    h.broadcastManager = { sendStatusUpdate: jest.fn() };
    return h;
}

function socket() {
    const emitted = [];
    return { id: 's1', emitted, emit: (event, payload) => emitted.push({ event, payload }) };
}

describe('admission while no node is reachable', () => {
    test('refuses the admission and never runs the task', async () => {
        const h = handlers({ chainHealthy: false });
        const s = socket();
        const task = jest.fn();

        await h._runAdmission(s, 'auto_start', task);

        expect(task).not.toHaveBeenCalled();
        const refusal = s.emitted.find(e => e.event === 'chain_unavailable');
        expect(refusal).toBeDefined();
        expect(refusal.payload).toMatchObject({ code: 'NODE_UNREACHABLE', kind: 'auto_start' });
        // The player must be told nothing was taken from them.
        expect(refusal.payload.message).toMatch(/nothing was charged/i);
        expect(h.broadcastManager.sendStatusUpdate).toHaveBeenCalled();
    });

    test('runs the admission normally when a node is reachable', async () => {
        const h = handlers({ chainHealthy: true });
        const s = socket();
        const task = jest.fn().mockResolvedValue('started');

        await expect(h._runAdmission(s, 'join_queue', task)).resolves.toBe('started');
        expect(task).toHaveBeenCalledTimes(1);
        expect(s.emitted).toHaveLength(0);
    });

    test('gates every admission kind, including paid intake', async () => {
        for (const kind of ['auto_start', 'play_free', 'join_queue', 'early_entry',
            'request_payment', 'match_queue']) {
            const h = handlers({ chainHealthy: false });
            const s = socket();
            const task = jest.fn();
            await h._runAdmission(s, kind, task);
            expect(task).not.toHaveBeenCalled();
            expect(s.emitted.some(e => e.event === 'chain_unavailable')).toBe(true);
        }
    });

    test('shutdown still takes precedence over the node check', async () => {
        const h = handlers({ chainHealthy: false, shuttingDown: true });
        h._emitShutdownAdmissionRefusal = jest.fn();
        const s = socket();

        await h._runAdmission(s, 'auto_start', jest.fn());

        expect(h._emitShutdownAdmissionRefusal).toHaveBeenCalled();
        expect(s.emitted.some(e => e.event === 'chain_unavailable')).toBe(false);
    });

    test('paid intake is refused when the WALLET is unreachable, but credits/free are not', async () => {
        // Not a failover: two wallet-rpc processes over one wallet file can spend the same outputs.
        // The safe response to a wallet outage is a clean refusal of intake only.
        const h = handlers({ chainHealthy: true });
        h.walletService = { isHealthy: false };

        const paid = socket();
        await h._runAdmission(paid, 'request_payment', jest.fn());
        const refusal = paid.emitted.find(e => e.event === 'payment_unavailable');
        expect(refusal).toBeDefined();
        expect(refusal.payload).toMatchObject({ code: 'WALLET_UNREACHABLE' });

        for (const kind of ['auto_start', 'play_free', 'join_queue']) {
            const s = socket();
            const task = jest.fn().mockResolvedValue('ok');
            await expect(h._runAdmission(s, kind, task)).resolves.toBe('ok');
            expect(task).toHaveBeenCalled();
        }
    });

    test('a runtime without the health probe is left alone (fires only on an explicit false)', async () => {
        const h = handlers({ chainHealthy: true });
        h.debugManager = { CONSOLE_LOGGING: false }; // no isChainHealthy at all
        const s = socket();
        const task = jest.fn().mockResolvedValue('ok');

        await expect(h._runAdmission(s, 'auto_start', task)).resolves.toBe('ok');
        expect(task).toHaveBeenCalled();
    });
});
