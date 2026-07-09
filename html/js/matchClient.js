(function () {
    'use strict';

    const socket = io({ transports: ['websocket', 'polling'] });

    const els = {
        economies: document.getElementById('economies'),
        status: document.getElementById('status'),
        queueBtn: document.getElementById('queueBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        queuePanel: document.getElementById('queuePanel'),
        racePanel: document.getElementById('racePanel'),
        raceEconomy: document.getElementById('raceEconomy'),
        raceTimer: document.getElementById('raceTimer'),
        racePlace: document.getElementById('racePlace'),
        stage: document.getElementById('stage')
    };

    let gameModeInfo = null;
    let selectedEconomy = 'free';
    let inQueue = false;
    let inRace = false;
    let mySocketId = null;
    let renderer = null;
    let mode = 'tiles';
    let keyState = {};

    function setStatus(msg) {
        els.status.textContent = msg;
    }

    function renderEconomies() {
        if (!gameModeInfo || !gameModeInfo.modes || !gameModeInfo.modes.match || !gameModeInfo.modes.match.enabled) {
            els.economies.innerHTML = '';
            setStatus('Match mode is not enabled on this server.');
            els.queueBtn.disabled = true;
            return;
        }

        const available = gameModeInfo.modes.match.economies || {};
        const labels = {
            free: 'Free',
            credits_prestige: 'Prestige Credits',
            crypto_race: 'Crypto Race'
        };

        els.economies.innerHTML = '';
        Object.keys(labels).forEach(function (key) {
            const locked = !available[key];
            const el = document.createElement('div');
            el.className = 'economy' + (key === selectedEconomy ? ' active' : '') + (locked ? ' locked' : '');
            el.textContent = labels[key];
            if (!locked) {
                el.addEventListener('click', function () {
                    selectedEconomy = key;
                    renderEconomies();
                });
            }
            els.economies.appendChild(el);
        });

        els.queueBtn.disabled = false;
    }

    socket.on('connect', function () {
        mySocketId = socket.id;
        setStatus('Connected. Waiting for server info…');
    });

    socket.on('game_mode_info', function (info) {
        gameModeInfo = info;
        renderEconomies();
        if (gameModeInfo?.modes?.match?.enabled) {
            setStatus('Ready to queue. Choose an economy and click Join Queue.');
        }
    });

    socket.on('match_queue_joined', function (res) {
        if (res.success) {
            inQueue = true;
            els.queueBtn.classList.add('hidden');
            els.leaveBtn.classList.remove('hidden');
            setStatus('Queued for ' + selectedEconomy + ' (position ' + (res.position || '?') + '). Waiting for next race…');
        } else {
            setStatus('Queue failed: ' + (res.reason || 'unknown'));
        }
    });

    socket.on('match_queue_left', function (res) {
        inQueue = false;
        els.queueBtn.classList.remove('hidden');
        els.leaveBtn.classList.add('hidden');
        setStatus(res.success ? 'Left queue.' : 'Leave failed: ' + (res.reason || 'unknown'));
    });

    socket.on('match_joined', function (data) {
        setStatus('Race starting! Seed: ' + data.seedHash.slice(0, 12) + '…');
    });

    socket.on('match_start', function (data) {
        inQueue = false;
        inRace = true;
        els.queuePanel.classList.add('hidden');
        els.racePanel.classList.remove('hidden');
        els.raceEconomy.textContent = 'Economy: ' + selectedEconomy;
        els.raceTimer.textContent = 'Timer: 0s';
        els.racePlace.textContent = 'Place: —';

        if (!renderer) {
            renderer = RK.createRenderer(mode, els.stage, {});
        }
    });

    socket.on('match_tick', function (data) {
        if (!renderer || !data.state) return;
        const scene = RK.sceneFromGameState ? RK.sceneFromGameState(data.state, mySocketId) : null;
        if (scene) renderer.render(scene);

        const me = data.state.players.find(function (p) { return p.you; });
        if (me) {
            els.racePlace.textContent = 'Place: ' + (me.placement || '—') + (me.alive ? '' : ' 💀');
        }
    });

    socket.on('match_end', function (data) {
        inRace = false;
        const me = data.players.find(function (p) { return p.id === mySocketId; });
        setStatus('Race over! ' + (data.reason || '') + ' — your placement: ' + (me ? me.placement : '—'));
        setTimeout(function () {
            if (!inRace) return;
            els.racePanel.classList.add('hidden');
            els.queuePanel.classList.remove('hidden');
            els.queueBtn.classList.remove('hidden');
            els.leaveBtn.classList.add('hidden');
        }, 5000);
    });

    socket.on('match_error', function (err) {
        setStatus('Match error: ' + (err.reason || 'unknown'));
    });

    socket.on('disconnect', function () {
        setStatus('Disconnected. Reconnecting…');
        inQueue = false;
        inRace = false;
    });

    els.queueBtn.addEventListener('click', function () {
        if (inQueue || inRace) return;
        socket.emit('match_queue', { economy: selectedEconomy, action: 'join' });
    });

    els.leaveBtn.addEventListener('click', function () {
        if (!inQueue) return;
        socket.emit('match_queue', { economy: selectedEconomy, action: 'leave' });
    });

    function sendMove(dx, dy) {
        if (!inRace) return;
        socket.emit('match_move', { dx: dx, dy: dy });
    }

    window.addEventListener('keydown', function (e) {
        if (keyState[e.key]) return; // already pressed
        keyState[e.key] = true;
        if (['ArrowUp', 'w', 'W'].includes(e.key)) { e.preventDefault(); sendMove(0, -1); }
        else if (['ArrowDown', 's', 'S'].includes(e.key)) { e.preventDefault(); sendMove(0, 1); }
        else if (['ArrowLeft', 'a', 'A'].includes(e.key)) { e.preventDefault(); sendMove(-1, 0); }
        else if (['ArrowRight', 'd', 'D'].includes(e.key)) { e.preventDefault(); sendMove(1, 0); }
    });

    window.addEventListener('keyup', function (e) {
        keyState[e.key] = false;
    });
}());
