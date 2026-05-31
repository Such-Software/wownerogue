/**
 * Leaderboard Panel
 * Displays high scores with period filtering
 */
const Leaderboard = {
    _isLoading: false,
    _currentPeriod: 'all',

    init: function() {
        $('#leaderboardButton').on('click', function() {
            Leaderboard.show();
        });

        // Listen for real-time leaderboard updates
        if (window.socket) {
            window.socket.on('leaderboard_update', function(data) {
                // Refresh if modal is visible
                if ($('#leaderboard-panel').is(':visible')) {
                    Leaderboard._fetchAndRender();
                }
            });
        }
    },

    show: function() {
        this._ensurePanel();
        $('#leaderboard-panel').show();
        this._fetchAndRender();
    },

    _ensurePanel: function() {
        if ($('#leaderboard-panel').length) return;

        var panel = $(
            '<div id="leaderboard-panel" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:2100; background:rgba(10,10,20,0.97); border:2px solid #f59e0b; padding:20px; color:#e0e0e0; min-width:380px; max-width:500px; max-height:80vh; overflow-y:auto; box-shadow:0 0 20px rgba(245,158,11,0.3); border-radius:6px;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">' +
                    '<strong style="color:#fbbf24; font-size:1.1em;">🏆 Leaderboard</strong>' +
                    '<button id="close-leaderboard" style="background:#500; color:#f00; border:1px solid #f00; padding:2px 8px; cursor:pointer; font-size:14px;">✕</button>' +
                '</div>' +
                '<div id="leaderboard-tabs" style="display:flex; gap:4px; margin-bottom:12px;">' +
                    '<button class="lb-tab" data-period="all" style="flex:1; padding:6px; font-size:11px; cursor:pointer; border:1px solid #555; border-radius:3px;">All Time</button>' +
                    '<button class="lb-tab" data-period="month" style="flex:1; padding:6px; font-size:11px; cursor:pointer; border:1px solid #555; border-radius:3px;">Month</button>' +
                    '<button class="lb-tab" data-period="week" style="flex:1; padding:6px; font-size:11px; cursor:pointer; border:1px solid #555; border-radius:3px;">Week</button>' +
                '</div>' +
                '<div id="leaderboard-content" style="font-size:12px;">Loading...</div>' +
                '<div style="margin-top:10px; font-size:10px; color:#666; text-align:center;">Set your name: type /nick YourName in chat</div>' +
            '</div>'
        );

        $('body').append(panel);

        $('#close-leaderboard').on('click', function() {
            $('#leaderboard-panel').hide();
        });

        var self = this;
        $(document).on('click', '.lb-tab', function() {
            self._currentPeriod = $(this).data('period');
            self._updateTabs();
            self._fetchAndRender();
        });

        this._updateTabs();
    },

    _updateTabs: function() {
        var current = this._currentPeriod;
        $('.lb-tab').each(function() {
            if ($(this).data('period') === current) {
                $(this).css({ background: '#92400e', color: '#fff', borderColor: '#f59e0b' });
            } else {
                $(this).css({ background: '#1a1a2e', color: '#aaa', borderColor: '#555' });
            }
        });
    },

    _fetchAndRender: function() {
        if (this._isLoading) return;
        this._isLoading = true;
        $('#leaderboard-content').html('<div style="text-align:center; color:#888;">Loading...</div>');

        var self = this;
        $.getJSON('/api/leaderboard?period=' + this._currentPeriod + '&limit=20')
            .done(function(data) {
                self._render(data.leaderboard || []);
            })
            .fail(function() {
                $('#leaderboard-content').html('<div style="text-align:center; color:#f66;">Failed to load leaderboard</div>');
            })
            .always(function() {
                self._isLoading = false;
            });
    },

    _render: function(entries) {
        if (!entries.length) {
            $('#leaderboard-content').html('<div style="text-align:center; color:#888; padding:20px;">No scores yet. Play a game to be first!</div>');
            return;
        }

        var html = '<table style="width:100%; border-collapse:collapse;">';
        html += '<thead><tr style="border-bottom:1px solid #444; color:#fbbf24; font-size:11px;">';
        html += '<th style="text-align:left; padding:4px;">#</th>';
        html += '<th style="text-align:left; padding:4px;">Player</th>';
        html += '<th style="text-align:right; padding:4px;">Best</th>';
        html += '<th style="text-align:right; padding:4px;">Wins</th>';
        html += '<th style="text-align:right; padding:4px;">Games</th>';
        html += '</tr></thead><tbody>';

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var rankColor = i === 0 ? '#fbbf24' : (i === 1 ? '#c0c0c0' : (i === 2 ? '#cd7f32' : '#888'));
            var rankIcon = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : (i + 1)));
            var bgColor = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent';

            html += '<tr style="border-bottom:1px solid #222; background:' + bgColor + ';">';
            html += '<td style="padding:6px 4px; color:' + rankColor + '; font-weight:bold;">' + rankIcon + '</td>';
            html += '<td style="padding:6px 4px; color:#e0e0e0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + Leaderboard._escapeHtml(e.name) + '</td>';
            html += '<td style="padding:6px 4px; text-align:right; color:#4ade80; font-weight:bold;">' + (e.best_score || 0) + '</td>';
            html += '<td style="padding:6px 4px; text-align:right; color:#60a5fa;">' + (e.wins || 0) + '</td>';
            html += '<td style="padding:6px 4px; text-align:right; color:#888;">' + (e.games_played || 0) + '</td>';
            html += '</tr>';
        }

        html += '</tbody></table>';
        $('#leaderboard-content').html(html);
    },

    _escapeHtml: function(str) {
        // Delegate to the shared helper (single source of truth). Falls back to a local
        // implementation if the helper somehow isn't loaded.
        if (typeof window !== 'undefined' && typeof window.escapeHtml === 'function') {
            return window.escapeHtml(str);
        }
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
};

// Initialize when DOM is ready
$(document).ready(function() {
    Leaderboard.init();
});
