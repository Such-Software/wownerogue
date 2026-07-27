const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeElement(tag = 'div') {
    return {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        listeners: {},
        capturedPointers: new Set(),
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; },
        addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
        removeEventListener(name, fn) {
            this.listeners[name] = (this.listeners[name] || []).filter(listener => listener !== fn);
        },
        dispatch(name, event = {}) {
            event.target ||= this;
            for (const listener of [...(this.listeners[name] || [])]) listener(event);
        },
        setAttribute() {},
        querySelector() { return null; },
        setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); },
        releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
    };
}

function loadKit(ResizeObserver) {
    const document = { createElement: makeElement };
    const context = { document, console, Math };
    if (ResizeObserver) context.ResizeObserver = ResizeObserver;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/js/render/zoomControl.js'), 'utf8'), context);
    return context.RK;
}

describe('render-kit viewport camera', () => {
    test('centers a focus point and clamps the view at map edges', () => {
        const RK = loadKit();
        const host = makeElement();
        host.clientWidth = 300;
        host.clientHeight = 200;
        const canvas = makeElement('canvas');
        canvas.width = 600;
        canvas.height = 400;
        const renderer = { name: 'tiles', canvas, focusPoint: { x: 500, y: 300 } };
        const camera = RK.attachCamera(host, { zoom: 1, min: 0.5, controls: false });

        camera.update(renderer);
        expect(canvas.style.transform).toBe('translate(-300px,-200px) scale(1)');

        renderer.focusPoint = { x: 300, y: 200 };
        camera.update(renderer);
        expect(canvas.style.transform).toBe('translate(-150px,-100px) scale(1)');

        camera.setZoom(0.5);
        expect(canvas.style.transform).toBe('translate(0px,0px) scale(0.5)');
    });

    test('delegates projection zoom and drag pan to the native 3D camera', () => {
        const RK = loadKit();
        const host = makeElement();
        host.clientWidth = 300;
        host.clientHeight = 200;
        const setZoom = jest.fn();
        const setPan = jest.fn();
        const renderer = { name: '3d', setZoom, setPan };
        const camera = RK.attachCamera(host, { zoom: 1.2, controls: false });

        camera.update(renderer);
        expect(setZoom).toHaveBeenLastCalledWith(1.2);
        expect(setPan).toHaveBeenLastCalledWith(0, 0);
        host.dispatch('pointerdown', { pointerId: 1, clientX: 10, clientY: 20 });
        host.dispatch('pointermove', { pointerId: 1, clientX: 34, clientY: 31 });
        expect(setPan).toHaveBeenLastCalledWith(24, 11);
        camera.setZoom(1.5);
        expect(setZoom).toHaveBeenLastCalledWith(1.5);
        camera.reset();
        expect(setPan).toHaveBeenLastCalledWith(0, 0);
    });

    test('fits a compact room to a responsive share of the viewport and restores that fit', () => {
        const RK = loadKit();
        const host = makeElement();
        host.clientWidth = 900;
        host.clientHeight = 550;
        const canvas = makeElement('canvas');
        canvas.width = 288;
        canvas.height = 168;
        const renderer = { name: 'tiles', canvas, focusPoint: { x: 144, y: 84 } };
        const camera = RK.attachCamera(host, { zoom: 1.25, fitRatio: 0.75, min: 0.5, max: 3.2, controls: false });

        camera.fit(renderer);
        expect(camera.getZoom()).toBeCloseTo(2.34375);
        expect(canvas.style.transform).toBe('translate(112.5px,78.125px) scale(2.34375)');

        camera.setZoom(1.1);
        camera.reset();
        expect(camera.getZoom()).toBeCloseTo(2.34375);
    });

    test('pans with one pointer and pinches with two pointers', () => {
        const RK = loadKit();
        const host = makeElement();
        host.clientWidth = 300;
        host.clientHeight = 200;
        const canvas = makeElement('canvas');
        canvas.width = 600;
        canvas.height = 400;
        const renderer = { name: 'tiles', canvas, focusPoint: { x: 300, y: 200 } };
        const camera = RK.attachCamera(host, { zoom: 1, min: 0.5, max: 3, controls: false });
        camera.update(renderer);

        host.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
        host.dispatch('pointermove', { pointerId: 1, clientX: 20, clientY: 10 });
        expect(canvas.style.transform).toBe('translate(-130px,-90px) scale(1)');
        expect(host.capturedPointers.has(1)).toBe(true);

        host.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 10 });
        host.dispatch('pointermove', { pointerId: 2, clientX: 100, clientY: 10 });
        host.dispatch('pointermove', { pointerId: 2, clientX: 180, clientY: 10 });
        expect(camera.getZoom()).toBeCloseTo(2);

        host.dispatch('pointerup', { pointerId: 1 });
        host.dispatch('pointercancel', { pointerId: 2 });
        expect(host.style.cursor).toBe('grab');
    });

    test('resize auto-fit follows the current renderer after a renderer switch', () => {
        let observer;
        class FakeResizeObserver {
            constructor(callback) { this.callback = callback; observer = this; }
            observe = jest.fn();
            disconnect = jest.fn();
        }
        const RK = loadKit(FakeResizeObserver);
        const host = makeElement();
        host.clientWidth = 900;
        host.clientHeight = 600;
        const firstCanvas = makeElement('canvas');
        firstCanvas.width = 300;
        firstCanvas.height = 200;
        const secondCanvas = makeElement('canvas');
        secondCanvas.width = 600;
        secondCanvas.height = 300;
        const first = { name: 'tiles', canvas: firstCanvas };
        const second = { name: 'iso', canvas: secondCanvas };
        const camera = RK.attachCamera(host, { zoom: 1, fitRatio: 0.75, min: 0.5, max: 3, controls: false });

        camera.fit(first);
        const firstTransform = firstCanvas.style.transform;
        camera.update(second);
        host.clientWidth = 600;
        host.clientHeight = 300;
        observer.callback();

        expect(camera.getZoom()).toBeCloseTo(0.75);
        expect(secondCanvas.style.transform).toBe('translate(75px,37.5px) scale(0.75)');
        expect(firstCanvas.style.transform).toBe(firstTransform);
    });

    test('destroy removes host and control listeners, disconnects resize, and permits clean reattachment', () => {
        let observer;
        class FakeResizeObserver {
            constructor(callback) { this.callback = callback; observer = this; }
            observe = jest.fn();
            disconnect = jest.fn();
        }
        const RK = loadKit(FakeResizeObserver);
        const host = makeElement();
        host.clientWidth = 300;
        host.clientHeight = 200;
        const nativeSetZoom = jest.fn();
        const camera = RK.attachCamera(host, { zoom: 1.2 });
        camera.update({ name: '3d', setZoom: nativeSetZoom });
        const controls = host.children[0];
        const buttons = controls.children.filter(child => child.tagName === 'BUTTON');

        host.dispatch('pointerdown', { pointerId: 7, clientX: 10, clientY: 10 });
        expect(host.capturedPointers.has(7)).toBe(true);
        expect(Object.values(host.listeners).flat()).toHaveLength(6);
        expect(buttons.every(button => button.listeners.click.length === 1)).toBe(true);

        camera.destroy();

        expect(Object.values(host.listeners).flat()).toHaveLength(0);
        expect(buttons.every(button => button.listeners.click.length === 0)).toBe(true);
        expect(host.children).not.toContain(controls);
        expect(host.capturedPointers.size).toBe(0);
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(host._rkCamera).toBeUndefined();

        const callCount = nativeSetZoom.mock.calls.length;
        host.dispatch('wheel', { deltaY: -100, preventDefault: jest.fn() });
        observer.callback(); // A queued callback after disconnect must also be inert.
        expect(nativeSetZoom).toHaveBeenCalledTimes(callCount);

        const replacement = RK.attachCamera(host, { zoom: 1.5, controls: false });
        expect(replacement).not.toBe(camera);
        camera.destroy(); // Stale/double teardown must not detach the replacement camera.
        expect(RK.attachCamera(host, { controls: false })).toBe(replacement);
        replacement.destroy();
    });
});
