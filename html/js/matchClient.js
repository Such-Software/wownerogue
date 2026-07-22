(function () {
    'use strict';

    var socketOpts = { transports: ['websocket', 'polling'] };
    try {
        var resumeToken = localStorage.getItem('wownerogue_token');
        if (resumeToken) socketOpts.auth = { resumeToken: resumeToken };
    } catch (_) {}
    var socket = io(socketOpts);
    var RK = window.RK || {};

    var els = {
        economies: document.getElementById('economies'),
        status: document.getElementById('status'),
        queueBtn: document.getElementById('queueBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        queuePanel: document.getElementById('queuePanel'),
        racePanel: document.getElementById('racePanel'),
        raceMode: document.getElementById('raceMode'),
        raceEconomy: document.getElementById('raceEconomy'),
        raceTimer: document.getElementById('raceTimer'),
        racePlace: document.getElementById('racePlace'),
        raceResult: document.getElementById('raceResult'),
        stage: document.getElementById('stage'),
        renderModes: document.getElementById('renderModes'),
        modeTitle: document.getElementById('modeTitle'),
        modeDescription: document.getElementById('modeDescription'),
        modeBadge: document.getElementById('modeBadge'),
        rulesetCatalog: document.getElementById('rulesetCatalog'),
        economyHelp: document.getElementById('economyHelp'),
        objectiveHint: document.getElementById('objectiveHint'),
        dpad: document.getElementById('matchDpad')
    };

    var ECONOMIES = {
        free: { label: 'Free / Pleb', description: 'No entry cost · separate free board for competitive modes', available: 'FREE ENTRY' },
        credits_prestige: { label: 'Prestige', description: 'Spend credits · PvP Prestige board only', available: 'PAID CREDITS' },
        crypto_race: { label: 'Stagenet Stakes', description: 'Race-entry ticket · Champions board and the disclosed pot payout', available: 'STAGENET / CRYPTO' }
    };
    var MatchCopy = window.MatchUiCopy;

    var gameModeInfo = null;
    var activeRuleset = MatchCopy.normalize({ id: 'race' });
    var selectedEconomy = 'free';
    var inQueue = false;
    var inRace = false;
    var mySocketId = socket.id || null;
    var renderer = null;
    var rendererPending = false;
    var rendererToken = 0;
    var camera = null;
    var mode = (RK.loadMode && RK.loadMode('tiles')) || 'tiles';
    var keyState = {};
    var lastState = null;
    var tickMs = 250;
    var countdownTimer = null;
    var resultTimer = null;

    function setStatus(msg) { els.status.textContent = msg; }
    function verifyMatchReveal(fairness) {
        if (!fairness || !fairness.seed || !/^[0-9a-f]{64}$/i.test(fairness.seedHash || '')) {
            return Promise.resolve(null);
        }
        if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') {
            return Promise.resolve(null);
        }
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(fairness.seed))
            .then(function (digest) {
                var actual = Array.from(new Uint8Array(digest))
                    .map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
                return actual === String(fairness.seedHash).toLowerCase();
            }).catch(function () { return null; });
    }
    function matchInfo() {
        return gameModeInfo && gameModeInfo.modes && gameModeInfo.modes.match;
    }
    function economyLabel(id) { return (ECONOMIES[id] && ECONOMIES[id].label) || id || 'Match'; }

    function normalizedRuleset(raw) {
        return MatchCopy.normalize(raw);
    }

    function applyRuleset(raw) {
        activeRuleset = normalizedRuleset(raw);
        els.modeTitle.textContent = activeRuleset.label;
        els.modeDescription.textContent = activeRuleset.description;
        els.modeBadge.textContent = activeRuleset.badge || 'LIVE MATCH';
        els.objectiveHint.textContent = 'Arrow keys / WASD · ' + activeRuleset.objective + ' · drag or pinch the camera';
        els.economyHelp.textContent = activeRuleset.cooperative
            ? 'Co-op is a team result and does not create an individual leaderboard winner.'
            : 'Free, Prestige, and Champions results remain on separate boards.';
    }

    function renderRulesets() {
        var info = matchInfo() || {};
        applyRuleset(info.activeRuleset || { id: info.rulesetId || 'race' });
        els.rulesetCatalog.innerHTML = '';
        var catalog = Array.isArray(info.rulesets) && info.rulesets.length ? info.rulesets : [activeRuleset];
        catalog.forEach(function (raw) {
            var r = normalizedRuleset(raw);
            var chip = document.createElement('span');
            chip.className = 'tag' + (r.id === activeRuleset.id ? ' active' : '');
            chip.textContent = r.label;
            chip.title = r.id === activeRuleset.id ? 'Active on this server' : 'Available to the operator';
            els.rulesetCatalog.appendChild(chip);
        });
    }

    function renderEconomies() {
        var info = matchInfo();
        if (!info || !info.enabled) {
            els.economies.innerHTML = '';
            setStatus('Multiplayer mode is not enabled on this server.');
            els.queueBtn.disabled = true;
            return;
        }

        var available = info.economies || {};
        var availableKeys = Object.keys(ECONOMIES).filter(function (key) { return !!available[key]; });
        if (!available[selectedEconomy] && availableKeys.length) selectedEconomy = availableKeys[0];
        els.economies.innerHTML = '';
        Object.keys(ECONOMIES).forEach(function (key) {
            var def = ECONOMIES[key];
            var locked = !available[key];
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'economy' + (key === selectedEconomy && !locked ? ' active' : '') + (locked ? ' locked' : '');
            button.dataset.economy = key;
            button.disabled = locked;
            button.setAttribute('aria-pressed', key === selectedEconomy && !locked ? 'true' : 'false');
            var title = document.createElement('strong'); title.textContent = def.label;
            var desc = document.createElement('small'); desc.textContent = def.description;
            var avail = document.createElement('small'); avail.className = 'availability'; avail.textContent = locked ? 'NOT ENABLED' : def.available;
            button.appendChild(title); button.appendChild(desc); button.appendChild(avail);
            if (!locked) button.addEventListener('click', function () {
                selectedEconomy = key;
                renderEconomies();
            });
            els.economies.appendChild(button);
        });
        els.queueBtn.disabled = availableKeys.length === 0;
    }

    function renderModeButtons() {
        if (!els.renderModes || !RK.RENDER_MODES) return;
        els.renderModes.innerHTML = '';
        RK.RENDER_MODES.forEach(function (meta) {
            var availability = RK.modeAvailability
                ? RK.modeAvailability(meta.id)
                : { usable: !RK.canUseMode || RK.canUseMode(meta.id), runtimeAvailable: true };
            var usable = availability.usable;
            var b = document.createElement('button');
            b.type = 'button'; b.textContent = meta.label
                + (!availability.runtimeAvailable ? ' ⛔' : (meta.premium ? ' ★' : ''));
            b.className = (meta.id === mode ? 'active ' : '') + (usable ? '' : 'locked');
            b.disabled = !usable;
            if (!availability.runtimeAvailable) {
                b.title = 'Unavailable on this server: optional renderer dependency disabled.';
            } else if (!usable) b.title = 'Unlock a compatible render pack with credits.';
            b.addEventListener('click', function () { switchRenderMode(meta.id); });
            els.renderModes.appendChild(b);
        });
    }

    function defaultZoomForMode(name) { return name === 'iso' ? 0.82 : (name === '3d' ? 1.15 : 1.45); }
    function ensureCamera() {
        if (!camera && RK.attachCamera) camera = RK.attachCamera(els.stage, { zoom: defaultZoomForMode(mode), min: 0.5, max: 3.2 });
        return camera;
    }
    function destroyRenderer() {
        rendererToken++;
        rendererPending = false;
        if (renderer && renderer.destroy) { try { renderer.destroy(); } catch (_) {} }
        renderer = null;
    }
    function ensureRenderer() {
        if (renderer || rendererPending) return;
        rendererPending = true;
        var token = ++rendererToken;
        var done = function (next) {
            if (token !== rendererToken) { if (next && next.destroy) next.destroy(); return; }
            rendererPending = false;
            renderer = next;
            ensureCamera();
            if (camera) camera.setZoom(defaultZoomForMode(renderer.name || mode));
            renderState(lastState);
        };
        if (RK.createRendererAsync) RK.createRendererAsync(mode, els.stage, { cell: 26 }, done);
        else if (RK.createRenderer) done(RK.createRenderer(mode, els.stage, { cell: 26 }));
    }
    function switchRenderMode(next) {
        if (next === mode || (RK.canUseMode && !RK.canUseMode(next))) return;
        mode = next;
        if (RK.saveMode) RK.saveMode(mode);
        renderModeButtons();
        destroyRenderer();
        if (inRace && lastState) ensureRenderer();
    }
    function renderState(state) {
        if (!state || !renderer) return;
        var scene = RK.sceneFromGameState ? RK.sceneFromGameState(state, {
            viewerId: mySocketId,
            cryptoType: gameModeInfo && gameModeInfo.cryptoType
        }) : null;
        if (!scene) return;
        renderer.render(scene);
        if (camera) camera.update(renderer);
    }

    function clearCountdown() {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
    }
    function showCountdown(data) {
        clearCountdown();
        var ruleset = MatchCopy.fromPayload(data, activeRuleset);
        applyRuleset(ruleset);
        var ends = Date.now() + Math.max(0, Number(data.countdownMs) || 0);
        function update() {
            var left = Math.max(0, ends - Date.now());
            var count = data.players ? data.players.length : 0;
            setStatus('Match found · ' + count + ' ' + MatchCopy.plural(ruleset, count) + ' · starts in ' + (left / 1000).toFixed(1) + 's');
            if (left <= 0) clearCountdown();
        }
        update();
        countdownTimer = setInterval(update, 100);
    }
    function startRace(data, initialState) {
        clearCountdown();
        if (resultTimer) clearTimeout(resultTimer);
        inQueue = false;
        inRace = true;
        applyRuleset(MatchCopy.fromPayload({ ruleset: data && data.ruleset, state: initialState }, activeRuleset));
        tickMs = Math.max(50, Number(data && data.tickMs) || tickMs || 250);
        els.queuePanel.classList.add('hidden');
        els.racePanel.classList.remove('hidden');
        els.raceResult.classList.add('hidden');
        els.raceResult.textContent = '';
        els.raceResult.title = '';
        els.raceMode.textContent = activeRuleset.label;
        els.raceEconomy.textContent = economyLabel((initialState && initialState.economy) || selectedEconomy);
        els.raceTimer.textContent = '0.0s';
        els.racePlace.textContent = 'Waiting for first move';
        renderModeButtons();
        lastState = initialState || null;
        ensureRenderer();
        if (lastState) renderState(lastState);
    }

    socket.on('connect', function () {
        mySocketId = socket.id;
        socket.emit('register_client', { clientId: socket.id, userAgent: navigator.userAgent });
        socket.emit('match_reconnect', {});
        setStatus(inRace ? 'Reconnected to the arena.' : 'Connected. Loading server modes…');
    });
    socket.on('session_token', function (data) {
        try { if (data && data.token) localStorage.setItem('wownerogue_token', data.token); } catch (_) {}
    });
    socket.on('session_resumed', function (data) {
        try { if (data && data.token) localStorage.setItem('wownerogue_token', data.token); } catch (_) {}
    });

    socket.on('game_mode_info', function (info) {
        gameModeInfo = info || {};
        if (RK.setEntitlementSnapshot && info && info.entitlements) RK.setEntitlementSnapshot(info.entitlements);
        renderRulesets();
        renderEconomies();
        renderModeButtons();
        if (matchInfo() && matchInfo().enabled && !inQueue && !inRace) {
            setStatus('Ready. Choose an entry mode and join the next ' + activeRuleset.label.toLowerCase() + '.');
        }
    });

    socket.on('match_queue_joined', function (res) {
        els.queueBtn.disabled = false;
        if (res && res.success) {
            inQueue = true;
            els.queueBtn.classList.add('hidden');
            els.leaveBtn.classList.remove('hidden');
            setStatus('Queued for ' + economyLabel(selectedEconomy) + ' · position ' + (res.position || '?') + ' · waiting for the next block.');
        } else {
            setStatus('Queue failed: ' + ((res && (res.reason || res.message)) || 'unknown error'));
        }
    });

    socket.on('match_queue_left', function (res) {
        inQueue = false;
        els.queueBtn.classList.remove('hidden');
        els.leaveBtn.classList.add('hidden');
        setStatus(res && res.success ? 'Left the queue. Any held entry was returned.' : 'Could not leave: ' + ((res && res.reason) || 'unknown error'));
    });

    socket.on('match_joined', function (data) {
        if (!data) return;
        selectedEconomy = data.economy || selectedEconomy;
        showCountdown(data);
    });

    socket.on('match_start', function (data) { startRace(data || {}, null); });
    socket.on('match_rejoined', function (data) {
        if (!data || !data.state) return;
        selectedEconomy = data.state.economy || selectedEconomy;
        startRace({ tickMs: tickMs }, data.state);
    });

    socket.on('match_tick', function (data) {
        if (!data || !data.state) return;
        if (!inRace) startRace({ tickMs: tickMs }, data.state);
        lastState = data.state;
        ensureRenderer();
        renderState(lastState);
        var tick = Number(data.tick != null ? data.tick : lastState.tick) || 0;
        els.raceTimer.textContent = (tick * tickMs / 1000).toFixed(1) + 's';
        els.racePlace.textContent = MatchCopy.liveSummary(lastState, mySocketId, activeRuleset);
    });

    socket.on('match_end', function (data) {
        data = data || {};
        inRace = false;
        var result = MatchCopy.finalResult(data, mySocketId, activeRuleset);
        applyRuleset(result.mode);
        els.raceResult.textContent = result.text;
        if (data.fairness && data.fairness.seed) {
            els.raceResult.title = 'Seed: ' + data.fairness.seed
                + '\nCommitment: ' + data.fairness.seedHash
                + '\nSource: ' + (data.fairness.scope || data.fairness.version || 'commitment');
            verifyMatchReveal(data.fairness).then(function (valid) {
                if (valid === true) els.raceResult.textContent += ' · seed proof ✓';
                else if (valid === false) els.raceResult.textContent += ' · seed proof FAILED';
                else els.raceResult.textContent += ' · seed revealed';
            });
        }
        els.raceResult.classList.remove('hidden');
        resultTimer = setTimeout(function () {
            if (inRace) return;
            els.racePanel.classList.add('hidden');
            els.queuePanel.classList.remove('hidden');
            els.raceResult.classList.add('hidden');
            els.queueBtn.classList.remove('hidden');
            els.leaveBtn.classList.add('hidden');
            lastState = null;
            destroyRenderer();
            setStatus('Ready for another ' + activeRuleset.label.toLowerCase() + '.');
        }, 5000);
    });

    socket.on('match_settlement_pending', function () {
        // The server deliberately withholds match_end until its authoritative finish transaction
        // commits. Keep this player in the arena mapping while the bounded retry runs.
        els.raceResult.textContent = 'Result pending durable settlement · retrying safely…';
        els.raceResult.classList.remove('hidden');
        setStatus('The arena result is not final yet. No final result has been published.');
    });

    socket.on('match_error', function (err) {
        setStatus('Arena error: ' + ((err && (err.message || err.reason)) || 'unknown error'));
    });
    socket.on('commerce_ack_required', function (err) {
        setStatus((err && (err.message || err.error)) || 'Review the paid-play disclosures before joining.');
        if (window.CommerceConsent && window.CommerceConsent.require) {
            var refreshed = window.CommerceConsent.reject
                ? window.CommerceConsent.reject(err)
                : Promise.resolve();
            refreshed.catch(function () { return null; }).then(function () {
                window.CommerceConsent.require(function () {
                    setStatus('Disclosures acknowledged. Retry the paid queue when ready.');
                });
            });
        }
    });
    socket.on('disconnect', function () {
        clearCountdown();
        if (window.CommerceConsent && window.CommerceConsent.clear) window.CommerceConsent.clear();
        setStatus(inRace ? 'Connection lost · attempting to rejoin your match…' : 'Disconnected · reconnecting…');
    });

    els.queueBtn.addEventListener('click', function () {
        if (inQueue || inRace) return;
        function join(acknowledgement) {
            els.queueBtn.disabled = true;
            setStatus('Joining ' + economyLabel(selectedEconomy) + '…');
            var payload = { economy: selectedEconomy, action: 'join' };
            if (acknowledgement) payload.legalAcknowledgement = acknowledgement;
            socket.emit('match_queue', payload);
            setTimeout(function () { if (!inQueue && !inRace) els.queueBtn.disabled = false; }, 1500);
        }
        if (selectedEconomy !== 'free' && window.CommerceConsent) {
            window.CommerceConsent.require(join);
        } else {
            join(null);
        }
    });
    els.leaveBtn.addEventListener('click', function () {
        if (!inQueue) return;
        socket.emit('match_queue', { economy: selectedEconomy, action: 'leave' });
    });

    function sendMove(dx, dy) {
        if (!inRace || !socket.connected) return;
        socket.emit('match_move', { dx: dx, dy: dy });
    }
    function directionMove(dir) {
        if (dir === 'up') sendMove(0, -1);
        else if (dir === 'down') sendMove(0, 1);
        else if (dir === 'left') sendMove(-1, 0);
        else if (dir === 'right') sendMove(1, 0);
    }
    window.addEventListener('keydown', function (e) {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (keyState[e.key]) return;
        keyState[e.key] = true;
        if (['ArrowUp', 'w', 'W'].indexOf(e.key) !== -1) { e.preventDefault(); directionMove('up'); }
        else if (['ArrowDown', 's', 'S'].indexOf(e.key) !== -1) { e.preventDefault(); directionMove('down'); }
        else if (['ArrowLeft', 'a', 'A'].indexOf(e.key) !== -1) { e.preventDefault(); directionMove('left'); }
        else if (['ArrowRight', 'd', 'D'].indexOf(e.key) !== -1) { e.preventDefault(); directionMove('right'); }
    });
    window.addEventListener('keyup', function (e) { keyState[e.key] = false; });
    window.addEventListener('blur', function () { keyState = {}; });
    if (els.dpad) Array.prototype.forEach.call(els.dpad.querySelectorAll('[data-dir]'), function (b) {
        // Native click covers mouse/touch plus Enter and Space activation for keyboard and AT users.
        b.addEventListener('click', function () { directionMove(b.dataset.dir); });
    });
}());
