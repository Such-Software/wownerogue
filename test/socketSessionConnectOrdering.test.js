const fs = require('node:fs');
const vm = require('node:vm');

class SocketFixture {
    constructor() {
        this.connected = false;
        this.id = 'ordering-fixture-socket';
        this.listeners = new Map();
        this.emitted = [];
        this.connectCount = 0;
        this.listenersReadyAtConnect = [];
        this.handshakeAuth = [];
    }

    on(eventName, callback) {
        const callbacks = this.listeners.get(eventName) || [];
        callbacks.push(callback);
        this.listeners.set(eventName, callbacks);
    }

    emit(eventName, payload) {
        this.emitted.push({ eventName, payload });
    }

    deliver(eventName, payload) {
        for (const callback of this.listeners.get(eventName) || []) callback(payload);
    }

    connect(authProvider) {
        if (this.connected) return;
        if (authProvider === undefined) authProvider = this.authProvider;
        let auth = null;
        if (typeof authProvider === 'function') {
            authProvider(payload => { auth = payload; });
        }
        this.handshakeAuth.push(auth);
        this.connected = true;
        this.connectCount += 1;
        this.listenersReadyAtConnect.push(
            ['connect', 'session_token', 'session_resumed'].every(name => this.listeners.has(name))
        );

        // The server can emit session state immediately after the client's connect event.
        this.deliver('connect');
        if (this.connectCount === 1) {
            this.deliver('session_token', { token: 'fixture-session-first', userId: 41 });
        } else if (this.connectCount === 2) {
            this.deliver('session_resumed', { token: 'fixture-session-resumed', userId: 41, credits: 0 });
        } else {
            this.deliver('session_resumed', { token: 'fixture-session-latest', userId: 41, credits: 0 });
        }
    }

    disconnect() {
        if (!this.connected) return;
        this.connected = false;
        this.deliver('disconnect');
    }
}

function makeJQueryStub() {
    return function jqueryStub() {
        const chain = {
            length: 0,
            on() { return this; },
            append() { return this; },
            remove() { return this; },
            hide() { return this; },
            show() { return this; },
            val() { return this; },
            text() { return this; },
            html() { return this; },
            css() { return this; },
            prop() { return this; },
            removeData() { return this; }
        };
        return chain;
    };
}

function loadLobbyClient({ storageUnavailable = false } = {}) {
    const html = fs.readFileSync(require.resolve('../html/index.html'), 'utf8');
    const bootstrap = html.match(/<script>\s*([\s\S]*?)<\/script>/);
    if (!bootstrap) throw new Error('Lobby socket bootstrap script was not found');

    const localValues = new Map();
    const localStorage = {
        getItem: key => {
            if (storageUnavailable) throw new Error('storage unavailable');
            return localValues.get(key) || null;
        },
        setItem: (key, value) => {
            if (storageUnavailable) throw new Error('storage unavailable');
            localValues.set(key, String(value));
        },
        removeItem: key => localValues.delete(key)
    };
    const socket = new SocketFixture();
    let socketOptions = null;
    const context = {
        window: {
            location: { origin: 'https://wowngeon.test' },
            localStorage,
            navigator: { userAgent: 'socket-session-ordering-test' }
        },
        document: {
            addEventListener() {},
            getElementById() { return null; }
        },
        localStorage,
        navigator: { userAgent: 'socket-session-ordering-test' },
        io(options) {
            socketOptions = options;
            socket.authProvider = options.auth;
            if (options.autoConnect !== false) socket.connect(options.auth);
            return socket;
        },
        socket,
        $: makeJQueryStub(),
        UI: { scrollChat() {} },
        console: { log() {}, warn() {}, error() {} },
        fetch: async () => ({ json: async () => ({}) }),
        setTimeout() { return 1; }
    };
    vm.createContext(context);
    vm.runInContext(bootstrap[1], context, { filename: 'html/index.html#socket-bootstrap' });
    vm.runInContext(
        `${fs.readFileSync(require.resolve('../html/js/network/socketHandlers'), 'utf8')}\nthis.socketHandlers = SocketHandlers;`,
        context,
        { filename: 'html/js/network/socketHandlers.js' }
    );
    return { context, localValues, socket, socketOptions };
}

describe('lobby socket session event ordering', () => {
    test('registers session listeners before connecting and restores the token on reconnect', () => {
        const { context, localValues, socket, socketOptions } = loadLobbyClient();

        expect(socketOptions.autoConnect).toBe(false);
        expect(socket.connected).toBe(false);
        context.socketHandlers.init();

        expect(socket.listenersReadyAtConnect).toEqual([true]);
        expect(socket.handshakeAuth).toEqual([{}]);
        expect(context.socketHandlers._sessionUserId).toBe(41);
        expect(localValues.get('wownerogue_token')).toBe('fixture-session-first');
        expect(socket.emitted.filter(event => event.eventName === 'register_client')).toHaveLength(1);

        context.socketHandlers.init();
        expect(socket.connectCount).toBe(1);
        expect(socket.emitted.filter(event => event.eventName === 'register_client')).toHaveLength(1);

        socket.disconnect();
        expect(context.socketHandlers._sessionUserId).toBeNull();
        socket.connect(socketOptions.auth);

        expect(socket.listenersReadyAtConnect).toEqual([true, true]);
        expect(socket.handshakeAuth).toEqual([{}, { resumeToken: 'fixture-session-first' }]);
        expect(context.socketHandlers._sessionUserId).toBe(41);
        expect(localValues.get('wownerogue_token')).toBe('fixture-session-resumed');
        expect(socket.emitted.filter(event => event.eventName === 'register_client')).toHaveLength(2);

        socket.disconnect();
        socket.connect(socketOptions.auth);
        expect(socket.handshakeAuth).toEqual([
            {},
            { resumeToken: 'fixture-session-first' },
            { resumeToken: 'fixture-session-resumed' }
        ]);
        expect(localValues.get('wownerogue_token')).toBe('fixture-session-latest');
        expect(socket.emitted.filter(event => event.eventName === 'register_client')).toHaveLength(3);
    });

    test('leaves session resume disabled when storage is unavailable', () => {
        const { context, socket, socketOptions } = loadLobbyClient({ storageUnavailable: true });

        expect(socketOptions.auth).toBeUndefined();
        context.socketHandlers.init();

        expect(socket.connected).toBe(true);
        expect(socket.handshakeAuth).toEqual([null]);
        expect(context.socketHandlers._sessionUserId).toBe(41);
    });
});
