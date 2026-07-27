(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var MIN = 0.4, MAX = 4.0;

    // Apply the host's current zoom to whatever canvas is mounted in it (2D or WebGL). Re-callable
    // after a renderer/mode switch so the new canvas inherits the zoom.
    RK.applyZoom = function (host) {
        if (!host) return;
        var z = host._rkZoom || 1;
        var c = host.querySelector('canvas');
        if (!c) return;
        c.style.transformOrigin = 'center center';
        c.style.transform = z === 1 ? '' : 'scale(' + z + ')';
        c.style.imageRendering = 'pixelated'; // keep pixel art crisp when zoomed
    };

    // Wheel + trackpad-pinch zoom on a render host, shared by every mode. Trackpad pinch arrives as
    // a wheel event with ctrlKey set; a normal wheel over the canvas zooms instead of scrolling.
    RK.attachZoom = function (host) {
        if (!host || host._rkZoomAttached) return;
        host._rkZoomAttached = true;
        host._rkZoom = host._rkZoom || 1;
        host.style.overflow = 'hidden';
        host.title = 'Scroll / pinch to zoom · double-click to reset';

        host.addEventListener('wheel', function (e) {
            e.preventDefault();
            var factor = Math.exp(-e.deltaY * 0.0015);      // smooth, direction-correct
            host._rkZoom = Math.max(MIN, Math.min(MAX, (host._rkZoom || 1) * factor));
            RK.applyZoom(host);
        }, { passive: false });

        host.addEventListener('dblclick', function () {
            host._rkZoom = 1;
            RK.applyZoom(host);
        });
    };

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function rendererCanvas(renderer) {
        return renderer && (renderer.canvas || (renderer.app && renderer.app.view) ||
            (renderer.renderer && renderer.renderer.domElement));
    }

    // Player-follow camera for fixed viewports (single/multiplayer races and spectator views).
    // Renderers only need to expose `canvas` + `focusPoint`; ThreeRenderer instead handles zoom and
    // following internally through setZoom(). The older attachZoom API above remains unchanged for
    // whole-room previews that intentionally do not follow an avatar.
    RK.attachCamera = function (host, opts) {
        if (!host) return null;
        if (host._rkCamera) return host._rkCamera.api;
        opts = opts || {};
        var state = host._rkCamera = {
            zoom: clamp(Number(opts.zoom) || 1.35, Number(opts.min) || 0.55, Number(opts.max) || 3.2),
            defaultZoom: Number(opts.zoom) || 1.35,
            fitRatio: Number(opts.fitRatio) || 0,
            autoFit: false,
            min: Number(opts.min) || 0.55,
            max: Number(opts.max) || 3.2,
            panX: 0,
            panY: 0,
            renderer: null,
            pointers: {},
            pinchDistance: null,
            listeners: [],
            destroyed: false
        };
        host.style.position = host.style.position || 'relative';
        host.style.overflow = 'hidden';
        host.style.touchAction = 'none';
        host.style.cursor = 'grab';

        function updateReadout() {
            if (state.readout) state.readout.textContent = Math.round(state.zoom * 100) + '%';
        }
        function listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            state.listeners.push({ target: target, type: type, handler: handler, options: options });
        }
        function fitZoom(renderer, ratio) {
            if (!renderer || renderer.name === '3d') return clamp(state.defaultZoom, state.min, state.max);
            var canvas = rendererCanvas(renderer);
            if (!canvas) return clamp(state.defaultZoom, state.min, state.max);
            var cw = canvas.width || canvas.offsetWidth || 1;
            var ch = canvas.height || canvas.offsetHeight || 1;
            var w = host.clientWidth || host.offsetWidth || 640;
            var h = host.clientHeight || host.offsetHeight || 400;
            return clamp(Math.min(w / cw, h / ch) * (Number(ratio) || state.fitRatio || 0.72), state.min, state.max);
        }
        function setZoom(next, manual) {
            if (state.destroyed) return;
            if (manual) state.autoFit = false;
            state.zoom = clamp(Number(next) || 1, state.min, state.max);
            updateReadout();
            RK.updateCamera(host, state.renderer);
        }
        function reset() {
            if (state.destroyed) return;
            state.panX = 0;
            state.panY = 0;
            state.autoFit = !!(state.fitRatio && state.renderer);
            setZoom(state.autoFit ? fitZoom(state.renderer) : state.defaultZoom);
        }

        function onWheel(e) {
            if (state.destroyed) return;
            e.preventDefault();
            setZoom(state.zoom * Math.exp(-e.deltaY * 0.0015), true);
        }
        function onDoubleClick(e) {
            if (state.destroyed) return;
            if (e.target && e.target.closest && e.target.closest('.rk-camera-controls')) return;
            reset();
        }

        function onPointerDown(e) {
            if (state.destroyed) return;
            if (e.target && e.target.closest && e.target.closest('.rk-camera-controls')) return;
            state.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            state.dragId = e.pointerId;
            host.style.cursor = 'grabbing';
            try { host.setPointerCapture(e.pointerId); } catch (_) {}
        }
        function onPointerMove(e) {
            if (state.destroyed) return;
            var prev = state.pointers[e.pointerId];
            if (!prev) return;
            state.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            var ids = Object.keys(state.pointers);
            if (ids.length > 1) {
                var a = state.pointers[ids[0]], b = state.pointers[ids[1]];
                var dist = Math.hypot(a.x - b.x, a.y - b.y);
                if (state.pinchDistance) setZoom(state.zoom * (dist / state.pinchDistance));
                state.pinchDistance = dist;
            } else {
                state.autoFit = false;
                state.panX += e.clientX - prev.x;
                state.panY += e.clientY - prev.y;
                RK.updateCamera(host, state.renderer);
            }
        }
        function releasePointer(e) {
            if (state.destroyed) return;
            delete state.pointers[e.pointerId];
            state.pinchDistance = null;
            if (!Object.keys(state.pointers).length) host.style.cursor = 'grab';
        }
        listen(host, 'wheel', onWheel, { passive: false });
        listen(host, 'dblclick', onDoubleClick);
        listen(host, 'pointerdown', onPointerDown);
        listen(host, 'pointermove', onPointerMove);
        listen(host, 'pointerup', releasePointer);
        listen(host, 'pointercancel', releasePointer);

        if (opts.controls !== false && root.document) {
            var controls = root.document.createElement('div');
            controls.className = 'rk-camera-controls';
            controls.setAttribute('aria-label', 'Camera controls');
            controls.style.cssText = 'position:absolute;right:10px;bottom:10px;z-index:20;display:flex;' +
                'align-items:center;gap:4px;padding:4px;background:rgba(4,7,10,.82);border:1px solid rgba(255,255,255,.2);' +
                'border-radius:7px;box-shadow:0 4px 18px rgba(0,0,0,.45);font:12px ui-monospace,monospace;';
            function button(label, title, fn) {
                var b = root.document.createElement('button');
                b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
                b.style.cssText = 'min-width:30px;height:28px;padding:0 7px;background:#151b22;color:#e5e7eb;' +
                    'border:1px solid #3b4552;border-radius:4px;cursor:pointer;font:inherit;';
                listen(b, 'click', function (e) { e.stopPropagation(); fn(); });
                controls.appendChild(b);
            }
            button('−', 'Zoom out', function () { setZoom(state.zoom / 1.18, true); });
            state.readout = root.document.createElement('span');
            state.readout.style.cssText = 'min-width:42px;text-align:center;color:#a7f3d0;';
            controls.appendChild(state.readout);
            button('+', 'Zoom in', function () { setZoom(state.zoom * 1.18, true); });
            button('⌂', 'Reset camera', reset);
            host.appendChild(controls);
            state.controls = controls;
        }
        updateReadout();

        if (typeof root.ResizeObserver === 'function') {
            state.observer = new root.ResizeObserver(function () {
                if (state.destroyed) return;
                if (state.autoFit) setZoom(fitZoom(state.renderer));
                else RK.updateCamera(host, state.renderer);
            });
            state.observer.observe(host);
        }
        state.api = {
            update: function (renderer) {
                if (!state.destroyed) RK.updateCamera(host, renderer);
            },
            setZoom: setZoom,
            setDefaultZoom: function (zoom) {
                if (!state.destroyed) state.defaultZoom = Number(zoom) || state.defaultZoom;
            },
            fit: function (renderer, ratio) {
                if (state.destroyed) return;
                state.renderer = renderer || state.renderer;
                if (ratio != null) state.fitRatio = Number(ratio) || state.fitRatio;
                state.panX = 0;
                state.panY = 0;
                state.autoFit = !!state.renderer;
                setZoom(fitZoom(state.renderer));
            },
            reset: reset,
            getZoom: function () { return state.zoom; },
            destroy: function () {
                if (state.destroyed) return;
                state.destroyed = true;
                state.listeners.splice(0).forEach(function (entry) {
                    if (entry.target && typeof entry.target.removeEventListener === 'function') {
                        entry.target.removeEventListener(entry.type, entry.handler, entry.options);
                    }
                });
                Object.keys(state.pointers).forEach(function (pointerId) {
                    try {
                        if (typeof host.releasePointerCapture === 'function') {
                            host.releasePointerCapture(Number(pointerId));
                        }
                    } catch (_) {}
                });
                state.pointers = {};
                state.pinchDistance = null;
                host.style.cursor = 'grab';
                if (state.observer) {
                    state.observer.disconnect();
                    state.observer = null;
                }
                if (state.controls && state.controls.parentNode) state.controls.parentNode.removeChild(state.controls);
                state.controls = null;
                state.readout = null;
                state.renderer = null;
                if (host._rkCamera === state) delete host._rkCamera;
            }
        };
        return state.api;
    };

    RK.updateCamera = function (host, renderer) {
        var state = host && host._rkCamera;
        if (!state || !renderer) return;
        state.renderer = renderer;
        if (renderer.name === '3d') {
            if (typeof renderer.setZoom === 'function') renderer.setZoom(state.zoom);
            if (typeof renderer.setPan === 'function') renderer.setPan(state.panX, state.panY);
            return;
        }
        var canvas = rendererCanvas(renderer);
        if (!canvas) return;
        var cw = canvas.width || canvas.offsetWidth || 1;
        var ch = canvas.height || canvas.offsetHeight || 1;
        var w = host.clientWidth || host.offsetWidth || 640;
        var h = host.clientHeight || host.offsetHeight || 400;
        var focus = renderer.focusPoint || { x: cw / 2, y: ch / 2 };
        var z = state.zoom;
        var tx = w / 2 - focus.x * z + state.panX;
        var ty = h / 2 - focus.y * z + state.panY;
        var sw = cw * z, sh = ch * z;
        tx = sw <= w ? (w - sw) / 2 : clamp(tx, w - sw, 0);
        ty = sh <= h ? (h - sh) / 2 : clamp(ty, h - sh, 0);

        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.maxWidth = 'none';
        canvas.style.maxHeight = 'none';
        canvas.style.transformOrigin = '0 0';
        canvas.style.imageRendering = 'pixelated';
        canvas.style.transition = 'transform 110ms ease-out';
        canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
    };
})(window);
