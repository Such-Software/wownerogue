const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTileRenderer(options) {
    options = options || {};
    const frames = [];
    const callbacks = [];
    let atlasReady = false;
    let skinReady = false;
    let skinFailed = false;
    const sprites = [];
    let renderPasses = 0;
    const ctx = {
        fillRect() {}, strokeRect() {}, save() {}, restore() {}, beginPath() {}, ellipse() {},
        arc() {}, fill() {}, stroke() {}, clearRect() {}, drawImage() {}, fillText() {}
    };
    const canvas = { className: '', width: 0, height: 0, parentNode: null, getContext: () => ctx };
    const window = {
        requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrame() {},
        RK: {
            themeAtlas: () => null,
            tileMap: () => ({}),
            roomReady: () => false,
            charAtlas: () => atlasReady ? {} : null,
            skinSheet: () => skinReady ? {} : null,
            skinSheetFailed: () => skinFailed,
            avatarVisuals: {
                resolve: appearance => ({
                    kind: appearance.avatar === 'generated-test-skin' ? 'skin' : 'char',
                    allowed: true,
                    appearance
                }),
                drawTopdownWorld(_ctx, visual, entity, _viewport, opts) {
                    if (visual.kind === 'skin' && skinReady) { sprites.push(entity.id); return true; }
                    if (visual.kind === 'skin' && skinFailed && atlasReady) { sprites.push(entity.id); return true; }
                    if (visual.kind === 'char' && atlasReady) { sprites.push(entity.id); return true; }
                    if (visual.kind === 'skin' && options.transitionToChar) {
                        callbacks.push(opts.onReady);
                        return false;
                    }
                    if (options.completeWithoutReady) { opts.onReady(); return false; }
                    if (options.completeWithReady) { atlasReady = true; opts.onReady(); return false; }
                    callbacks.push(opts.onReady);
                    return false;
                }
            }
        }
    };
    const document = { createElement: () => canvas };
    const context = { window, document, RK: window.RK, Date };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/tileRenderer.js'), 'utf8'), context);
    const host = { appendChild(child) { child.parentNode = this; }, removeChild(child) { child.parentNode = null; } };
    const renderer = new window.RK.TileRenderer(host);
    renderer._collectEmitters = () => {};
    renderer._snapshot = () => { renderPasses += 1; };
    renderer._ensureEmbers = () => {};
    renderer._composite = () => {};
    renderer._startLoop = () => {};
    function scene(id) {
        return {
            cols: 1, rows: 1, grid: [['floor']], legend: { floor: { color: '#654321' } },
            entities: [{ id, kind: 'avatar', x: 0, y: 0, appearance: { avatar: 'default' } }]
        };
    }
    return {
        callbacks, frames, renderer, scene, sprites,
        ready() { atlasReady = true; },
        failSkin() { skinFailed = true; },
        get renderPasses() { return renderPasses; }
    };
}

describe('TileRenderer character atlas repaint', () => {
    test('repaints the latest retained scene once when the free character atlas becomes ready', () => {
        const kit = loadTileRenderer();
        const first = kit.scene('first');
        first.entities.push({ id: 'first-other', kind: 'avatar', x: 0, y: 0, appearance: { avatar: 'default' } });
        const latest = kit.scene('latest');
        latest.entities.push({ id: 'latest-other', kind: 'avatar', x: 0, y: 0, appearance: { avatar: 'default' } });
        kit.renderer.render(first);
        kit.renderer.render(latest);
        expect(new Set(kit.callbacks).size).toBe(1);
        expect(kit.sprites).toEqual([]);

        kit.ready();
        kit.callbacks.forEach(callback => callback());
        expect(kit.frames).toHaveLength(1);
        kit.frames.shift()();

        expect(kit.sprites).toEqual(['latest', 'latest-other']);
        expect(kit.renderPasses).toBe(3);
        expect(kit.frames).toHaveLength(0);
    });

    test('does not repaint after destruction, including when readiness was already queued', () => {
        const kit = loadTileRenderer();
        kit.renderer.render(kit.scene('removed'));
        kit.ready();
        kit.callbacks[0]();
        expect(kit.frames).toHaveLength(1);

        kit.renderer.destroy();
        kit.frames.shift()();
        expect(kit.renderPasses).toBe(1);
        expect(kit.sprites).toEqual([]);
    });

    test('does not retry a loader callback that completes without a drawable atlas', () => {
        const kit = loadTileRenderer({ completeWithoutReady: true });
        kit.renderer.render(kit.scene('unavailable'));
        expect(kit.frames).toHaveLength(0);
        expect(kit.renderPasses).toBe(1);
    });

    test('retains the current scene before a loader completion callback can repaint it', () => {
        const kit = loadTileRenderer({ completeWithReady: true });
        kit.renderer.render(kit.scene('synchronous-ready'));
        expect(kit.frames).toHaveLength(1);
        kit.frames.shift()();
        expect(kit.sprites).toEqual(['synchronous-ready']);
        expect(kit.renderPasses).toBe(2);
        expect(kit.frames).toHaveLength(0);
    });

    test('repaints after a failed skin so the free character fallback can load and draw', () => {
        const kit = loadTileRenderer({ transitionToChar: true });
        const skinScene = kit.scene('free-fallback');
        skinScene.entities[0].appearance = { avatar: 'generated-test-skin' };
        kit.renderer.render(skinScene);
        expect(kit.callbacks).toHaveLength(1);
        expect(kit.frames).toHaveLength(0);

        kit.failSkin();
        kit.callbacks[0]();
        expect(kit.frames).toHaveLength(1);
        kit.frames.shift()();
        expect(kit.callbacks).toHaveLength(2);
        expect(kit.sprites).toEqual([]);

        kit.ready();
        kit.callbacks[1]();
        expect(kit.frames).toHaveLength(1);
        kit.frames.shift()();
        expect(kit.sprites).toEqual(['free-fallback']);
        expect(kit.renderPasses).toBe(3);
        expect(kit.frames).toHaveLength(0);
    });
});
