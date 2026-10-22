const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Appearance = require('../src/multiplayer/appearance');
const Entitlements = require('../src/multiplayer/entitlements');

// Only DOM/canvas/Pixi primitives and atlas I/O are replaced. Catalogs, entitlement
// resolution, normalization, customizer, and both renderer paths are production code.
function kit() {
    const frames = [], loads = [], draws = [];
    let ready = false;
    const ctx = new Proxy({}, { get(target, key) { return target[key] || (() => {}); } });
    function element(tag) {
        const e = { tagName: tag, style: {}, children: [], className: '', textContent: '',
            appendChild(c) { this.children.push(c); c.parentNode = this; },
            removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
            getContext: () => ctx, setAttribute() {}, addEventListener() {} };
        e.classList = { add(c) { if (!e.className.split(' ').includes(c)) e.className += ' ' + c; },
            remove(c) { e.className = e.className.split(' ').filter(x => x !== c).join(' '); },
            contains(c) { return e.className.split(' ').includes(c); } };
        Object.defineProperty(e, 'innerHTML', { set() { e.children = []; } });
        return e;
    }
    const document = { createElement: element, head: element('head'), body: element('body'), getElementById: () => null };
    const context = { document, localStorage: { getItem: () => null, setItem() {} },
        Image: class {}, console, Date, requestAnimationFrame(fn) { frames.push(fn); }, cancelAnimationFrame() {} };
    context.window = context;
    vm.createContext(context);
    for (const file of ['charSprites', 'skins', 'assetPacks', 'charCustomize', 'avatarVisuals', 'tileRenderer', 'fancyRenderer']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/' + file + '.js'), 'utf8'), context);
    }
    const RK = context.RK;
    RK.setEntitlementSnapshot(Entitlements.snapshotForUser({ credits: 0, total_credits_purchased: 0 }));
    RK.charAtlas = () => ready ? {} : null;
    RK.loadCharAtlas = fn => { if (fn) loads.push(fn); };
    RK.drawCharTileCanvas = (...args) => { draws.push(args); return true; };
    RK.drawCharCompositeCanvas = () => ready;
    return { RK, frames, loads, draws, document, ctx, element,
        ready() { ready = true; }, complete() { loads.splice(0).forEach(fn => fn()); } };
}
function descendants(e) { return [e, ...e.children.flatMap(descendants)]; }
function scene(id, appearance = { avatar: 'default' }) {
    return { cols: 1, rows: 1, grid: [['floor']], legend: { floor: { color: '#654321' } },
        entities: [{ id, kind: 'avatar', x: 0, y: 0, appearance }] };
}
function tiled(k) {
    k.RK.themeAtlas = () => null; k.RK.tileMap = () => ({}); k.RK.roomReady = () => false;
    const r = new k.RK.TileRenderer(k.element('host'));
    for (const name of ['_collectEmitters', '_snapshot', '_ensureEmbers', '_composite', '_startLoop']) r[name] = () => {};
    return r;
}
function fancy(k) {
    const r = Object.create(k.RK.FancyRenderer.prototype);
    Object.assign(r, { app: {}, cell: 24, sprites: {}, entityLayer: { addChild() {}, removeChild() {} } });
    const made = [];
    for (const [method, kind] of [['_makeCharSprite', 'char'], ['_makeSkinSprite', 'skin'], ['_makeSprite', 'circle']]) {
        r[method] = e => { made.push({ kind, e }); return { destroy() {} }; };
    }
    r.show = s => { r._lastScene = s; r._syncEntities(s); };
    return { r, made };
}

test('client and server normalize defaults and preserve every valid catalog identity and character fields', () => {
    const { RK } = kit();
    const inputs = [undefined, null, {}, 'default', 'unknown', { appearance: { avatar: 'default' } },
        ...Appearance.avatarIds().map(avatar => ({ avatar, tint: 'moss', colors: { base: 'teal', hair: 'silver' }, equipment: { body: 'mail', weapon: 'bow' } }))];
    for (const input of inputs) expect(RK.normalizeAppearance(input)).toEqual(Appearance.normalizeAppearance(input));
    expect(RK.appearances().filter(a => a.id === 'char-villager').map(a => a.label)).toEqual(['Adventurer']);
    expect(RK.appearances().some(a => a.id === 'default')).toBe(false);
});

test.each(['ascii', 'topdown', 'iso', '3d'])('Adventurer is selected and remains the same saved identity in %s picker', projection => {
    const k = kit(); k.ready();
    const saved = [];
    k.RK.openCustomize('default', ap => saved.push(ap), { projection });
    const nodes = descendants(k.document.body);
    const cards = nodes.filter(e => e.classList.contains('rk-option-card'));
    const adventurers = cards.filter(e => e.children.some(c => c.textContent === 'Adventurer'));
    expect(adventurers).toHaveLength(1);
    expect(adventurers[0].classList.contains('is-selected')).toBe(true);
    nodes.find(e => e.classList.contains('rk-save')).onclick();
    expect(saved[0]).toEqual(Appearance.normalizeAppearance('char-villager'));
    expect(k.RK.canUsePack('kenney-3d-characters')).toBe(false);
});

test.each(['green', 'char-ranger'])('opening another projection preserves saved %s identity', avatar => {
    const k = kit(); k.ready(); const saved = [];
    const ap = { avatar, colors: { base: 'teal', hair: 'silver' }, equipment: { weapon: 'bow' } };
    k.RK.openCustomize(ap, value => saved.push(value), { projection: 'ascii' });
    descendants(k.document.body).find(e => e.classList.contains('rk-save')).onclick();
    expect(saved[0]).toEqual(Appearance.normalizeAppearance(ap));
});

test('actual FREE catalog permits character rendering without unlocking premium environments or skins', () => {
    const { RK } = kit();
    expect(RK.canUsePack('roguelike-interior')).toBe(false);
    for (const id of ['char-villager', 'char-ranger']) {
        const visual = RK.avatarVisuals.resolve(id, { projection: 'topdown' });
        expect(visual.allowed).toBe(true); expect(visual.pack).toBeNull();
    }
    expect(RK.avatarVisuals.resolve('monero-knight', { projection: 'topdown' }).allowed).toBe(false);
    expect(RK.avatarVisuals.resolve('char-villager', { projection: '3d' }).allowed).toBe(false);
    expect(RK.avatarVisuals.resolve('green', { projection: 'topdown' }).appearance.avatar).toBe('green');
});

test('actual tiled FREE path repaints a canonical default character after atlas completion', () => {
    const k = kit(), r = tiled(k);
    r.render(scene('first')); r.render(scene('latest'));
    expect(k.draws).toHaveLength(0);
    k.ready(); k.complete();
    expect(k.frames).toHaveLength(1); k.frames.shift()();
    expect(k.draws.some(args => args[1] === k.RK.CHARS['char-villager'].frame)).toBe(true);
    expect(k.frames).toHaveLength(0);
});

test('Fancy uses canonical appearance, redraws latest entities once, and keeps valid colors', () => {
    const k = kit(), { r, made } = fancy(k);
    r.show(scene('first')); r.show(scene('latest'));
    expect(made.every(x => x.kind === 'circle')).toBe(true);
    k.ready(); k.complete(); expect(k.frames).toHaveLength(1); k.frames.shift()();
    expect(made.filter(x => x.kind === 'char').map(x => [x.e.id, x.e.avatar])).toEqual([['latest', 'char-villager']]);
    const explicit = scene('saved', { avatar: 'char-ranger', colors: { base: 'teal' } });
    explicit.entities[0].avatar = 'default';
    r.show(explicit);
    expect(r.sprites.saved.e.appearance).toEqual(Appearance.normalizeAppearance(explicit.entities[0].appearance));
    r.show(scene('color', { avatar: 'green' }));
    expect(r.sprites.color.kind).toBe('circle'); expect(r.sprites.color.e.avatar).toBe('green');
});

test('Fancy never spins on failed atlas completion or repaints after destruction', () => {
    const k = kit(), { r } = fancy(k);
    r.show(scene('pending')); k.complete(); expect(k.frames).toHaveLength(0);
    r.show(scene('retry')); k.ready(); k.complete(); expect(k.frames).toHaveLength(1);
    r.app = null; const before = r.sprites; k.frames.shift()(); expect(r.sprites).toBe(before);
});


test('Fancy default normalization never turns monsters, features, items, or cats into humanoid avatars', () => {
    const k = kit(), { r, made } = fancy(k); k.ready();
    const mixed = scene('adventurer');
    for (const kind of ['monster', 'feature', 'item', 'cat']) {
        mixed.entities.push({ id: kind, kind, x: 0, y: 0, color: '#f85149', char: kind === 'cat' ? 'c' : '~' });
    }
    r.show(mixed);
    expect(made.filter(x => x.kind === 'char').map(x => x.e.id)).toEqual(['adventurer']);
    for (const entity of mixed.entities.slice(1)) {
        expect(r.sprites[entity.id].kind).toBe('circle');
        expect(r.sprites[entity.id].e).toBe(entity);
        expect(entity.avatar).toBeUndefined();
    }
});
