// TavernManager tests. The manager owns transport + the server tick; we drive it with a
// fake Socket.IO io/socket so no real server or network is involved.

function makeFakeIo() {
    const io = {
        emitted: [], // { channel, event, payload }
        sockets: { sockets: new Map() },
        to(channel) {
            return { emit: (event, payload) => io.emitted.push({ channel, event, payload }) };
        }
    };
    return io;
}

function makeFakeSocket(id, io) {
    const socket = {
        id,
        joined: new Set(),
        emitted: [], // { event, payload }
        join(ch) { this.joined.add(ch); },
        leave(ch) { this.joined.delete(ch); },
        emit(event, payload) { this.emitted.push({ event, payload }); }
    };
    if (io) io.sockets.sockets.set(id, socket);
    return socket;
}

function loadManager() {
    // enabled is read from env in the constructor.
    jest.resetModules();
    return require('../src/network/tavernManager');
}

describe('TavernManager', () => {
    const prev = process.env.TAVERN_ENABLED;
    afterAll(() => { process.env.TAVERN_ENABLED = prev; });

    test('is inert and refuses joins when TAVERN_ENABLED is not set', async () => {
        delete process.env.TAVERN_ENABLED;
        const TavernManager = loadManager();
        const io = makeFakeIo();
        const mgr = new TavernManager({ io });
        mgr.initialize(); // must not start a timer
        expect(mgr._tickInterval).toBeNull();

        const s = makeFakeSocket('a', io);
        const res = await mgr.join(s, { name: 'Alice' });
        expect(res.success).toBe(false);
        expect(s.emitted.some(e => e.event === 'tavern_error')).toBe(true);
        expect(mgr.room.size).toBe(0);
    });

    describe('when enabled', () => {
        let TavernManager;
        beforeAll(() => { process.env.TAVERN_ENABLED = 'true'; });
        beforeEach(() => { TavernManager = loadManager(); });

        test('join adds an occupant and sends full state (with the map) to the joiner', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);

            const res = await mgr.join(s, { name: 'Alice', avatar: 'green' });
            expect(res.success).toBe(true);
            expect(mgr.room.size).toBe(1);
            expect(s.joined.has(mgr.channel)).toBe(true);

            const joined = s.emitted.find(e => e.event === 'tavern_joined');
            expect(joined).toBeTruthy();
            expect(joined.payload.you).toBe('a');
            expect(Array.isArray(joined.payload.state.layout)).toBe(true);
            expect(joined.payload.state.occupants.map(o => o.id)).toEqual(['a']);
        });

        test('join preserves structured character appearance', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            const appearance = {
                avatar: 'char-ranger',
                tint: 'teal',
                equipment: { body: 'mail', head: 'hood', shield: 'round', weapon: 'bow' },
                colors: { base: 'teal', skin: 'warm', hair: 'silver', body: 'gold', head: 'none', shield: 'rose', weapon: 'none' }
            };

            await mgr.join(s, { name: 'Alice', avatar: 'green', appearance });
            const occ = mgr.room.getOccupant('a');
            expect(occ.avatar).toBe('char-ranger');
            expect(occ.appearance).toEqual(appearance);

            const joined = s.emitted.find(e => e.event === 'tavern_joined');
            expect(joined.payload.state.occupants[0].appearance).toEqual(appearance);
        });

        test('appearance is normalized and names are sanitized', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, {
                name: '  <b>Ann</b>  ',
                avatar: 'rainbow',
                appearance: {
                    avatar: 'char-ranger',
                    tint: 'bad',
                    equipment: { body: 'mail', head: 'bad', shield: 'round', weapon: 'laser' },
                    colors: { base: 'violet', skin: 'bad', hair: 'black', body: 'gold', head: 'bad', shield: 'rose', weapon: 'bad' }
                }
            });
            const occ = mgr.room.getOccupant('a');
            expect(occ.avatar).toBe('char-ranger');
            expect(occ.appearance).toEqual({
                avatar: 'char-ranger',
                tint: 'violet',
                equipment: { body: 'mail', head: 'none', shield: 'round', weapon: 'none' },
                colors: { base: 'violet', skin: 'natural', hair: 'black', body: 'gold', head: 'none', shield: 'rose', weapon: 'none' }
            });
            expect(occ.name).not.toMatch(/[<>]/);
            expect(occ.name.length).toBeLessThanOrEqual(16);
        });

        test('premium avatars require a premium entitlement', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, { appearance: { avatar: 'monero-knight' } });
            expect(mgr.room.getOccupant('a').avatar).toBe('default');

            const paid = new TavernManager({
                io,
                entitlementProvider: async () => ({ premium: true, totalCreditsPurchased: 10 })
            });
            const s2 = makeFakeSocket('b', io);
            await paid.join(s2, { appearance: { avatar: 'monero-knight' } });
            expect(paid.room.getOccupant('b').avatar).toBe('monero-knight');
        });

        test('move is server-authoritative and honours the flood cooldown', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, {});
            const occ = mgr.room.getOccupant('a');
            const startX = occ.x;

            mgr.move(s, { dir: 'right' });
            expect(occ.x).toBe(startX + 1);

            // Immediate second move is dropped by the cooldown.
            mgr.move(s, { dir: 'right' });
            expect(occ.x).toBe(startX + 1);
        });

        test('the tick broadcasts a snapshot to the room when occupied', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, {});
            io.emitted.length = 0;

            mgr._tick();
            const update = io.emitted.find(e => e.event === 'tavern_update' && e.channel === mgr.channel);
            expect(update).toBeTruthy();
            expect(update.payload.occupants.map(o => o.id)).toEqual(['a']);
        });

        test('disconnect removes the occupant', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, {});
            expect(mgr.room.size).toBe(1);

            mgr.handleDisconnect('a', s);
            expect(mgr.room.size).toBe(0);
            expect(s.joined.has(mgr.channel)).toBe(false);
        });

        test('chat from an occupant is delivered to the tavern room, HTML-escaped', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, { name: 'Alice' });
            io.emitted.length = 0;

            mgr.chat(s, { text: 'hi <b>there</b>' });
            const ev = io.emitted.find(e => e.event === 'chat_broadcast' && e.channel === mgr.channel);
            expect(ev).toBeTruthy();
            expect(ev.payload.username).toBe('Alice');
            expect(ev.payload.message).toBe('hi &lt;b&gt;there&lt;/b&gt;');
            expect(ev.payload.scope).toBe(mgr.channel);
        });

        test('chat honours the flood cooldown', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const s = makeFakeSocket('a', io);
            await mgr.join(s, {});
            io.emitted.length = 0;
            mgr.chat(s, { text: 'one' });
            s.emitted.length = 0;
            mgr.chat(s, { text: 'two' }); // immediate second is dropped
            const msgs = io.emitted.filter(e => e.event === 'chat_broadcast');
            expect(msgs).toHaveLength(1);
            expect(msgs[0].payload.message).toBe('one');
            // The sender is told, rather than the message vanishing silently.
            expect(s.emitted.some(e => e.event === 'tavern_notice')).toBe(true);
        });

        test('non-occupants and empty messages cannot chat', async () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            const outsider = makeFakeSocket('z', io);
            mgr.chat(outsider, { text: 'sneaky' }); // never joined -> ignored

            const s = makeFakeSocket('a', io);
            await mgr.join(s, {});
            io.emitted.length = 0;
            mgr.chat(s, { text: '   ' }); // whitespace only -> ignored
            expect(io.emitted.filter(e => e.event === 'chat_broadcast')).toHaveLength(0);
        });

        test('shutdown clears the tick timer', () => {
            const io = makeFakeIo();
            const mgr = new TavernManager({ io });
            mgr.initialize();
            expect(mgr._tickInterval).not.toBeNull();
            mgr.shutdown();
            expect(mgr._tickInterval).toBeNull();
        });

        describe('global chat wiring', () => {
            function makeGlobalProvider() {
                return {
                    published: [],
                    publish(msg) { this.published.push(msg); return Promise.resolve(); },
                    getHistory() { return Promise.resolve([{ username: 'bob', message: 'gm all' }]); }
                };
            }

            test('join sends the global chat backlog to the joiner', async () => {
                const io = makeFakeIo();
                const gcp = makeGlobalProvider();
                const mgr = new TavernManager({ io, globalChatProvider: gcp });
                const s = makeFakeSocket('a', io);
                await mgr.join(s, { name: 'Alice' });
                await new Promise(r => setImmediate(r)); // let the history promise resolve
                const hist = s.emitted.find(e => e.event === 'chat_history');
                expect(hist).toBeDefined();
                expect(hist.payload.messages[0].message).toBe('gm all');
            });

            test('chat routes to the GLOBAL scope through the shared provider', async () => {
                const io = makeFakeIo();
                const gcp = makeGlobalProvider();
                const mgr = new TavernManager({ io, globalChatProvider: gcp });
                const s = makeFakeSocket('a', io);
                await mgr.join(s, { name: 'Alice' });
                mgr.chat(s, { text: 'hello world' });
                const sent = gcp.published.find(m => m.text && m.text.indexOf('hello') !== -1);
                expect(sent).toBeDefined();
                expect(sent.scope).toBe('global');
            });

            test('without a global provider, chat stays tavern-scoped (legacy behavior)', async () => {
                const io = makeFakeIo();
                const mgr = new TavernManager({ io }); // no globalChatProvider
                const s = makeFakeSocket('a', io);
                await mgr.join(s, { name: 'Alice' });
                io.emitted.length = 0;
                mgr.chat(s, { text: 'local only' });
                const bc = io.emitted.find(e => e.event === 'chat_broadcast');
                expect(bc).toBeDefined();
                expect(bc.channel).toBe('tavern:main'); // room-scoped, not global
            });
        });
    });
});
