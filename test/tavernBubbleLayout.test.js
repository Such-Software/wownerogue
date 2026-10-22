const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture(width = 320, height = 300) {
    let now = 1000;
    const painted = [], bodies = [];
    const ctx = {
        clearRect() { painted.length = 0; bodies.length = 0; }, save() {}, restore() {},
        beginPath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
        roundRect(x, y, w, h) { bodies.push({ x, y, w, h }); },
        measureText(text) { return { width: Array.from(text).length * 7 }; },
        fillText(text, x, y) { painted.push({ text, x, y }); }
    };
    const canvas = { style: {}, width, height, getContext: () => ctx };
    ctx.canvas = canvas;
    const bounds = () => ({ left: 0, top: 0, width, height });
    const host = { style: {}, clientWidth: width, clientHeight: height,
        appendChild(c) { c.parentNode = this; }, getBoundingClientRect: bounds,
        querySelector: () => ({ width, height, getBoundingClientRect: bounds }) };
    const root = { RK: {}, CanvasRenderingContext2D: function () {}, document: { createElement: () => canvas } };
    root.CanvasRenderingContext2D.prototype.roundRect = function () {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../html/js/render/tavernLife.js'), 'utf8'), { window: root });
    const scene = { cols: 8, rows: 5, grid: Array.from({ length: 5 }, () => Array(8).fill('floor')),
        entities: [{ id: 'speaker', x: 2, y: 2 }] };
    const life = new root.RK.TavernLife(host, () => scene, () => 24, { now: () => now });
    return { life, scene, painted, bodies, ctx, root, draw: () => life.update(scene, 24, 'tiles'), advance: ms => { now += ms; } };
}

describe('Tavern accepted speech layout', () => {
    test('an actor-free authored room still paints accepted speech as literal text', () => {
        const f = fixture();
        f.life.spawn();
        expect(f.life._spawned).toBe(false);
        const text = 'Cheers & <b>hello</b> 🙂';
        f.life.showPlayerBubble('speaker', text); f.draw();
        expect(f.painted.map(p => p.text).join('')).toBe(text);
        expect(f.bodies.length).toBeGreaterThan(0);
    });

    test('long unbroken and Unicode text wraps inside a narrow viewport', () => {
        const f = fixture(160, 300), text = 'a'.repeat(90) + '🙂'.repeat(10) + ' & hello';
        f.life.showPlayerBubble('speaker', text); f.draw();
        expect(f.painted.length).toBeGreaterThan(1);
        expect(f.painted.map(p => p.text).join('')).toBe(text);
        for (const body of f.bodies) {
            expect(body.x).toBeGreaterThanOrEqual(0);
            expect(body.x + body.w).toBeLessThanOrEqual(160);
            expect(body.y).toBeGreaterThanOrEqual(0);
            expect(body.y + body.h).toBeLessThanOrEqual(300);
        }
        for (const line of f.painted) expect(line.text.includes('�')).toBe(false);
    });

    test('character bubbles anchor above sprite heads before viewport scaling', () => {
        const f = fixture();
        f.root.RK.avatarVisuals = { resolve: () => ({ kind: 'char', allowed: true }) };
        const speaker = f.scene.entities[0];
        speaker.y = 4;
        const point = f.life._entityScreenPos(speaker, f.scene, 24, 'tiles');
        const spriteTop = (speaker.y + 1) * 24 - 1.8 * 24;
        expect(point.y).toBeLessThan(spriteTop);
        f.life._viewTransform = { left: 13, top: 17, scaleX: 2, scaleY: 0.5 };
        const scaled = f.life._entityScreenPos(speaker, f.scene, 24, 'tiles');
        expect(scaled).toEqual({ x: 13 + point.x * 2, y: 17 + point.y * 0.5 });
        f.life._viewTransform = null;
        expect(f.life._entityScreenPos(speaker, f.scene, 24, 'ascii').y).toBe(speaker.y * 24);
        f.life.showPlayerBubble('speaker', 'hello'); f.draw();
        expect(f.bodies.every(body => body.y + body.h < spriteTop)).toBe(true);
    });

    test('actual default normalization never gives a cat a humanoid head position', () => {
        const f = fixture();
        for (const name of ['charSprites', 'charCustomize', 'avatarVisuals']) {
            vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../html/js/render/' + name + '.js'), 'utf8'), { window: f.root });
        }
        expect(f.root.RK.avatarVisuals.resolve({ avatar: null }, { projection: 'topdown' }).kind).toBe('char');
        const cat = { x: 2, y: 3, role: 'cat', avatar: null, appearance: { avatar: null } };
        const point = f.life._entityScreenPos(cat, f.scene, 24, 'tiles');
        expect(point.y).toBeCloseTo((cat.y + 0.2) * 24);
        expect(f.life._entityScreenPos({ ...cat, role: undefined, kind: 'cat' }, f.scene, 24, 'tiles')).toEqual(point);
    });

    test('failed skins anchor at the Adventurer fallback head', () => {
        const f = fixture();
        const speaker = f.scene.entities[0];
        f.root.RK.avatarVisuals = { resolve: () => ({ kind: 'skin', allowed: true, appearance: { avatar: 'failed-skin' } }) };
        f.root.RK.SKINS = { 'failed-skin': { scale: 2.5 } };
        f.root.RK.skinSheetFailed = () => false;
        expect(f.life._entityScreenPos(speaker, f.scene, 24, 'tiles').y).toBeCloseTo((speaker.y - 1.5) * 24);
        f.root.RK.skinSheetFailed = () => true;
        expect(f.life._entityScreenPos(speaker, f.scene, 24, 'tiles').y).toBeCloseTo((speaker.y - 0.9) * 24);
    });

    test('Iso bubbles use the selected character image height above its floor anchor', () => {
        const f = fixture();
        f.root.RK.avatarVisuals = { resolve: () => ({ allowed: true, character: { imageH: 110 } }) };
        const speaker = f.scene.entities[0];
        const point = f.life._entityScreenPos(speaker, f.scene, 24, 'iso');
        const floor = 28 + 184 + (speaker.x + speaker.y) * 42 / 2;
        expect(point.y).toBeCloseTo(floor + 42 * 0.95 - 110);
    });

    test('departure removes old speech before the same handle can return', () => {
        const f = fixture();
        f.life.showPlayerBubble('speaker', 'old visit'); f.draw();
        f.scene.entities = []; f.draw();
        expect(Object.keys(f.life._realBubbles)).toEqual([]);
        f.scene.entities = [{ id: 'speaker', x: 2, y: 2 }]; f.draw();
        expect(f.painted).toEqual([]);
    });

    test('offscreen speakers do not pin bubbles to a viewport edge; expiry still cleans up', () => {
        const f = fixture();
        f.life.showPlayerBubble('speaker', 'hello'); f.scene.entities[0].x = -20; f.draw();
        expect(f.painted).toEqual([]);
        f.advance(10000); f.draw();
        expect(Object.keys(f.life._realBubbles)).toEqual([]);
    });
});
