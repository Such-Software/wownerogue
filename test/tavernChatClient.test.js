const fs = require('fs');
const vm = require('vm');

function client(wallet) {
    const html = fs.readFileSync(require.resolve('../html/tavern.html'), 'utf8');
    // Execute the page's actual chat wiring with a small DOM, without booting renderers/network.
    const script = html.slice(html.indexOf('// ---- Chat '), html.indexOf('// ---- Input '));
    const handlers = {};
    const elements = [];
    const form = {};
    const context = {
        socket: { on: (name, fn) => { handlers[name] = fn; }, emit: jest.fn() },
        window: { smirk: wallet }, state: { channel: 'tavern:main', occupants: [
            { id: 'same-prefix-one', name: 'Same name' }, { id: 'same-prefix-two', name: 'Same name' }
        ] }, tavernLife: { showPlayerBubble: jest.fn() },
        chatInput: { value: 'hello' }, chatForm: { addEventListener: (_, fn) => { form.submit = fn; } },
        chatLog: { appendChild: el => elements.push(el), childElementCount: 0 },
        document: { createElement: () => ({ firstChild: {}, insertAdjacentHTML() {} }) }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../html/js/smirkChatSign.js'), 'utf8'), context);
    vm.runInContext(script, context);
    return { ...context, handlers, form, elements };
}

test('only room speech targets an exact occupant, never global names/prefixes or history', () => {
    const c = client();
    c.handlers.chat_broadcast({ username: 'Same name', message: 'remote', publicId: 'same-prefix' });
    c.handlers.chat_history({ messages: [{ username: 'Same name', message: 'old' }] });
    expect(c.tavernLife.showPlayerBubble).not.toHaveBeenCalled();
    c.handlers.tavern_speech({ occupantId: 'same-prefix', text: 'guess' });
    expect(c.tavernLife.showPlayerBubble).not.toHaveBeenCalled();
    c.handlers.tavern_speech({ occupantId: 'same-prefix-two', text: '<hello> & welcome' });
    expect(c.tavernLife.showPlayerBubble).toHaveBeenCalledWith('same-prefix-two', '<hello> & welcome');
});

test('a declined signature never becomes unsigned chat or an optimistic bubble', async () => {
    const c = client({ signNostrEvent: async () => { throw Object.assign(new Error('declined'), { code: 'USER_REJECTED' }); } });
    c.form.submit({ preventDefault() {} });
    await new Promise(setImmediate);
    expect(c.socket.emit).not.toHaveBeenCalled();
    expect(c.tavernLife.showPlayerBubble).not.toHaveBeenCalled();
    expect(c.elements.some(el => /not sent/i.test(el.textContent))).toBe(true);
});

test('without a signer ordinary chat still waits for server acceptance', () => {
    const c = client();
    c.form.submit({ preventDefault() {} });
    expect(c.socket.emit).toHaveBeenCalledWith('tavern_chat', { text: 'hello' });
    expect(c.tavernLife.showPlayerBubble).not.toHaveBeenCalled();
});


test('server moderation/verification refusal is visible without speech', () => {
    const c = client();
    c.handlers.status_update({ type: 'error', message: 'Signed message could not be verified.' });
    expect(c.elements.some(el => /verified/.test(el.textContent))).toBe(true);
    expect(c.tavernLife.showPlayerBubble).not.toHaveBeenCalled();
});


test('actual Tavern join wires 3D bubble projection to the current renderer, with safe fallback', () => {
    const html = fs.readFileSync(require.resolve('../html/tavern.html'), 'utf8');
    const script = html.slice(html.indexOf("socket.on('tavern_joined'"), html.indexOf("socket.on('blockheight'"));
    let joined;
    let options;
    const element = { classList: { add() {}, remove() {} }, setAttribute() {} };
    const context = {
        socket: { on: (_, fn) => { joined = fn; } }, state: {}, currentScene: {}, currentMode: '3d',
        currentRenderer: { projectEntityHead: jest.fn(() => ({ x: 50, y: 70 })) },
        RK: { loadMode: () => '3d', TavernLife: function (_host, _scene, _cell, opts) {
            options = opts;
            return { setMode() {}, spawn() {}, welcomeBubbles() {} };
        } },
        clearJoinAttempt() {}, applyFull() {}, rebuildScene() {}, buildModebar() {}, setMode() {},
        mountChainAmbience() {}, startRafLoop() {}, setStatus() {},
        joinPanel: element, modebar: element, stageEl: element, chatPanel: element,
        tavernDpad: element, movementHint: element, watchGamesBtn: element
    };
    vm.createContext(context);
    vm.runInContext(script, context);
    joined({ you: 'speaker', state: {} });
    expect(options.projectEntityHead({ id: 'speaker' })).toEqual({ x: 50, y: 70 });
    expect(context.currentRenderer.projectEntityHead).toHaveBeenCalledWith('speaker');
    const replacement = { projectEntityHead: jest.fn(() => null) };
    context.currentRenderer = replacement;
    expect(options.projectEntityHead({ id: 'speaker' })).toBeNull();
    expect(replacement.projectEntityHead).toHaveBeenCalledWith('speaker');
    context.currentRenderer = {};
    expect(options.projectEntityHead({ id: 'speaker' })).toBeNull();
});
