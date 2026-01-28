/**
 * SmirkAuth - Smirk Wallet Authentication Module
 *
 * Handles "Login with Smirk" wallet integration for Wownerogue.
 * Uses the Smirk browser extension API (window.smirk) for wallet interactions.
 *
 * Flow:
 * 1. Get challenge from server
 * 2. Connect to Smirk extension to get public keys
 * 3. Sign challenge with wallet
 * 4. Verify signature with backend
 * 5. Auto-set payout address from wallet
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
    _walletAddress: null,

    /**
     * Main login flow
     */
    async login() {
        if (!this.isAvailable()) {
            throw new Error('Smirk extension not installed. Please install it from your browser extension store.');
        }

        if (!window.socket || !window.socket.id) {
            throw new Error('Not connected to server. Please wait for connection.');
        }

        const socketId = window.socket.id;

        // Step 1: Get challenge from server
        const challengeRes = await fetch('/api/auth/smirk/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ socketId })
        });

        if (!challengeRes.ok) {
            const error = await challengeRes.json();
            throw new Error(error.message || 'Failed to get challenge from server');
        }

        const { challenge } = await challengeRes.json();

        // Step 2: Connect to Smirk extension
        let keys;
        try {
            keys = await window.smirk.connect();
        } catch (smirkError) {
            throw new Error('Failed to connect to Smirk wallet: ' + (smirkError.message || 'Unknown error'));
        }

        if (!keys || !keys.wow) {
            throw new Error('Smirk wallet did not return a WOW address');
        }

        // Step 3: Sign the challenge
        let signResult;
        try {
            signResult = await window.smirk.signMessage(challenge);
        } catch (signError) {
            throw new Error('Failed to sign challenge: ' + (signError.message || 'Unknown error'));
        }

        // Find WOW signature
        const wowSig = signResult.signatures?.find(s => s.asset === 'wow');
        if (!wowSig) {
            throw new Error('WOW signature not found in Smirk response');
        }

        // Step 4: Verify signature with backend
        const verifyRes = await fetch('/api/auth/smirk/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

        // Step 5: Auto-set payout address from wallet
        if (keys.wow && window.socket) {
            window.socket.emit('address:update', { address: keys.wow });
        }

        // Update internal state
        this._isLinked = true;
        this._walletAddress = keys.wow;

        return {
            success: true,
            linked: verifyData.linked,
            address: keys.wow
        };
    },

    /**
     * Check current link status
     */
    async checkStatus() {
        if (!window.socket || !window.socket.id) {
            return { linked: false, hasPayoutAddress: false };
        }

        try {
            const res = await fetch(`/api/auth/smirk/status?socketId=${encodeURIComponent(window.socket.id)}`);
            if (res.ok) {
                const data = await res.json();
                this._isLinked = data.linked;
                return data;
            }
        } catch (e) {
            console.warn('Failed to check Smirk status:', e.message);
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
                btn.prop('disabled', true)
                   .css({ 'background': '#0a5c0a', 'border-color': '#0a8c0a', 'cursor': 'default' })
                   .text('Smirk Connected');
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
            const result = await this.login();

            this._updateButton(btn, 'connected');

            // Show success message in chat
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._appendMessage) {
                SocketHandlers._appendMessage('status', 'Smirk wallet connected! Payout address set.');
            } else {
                $('#messages').append($('<li class="status">').text('Smirk wallet connected! Payout address set.'));
            }

            // Update address button status if available
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._updateAddressButtonStatus) {
                SocketHandlers._updateAddressButtonStatus(true);
            }

            return result;

        } catch (err) {
            console.error('Smirk login failed:', err);
            this._updateButton(btn, 'error');

            // Show error message
            const errorMsg = 'Smirk login failed: ' + err.message;
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers._appendMessage) {
                SocketHandlers._appendMessage('error', errorMsg);
            } else {
                $('#messages').append($('<li class="error">').text(errorMsg));
            }

            throw err;
        }
    },

    /**
     * Initialize the Smirk button in the UI
     * Should be called after DOM is ready and socket is connected
     */
    init() {
        // Only show button if Smirk extension is available
        if (!this.isAvailable()) {
            console.log('Smirk extension not detected, button will not be shown');
            return;
        }

        // Check if button already exists
        if ($('#smirkLoginBtn').length > 0) {
            return;
        }

        // Create button
        const btn = this._createButton();

        // Add click handler
        btn.on('click', () => this._handleClick(btn));

        // Insert after the address button (if it exists) or after the help button
        const addressBtn = $('#manageAddressButton');
        if (addressBtn.length > 0) {
            addressBtn.after(btn);
        } else {
            const helpBtn = $('#helpButton');
            if (helpBtn.length > 0) {
                helpBtn.after(btn);
            } else {
                // Fallback: append to status area
                $('#status').append(btn);
            }
        }

        // Check if already linked on page load
        this.checkStatus().then(status => {
            if (status.linked) {
                this._updateButton(btn, 'connected');
            }
        });

        console.log('Smirk authentication module initialized');
    }
};

// Auto-initialize when DOM is ready
$(document).ready(function() {
    // Wait a short moment for socket to connect before initializing
    setTimeout(() => {
        SmirkAuth.init();
    }, 1000);
});

// Also re-check when socket connects (in case of reconnection)
if (typeof window.socket !== 'undefined') {
    window.socket.on('connect', function() {
        setTimeout(() => {
            if (SmirkAuth.isAvailable() && !SmirkAuth._isLinked) {
                SmirkAuth.checkStatus().then(status => {
                    const btn = $('#smirkLoginBtn');
                    if (btn.length > 0 && status.linked) {
                        SmirkAuth._updateButton(btn, 'connected');
                    }
                });
            }
        }, 500);
    });
}
