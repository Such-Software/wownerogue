// ChainAmbience: the live chain, drifting around the edges of a stage.
//
// Fragments of the top block hash fade in around the border and drift away, a corner readout
// tracks the height, and a new block sends a ripple around the frame.
//
// Purely decorative. It reads the public `blockheight` broadcast and never influences gameplay, so
// a missing or stale tip just means fewer motes.
(function (root) {
    'use strict';
    var RK = root.RK = root.RK || {};

    var STYLE_ID = 'rk-chain-ambience-style';
    var CSS = [
        '.rk-chain-amb{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:9;',
        '  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
        '.rk-chain-amb .rk-cm{position:absolute;white-space:nowrap;font-size:11px;letter-spacing:.09em;',
        '  color:#7fe3c0;opacity:0;text-shadow:0 0 8px rgba(80,220,180,.45);will-change:transform,opacity;}',
        '.rk-chain-amb .rk-cm.rk-drift{animation:rk-cm-drift var(--rk-cm-life,9s) linear forwards;}',
        '@keyframes rk-cm-drift{',
        '  0%{opacity:0;transform:translate3d(0,0,0) scale(.94);}',
        '  16%{opacity:var(--rk-cm-peak,.42);}',
        '  76%{opacity:var(--rk-cm-peak,.42);}',
        '  100%{opacity:0;transform:translate3d(var(--rk-cm-dx,0px),var(--rk-cm-dy,-26px),0) scale(1);}}',
        '.rk-chain-amb .rk-chain-readout{position:absolute;left:10px;bottom:8px;font-size:10px;',
        '  line-height:1.5;color:#5f7f96;letter-spacing:.1em;opacity:.72;transition:color .5s ease;}',
        '.rk-chain-amb .rk-chain-readout b{display:block;color:#8fd8b6;font-weight:400;font-size:11px;}',
        '.rk-chain-amb .rk-chain-readout .rk-chain-hash{display:block;color:#4d6a80;word-break:break-all;max-width:34ch;}',
        '.rk-chain-amb .rk-chain-readout.rk-fresh b{color:#b6f7d6;text-shadow:0 0 10px rgba(120,240,190,.55);}',
        '.rk-chain-amb .rk-chain-ripple{position:absolute;inset:0;border:1px solid rgba(127,227,192,0);',
        '  border-radius:inherit;}',
        '.rk-chain-amb .rk-chain-ripple.rk-go{animation:rk-chain-ripple 1.5s ease-out forwards;}',
        '@keyframes rk-chain-ripple{',
        '  0%{border-color:rgba(127,227,192,.55);box-shadow:inset 0 0 0 rgba(127,227,192,.4);}',
        '  100%{border-color:rgba(127,227,192,0);box-shadow:inset 0 0 46px rgba(127,227,192,0);}}',
        '@media (prefers-reduced-motion:reduce){',
        '  .rk-chain-amb .rk-cm{display:none}',
        '  .rk-chain-amb .rk-chain-ripple.rk-go{animation:none}}'
    ].join('\n');

    function ensureStyle(doc) {
        if (doc.getElementById(STYLE_ID)) return;
        var el = doc.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        doc.head.appendChild(el);
    }

    function reducedMotion() {
        try { return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; }
        catch (_) { return false; }
    }

    function ChainAmbience(host, opts) {
        opts = opts || {};
        var doc = root.document;
        ensureStyle(doc);
        this.host = host;
        this.doc = doc;
        this.tip = { height: null, hash: null, difficulty: null, txPoolSize: null };
        this.motes = 0;
        this.maxMotes = opts.maxMotes || 9;
        this.spawnMs = opts.spawnMs || 1200;

        this.el = doc.createElement('div');
        this.el.className = 'rk-chain-amb';
        this.el.setAttribute('aria-hidden', 'true'); // decoration; the readout below is the a11y copy

        this.ripple = doc.createElement('div');
        this.ripple.className = 'rk-chain-ripple';
        this.el.appendChild(this.ripple);

        this.readout = doc.createElement('div');
        this.readout.className = 'rk-chain-readout';
        this.heightEl = doc.createElement('b');
        this.hashEl = doc.createElement('span');
        this.hashEl.className = 'rk-chain-hash';
        this.readout.appendChild(this.heightEl);
        this.readout.appendChild(this.hashEl);
        this.el.appendChild(this.readout);

        host.appendChild(this.el);

        var self = this;
        this.timer = root.setInterval(function () { self._spawn(); }, this.spawnMs);

        // A hidden tab pauses CSS animations, so `animationend` never fires and motes are never
        // removed. Spawning is skipped while hidden and any backlog is dropped here, otherwise a
        // backgrounded tab accrues motes indefinitely and replays them all at once on return.
        // These are decorations, so discarding them costs nothing.
        this._onVisibility = function () {
            if (!self.el || !self.doc.hidden) return;
            self._clearMotes();
        };
        doc.addEventListener('visibilitychange', this._onVisibility);
    }

    ChainAmbience.prototype._clearMotes = function () {
        if (!this.el) return;
        var existing = this.el.querySelectorAll('.rk-cm');
        for (var i = 0; i < existing.length; i++) existing[i].remove();
        this.motes = 0;
    };

    // Fragments of the real top-block hash, plus the occasional height/difficulty token, so the
    // drifting text is actual chain data rather than decorative gibberish.
    ChainAmbience.prototype._fragment = function () {
        var t = this.tip;
        var roll = Math.random();
        if (t.hash && roll < 0.68) {
            var start = Math.floor(Math.random() * (t.hash.length - 8));
            return t.hash.substr(start, 4 + Math.floor(Math.random() * 5));
        }
        if (t.height != null && roll < 0.86) return '#' + t.height;
        if (t.difficulty != null && roll < 0.94) return 'diff ' + Math.round(t.difficulty / 1e6) + 'M';
        if (t.txPoolSize != null) return 'mempool ' + t.txPoolSize;
        return t.height != null ? '#' + t.height : '';
    };

    ChainAmbience.prototype._spawn = function (burst) {
        if (!this.el || reducedMotion()) return;
        if (this.doc.hidden) return; // paused animations never clean themselves up
        // Count the DOM, not `this.motes`: a missed animationend would permanently inflate the
        // tally and silently stop all further spawning.
        if (!burst && this.el.querySelectorAll('.rk-cm').length >= this.maxMotes) return;
        var text = this._fragment();
        if (!text) return;
        var doc = this.doc;
        var m = doc.createElement('span');
        m.className = 'rk-cm rk-drift';
        m.textContent = text;

        // Hug the border: pick an edge, then a position along it. The middle of the stage belongs
        // to the game, so the chain lives in the margins.
        var edge = Math.floor(Math.random() * 4);
        var along = 6 + Math.random() * 84;
        var dx = 0, dy = 0;
        if (edge === 0) { m.style.left = along + '%'; m.style.top = '3%'; dy = -18; }
        else if (edge === 1) { m.style.left = along + '%'; m.style.bottom = '4%'; dy = 20; }
        else if (edge === 2) { m.style.left = '2%'; m.style.top = along + '%'; dx = -22; }
        else { m.style.right = '2%'; m.style.top = along + '%'; dx = 22; }
        dx += (Math.random() - 0.5) * 14;
        dy += (Math.random() - 0.5) * 10;

        m.style.setProperty('--rk-cm-dx', dx.toFixed(1) + 'px');
        m.style.setProperty('--rk-cm-dy', dy.toFixed(1) + 'px');
        m.style.setProperty('--rk-cm-life', (7 + Math.random() * 5).toFixed(1) + 's');
        m.style.setProperty('--rk-cm-peak', (burst ? 0.62 : 0.30 + Math.random() * 0.22).toFixed(2));
        if (burst) m.style.color = '#b6f7d6';

        var self = this;
        m.addEventListener('animationend', function () {
            if (m.parentNode) m.parentNode.removeChild(m);
            self.motes--;
        });
        this.motes++;
        this.el.appendChild(m);
    };

    // Feed it the `blockheight` payload. A height increase is treated as "a block landed" and gets
    // the ripple + a burst of fragments; a repeat of the same height just refreshes the readout.
    ChainAmbience.prototype.setTip = function (data) {
        if (!this.el || !data) return;
        var height = Number(data.blockHeight);
        if (!isFinite(height)) return;
        var advanced = this.tip.height != null && height > this.tip.height;
        this.tip.height = height;
        if (typeof data.hash === 'string') this.tip.hash = data.hash;
        if (data.difficulty != null) this.tip.difficulty = Number(data.difficulty);
        if (data.txPoolSize != null) this.tip.txPoolSize = Number(data.txPoolSize);

        this.heightEl.textContent = 'BLOCK ' + height;
        this.hashEl.textContent = this.tip.hash
            ? this.tip.hash.slice(0, 16) + '…' + this.tip.hash.slice(-8)
            : '';

        if (!advanced) return;
        var self = this;
        this.readout.classList.add('rk-fresh');
        this.ripple.classList.remove('rk-go');
        // Force a reflow so the animation restarts on consecutive blocks.
        void this.ripple.offsetWidth;
        this.ripple.classList.add('rk-go');
        for (var i = 0; i < 5; i++) {
            (function (n) { root.setTimeout(function () { self._spawn(true); }, n * 110); })(i);
        }
        if (this._freshTimer) root.clearTimeout(this._freshTimer);
        this._freshTimer = root.setTimeout(function () {
            if (self.readout) self.readout.classList.remove('rk-fresh');
        }, 2600);
    };

    ChainAmbience.prototype.destroy = function () {
        if (this.timer) root.clearInterval(this.timer);
        this.timer = null;
        if (this._onVisibility) this.doc.removeEventListener('visibilitychange', this._onVisibility);
        this._onVisibility = null;
        if (this._freshTimer) root.clearTimeout(this._freshTimer);
        this._freshTimer = null;
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
        this.readout = null;
        this.ripple = null;
    };

    RK.ChainAmbience = ChainAmbience;
    RK.mountChainAmbience = function (host, opts) {
        if (!host || !root.document) return null;
        try { return new ChainAmbience(host, opts); }
        catch (e) {
            if (root.console) console.warn('chain ambience unavailable:', e && e.message);
            return null;
        }
    };
})(typeof window !== 'undefined' ? window : this);
