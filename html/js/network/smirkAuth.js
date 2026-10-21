/**
 * SmirkAuth - Smirk Wallet Authentication Module
 *
 * Handles "Login with Smirk" wallet integration for Wownerogue.
 * Uses the Smirk browser extension API (window.smirk) for wallet interactions.
 *
 * Flow:
 * 1. Acquire explicit WOW permission from Smirk
 * 2. Get challenge from server
 * 3. Sign challenge with wallet
 * 4. Verify signature with backend
 * 5. Read wallet addresses; update a payout address only in payout-enabled modes
 */

const SmirkAuth = {
    /**
     * Check if Smirk extension is installed
     */
    isAvailable() {
        return typeof window.smirk !== 'undefined';
    },

    /**
     * Current link status
     */
    _isLinked: false,
    _wowReady: false,
    _walletAddress: null,

    _sessionEpoch() {
        return typeof SocketHandlers !== 'undefined' ? SocketHandlers._paymentSessionEpoch : null;
    },

    async requestWowAccess() {
        const epoch = this._sessionEpoch();
        this._wowReady = false;
        const keys = await window.smirk.connect(['wow']);
        if (epoch !== this._sessionEpoch()) throw new Error('Game session changed. Reconnect Smirk for the current account.');
        if (!keys || !keys.wow) throw new Error('Smirk did not grant WOW access.');
        this._wowReady = true;
        return keys;
    },

    async checkWowAccess() {
        const epoch = this._sessionEpoch();
        this._wowReady = false;
        try {
            const keys = await window.smirk.getPublicKeys();
            if (epoch !== this._sessionEpoch()) return false;
            this._wowReady = !!keys?.wow;
        } catch (_) { /* Missing permission or provider is not a grant. */ }
        return this._wowReady;
    },

    /**
     * Detect whether the connected Smirk wallet supports NIP-98 (nostr) signing.
     */
    _supportsNip98() {
        return typeof window.smirk?.signNostrEvent === 'function' &&
               typeof window.smirk?.getNostrPublicKey === 'function';
    },

    /**
     * Main login flow.
     *
     * Keeps NIP-98 identity when supported. Errors never switch credential methods.
     * WOW asset consent is separate from Nostr signing permission.
     */
    async login() {
        if (!this.isAvailable()) {
            throw new Error('Smirk extension not installed. Please install it from your browser extension store.');
        }

        if (!window.socket || !window.socket.id) {
            throw new Error('Not connected to server. Please wait for connection.');
        }

        const socketId = window.socket.id;
        let sessionToken = '';
        try { sessionToken = localStorage.getItem('wownerogue_token') || ''; } catch (_) {}
        if (!sessionToken) {
            throw new Error('Your game session is still being established. Please retry in a moment.');
        }

        // An explicit click grants only the asset this game supports. Nostr-only grants do
        // not authorize WOW payments. A denial ends this attempt without another popup.
        const keys = await this.requestWowAccess();

        // Step 1: Get challenge from server
        const challengeRes = await fetch('/api/auth/smirk/challenge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({ socketId })
        });

        if (!challengeRes.ok) {
            const error = await challengeRes.json();
            throw new Error(error.message || 'Failed to get challenge from server');
        }

        const { challenge } = await challengeRes.json();

        // Step 2: Feature-detect NIP-98 capability and verify with the backend.
        let verifyData;
        let provenPublicKey = null;

        if (this._supportsNip98()) {
            const result = await this._verifyNip98(socketId, challenge, sessionToken);
            verifyData = result.verifyData;
            provenPublicKey = result.pubkey;
        } else {
            const result = await this._verifyLegacy(socketId, challenge, sessionToken, keys);
            verifyData = result.verifyData;
            provenPublicKey = result.pubkey;
        }

        // Sign-in-with-wallet adoption: if this wallet already owned an account, the server signed
        // us into it and returned that account's session token. Persist it and reload so the whole
        // session re-establishes as that account (credits, address, history).
        if (verifyData && verifyData.adopted && verifyData.sessionToken) {
            if (typeof SocketHandlers !== 'undefined') {
                SocketHandlers._invalidatePaymentSession();
            }
            try { localStorage.setItem('wownerogue_token', verifyData.sessionToken); } catch (_) { /* ignore */ }
            $('#messages').append($('<li class="status">').text('🔑 Signed in to your wallet-linked account. Reloading…'));
            setTimeout(function () { window.location.reload(); }, 700);
            return { success: true, linked: true, adopted: true, address: verifyData.address || null };
        }

        // Receiving addresses are independent of the proven login identity.
        let walletAddress = null;
        try {
            const addresses = await window.smirk.getAddresses();
            if (addresses && addresses.wow && window.socket) {
                // Prestige-only play never needs a payout address.
                if (typeof SocketHandlers !== 'undefined' &&
                    (SocketHandlers._directPayoutsEnabled || SocketHandlers._creditsPayoutsEnabled)) {
                    window.socket.emit('address:update', { address: addresses.wow });
                }
                walletAddress = addresses.wow;
            }
        } catch (addrErr) {
            console.warn('Could not get Smirk addresses:', addrErr.message);
            // Fall back - user will need to manually enter address
        }

        // Update internal state
        this._isLinked = true;
        this._walletAddress = walletAddress;
        this._publicKey = provenPublicKey;

        return {
            success: true,
            linked: verifyData.linked,
            address: walletAddress
        };
    },

    /**
     * NIP-98 auth path: build a kind:27235 nostr event, sign it with the
     * Smirk wallet, and POST { socketId, event } to /verify.
     *
     * @returns {Promise<{verifyData: object, pubkey: string|null}>}
     */
    async _verifyNip98(socketId, challenge, sessionToken) {
        // Build the NIP-98 HTTP auth event. The wallet fills in pubkey/id/sig.
        const evt = {
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            content: '',
            tags: [
                ['u', new URL('/api/auth/smirk/verify', window.location.origin).href],
                ['method', 'POST'],
                ['challenge', challenge]
            ]
        };

        // Sign directly. If this origin doesn't yet hold the Nostr scope, the wallet throws
        // NOT_AUTHORIZED (no popup); grant it once via getNostrPublicKey() and retry. Signing
        // first means a RETURNING user (scope already granted) gets a SINGLE approval instead of
        // two. The wallet still asks per-signature for kind 27235; that can't be silenced.
        let signed;
        try {
            signed = await window.smirk.signNostrEvent(evt);
        } catch (scopeErr) {
            const needsScope = scopeErr && scopeErr.code === 'NOT_AUTHORIZED';
            if (!needsScope) throw scopeErr;
            const granted = await window.smirk.getNostrPublicKey();
            if (!granted) throw new Error('Smirk Nostr permission was declined.');
            signed = await window.smirk.signNostrEvent(evt);
        }
        if (!signed || typeof signed !== 'object') {
            throw new Error('Smirk wallet did not return a signed nostr event');
        }

        const verifyRes = await fetch('/api/auth/smirk/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({ socketId, event: signed })
        });

        if (!verifyRes.ok) {
            const error = await verifyRes.json().catch(() => ({}));
            throw new Error(error.message || 'NIP-98 verification failed');
        }

        const verifyData = await verifyRes.json();
        return { verifyData, pubkey: signed.pubkey || null };
    },

    /**
     * Legacy Ed25519 auth path: connect, sign the challenge string, and POST
     * { socketId, challenge, publicKey, signature } to /verify.
     *
     * @returns {Promise<{verifyData: object, pubkey: string|null}>}
     */
    async _verifyLegacy(socketId, challenge, sessionToken, keys) {
        if (!keys || !keys.wow) {
            throw new Error('Smirk wallet did not return WOW public key');
        }

        // Sign the challenge
        let signResult;
        try {
            signResult = await window.smirk.signMessage(challenge);
        } catch (signError) {
            const e = new Error('Failed to sign challenge: ' + (signError.message || 'Unknown error'));
            e.code = signError && signError.code; // preserve 'LOCKED' etc.
            throw e;
        }

        // Find WOW signature
        const wowSig = signResult.signatures?.find(s => s.asset === 'wow');
        if (!wowSig) {
            throw new Error('WOW signature not found in Smirk response');
        }

        // Verify signature with backend
        const verifyRes = await fetch('/api/auth/smirk/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': sessionToken
            },
            body: JSON.stringify({
                socketId,
                challenge,
                publicKey: wowSig.publicKey,
                signature: wowSig.signature
            })
        });

        if (!verifyRes.ok) {
            const error = await verifyRes.json();
            throw new Error(error.message || 'Signature verification failed');
        }

        const verifyData = await verifyRes.json();
        return { verifyData, pubkey: wowSig.publicKey };
    },

    /**
     * Check current link status
     */
    async checkStatus() {
        if (!window.socket || !window.socket.id) {
            return { linked: false, hasPayoutAddress: false };
        }

        const epoch = this._sessionEpoch();
        const socketId = window.socket.id;
        const requestId = this._statusRequestId = (this._statusRequestId || 0) + 1;
        let token = '';
        try { token = localStorage.getItem('wownerogue_token') || ''; } catch (_) {}
        const current = () => {
            let activeToken = '';
            try { activeToken = localStorage.getItem('wownerogue_token') || ''; } catch (_) {}
            return epoch === this._sessionEpoch() && socketId === window.socket?.id &&
                token === activeToken && requestId === this._statusRequestId;
        };
        try {
            // /status is session-gated (BOLA fix): send the session token so a linked user
            // is recognised; without it the endpoint returns 401 and we fall through to unlinked.
            const res = await fetch(`/api/auth/smirk/status?socketId=${encodeURIComponent(window.socket.id)}`, {
                headers: token ? { 'X-Session-Token': token } : {}
            });
            if (res.ok) {
                const data = await res.json();
                if (!current()) return { linked: false, hasPayoutAddress: false };
                await this.checkWowAccess();
                if (!current()) return { linked: false, hasPayoutAddress: false };
                this._isLinked = data.linked === true;
                this._updateButton($('#smirkLoginBtn'), data.linked ? (this._wowReady ? 'connected' : 'linked') : 'ready');
                if (typeof SocketHandlers !== 'undefined' && SocketHandlers._refreshSmirkPaymentButton) {
                    SocketHandlers._refreshSmirkPaymentButton();
                }
                return data;
            }
        } catch (e) {
            console.warn('Failed to check Smirk status:', e.message);
        }

        if (current()) {
            this._isLinked = false;
            this._wowReady = false;
            this._updateButton($('#smirkLoginBtn'), 'ready');
        }
        return { linked: false, hasPayoutAddress: false };
    },

    /**
     * Create and return the Smirk login button element
     */
    _createButton() {
        const btn = $('<button id="smirkLoginBtn" class="menu-button">')
            .css({
                'background': '#1a1a4d',
                'color': '#fff',
                'border': '1px solid #3a3a7d',
                'margin-top': '5px',
                'cursor': 'pointer',
                'font-size': '12px',
                'padding': '8px 12px',
                'width': '100%',
                'text-align': 'center'
            })
            .text('Connect Smirk Wallet');

        return btn;
    },

    /**
     * Update button state
     */
    _updateButton(btn, state) {
        switch (state) {
            case 'connecting':
                btn.prop('disabled', true)
                   .css({ 'background': '#2a2a5d', 'cursor': 'wait' })
                   .text('Connecting...');
                break;
            case 'connected':
                btn.prop('disabled', false)
                   .css({ 'background': '#0a5c0a', 'border-color': '#0a8c0a', 'cursor': 'pointer' })
                   .text('Smirk connected · Recheck WOW access');
                break;
            case 'linked':
                btn.prop('disabled', false)
                   .css({ 'background': '#1a1a4d', 'cursor': 'pointer' })
                   .text('Enable WOW payments');
                break;
            case 'error':
                btn.prop('disabled', false)
                   .css({ 'background': '#5c0a0a', 'border-color': '#8c0a0a', 'cursor': 'pointer' })
                   .text('Retry Smirk Connect');
                break;
            default: // 'ready'
                btn.prop('disabled', false)
                   .css({ 'background': '#1a1a4d', 'border-color': '#3a3a7d', 'cursor': 'pointer' })
                   .text('Connect Smirk Wallet');
        }
    },

    /**
     * Handle button click
     */
    async _handleClick(btn) {
        this._updateButton(btn, 'connecting');

        try {
            const result = this._isLinked
                ? (await this.requestWowAccess(), { success: true, linked: true, address: this._walletAddress })
                : await this.login();

            this._updateButton(btn, 'connected');
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._refreshSmirkPaymentButton) {
                SocketHandlers._refreshSmirkPaymentButton();
            }

            // Show success message in chat
            const addressSet = result.address != null;
            const successMsg = 'Smirk account connected. WOW payment permission granted.';

            // .text() sets textContent, so the message is safe from injection.
            $('#messages').append($('<li class="status">').text(successMsg));

            // Update address button status if available
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._updateAddressButtonStatus) {
                SocketHandlers._updateAddressButtonStatus(addressSet);
            }

            return result;

        } catch (err) {
            this._updateButton(btn, 'error'); // button label becomes "Retry Smirk Connect"

            // A locked wallet is an action, not a red error. Current Smirk builds auto-open the
            // unlock popup on connect()/signNostrEvent(); older builds throw LOCKED, so guide the
            // user to unlock and retry (the Retry button re-invokes connect(), which pops the
            // unlock screen on the updated build).
            const locked = (err && err.code === 'LOCKED') || /is locked/i.test((err && err.message) || '');
            if (locked) {
                $('#messages').append($('<li class="status">').text(
                    '🔒 Your Smirk wallet is locked. Open the Smirk extension, unlock it, then click "Retry Smirk Connect".'
                ));
            } else {
                $('#messages').append($('<li class="error">').text('Smirk login failed: ' + err.message));
            }

            throw err;
        }
    },

    /**
     * Initialize the Smirk button in the UI
     * Should be called after DOM is ready and socket is connected
     */
    init() {
        // Check if server has Smirk disabled (e.g., for Monero stagenet)
        if (typeof SocketHandlers === 'undefined' || SocketHandlers._smirkEnabled !== true) {
            console.log('Smirk integration disabled by server');
            return;
        }

        // Prevent double-initialization
        if (this._initialized) {
            return;
        }
        this._initialized = true;

        const container = $('#smirkButtonContainer');
        if (!container.length) {
            console.log('Smirk button container not found');
            return;
        }

        // Clear any existing content
        container.empty();

        if (this.isAvailable()) {
            // Smirk extension IS installed - show connect button
            const btn = this._createButton();
            btn.on('click', () => this._handleClick(btn));
            container.append(btn);

            // Check if already linked on page load
            this.checkStatus();

            console.log('Smirk extension detected, connect button shown');
        } else {
            // Smirk extension NOT installed - show install link
            const installLink = $('<a>')
                .attr('href', 'https://smirk.cash')
                .attr('target', '_blank')
                .attr('rel', 'noopener noreferrer')
                .css({
                    'display': 'inline-block',
                    'background': '#2a2a5d',
                    'color': '#aaf',
                    'border': '1px solid #3a3a7d',
                    'padding': '8px 16px',
                    'border-radius': '4px',
                    'text-decoration': 'none',
                    'font-size': '12px',
                    'width': '100%',
                    'text-align': 'center',
                    'box-sizing': 'border-box'
                })
                .text('Get Smirk Wallet →')
                .hover(
                    function() { $(this).css('background', '#3a3a7d'); },
                    function() { $(this).css('background', '#2a2a5d'); }
                );

            container.append(installLink);

            const hint = $('<p>')
                .css({ 'font-size': '10px', 'color': '#666', 'margin-top': '6px', 'margin-bottom': '0' })
                .text('Install the Smirk browser extension, then refresh this page.');
            container.append(hint);

            console.log('Smirk extension not detected, showing install link');
        }
    }
};

// Auto-initialize when DOM is ready (with delay to allow game_mode_info to arrive first)
$(document).ready(function() {
    // Wait for game_mode_info to arrive first (typically within 2 seconds)
    // SocketHandlers will call SmirkAuth.init() when it receives game_mode_info
    // Fail closed: the server must explicitly advertise smirkEnabled=true.
    setTimeout(() => {
        // Only auto-init if not already initialized by SocketHandlers
        // and only when the server explicitly enabled it
        if (!SmirkAuth._initialized &&
            typeof SocketHandlers !== 'undefined' && SocketHandlers._smirkEnabled === true) {
            SmirkAuth.init();
        }
    }, 3000);
});

// Also re-check when socket connects (in case of reconnection)
if (typeof window.socket !== 'undefined') {
    window.socket.on('connect', function() {
        setTimeout(() => {
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._smirkEnabled === true &&
                SmirkAuth.isAvailable() && !SmirkAuth._isLinked) {
                SmirkAuth.checkStatus().then(status => {
                    const btn = $('#smirkLoginBtn');
                    if (btn.length > 0 && status.linked) {
                        SmirkAuth._updateButton(btn, SmirkAuth._wowReady ? 'connected' : 'linked');
                    }
                });
            }
        }, 500);
    });
}
