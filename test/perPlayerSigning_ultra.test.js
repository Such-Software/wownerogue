/**
 * Phase 2 — per-player nostr identity: verify client-signed chat events, relay them under the
 * player's own npub, and let a premium subscription unlock cosmetic tiers.
 */
const { verifyChatEvent } = require('../src/utils/verifyChatEvent');
const { loadNostrTools } = require('../src/utils/nostrLoader');
const NostrChatProvider = require('../src/network/chat/NostrChatProvider');
const ChatProvider = require('../src/network/chat/ChatProvider');
const Entitlements = require('../src/multiplayer/entitlements');

const tools = loadNostrTools();
function signedEvent({ sk, content = 'gm', tag = 'wowngeon-global', kind = 1, created_at } = {}) {
    return tools.finalizeEvent({
        kind,
        created_at: created_at || Math.floor(Date.now() / 1000),
        tags: [['t', tag]],
        content
    }, sk);
}

describe('verifyChatEvent', () => {
    const sk = tools.generateSecretKey();
    const pub = tools.getPublicKey(sk);

    test('accepts an authentic event signed by the expected npub', () => {
        const v = verifyChatEvent(signedEvent({ sk, content: 'hello world' }), { expectedPubkey: pub });
        expect(v.ok).toBe(true);
        expect(v.pubkey).toBe(pub);
        expect(v.content).toBe('hello world');
    });

    test('rejects a valid event signed by a DIFFERENT key (impersonation)', () => {
        const otherPub = tools.getPublicKey(tools.generateSecretKey());
        const v = verifyChatEvent(signedEvent({ sk }), { expectedPubkey: otherPub });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('pubkey-mismatch');
    });

    test('rejects a tampered event (content changed after signing)', () => {
        const ev = signedEvent({ sk, content: 'original' });
        ev.content = 'tampered';
        expect(verifyChatEvent(ev, { expectedPubkey: pub }).reason).toBe('id-mismatch');
    });

    test('rejects the wrong channel tag', () => {
        const v = verifyChatEvent(signedEvent({ sk, tag: 'some-other-room' }), { expectedPubkey: pub });
        expect(v.reason).toBe('wrong-channel');
    });

    test('rejects a stale event', () => {
        const v = verifyChatEvent(signedEvent({ sk, created_at: Math.floor(Date.now() / 1000) - 9999 }), { expectedPubkey: pub });
        expect(v.reason).toBe('expired');
    });

    test('rejects wrong kind and over-length content', () => {
        expect(verifyChatEvent(signedEvent({ sk, kind: 4 }), { expectedPubkey: pub }).reason).toBe('wrong-kind');
        expect(verifyChatEvent(signedEvent({ sk, content: 'x'.repeat(400) }), { expectedPubkey: pub, maxLen: 280 }).reason).toBe('too-long');
    });

    test('requires an expected pubkey', () => {
        expect(verifyChatEvent(signedEvent({ sk }), {}).reason).toBe('no-expected-pubkey');
    });
});

describe('relaySignedEvent', () => {
    function fakeLocal() {
        return { initialize: jest.fn().mockResolvedValue(), publish: jest.fn().mockResolvedValue(), getHistory: jest.fn(), shutdown: jest.fn() };
    }
    function fakeTransport() {
        return { publish: jest.fn().mockResolvedValue(), subscribe: jest.fn(function (f, cb) { this.onEvent = cb; }), close: jest.fn() };
    }

    test('NostrChatProvider delivers in-game AND relays the pre-signed event without re-signing', async () => {
        const local = fakeLocal(), transport = fakeTransport();
        const p = new NostrChatProvider({ local, transport, signer: { pubkey: 'aa'.repeat(32), sign: () => { throw new Error('should not sign'); } } });
        const event = { id: 'evt-42', pubkey: 'bb'.repeat(32), sig: 'x', kind: 1, content: 'gm', tags: [] };
        await p.relaySignedEvent({ event, username: 'alice', text: 'gm', ts: 1700000000000 });

        expect(local.publish).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', username: 'alice', text: 'gm' }));
        expect(transport.publish).toHaveBeenCalledWith(event); // the client-signed event, verbatim
    });

    test('the relayed event echoing back from the relay is deduped (not re-delivered)', async () => {
        const local = fakeLocal(), transport = fakeTransport();
        const p = new NostrChatProvider({ local, transport, signer: { pubkey: 'aa'.repeat(32), sign: () => ({}) } });
        await p.initialize();
        const event = { id: 'evt-echo', pubkey: 'bb'.repeat(32), sig: 'x', kind: 1, content: 'gm', tags: [] };
        await p.relaySignedEvent({ event, username: 'alice', text: 'gm' });
        local.publish.mockClear();
        transport.onEvent(event); // relay echoes our own published event back
        expect(local.publish).not.toHaveBeenCalled(); // markSeen dropped it
    });

    test('the base ChatProvider relaySignedEvent just delivers locally (no relay)', async () => {
        const base = new ChatProvider();
        base.publish = jest.fn().mockResolvedValue();
        await base.relaySignedEvent({ event: { id: 'x' }, username: 'a', text: 'hi' });
        expect(base.publish).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', username: 'a', text: 'hi' }));
        expect(base.publish.mock.calls[0][0].event).toBeUndefined(); // signed event not forwarded to a non-relay provider
    });
});

describe('premium subscription unlocks cosmetic tiers', () => {
    test('an active premium sub sets the tier and unlocks tier-1 packs — no purchase needed', () => {
        const free = Entitlements.snapshotForUser({ credits: 0, total_credits_purchased: 0 });
        expect(free.tier).toBe(0);
        expect(free.packs['generated-skins']).toBe(false); // tier-1 pack locked for free

        const premium = Entitlements.snapshotForUser({ subscription_tier: 'premium', total_credits_purchased: 0 });
        expect(premium.level).toBe('premium');
        expect(premium.tier).toBe(2);
        expect(premium.packs['generated-skins']).toBe(true); // tier-1 pack unlocked by the sub
        expect(premium.premium).toBe(true);
    });

    test('buying credits still does NOT put you on the premium ladder', () => {
        const snap = Entitlements.snapshotForUser({ subscription_tier: 'credits', total_credits_purchased: 50 });
        expect(snap.level).toBe('free');
        expect(snap.tier).toBe(0);
    });

    test('the higher of stored level and subscription tier wins', () => {
        const snap = Entitlements.snapshotForUser({ premium_level: 'supporter', subscription_tier: 'operator' });
        expect(snap.level).toBe('operator');
        expect(snap.tier).toBe(3);
    });
});
