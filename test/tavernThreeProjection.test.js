const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
    const root = { RK: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../html/js/render/threeRenderer.js'), 'utf8'), { window: root });
    const renderer = Object.create(root.RK.ThreeRenderer.prototype);
    const projected = { x: 0, y: 0, z: 0 };
    const local = [];
    renderer.THREE = { Vector3: class {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        project(camera) { camera.observedWorld = [this.x, this.y, this.z]; Object.assign(this, projected); return this; }
    } };
    renderer.host = { getBoundingClientRect: () => ({ left: 100, top: 60, width: 600, height: 400 }) };
    renderer.renderer = { domElement: { width: 1200, height: 800,
        getBoundingClientRect: () => ({ left: 110, top: 70, width: 500, height: 300 }) } };
    renderer.camera = { updateMatrixWorld: jest.fn() };
    renderer.entities = { speaker: { obj: {
        position: { x: 3, y: 0.1, z: -2 },
        updateWorldMatrix: jest.fn(),
        localToWorld(v) { local.push([v.x, v.y, v.z]); v.x += this.position.x; v.y += this.position.y; v.z += this.position.z; return v; }
    } } };
    return { renderer, projected, local };
}

describe('Tavern 3D speech projection', () => {
    test('uses the current mesh position and CSS canvas bounds without device-pixel multiplication', () => {
        const { renderer, local } = fixture();
        expect(renderer.projectEntityHead('speaker')).toEqual({ x: 260, y: 160 });
        expect(local).toEqual([[0, 2, 0]]);
        expect(renderer.camera.observedWorld).toEqual([3, 2.1, -2]);
        expect(renderer.entities.speaker.obj.updateWorldMatrix).toHaveBeenCalledWith(true, false);
    });

    test('tracks the live camera projection and resized viewport', () => {
        const { renderer, projected } = fixture();
        projected.x = 0.5; projected.y = -0.5;
        expect(renderer.projectEntityHead('speaker')).toEqual({ x: 385, y: 235 });
        renderer.renderer.domElement.getBoundingClientRect = () => ({ left: 100, top: 60, width: 300, height: 200 });
        expect(renderer.projectEntityHead('speaker')).toEqual({ x: 225, y: 150 });
    });

    test.each(['x', 'y', 'z'])('suppresses an avatar outside the %s clip plane', axis => {
        const { renderer, projected } = fixture();
        projected[axis] = 1.01;
        expect(renderer.projectEntityHead('speaker')).toBeNull();
        projected[axis] = -1.01;
        expect(renderer.projectEntityHead('speaker')).toBeNull();
        projected[axis] = NaN;
        expect(renderer.projectEntityHead('speaker')).toBeNull();
    });

    test('suppresses points outside the host even when the canvas is panned', () => {
        const { renderer } = fixture();
        renderer.renderer.domElement.getBoundingClientRect = () => ({ left: -500, top: 60, width: 500, height: 300 });
        expect(renderer.projectEntityHead('speaker')).toBeNull();
    });

    test('removed, hidden, destroyed, and zero-size renderers have no bubble position', () => {
        const { renderer } = fixture();
        expect(renderer.projectEntityHead('absent')).toBeNull();
        expect(renderer.projectEntityHead('__proto__')).toBeNull();
        renderer.entities.speaker.obj.visible = false;
        expect(renderer.projectEntityHead('speaker')).toBeNull();
        renderer.entities.speaker.obj.visible = true;
        renderer.host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
        expect(renderer.projectEntityHead('speaker')).toBeNull();
        renderer._destroyed = true;
        expect(renderer.projectEntityHead('speaker')).toBeNull();
    });
});
