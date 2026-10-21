const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeElement(tag = 'div') {
    const attributes = {};
    const element = {
        tagName: tag.toUpperCase(),
        style: {},
        dataset: {},
        children: [],
        listeners: {},
        attributes,
        disabled: false,
        textContent: '',
        className: '',
        classList: {
            values: new Set(),
            add(value) { this.values.add(value); },
            remove(value) { this.values.delete(value); },
            contains(value) { return this.values.has(value); },
            toggle(value, force) {
                const enabled = force == null ? !this.values.has(value) : !!force;
                if (enabled) this.values.add(value); else this.values.delete(value);
                return enabled;
            }
        },
        addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
        dispatch(name, event = {}) {
            event.target ||= this;
            (this.listeners[name] || []).forEach(fn => fn(event));
        },
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        setAttribute(name, value) { attributes[name] = String(value); },
        querySelectorAll(selector) {
            if (selector === '[data-economy]') return this.children.filter(child => child.dataset.economy);
            if (selector === '[data-dir]') return this.children.filter(child => child.dataset.dir);
            return [];
        }
    };
    Object.defineProperty(element, 'innerHTML', {
        get() { return ''; },
        set() { element.children = []; }
    });
    return element;
}

function loadMatchClient() {
    const ids = [
        'economies', 'status', 'queueBtn', 'leaveBtn', 'queuePanel', 'racePanel', 'raceMode',
        'raceEconomy', 'raceTimer', 'racePlace', 'raceResult', 'stage', 'renderModes',
        'modeTitle', 'modeDescription', 'modeBadge', 'rulesetCatalog', 'economyHelp',
        'objectiveHint', 'matchDpad'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, makeElement(id.includes('Btn') ? 'button' : 'div')]));
    const socketHandlers = {};
    const windowHandlers = {};
    const emitted = [];
    const socket = {
        id: 'local-player', connected: true,
        on(name, fn) { socketHandlers[name] = fn; },
        emit(name, payload) { emitted.push({ name, payload }); }
    };
    const modeList = [
        { id: 'tiles', label: 'Tiled', premium: false },
        { id: 'ascii', label: 'ASCII', premium: false }
    ];
    const RK = {
        RENDER_MODES: modeList,
        loadMode: () => 'tiles',
        saveMode: () => {},
        canUseMode: () => true,
        modeAvailability: id => ({ usable: true, runtimeAvailable: true }),
        createRendererAsync: (mode, host, options, done) => done({ name: mode, destroy() {}, render() {} })
    };
    const MatchCopy = {
        normalize: raw => ({ id: raw.id || 'race', label: 'Race', description: 'Reach the exit', badge: 'RACE', objective: 'reach the exit' }),
        fromPayload: (data, fallback) => fallback,
        plural: () => 'delvers',
        liveSummary: () => 'Racing',
        finalResult: () => ({ text: 'Finished', mode: { id: 'race' } })
    };
    const window = {
        RK,
        MatchUiCopy: MatchCopy,
        addEventListener(name, fn) { windowHandlers[name] = fn; },
        CommerceConsent: null
    };
    const document = { getElementById: id => elements[id], createElement: tag => makeElement(tag) };
    const context = {
        window, document, io: () => socket, localStorage: { getItem: () => null, setItem() {} },
        navigator: { userAgent: 'test' }, console, Date, Math, Promise, TextEncoder,
        setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        Array, Object, Number, String, RegExp
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/matchClient.js'), 'utf8'), context);
    return { elements, socket, socketHandlers, windowHandlers, emitted, modeList };
}

describe('renderer controls and failed skin fallback', () => {
    test('match render mode announces its selected state and updates it after a switch', () => {
        const { elements, socketHandlers } = loadMatchClient();
        socketHandlers.game_mode_info({ modes: { match: { enabled: true, economies: { free: true }, rulesets: [{ id: 'race' }] } } });
        let [tiled, ascii] = elements.renderModes.children;
        expect(tiled.attributes['aria-pressed']).toBe('true');
        expect(ascii.attributes['aria-pressed']).toBe('false');

        ascii.dispatch('click');
        [tiled, ascii] = elements.renderModes.children;
        expect(tiled.attributes['aria-pressed']).toBe('false');
        expect(ascii.attributes['aria-pressed']).toBe('true');
    });

    test('a restored queue selects the server-returned economy and exposes the leave action', () => {
        const { elements, socketHandlers } = loadMatchClient();
        socketHandlers.game_mode_info({ modes: { match: {
            enabled: true,
            economies: { free: true, credits_prestige: true },
            rulesets: [{ id: 'race' }]
        } } });

        socketHandlers.match_queue_joined({ success: true, economy: 'credits_prestige', position: 2, restored: true });

        const [free, prestige] = elements.economies.children;
        expect(free.attributes['aria-pressed']).toBe('false');
        expect(prestige.attributes['aria-pressed']).toBe('true');
        expect(elements.queueBtn.classList.contains('hidden')).toBe(true);
        expect(elements.leaveBtn.classList.contains('hidden')).toBe(false);
        expect(elements.status.textContent).toContain('Queue restored for Prestige');
    });

    test.each([
        ['INPUT', false], ['TEXTAREA', false], ['SELECT', false], ['DIV', true]
    ])('match movement ignores text-entry and select targets (%s)', (tagName, contentEditable) => {
        const { socketHandlers, windowHandlers, emitted } = loadMatchClient();
        socketHandlers.match_start({ ruleset: { id: 'race' } });
        const target = { tagName, isContentEditable: contentEditable };
        let prevented = false;
        windowHandlers.keydown({ key: 'ArrowUp', target, preventDefault() { prevented = true; } });
        expect(prevented).toBe(false);
        expect(emitted.some(event => event.name === 'match_move')).toBe(false);
    });

    test('match movement ignores contenteditable targets but still moves from the game surface', () => {
        const { socketHandlers, windowHandlers, emitted } = loadMatchClient();
        socketHandlers.match_start({ ruleset: { id: 'race' } });
        let prevented = false;
        windowHandlers.keydown({ key: 'ArrowUp', target: { tagName: 'DIV', isContentEditable: true }, preventDefault() { prevented = true; } });
        expect(prevented).toBe(false);

        windowHandlers.keydown({ key: 'ArrowUp', target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
        expect(prevented).toBe(true);
        expect(emitted.some(event => event.name === 'match_move' && event.payload.dx === 0 && event.payload.dy === -1)).toBe(true);
    });

    test('a failed premium skin completes pending loads and draws a free character fallback', () => {
        const images = [];
        const RK = {
            CHARS: { 'char-villager': { frame: 1 } },
            normalizeAppearance: appearance => ({ avatar: typeof appearance === 'string' ? appearance : appearance.avatar || 'default' }),
            appearance: appearance => ({ label: appearance.avatar }),
            isChar: id => id === 'char-villager',
            charAppearance: appearance => ({ avatar: appearance.avatar, tint: 'none', colors: {}, equipment: {} }),
            charAtlas: () => ({}),
            charFrame: () => ({ squash: 1, bob: 0 }),
            drawCharTileCanvas: jest.fn(),
            charOverlayParts: () => []
        };
        const context = {
            window: null,
            Image: class { constructor() { images.push(this); } set src(value) { this.url = value; } },
            console: { warn: jest.fn() }
        };
        context.window = context;
        context.RK = RK;
        vm.createContext(context);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/skins.js'), 'utf8'), context);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/avatarVisuals.js'), 'utf8'), context);

        const visual = RK.avatarVisuals.resolve({ avatar: 'wownero-rogue' }, { projection: 'topdown' });
        const ready = jest.fn();
        const canvas = { beginPath() {}, ellipse() {}, stroke() {} };
        const entity = { id: 'me', x: 1, y: 1, facing: 'down', you: true };
        expect(RK.avatarVisuals.drawTopdownWorld(canvas, visual, entity, { screenX: 1, screenY: 1, cell: 24 }, { onReady: ready })).toBe(false);
        expect(images).toHaveLength(1);

        images[0].onerror();
        expect(ready).toHaveBeenCalledTimes(1);
        expect(RK.skinSheetFailed('wownero-rogue')).toBe(true);
        expect(RK.avatarVisuals.drawTopdownWorld(canvas, visual, entity, { screenX: 1, screenY: 1, cell: 24 }, {})).toBe(true);
        expect(RK.drawCharTileCanvas).toHaveBeenCalled();
    });

    test('a normal character still waits for its atlas and resolves the render callback', () => {
        let atlasReady;
        let atlasLoaded = false;
        const RK = {
            CHARS: { 'char-villager': { frame: 1 } },
            normalizeAppearance: appearance => ({ avatar: typeof appearance === 'string' ? appearance : appearance.avatar || 'default' }),
            appearance: appearance => ({ label: appearance.avatar }),
            isChar: id => id === 'char-villager',
            charAtlas: () => atlasLoaded ? {} : null,
            loadCharAtlas: callback => { atlasReady = callback; },
            charAppearance: appearance => ({ avatar: appearance.avatar, tint: 'none', colors: {}, equipment: {} }),
            charFrame: () => ({ squash: 1, bob: 0 }),
            drawCharTileCanvas: jest.fn(),
            charOverlayParts: () => []
        };
        const context = { window: null, Image: class {}, console };
        context.window = context;
        context.RK = RK;
        vm.createContext(context);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/skins.js'), 'utf8'), context);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/avatarVisuals.js'), 'utf8'), context);

        const visual = RK.avatarVisuals.resolve({ avatar: 'char-villager' }, { projection: 'topdown' });
        const ready = jest.fn();
        const canvas = { beginPath() {}, ellipse() {}, stroke() {} };
        const entity = { id: 'me', x: 1, y: 1, facing: 'down', you: true };
        expect(RK.avatarVisuals.drawTopdownWorld(canvas, visual, entity, { screenX: 1, screenY: 1, cell: 24 }, { onReady: ready })).toBe(false);

        atlasLoaded = true;
        atlasReady();
        expect(ready).toHaveBeenCalledTimes(1);
        expect(RK.avatarVisuals.drawTopdownWorld(canvas, visual, entity, { screenX: 1, screenY: 1, cell: 24 }, {})).toBe(true);
        expect(RK.drawCharTileCanvas).toHaveBeenCalled();
    });
});
