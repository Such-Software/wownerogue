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
})(window);
