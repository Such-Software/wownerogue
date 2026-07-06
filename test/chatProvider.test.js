const SocketChatProvider = require('../src/network/chat/SocketChatProvider');

function makeFakeIo() {
    const io = {
        emitted: [],       // { channel|null, event, payload }
        to(channel) {
            return { emit: (event, payload) => io.emitted.push({ channel, event, payload }) };
        },
        emit(event, payload) { io.emitted.push({ channel: null, event, payload }); }
    };
    return io;
}

describe('SocketChatProvider', () => {
    test('global publish persists via history and broadcasts via broadcastManager', async () => {
        const io = makeFakeIo();
        const saved = [];
        const broadcast = [];
        const history = { saveMessage: (m) => { saved.push(m); return Promise.resolve(); } };
        const broadcastManager = {
            broadcastChatMessage: (username, text, ts, socketId) => broadcast.push({ username, text, ts, socketId })
        };
        const provider = new SocketChatProvider({ io, broadcastManager, historyManager: history });

        await provider.publish({ scope: 'global', username: 'abc123', text: 'hi', ts: 42, socketId: 'sock', userId: 7 });

        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ socketId: 'sock', username: 'abc123', message: 'hi', userId: 7 });
        expect(broadcast).toHaveLength(1);
        expect(broadcast[0]).toEqual({ username: 'abc123', text: 'hi', ts: 42, socketId: 'sock' });
    });

    test('global publish falls back to io.emit when no broadcastManager is given', async () => {
        const io = makeFakeIo();
        const provider = new SocketChatProvider({ io });
        await provider.publish({ scope: 'global', username: 'x', text: 'yo', ts: 1 });
        const ev = io.emitted.find(e => e.event === 'chat_broadcast' && e.channel === null);
        expect(ev).toBeTruthy();
        expect(ev.payload).toMatchObject({ username: 'x', message: 'yo', timestamp: 1 });
    });

    test('room-scoped publish delivers only to that room and tags the scope', async () => {
        const io = makeFakeIo();
        const provider = new SocketChatProvider({ io });
        await provider.publish({ scope: 'tavern:main', username: 'bob', text: 'hey', ts: 5 });
        const ev = io.emitted.find(e => e.event === 'chat_broadcast');
        expect(ev.channel).toBe('tavern:main');
        expect(ev.payload).toMatchObject({ username: 'bob', message: 'hey', timestamp: 5, scope: 'tavern:main' });
    });

    test('getHistory: global reads the history manager; room scopes are ephemeral', async () => {
        const io = makeFakeIo();
        const history = { getRecentMessages: (n) => Promise.resolve([{ message: 'old', n }]) };
        const provider = new SocketChatProvider({ io, historyManager: history });
        await expect(provider.getHistory({ scope: 'global', limit: 10 })).resolves.toEqual([{ message: 'old', n: 10 }]);
        await expect(provider.getHistory({ scope: 'tavern:main' })).resolves.toEqual([]);
    });

    test('an injected history manager is not shut down by the provider (caller owns it)', async () => {
        const io = makeFakeIo();
        let shut = false;
        const history = { shutdown: () => { shut = true; } };
        const provider = new SocketChatProvider({ io, historyManager: history });
        await provider.shutdown();
        expect(shut).toBe(false);
    });
});
