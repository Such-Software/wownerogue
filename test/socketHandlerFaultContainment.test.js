/**
 * Socket listener fault containment.
 *
 * Socket.IO invokes listeners WITHOUT a try/catch, and this process treats `uncaughtException` and
 * `unhandledRejection` as fatal (src/index.js calls gracefulShutdown and exits). That combination
 * made any unguarded throw in any listener an unauthenticated remote kill switch — the original
 * instance was `socket.emit('debug_ping')` with no argument, which dereferenced `data.time` on
 * `undefined` and took the whole server down. systemd restarts it, the attacker repeats.
 *
 * Two invariants are covered here:
 *   1. `handleDebugPing` tolerates a missing / null / non-object payload.
 *   2. The safe-dispatch wrapper contains BOTH synchronous throws and rejected promises, answering
 *      the offending socket with a generic message and never re-throwing.
 */

const SocketHandlers = require('../src/network/socketHandlers');

function fakeSocket() {
    const emitted = [];
    return {
        id: 'sock-1',
        client: { id: 'client-1' },
        emitted,
        emit: (event, payload) => emitted.push({ event, payload })
    };
}

// The wrapper is a closure created per connection inside handleConnection, which needs the full
// dependency graph. Rebuild the identical shape here and assert its behaviour directly — the source
// of truth is that handleConnection registers every listener through it (asserted below).
function makeSafeDispatch(handlers, socket) {
    return (event, handler) => {
        socket.on = socket.on || (() => {});
        return (...args) => {
            let result;
            try {
                result = handler(...args);
            } catch (err) {
                handlers._onHandlerFault(socket, event, err);
                return;
            }
            if (result && typeof result.then === 'function') {
                result.catch((err) => handlers._onHandlerFault(socket, event, err));
            }
        };
    };
}

describe('socket handler fault containment', () => {
    const handlers = Object.create(SocketHandlers.prototype);
    handlers.debugManager = { CONSOLE_LOGGING: false };

    let errorSpy;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    describe('handleDebugPing payload hardening', () => {
        test.each([
            ['no argument at all', undefined],
            ['an explicit null (defeats a default parameter)', null],
            ['a non-object primitive', 42],
            ['a string', 'time']
        ])('does not throw for %s', (_label, payload) => {
            const socket = fakeSocket();
            expect(() => handlers.handleDebugPing(socket, payload)).not.toThrow();
            const pong = socket.emitted.find(e => e.event === 'debug_pong');
            expect(pong).toBeDefined();
            expect(pong.payload.clientTime).toBeNull();
        });

        test('passes a supplied time through unchanged', () => {
            const socket = fakeSocket();
            handlers.handleDebugPing(socket, { time: 1234 });
            expect(socket.emitted.find(e => e.event === 'debug_pong').payload.clientTime).toBe(1234);
        });
    });

    describe('_onHandlerFault', () => {
        test('reports a generic message and never leaks internals to the client', () => {
            const socket = fakeSocket();
            handlers._onHandlerFault(socket, 'player_move', new Error('ENOENT /srv/secret/path.js'));
            expect(socket.emitted).toHaveLength(1);
            const sent = socket.emitted[0];
            expect(sent.event).toBe('error_message');
            expect(JSON.stringify(sent.payload)).not.toMatch(/ENOENT|secret|stack/i);
        });

        test('survives a socket that can no longer be emitted to', () => {
            const dead = { emit: () => { throw new Error('socket closed'); } };
            expect(() => handlers._onHandlerFault(dead, 'disconnect', new Error('boom'))).not.toThrow();
        });
    });

    describe('safe dispatch', () => {
        test('contains a synchronous throw instead of letting it escape the listener', () => {
            const socket = fakeSocket();
            const wrap = makeSafeDispatch(handlers, socket);
            const listener = wrap('debug_ping', () => { throw new TypeError("Cannot read properties of undefined (reading 'time')"); });
            expect(() => listener(undefined)).not.toThrow();
            expect(socket.emitted[0].event).toBe('error_message');
        });

        test('contains a rejected promise instead of reaching unhandledRejection', async () => {
            const socket = fakeSocket();
            const wrap = makeSafeDispatch(handlers, socket);
            const listener = wrap('tavern_chat', async () => { throw new Error('db down'); });
            listener({});
            await new Promise((r) => setImmediate(r));
            expect(socket.emitted[0].event).toBe('error_message');
        });

        test('leaves a successful handler untouched', async () => {
            const socket = fakeSocket();
            const wrap = makeSafeDispatch(handlers, socket);
            let ran = 0;
            wrap('ok', () => { ran++; })();
            await wrap('ok_async', async () => { ran++; })();
            expect(ran).toBe(2);
            expect(socket.emitted).toHaveLength(0);
        });
    });

    test('every listener in handleConnection is registered through the wrapper, not socket.on', () => {
        const source = require('fs').readFileSync(require.resolve('../src/network/socketHandlers.js'), 'utf8');
        const start = source.indexOf("const on = (event, handler) => {");
        expect(start).toBeGreaterThan(-1);
        const body = source.slice(start);
        // The only permitted raw registration is the one INSIDE the wrapper itself.
        const rawRegistrations = body.match(/socket\.on\(/g) || [];
        expect(rawRegistrations).toHaveLength(1);
        // ...and the wrapper is actually used for a meaningful number of events.
        expect((body.match(/\n\s{8}on\('/g) || []).length).toBeGreaterThan(20);
    });
});
