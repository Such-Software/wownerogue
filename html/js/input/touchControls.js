/**
 * Touch controls for mobile: an on-screen D-pad and swipe-to-move on the game area.
 * Both emit the SAME 'player_move' { direction } event the keyboard already uses, so no
 * game logic changes. The D-pad markup lives in index.html and is shown via CSS on small
 * screens; swipe is bound to #game-display.
 */
(function () {
    function move(direction) {
        if (direction && window.socket && window.socket.connected) {
            window.socket.emit('player_move', { direction: direction });
        }
    }

    function initDpad() {
        var map = { 'dpad-up': 'up', 'dpad-down': 'down', 'dpad-left': 'left', 'dpad-right': 'right' };
        Object.keys(map).forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            // touchstart drives touch input; preventDefault cancels the emulated click so a
            // single tap doesn't move twice. click handles mouse (desktop testing).
            el.addEventListener('touchstart', function (e) { e.preventDefault(); move(map[id]); }, { passive: false });
            el.addEventListener('click', function () { move(map[id]); });
        });
    }

    function initSwipe() {
        var area = document.getElementById('game-display');
        if (!area) return;
        var sx = 0, sy = 0, tracking = false;
        var THRESHOLD = 24; // px before a drag counts as a swipe
        area.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) { tracking = false; return; }
            sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
        }, { passive: true });
        area.addEventListener('touchend', function (e) {
            if (!tracking) return;
            tracking = false;
            var t = e.changedTouches[0];
            var dx = t.clientX - sx, dy = t.clientY - sy;
            var adx = Math.abs(dx), ady = Math.abs(dy);
            if (adx < THRESHOLD && ady < THRESHOLD) return; // a tap, not a swipe
            if (adx > ady) move(dx > 0 ? 'right' : 'left');
            else move(dy > 0 ? 'down' : 'up');
        }, { passive: true });
    }

    function init() {
        // Mark touch devices so the D-pad also shows on touch tablets / landscape phones
        // wider than the mobile media-query breakpoint.
        if ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0) {
            document.body.classList.add('touch');
        }
        initDpad();
        initSwipe();
    }
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
})();
