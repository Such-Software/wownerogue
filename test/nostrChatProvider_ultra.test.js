/**
 * Pillar 5 — global cross-server chat over nostr, layered on the ChatProvider seam.
 */
const NostrChatProvider = require('../src/network/chat/NostrChatProvider');
const { buildChatProvider } = require('../src/network/chat');
const { createBridgeSigner } = require('../src/network/chat/nostr/bridgeSigner');
const { loadNostrTools } = require('../src/utils/nostrLoader');

function fakeLocal() {
    return {
        initialize: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
        getHistory: jest.fn().mockResolvedValue(['history']),
        shutdown: jest.fn().mockResolvedValue()
    };
}
function fakeTransport() {
    return {
        publish: jest.fn().mockResolvedValue(),
        subscribe: jest.fn(function (filters, onEvent) { this.filters = filters; this.onEvent = onEvent; }),
        close: jest.fn()
    };
}
let _n = 0;
function fakeSigner(pubkey = 'ab'.repeat(32)) {
    return { pubkey, sign: (tpl) => ({ ...tpl, id: `evt-${++_n}`, pubkey, sig: 'sig' }) };
}

describe('NostrChatProvider decorates the local provider', () => {
    test('publish always delivers locally; getHistory/shutdown delegate', async () => {
        const local = fakeLocal();
        const p = new NostrChatProvider({ local }); // no transport/signer
        await p.publish({ scope: 'global', username: 'bob', text: 'hi' });
        expect(local.publish).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }));
        expect(await p.getHistory({ scope: 'global' })).toEqual(['history']);
        await p.shutdown();
        expect(local.shutdown).toHaveBeenCalled();
    });

    test('global message is signed and fanned out to the relay', async () => {
        const local = fakeLocal(), transport = fakeTransport(), signer = fakeSigner();
        const p = new NostrChatProvider({ local, transport, signer, channelTag: 'wowngeon-global', kind: 1 });
        await p.publish({ scope: 'global', username: 'bob', text: 'gm', ts: 1_700_000_000_000 });

        expect(local.publish).toHaveBeenCalled();
        expect(transport.publish).toHaveBeenCalledTimes(1);
        const ev = transport.publish.mock.calls[0][0];
        expect(ev.kind).toBe(1);
        expect(ev.content).toBe('gm');
        expect(ev.tags).toEqual(expect.arrayContaining([['t', 'wowngeon-global'], ['n', 'bob']]));
        expect(ev.created_at).toBe(1_700_000_000); // ms -> s
    });

    test('room-scoped and remote messages are NOT fanned out', async () => {
        const local = fakeLocal(), transport = fakeTransport(), signer = fakeSigner();
        const p = new NostrChatProvider({ local, transport, signer });
        await p.publish({ scope: 'tavern:1', username: 'x', text: 'local only' });
        await p.publish({ scope: 'global', username: 'x', text: 'echo', remote: true });
        expect(local.publish).toHaveBeenCalledTimes(2);
        expect(transport.publish).not.toHaveBeenCalled();
    });
});

describe('NostrChatProvider receives remote messages', () => {
    function connected() {
        const local = fakeLocal(), transport = fakeTransport(), signer = fakeSigner();
        const p = new NostrChatProvider({ local, transport, signer, now: () => 1_700_000_000_000 });
        return { local, transport, signer, p };
    }

    test('a remote event is delivered locally-only, escaped, never re-published', async () => {
        const { local, transport, p } = connected();
        await p.initialize();
        expect(transport.subscribe).toHaveBeenCalled();
        p.onEvent = transport.onEvent; // convenience
        transport.onEvent({ id: 'r1', pubkey: 'cc'.repeat(32), created_at: 1_700_000_000, content: '<b>hi</b>', tags: [['t', 'wowngeon-global'], ['n', 'alice']] });

        expect(local.publish).toHaveBeenCalledWith(expect.objectContaining({
            scope: 'global', username: 'alice', text: '&lt;b&gt;hi&lt;/b&gt;', remote: true
        }));
        expect(transport.publish).not.toHaveBeenCalled(); // no echo loop
    });

    test('our own echoes and duplicate ids are dropped', async () => {
        const { local, transport, signer, p } = connected();
        await p.initialize();
        transport.onEvent({ id: 'mine', pubkey: signer.pubkey, content: 'x', tags: [] }); // our pubkey -> drop
        transport.onEvent({ id: 'dup', pubkey: 'cc'.repeat(32), content: 'first', tags: [] });
        transport.onEvent({ id: 'dup', pubkey: 'cc'.repeat(32), content: 'again', tags: [] }); // same id -> drop
        expect(local.publish).toHaveBeenCalledTimes(1);
    });

    test('remote delivery is rate-limited', async () => {
        const local = fakeLocal(), transport = fakeTransport();
        const p = new NostrChatProvider({ local, transport, signer: fakeSigner(), maxRemotePerMin: 2, now: () => 1000 });
        await p.initialize();
        for (let i = 0; i < 5; i++) transport.onEvent({ id: `x${i}`, pubkey: 'dd'.repeat(32), content: 'spam', tags: [] });
        expect(local.publish).toHaveBeenCalledTimes(2); // capped
    });
});

describe('buildChatProvider (opt-in seam)', () => {
    const local = fakeLocal();
    test('disabled -> returns the local provider unchanged (behavior-preserving)', () => {
        expect(buildChatProvider({ local, env: {} })).toBe(local);
    });
    test('scope=local -> returns the plain local provider', () => {
        expect(buildChatProvider({ local, env: { NOSTR_CHAT_ENABLED: 'true', NOSTR_CHAT_SCOPE: 'local' } })).toBe(local);
    });
    test('scope=global -> wraps in a NostrChatProvider', () => {
        const p = buildChatProvider({ local, env: { NOSTR_CHAT_ENABLED: 'true', NOSTR_RELAYS: 'wss://relay.smirk.cash' } });
        expect(p).toBeInstanceOf(NostrChatProvider);
    });
});

describe('bridge signer (real nostr-tools round-trip)', () => {
    test('null key -> no signer; a real key signs a verifiable event', () => {
        expect(createBridgeSigner(null)).toBeNull();
        const tools = loadNostrTools();
        const sk = tools.generateSecretKey();
        const hex = Buffer.from(sk).toString('hex');
        const signer = createBridgeSigner(hex);
        expect(signer.pubkey).toBe(tools.getPublicKey(sk));
        const ev = signer.sign({ kind: 1, tags: [['t', 'wowngeon-global']], content: 'hello' });
        expect(tools.verifyEvent(ev)).toBe(true);
        expect(ev.content).toBe('hello');
    });
});
