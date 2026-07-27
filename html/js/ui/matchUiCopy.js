(function (root) {
    'use strict';

    var MODES = {
        race: {
            label: 'Dungeon Race',
            description: 'Outrun the other delvers, survive the shared dungeon, and reach the exit first.',
            badge: 'FIRST TO EXIT',
            objective: 'Reach the exit (→) first.',
            participant: 'racer',
            complete: 'Race complete',
            victory: '🏆 You escaped first!'
        },
        'last-alive': {
            label: 'Last Delver Standing',
            description: 'Rivals can strike each other down. Survive the dungeon and be the last contender alive.',
            badge: 'LAST ALIVE',
            objective: 'Stay alive; move into a rival to strike.',
            participant: 'contender',
            complete: 'Last-delver round complete',
            victory: '🏆 You are the last delver standing!'
        },
        'score-attack': {
            label: 'Score Attack',
            description: 'Build the strongest run before the arena clock expires.',
            badge: 'HIGH SCORE',
            objective: 'Build the highest score before time expires.',
            participant: 'delver',
            complete: 'Score attack complete',
            victory: '🏆 You set the high score!'
        },
        'coop-escape': {
            label: 'Co-op Escape',
            description: 'Work together and get every surviving delver to safety.',
            badge: 'TEAM ESCAPE',
            objective: 'Work together and get every surviving delver to the exit (→).',
            participant: 'teammate',
            complete: 'Co-op expedition complete',
            victory: '🤝 Team escaped!'
        }
    };

    function cleanId(raw) {
        var id = raw && (raw.id || raw.rulesetId);
        return Object.prototype.hasOwnProperty.call(MODES, id) ? id : 'race';
    }

    function normalize(raw) {
        raw = raw || {};
        var id = cleanId(raw);
        var base = MODES[id];
        var win = raw.winCondition;
        if (win && typeof win === 'object') win = win.type;
        return {
            id: id,
            label: raw.label || base.label,
            description: raw.description || raw.summary || base.description,
            badge: String(win || raw.win || base.badge).replace(/[-_]/g, ' ').toUpperCase(),
            objective: base.objective,
            participant: base.participant,
            complete: base.complete,
            victory: base.victory,
            cooperative: id === 'coop-escape'
        };
    }

    function fromPayload(data, fallback) {
        data = data || {};
        var state = data.state || data.gameState || {};
        return normalize(data.ruleset || state.ruleset || fallback || {});
    }

    function plural(mode, count) {
        var word = normalize(mode).participant;
        return word + (Number(count) === 1 ? '' : 's');
    }

    function playerFor(players, viewerId) {
        players = Array.isArray(players) ? players : [];
        for (var i = 0; i < players.length; i++) {
            var player = players[i];
            if (player && (player.you || (viewerId && player.id === viewerId))) return player;
        }
        return null;
    }

    function winnerFor(data, players) {
        players = Array.isArray(players) ? players : [];
        for (var i = 0; i < players.length; i++) {
            if (players[i] && players[i].id === data.winnerId) return players[i];
        }
        return null;
    }

    function finalResult(data, viewerId, fallbackRuleset) {
        data = data || {};
        var players = Array.isArray(data.players) ? data.players : [];
        var mode = fromPayload(data, fallbackRuleset);
        var me = playerFor(players, viewerId);
        var reason = data.reason || data.endReason || '';

        if (mode.cooperative) {
            var escaped = reason === 'all_escaped';
            var detail = '';
            if (me) detail = me.escaped ? 'you reached safety' : 'you did not escape';
            return {
                mode: mode,
                won: escaped,
                headline: escaped ? mode.victory : '☠️ The expedition was lost',
                detail: detail,
                text: (escaped ? mode.victory : '☠️ The expedition was lost') + (detail ? ' · ' + detail : '')
            };
        }

        var winner = winnerFor(data, players);
        var won = !!me && (me.id === data.winnerId || (!data.winnerId && Number(me.placement) === 1));
        var details = [];
        if (me && me.placement) details.push('you placed #' + me.placement);
        if (mode.id === 'score-attack' && me && Number.isFinite(Number(me.score))) {
            details.push('score ' + Number(me.score));
        }
        if (!won && winner) details.push('winner: ' + (winner.name || 'another delver'));
        var headline = won ? mode.victory : mode.complete;
        return {
            mode: mode,
            won: won,
            headline: headline,
            detail: details.join(' · '),
            text: headline + (details.length ? ' · ' + details.join(' · ') : '')
        };
    }

    function liveSummary(state, viewerId, fallbackRuleset) {
        state = state || {};
        var players = Array.isArray(state.players) ? state.players : [];
        var mode = fromPayload({ state: state }, fallbackRuleset);
        var me = playerFor(players, viewerId);
        var alive = players.filter(function (p) { return p && p.alive !== false && !p.finished; }).length;
        var escaped = players.filter(function (p) { return p && p.escaped; }).length;

        if (mode.id === 'last-alive') {
            return alive + ' ' + plural(mode, alive) + ' still in' + (me && me.alive === false ? ' · you are out' : '');
        }
        if (mode.id === 'score-attack') {
            return alive + ' ' + plural(mode, alive) + ' still scoring' + (me && me.alive === false ? ' · you are out' : '');
        }
        if (mode.cooperative) {
            return escaped + '/' + players.length + ' safe · ' + alive + ' still exploring';
        }
        if (me && me.escaped) return 'You escaped';
        if (me && me.alive === false) return 'You are out · ' + alive + ' still racing';
        return players.length + ' ' + plural(mode, players.length) + ' in the dungeon';
    }

    root.MatchUiCopy = {
        modes: MODES,
        normalize: normalize,
        fromPayload: fromPayload,
        plural: plural,
        finalResult: finalResult,
        liveSummary: liveSummary
    };
})(window);
