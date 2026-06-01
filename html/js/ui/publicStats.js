/**
 * Public stats strip — light "social proof" shown in the status area: games and escapes in
 * the last 24h, and total paid out (only where payouts are enabled). Polls /api/stats, which
 * is cached server-side (10s), so a 30s poll is cheap. Online-player count is intentionally
 * NOT shown here — it already updates live via the 'user_count' socket event.
 */
(function () {
    var EL_ID = 'publicStats';

    function fmtAmount(n) {
        if (!isFinite(n)) return '0';
        // Trim to a tidy magnitude: whole numbers plain, otherwise up to 4 dp without trailing zeros.
        if (n >= 1000) return Math.round(n).toLocaleString();
        var s = (Math.round(n * 10000) / 10000).toString();
        return s;
    }

    function render(data) {
        var el = document.getElementById(EL_ID);
        if (!el || !data) return;
        var parts = [];
        parts.push('🎮 ' + (data.gamesToday || 0) + ' games (24h)');
        parts.push('🏆 ' + (data.escapesToday || 0) + ' escapes');
        if (data.payoutsEnabled && data.totalPaidOut > 0) {
            parts.push('💰 ' + fmtAmount(data.totalPaidOut) + ' ' + (data.currencyLabel || '') + ' paid out');
        }
        el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
        el.style.display = 'block';
    }

    function poll() {
        fetch('/api/stats')
            .then(function (r) { return r.json(); })
            .then(render)
            .catch(function () { /* ignore; transient */ });
    }

    function start() {
        poll();
        setInterval(poll, 30000);
    }

    if (document.readyState !== 'loading') start();
    else document.addEventListener('DOMContentLoaded', start);
})();
