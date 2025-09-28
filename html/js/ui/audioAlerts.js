/**
 * AudioAlerts: optional user-enabled audio notifications for key events
 *  - Payment confirmed (game about to start soon / queued)
 *  - Game start (focus attention)
 * Persists preference in localStorage and uses Web Audio or HTMLAudio fallback.
 */
const AudioAlerts = {
    _enabled: false,
    _initialized: false,
    _ctx: null,
    _gain: null,
    _volume: 0.4,
    _lastPlay: 0,
    _cooldownMs: 1500,
    _audioTags: {}, // cache HTMLAudioElements
    _fileMap: {
        request_coin: 'audio/Pleasesendcoin.m4a',
        payment_detected: 'audio/Paymentdetected.m4a',
        payment_confirmed: 'audio/Paymentconfirmed.m4a',
        game_start: 'audio/Nowescapethedunge.m4a',
        game_escaped: 'audio/Youescaped.m4a',
        game_escaped_treasure: 'audio/Youescapedwiththe.m4a',
        game_timeout: 'audio/Yourtimeranout.m4a',
        game_monster: 'audio/Youwererektbythe.m4a'
    },

    init() {
        if (this._initialized) return;
        this._initialized = true;
        // Load preference
        try {
            const saved = localStorage.getItem('wow_audioAlerts');
            this._enabled = saved === '1';
        } catch(_) {}
        const toggle = document.getElementById('audioAlertsToggle');
        if (toggle) {
            toggle.checked = this._enabled;
            toggle.addEventListener('change', () => {
                this._enabled = !!toggle.checked;
                try { localStorage.setItem('wow_audioAlerts', this._enabled ? '1':'0'); } catch(_) {}
                if (this._enabled) this._lazyInitContext();
            });
        }

        // Hook into socket events (if SocketHandlers already patched later)
        if (typeof SocketHandlers !== 'undefined') {
            this._patchSocketHandlers();
        }
    },

    _patchSocketHandlers() {
        if (SocketHandlers._audioAlertsPatched) return; // idempotent
        SocketHandlers._audioAlertsPatched = true;
        const origPaymentConfirmed = SocketHandlers.onPaymentConfirmed;
        const origPaymentDetected = SocketHandlers.onPaymentDetected;
        const origGameStart = SocketHandlers.onGameStart;
        const origGameOver = SocketHandlers.onGameOver;
        const origQueueJoined = SocketHandlers.onQueueJoined;
        SocketHandlers.onPaymentConfirmed = function(data) {
            if (origPaymentConfirmed) origPaymentConfirmed.call(SocketHandlers, data);
            AudioAlerts.playFile('payment_confirmed');
        };
        SocketHandlers.onPaymentDetected = function(data) {
            if (origPaymentDetected) origPaymentDetected.call(SocketHandlers, data);
            AudioAlerts.playFile('payment_detected');
        };
        SocketHandlers.onGameStart = function(data) {
            if (origGameStart) origGameStart.call(SocketHandlers, data);
            // Add delay to prevent overlap with payment_confirmed audio
            const lastPaymentConfirmed = AudioAlerts._audioTagTimes && AudioAlerts._audioTagTimes['payment_confirmed'];
            if (lastPaymentConfirmed && (Date.now() - lastPaymentConfirmed < 2000)) {
                // Delay game_start audio if payment_confirmed played recently
                setTimeout(() => AudioAlerts.playFile('game_start'), 1500);
            } else {
                AudioAlerts.playFile('game_start');
            }
        };
        SocketHandlers.onGameOver = function(data) {
            if (origGameOver) origGameOver.call(SocketHandlers, data);
            AudioAlerts.playGameOverSound(data);
        };
        // We'll trigger request_coin when user attempts start but is blocked for payment/credits; handled externally via public method
    },

    _lazyInitContext() {
        if (this._ctx) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this._ctx = new AudioCtx();
            this._gain = this._ctx.createGain();
            this._gain.gain.value = this._volume;
            this._gain.connect(this._ctx.destination);
        } catch (e) {
            console.warn('Audio context init failed:', e);
        }
    },

    playPattern(type) {
        if (!this._enabled) return;
        const now = Date.now();
        if (now - this._lastPlay < this._cooldownMs) return; // basic cooldown
        this._lastPlay = now;
        this._lazyInitContext();
        if (!this._ctx) return;

        if (this._ctx.state === 'suspended') {
            // Attempt resume on user gesture contexts; safe to call
            this._ctx.resume().catch(()=>{});
        }

        // Simple beep patterns
        const pattern = type === 'start' ? [440, 660, 880] : [440, 660];
        const dur = 0.18;
        let t = this._ctx.currentTime + 0.01;
        pattern.forEach((freq) => {
            const osc = this._ctx.createOscillator();
            const gainNode = this._ctx.createGain();
            osc.frequency.value = freq;
            osc.type = 'sine';
            gainNode.gain.setValueAtTime(0.0001, t);
            gainNode.gain.linearRampToValueAtTime(this._volume, t + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            osc.connect(gainNode).connect(this._gain || this._ctx.destination);
            osc.start(t);
            osc.stop(t + dur + 0.02);
            t += dur * 0.5; // slight overlap for chord-like effect
        });
    }
    ,
    _getAudio(tag) {
        if (!this._enabled) return null;
        if (!this._audioTags[tag]) {
            const src = this._fileMap[tag];
            if (!src) return null;
            const el = new Audio(src);
            el.preload = 'auto';
            this._audioTags[tag] = el;
        }
        return this._audioTags[tag];
    },
    playFile(tag) {
        if (!this._enabled) return;
        const now = Date.now();
        // Per-tag cooldown so different event types can fire back-to-back (e.g. payment_confirmed -> game_start)
        if (!this._audioTagTimes) this._audioTagTimes = {}; // tag -> last play timestamp
        const lastForTag = this._audioTagTimes[tag] || 0;
        const elapsed = now - lastForTag;
        const allow = elapsed >= this._cooldownMs || (tag === 'game_start' && this._lastTag !== 'game_start');
        if (!allow) return;
        this._audioTagTimes[tag] = now;
        this._lastTag = tag;
        const el = this._getAudio(tag);
        if (!el) return;
        try { el.currentTime = 0; el.play().catch(()=>{}); } catch(_) {}
    },
    playGameOverSound(gameOverData) {
        if (!this._enabled) return;
        if (!gameOverData || !gameOverData.reason) return;
        
        let soundTag = '';
        switch (gameOverData.reason) {
            case 'escaped':
                // Check if they escaped with treasure
                soundTag = gameOverData.treasure ? 'game_escaped_treasure' : 'game_escaped';
                break;
            case 'timeout':
                soundTag = 'game_timeout';
                break;
            case 'monster':
                soundTag = 'game_monster';
                break;
            default:
                return; // Unknown reason, no audio
        }
        
        this.playFile(soundTag);
    },
    // Public helper to be invoked when server denies start due to payment/credits
    playRequestCoin() { this.playFile('request_coin'); }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioAlerts;
}