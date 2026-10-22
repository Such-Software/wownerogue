const TavernManager = require('../src/network/tavernManager');
const ChatHandler = require('../src/network/chatHandler');
const ChatHistoryManager = require('../src/network/chatHistoryManager');
const SocketChatProvider = require('../src/network/chat/SocketChatProvider');
const { loadNostrTools } = require('../src/utils/nostrLoader');
const { finalizeEvent } = loadNostrTools();

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture({ db = null, moderation = null, provider = null } = {}) {
    const io = { emitted: [], emit(event, payload) { this.emitted.push({ event, payload, channel: null }); },
        to(channel) { return { emit: (event, payload) => this.emitted.push({ event, payload, channel }) }; } };
    const socket = { id: 'shared-prefix-speaker', emit: jest.fn(), join() {}, leave() {} };
    const sessions = new Map([[socket.id, { id: 7 }]]);
    const gameModeManager = { db, sessionManager: { sessions }, getOrCreateUser: jest.fn(async () => ({ id: 7 })) };
    const history = new ChatHistoryManager({ db });
    const local = provider || new SocketChatProvider({ io });
    const manager = new TavernManager({ io, globalChatProvider: local, chatModeration: moderation || {
        sessionManager: gameModeManager.sessionManager, chatHistory: history, getOrCreateUser: gameModeManager.getOrCreateUser
    } });
    manager.enabled = true;
    const handler = new ChatHandler({ io, db, gameModeManager, debugManager: {}, rateLimiter: { checkLimit: async () => ({ allowed: true }), recordAttempt: async () => {} }, broadcastManager: { sendStatusUpdate: jest.fn() } });
    handler.chatProvider = local;
    return { io, socket, manager, handler, sessions, speech: () => io.emitted.filter(e => e.event === 'tavern_speech') };
}
const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
function signed(text = 'Signed <hello> & welcome') {
    return finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), content: text, tags: [['t', 'wowngeon-global']] }, secret);
}
function database({ banned = false, banFailure = false } = {}) {
    return { query: jest.fn(async sql => {
        if (sql.includes('SELECT chat_banned')) {
            if (banFailure) throw new Error('fixture moderation unavailable');
            return { rows: [{ chat_banned: banned }] };
        }
        return { rows: [{ smirk_public_key: signed().pubkey, display_name: 'Same name' }] };
    }) };
}

afterEach(() => jest.restoreAllMocks());

test('accepted ordinary speech is room-scoped, exact occupant, plain text; global delivery has no raw ID', async () => {
    const f = fixture({ db: database() });
    try {
        await f.manager.join(f.socket, { name: 'Same name' });
        await f.manager.join({ ...f.socket, id: 'shared-prefix-other' }, { name: 'Same name' });
        await f.manager.chat(f.socket, { text: '<hello> & welcome' });
        expect(f.speech()).toEqual([{ channel: f.manager.channel, event: 'tavern_speech', payload: {
            occupantId: f.socket.id, text: '<hello> & welcome'
        } }]);
        const global = f.io.emitted.find(e => e.event === 'chat_broadcast');
        expect(global.channel).toBeNull();
        expect(global.payload.message).toBe('&lt;hello&gt; &amp; welcome');
        expect(JSON.stringify(global.payload)).not.toContain(f.socket.id);
    } finally { f.handler.shutdown(); }
});

test('publish acceptance is awaited; leave/rejoin while publishing cannot speak for the replacement', async () => {
    const pending = deferred();
    let deliver;
    const f = fixture({ db: database(), provider: { publish: jest.fn(message => { deliver = message.onLocalDelivery; return pending.promise; }) } });
    try {
        await f.manager.join(f.socket, { name: 'Same name' });
        const sending = f.manager.chat(f.socket, { text: 'stale' });
        await new Promise(setImmediate);
        expect(f.speech()).toEqual([]);
        f.manager.leave(f.socket);
        await f.manager.join(f.socket, { name: 'Same name' });
        deliver();
        pending.resolve();
        await sending;
        expect(f.speech()).toEqual([]);
    } finally { f.handler.shutdown(); }
});

test.each(['banned', 'ban database failure', 'user lookup failure', 'publish failure', 'rate limited', 'rate lookup failure'])(
    'ordinary rejected message has no speech: %s', async reason => {
        const f = fixture({ db: database({ banned: reason === 'banned', banFailure: reason === 'ban database failure' }) });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        if (reason === 'user lookup failure') f.manager.chatModeration.getOrCreateUser = async () => { throw new Error('lookup unavailable'); };
        if (reason === 'publish failure') f.manager.globalChatProvider.publish = async () => { throw new Error('publish unavailable'); };
        if (reason === 'rate lookup failure') f.manager.chatModeration.rateLimiter = { checkLimit: async () => { throw new Error('limiter unavailable'); } };
        if (reason === 'rate limited') f.manager.chatModeration.rateLimiter = { checkLimit: async () => ({ allowed: false }) };
        try {
            await f.manager.join(f.socket, { name: 'Speaker' });
            await f.manager.chat(f.socket, { text: 'not accepted' }).catch(() => {});
            expect(f.speech()).toEqual([]);
            expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toEqual([]);
        } finally { f.handler.shutdown(); }
    });

test('valid signed speech uses authenticated content and the current room occupant', async () => {
    const f = fixture({ db: database() });
    try {
        await f.manager.join(f.socket, { name: 'Different avatar label' });
        await f.handler.handleSignedChatMessage(f.socket, { event: signed() }, f.manager.captureSpeech(f.socket));
        expect(f.speech()[0]).toMatchObject({ channel: f.manager.channel, payload: { occupantId: f.socket.id, text: signed().content } });
    } finally { f.handler.shutdown(); }
});

test.each(['bad signature', 'banned', 'ban database failure', 'session changed', 'left room', 'publish failure', 'rate limited'])(
    'signed rejection/stale acceptance has no bubble: %s', async reason => {
        const f = fixture({ db: database({ banned: reason === 'banned', banFailure: reason === 'ban database failure' }) });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        if (reason === 'rate limited') f.handler.rateLimiter = { checkLimit: async () => ({ allowed: false }) };
        try {
            await f.manager.join(f.socket, { name: 'Speaker' });
            const accept = f.manager.captureSpeech(f.socket);
            if (reason === 'session changed' || reason === 'left room' || reason === 'publish failure') {
                f.handler.chatProvider.relaySignedEvent = async (message) => {
                    if (reason === 'session changed') f.sessions.set(f.socket.id, { id: 9 });
                    if (reason === 'left room') { f.manager.leave(f.socket); await f.manager.join(f.socket, { name: 'Speaker' }); }
                    if (reason === 'publish failure') throw new Error('publish unavailable');
                    message.onLocalDelivery();
                };
            }
            const event = signed();
            if (reason === 'bad signature') event.content += 'tampered';
            await f.handler.handleSignedChatMessage(f.socket, { event }, accept);
            expect(f.speech()).toEqual([]);
        } finally { f.handler.shutdown(); }
    });


test.each(['chat message', 'chat_signed'])('real socket dispatch binds current room speech: %s', async eventName => {
    const SocketHandlers = require('../src/network/socketHandlers');
    const f = fixture({ db: database() });
    const callbacks = new Map();
    f.socket.on = (event, fn) => callbacks.set(event, fn);
    const dispatch = Object.assign(Object.create(SocketHandlers.prototype), {
        connectionHandler: { handleConnection: async () => ({}) },
        _emitFairnessOffer() {}, _emitIdentity: async () => {},
        tavernManager: f.manager, chatHandler: f.handler
    });
    f.handler.addressManager = { detectInText: () => null };
    f.handler.sendChatHistoryToUser = async () => {};
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        await dispatch.handleConnection(f.socket);
        callbacks.get(eventName)(eventName === 'chat_signed' ? { event: signed() } : 'ordinary hello');
        await new Promise(setImmediate);
        expect(f.speech()[0]).toMatchObject({ channel: f.manager.channel, payload: { occupantId: f.socket.id } });
    } finally { f.handler.shutdown(); }
});

test('session replacement during ordinary publish suppresses the captured bubble', async () => {
    const f = fixture({ db: database() });
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        f.manager.globalChatProvider.publish = async message => { f.sessions.set(f.socket.id, { id: 8 }); message.onLocalDelivery(); };
        await f.manager.chat(f.socket, { text: 'old session' });
        expect(f.speech()).toEqual([]);
    } finally { f.handler.shutdown(); }
});

test('leaving during moderation cannot publish for a new visit on the same socket', async () => {
    const f = fixture({ db: database() });
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        f.manager.chatModeration.getOrCreateUser = async () => {
            f.manager.leave(f.socket);
            await f.manager.join(f.socket, { name: 'Speaker' });
            return { id: 7 };
        };
        await f.manager.chat(f.socket, { text: 'old visit' });
        expect(f.speech()).toEqual([]);
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toEqual([]);
    } finally { f.handler.shutdown(); }
});

test.each([undefined, null, 0, 'false'])('strict real ban reader refuses unknown/malformed status: %p', async chat_banned => {
    const history = new ChatHistoryManager({ db: { query: async () => ({ rows: [{ chat_banned }] }) } });
    await expect(history.isUserChatBanned(7, { strict: true })).rejects.toThrow();
});

test('ephemeral Tavern without global moderation still delivers accepted room speech', async () => {
    const f = fixture();
    f.manager.globalChatProvider = null;
    try {
        await f.manager.join(f.socket, { name: 'Guest' });
        await f.manager.chat(f.socket, { text: 'local only' });
        expect(f.speech()[0]).toMatchObject({ channel: f.manager.channel, payload: { occupantId: f.socket.id, text: 'local only' } });
    } finally { f.handler.shutdown(); }
});


test('deferred moderation admits only one concurrent send and one accepted bubble', async () => {
    const pending = deferred();
    const f = fixture({ db: database() });
    const lookup = jest.fn(() => pending.promise);
    f.manager.chatModeration.getOrCreateUser = lookup;
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const first = f.manager.chat(f.socket, { text: 'first' });
        const second = f.manager.chat(f.socket, { text: 'second' });
        await second;
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toEqual([]);
        pending.resolve({ id: 7 });
        await first;
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast').map(e => e.payload.message)).toEqual(['first']);
        expect(f.speech().map(e => e.payload.text)).toEqual(['first']);
        expect(f.manager._chatInFlight.size).toBe(0);
    } finally { pending.resolve({ id: 7 }); f.handler.shutdown(); }
});

test('session switch during deferred moderation refuses before publishing', async () => {
    const pending = deferred();
    const f = fixture({ db: database() });
    f.manager.chatModeration.getOrCreateUser = () => pending.promise;
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const sending = f.manager.chat(f.socket, { text: 'stale account' });
        f.sessions.set(f.socket.id, { id: 8 });
        pending.resolve({ id: 7 });
        await sending;
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toEqual([]);
        expect(f.speech()).toEqual([]);
        expect(f.manager._chatInFlight.size).toBe(0);
    } finally { pending.resolve({ id: 7 }); f.handler.shutdown(); }
});

test('failed moderation releases admission without suppressing an explicit immediate retry', async () => {
    const f = fixture({ db: database() });
    const lookup = jest.fn().mockRejectedValueOnce(new Error('lookup unavailable')).mockResolvedValue({ id: 7 });
    f.manager.chatModeration.getOrCreateUser = lookup;
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        await f.manager.chat(f.socket, { text: 'refused' });
        await f.manager.chat(f.socket, { text: 'explicit retry' });
        expect(f.speech().map(e => e.payload.text)).toEqual(['explicit retry']);
    } finally { f.handler.shutdown(); }
});

test.each(['ordinary', 'signed'])('local %s speech does not wait for pending/rejected relay or duplicate later', async kind => {
    const NostrChatProvider = require('../src/network/chat/NostrChatProvider');
    let rejectRelay;
    const relay = new Promise((_, reject) => { rejectRelay = reject; });
    relay.catch(() => {});
    const f = fixture({ db: database() });
    const transport = { publish: jest.fn(() => relay) };
    const provider = new NostrChatProvider({ local: new SocketChatProvider({ io: f.io }), transport,
        signer: { sign: template => ({ ...template, id: 'synthetic-bridge-event' }) } });
    f.manager.globalChatProvider = provider;
    f.handler.chatProvider = provider;
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const sending = kind === 'signed'
            ? f.handler.handleSignedChatMessage(f.socket, { event: signed() }, f.manager.captureSpeech(f.socket))
            : f.manager.chat(f.socket, { text: 'immediate local speech' });
        await new Promise(setImmediate);
        expect(transport.publish).toHaveBeenCalled();
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toHaveLength(1);
        expect(f.speech()).toHaveLength(1);
        const localSpeech = f.speech()[0];
        rejectRelay(new Error('disposable relay refuses'));
        await sending;
        expect(f.speech()).toEqual([localSpeech]);
    } finally { rejectRelay(new Error('dispose pending relay')); f.handler.shutdown(); }
});

test('ordinary global session switch during deferred real moderation refuses before local delivery', async () => {
    const pending = deferred();
    const f = fixture({ db: database() });
    f.handler.gameModeManager.getOrCreateUser = () => pending.promise;
    f.handler.addressManager = { detectInText: () => null };
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const sending = f.handler.handleChatMessage(f.socket, 'stale global message', { acceptedSpeech: f.manager.captureSpeech(f.socket) });
        await new Promise(setImmediate);
        f.sessions.set(f.socket.id, { id: 8 });
        pending.resolve({ id: 7 });
        await sending;
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast')).toEqual([]);
        expect(f.speech()).toEqual([]);
    } finally { pending.resolve({ id: 7 }); f.handler.shutdown(); }
});

test('accepted room capability is single-use, including stale callback then restored session', async () => {
    const f = fixture({ db: database() });
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const accepted = f.manager.captureSpeech(f.socket);
        accepted('first');
        accepted('duplicate');
        expect(f.speech().map(e => e.payload.text)).toEqual(['first']);
        const stale = f.manager.captureSpeech(f.socket);
        const originalSession = f.sessions.get(f.socket.id);
        f.sessions.set(f.socket.id, { id: 8 });
        stale('stale');
        f.sessions.set(f.socket.id, originalSession);
        stale('cannot resurrect');
        expect(f.speech().map(e => e.payload.text)).toEqual(['first']);
    } finally { f.handler.shutdown(); }
});

test('an earlier pending relay cannot release a later send admission on the same visit', async () => {
    const NostrChatProvider = require('../src/network/chat/NostrChatProvider');
    const relay = deferred();
    const moderation = deferred();
    const f = fixture({ db: database() });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
    const lookup = jest.fn().mockResolvedValueOnce({ id: 7 }).mockImplementation(() => moderation.promise);
    f.manager.chatModeration.getOrCreateUser = lookup;
    f.manager.globalChatProvider = new NostrChatProvider({ local: new SocketChatProvider({ io: f.io }),
        transport: { publish: jest.fn().mockImplementationOnce(() => relay.promise).mockResolvedValue() },
        signer: { sign: template => ({ ...template, id: 'synthetic-bridge-event' }) } });
    try {
        await f.manager.join(f.socket, { name: 'Speaker' });
        const first = f.manager.chat(f.socket, { text: 'first' });
        await new Promise(setImmediate);
        expect(f.speech().map(e => e.payload.text)).toEqual(['first']);
        clock.mockReturnValue(1800000000000 + f.manager.chatCooldownMs + 1);
        const second = f.manager.chat(f.socket, { text: 'second' });
        expect(lookup).toHaveBeenCalledTimes(2);
        relay.resolve();
        await first;
        const third = f.manager.chat(f.socket, { text: 'third' });
        await new Promise(setImmediate);
        expect(lookup).toHaveBeenCalledTimes(2);
        moderation.resolve({ id: 7 });
        await Promise.all([second, third]);
        expect(f.io.emitted.filter(e => e.event === 'chat_broadcast').map(e => e.payload.message)).toEqual(['first', 'second']);
        expect(f.speech().map(e => e.payload.text)).toEqual(['first', 'second']);
    } finally { relay.resolve(); moderation.resolve({ id: 7 }); f.handler.shutdown(); clock.mockRestore(); }
});
