/**
 * Socket event handlers for the Wowngeon game
 */
const SocketHandlers = {
    _initialized: false,
    _didConnect: false,
    _setBannerStatus: function(text, color) {
        const el = $('#statusValue');
        if (!el.length) return;
        el.text(text);
        if (color) el.css('color', color);
    },
    
    init: function() {
        if (this._initialized) {
            return;
        }
        
        if (!window.socket) {
            console.error("Socket not available!");
            return;
        }

        this.registerEventHandlers();
        this._initialized = true;

        // If the low-level socket connected before handlers were registered, emulate onConnect.
        if (window.socket && window.socket.connected) {
            this.onConnect();
        }
    },

    registerEventHandlers: function() {
        // Connection handlers
        socket.on('connect', this.onConnect);
        socket.on('welcome', this.onWelcome);
        socket.on('session_token', this.onSessionToken);
        socket.on('session_resumed', this.onSessionResumed);
        socket.on('message', this.onMessage);
        socket.on('status_update', this.onStatusUpdate);
        socket.on('chat_broadcast', this.onChatBroadcast);
        
        // Game state handlers
        socket.on('waiting_status', this.onWaitingStatus);
        socket.on('queue_joined', this.onQueueJoined);
        socket.on('game_start', this.onGameStart);
        socket.on('game_update', this.onGameUpdate);
        socket.on('game_over', this.onGameOver);
        socket.on('queue_cancelled', this.onQueueCancelled);
        
        // Payment/Address handlers
        socket.on('address_detected', this.onAddressDetected);
        socket.on('address_confirmed', this.onAddressConfirmed);
        socket.on('payment_created', this.onPaymentCreated);
        socket.on('payment_confirmed', this.onPaymentConfirmed);
        socket.on('payment_detected', this.onPaymentDetected);
    socket.on('credits_update', this.onCreditsUpdate);
        
        // Block height handler
        socket.on('blockheight', this.onBlockHeight);
    },

    onConnect: function() {
        if (SocketHandlers._didConnect) return; // prevent duplicate registration emission
        SocketHandlers._didConnect = true;
        // Include stored session token in a lightweight resume emit (if server did not get it via handshake)
        try {
            const existing = localStorage.getItem('wowngeon_token');
            if (existing) {
                // If we later decide to rely solely on query param at io() creation, this is harmless redundancy.
                socket.io.opts.query = socket.io.opts.query || {};
                socket.io.opts.query.resumeToken = existing;
            }
        } catch (e) {}
        socket.emit('register_client', {
            clientId: socket.id,
            userAgent: navigator.userAgent
        });
        // Update small status banner immediately
        SocketHandlers._setBannerStatus('Connected', '#0f0');
    },

    onSessionToken: function(data) {
        if (data && data.token) {
            try { localStorage.setItem('wowngeon_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('New session established. Token stored.'));
            UI.scrollChat();
        }
    },

    onSessionResumed: function(data) {
        if (data && data.token) {
            try { localStorage.setItem('wowngeon_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('Session resumed.'));
            UI.scrollChat();
        }
        if (data && typeof data.credits === 'number') {
            SocketHandlers._updateCreditsDisplay(data.credits);
        }
        if (data && data.payoutAddress) {
            $('#messages').append($('<li class="address-confirmed" style="color:#0f0;">').text('Payout address restored.'));
            UI.scrollChat();
        }
    },

    onCreditsUpdate: function(data) {
        if (!data) return;
        if (typeof data.balance === 'number') {
            SocketHandlers._updateCreditsDisplay(data.balance);
        }
    },

    _updateCreditsDisplay: function(balance) {
        let el = document.getElementById('creditsDisplay');
        if (!el) {
            // Create a small unobtrusive badge in header if not present
            const header = document.getElementById('header') || document.body;
            el = document.createElement('div');
            el.id = 'creditsDisplay';
            el.style.cssText = 'position:absolute;top:4px;right:8px;font-size:12px;font-family:monospace;color:#0af;background:#111;padding:2px 6px;border:1px solid #044;border-radius:4px;';
            header.appendChild(el);
        }
        el.textContent = 'Credits: ' + balance;
    },

    onWelcome: function(msg) {
        $('#messages').append($('<li>').text("Connected to server!"));
        UI.scrollChat();
    },

    onMessage: function(msg) {
        $('#messages').append($('<li>').text(msg));
        UI.scrollChat();
    },

    onStatusUpdate: function(data) {
        const statusClass = data.type === 'error' ? 'error' : 'status';
        const statusColor = data.type === 'error' ? '#f00' : 
                           data.type === 'warning' ? '#ff0' : 
                           data.type === 'success' ? '#0f0' : 
                           data.type === 'payment' ? '#0af' : '#fff';
        
        $('#messages').append($('<li class="' + statusClass + '" style="color: ' + statusColor + '; white-space: pre-line;">').text(data.message));
        UI.scrollChat();

        // Mirror concise status in header banner for key lifecycle types
        if (data.type === 'connection') {
            SocketHandlers._setBannerStatus('Ready', '#0f0');
        } else if (data.type === 'queue') {
            SocketHandlers._setBannerStatus('Queued', '#0af');
        } else if (data.type === 'payment') {
            // Generic payment message (more granular handlers override later)
            SocketHandlers._setBannerStatus('Payment', '#0af');
            if (typeof AudioAlerts !== 'undefined') { AudioAlerts.playRequestCoin(); }
        } else if (data.type === 'error') {
            SocketHandlers._setBannerStatus('Error', '#f00');
        } else if (data.type === 'success') {
            SocketHandlers._setBannerStatus('Success', '#0f0');
        }
    },

    onChatBroadcast: function(data) {
        const msgElement = $('<li style="color: #aaa;">');
        if (data.socketId) {
            msgElement.html('<strong>' + data.socketId.substring(0, 6) + ':</strong> ' + data.message);
        } else {
            msgElement.text(data.message);
        }
        $('#messages').append(msgElement);
        UI.scrollChat();
    },

    onWaitingStatus: function(data) {
        if (data.status === 'waiting') {
            $('#messages').append($('<li style="color:#ff0;">').text(data.message));
            
            if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
                Game.drawWaitingScreen();
            }
        }
        UI.scrollChat();
    },

    onQueueJoined: function(data) {
        console.log('Queue joined:', data);
        const currentBlockFallback = (typeof data.currentBlock === 'number' && data.currentBlock > 0)
            ? data.currentBlock
            : (typeof UI !== 'undefined' && typeof UI._currentBlockHeight === 'number' && UI._currentBlockHeight > 0
                ? UI._currentBlockHeight
                : '?');
        const nextBlockFallback = (typeof data.nextBlock === 'number' && data.nextBlock > 0)
            ? data.nextBlock
            : (currentBlockFallback === '?' ? '?' : currentBlockFallback + 1);

        $('#messages').append($('<li class="queue-info" style="color:#0f0;">').html(
            '⏳ <strong>Queue Joined!</strong> Position: ' + data.position + '<br>' +
            '📦 Current block: ' + currentBlockFallback + ', Next: ' + nextBlockFallback
        ));
        UI.scrollChat();
        
        if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
            Game.drawWaitingScreen();
        }
        SocketHandlers._setBannerStatus('Queued', '#0af');
    },

    onGameStart: function(data) {
        $('#messages').append($('<li class="game-start">').text("Starting game..."));
        
        if (typeof Game !== 'undefined' && Game.stopWaitingScreen) {
            Game.stopWaitingScreen();
        }
        
        if (!data) {
            $('#messages').append($('<li class="error">').text("Error: No game data received from server."));
            if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            return;
        }
        
        try {
            var success = Game.startGame(data.player, data.map, data.monster, data.items, data.visibleTiles, data.lighting, data.torches);
            
            if (!success) {
                $('#messages').append($('<li class="error">').text("Game start failed. Check console for details."));
                if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            } else {
                setTimeout(function() {
                    $('#game-display').focus();
                }, 100);
            }
        } catch (error) {
            console.error("Error starting game:", error);
            $('#messages').append($('<li class="error">').text("Game start error: " + error.message));
            if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
        }
        
        UI.scrollChat();
        SocketHandlers._setBannerStatus('In Game', '#0f0');
        if (typeof AudioAlerts !== 'undefined' && AudioAlerts._enabled) {
            try { AudioAlerts.playFile('game_start'); } catch(_) {}
        }
    },

    onGameUpdate: function(data) {
        // Server pushed a game state update. The Game object exposes updateGameState().
        // Older code referenced Game.updateGame, which doesn't exist in the current refactor,
        // so updates were silently ignored (player appeared frozen).
        if (typeof Game !== 'undefined') {
            if (Game.updateGameState) {
                Game.updateGameState(data);
            } else if (Game.updateGame) { // Fallback if an alias gets added later
                Game.updateGame(data);
            } else {
                console.warn('Game update received but no updateGameState()/updateGame() method found on Game.');
            }
        }
        UI.scrollChat();
    },

    onGameOver: function(data) {
        $('#messages').append($('<li class="game-over">').text("Game Over: " + data.message));
        if (typeof Game !== 'undefined') {
            if (Game.endGame) {
                Game.endGame(data);
            } else if (Game.drawLoseScreen && data && data.reason) {
                // Minimal fallback if endGame not present
                if (data.reason === 'monster') Game.drawLoseScreen('monster');
            }
        }
        
        UI.scrollChat();
        const won = data && (data.status === 'won' || data.reason === 'escaped');
        if (won) {
            SocketHandlers._setBannerStatus('Won', '#0f0');
        } else {
            SocketHandlers._setBannerStatus('Lost', '#f00');
        }
    },

    onQueueCancelled: function(data) {
        $('#messages').append($('<li style="color: #ff0;">').text("Queue entry cancelled."));
        
        if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) {
            Game._drawWelcomeScreen();
        }
        
        UI.scrollChat();
        SocketHandlers._setBannerStatus('Ready', '#0f0');
    },

    onAddressDetected: function(data) {
        console.log('Address detected:', data);
        $('#messages').append($('<li class="address-detected" style="color: #ff0; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
    },

    onAddressConfirmed: function(data) {
        console.log('Address confirmed:', data);
        $('#messages').append($('<li class="address-confirmed" style="color: #0f0; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
    },

    onPaymentCreated: function(data) {
        console.log('Payment created:', data);
        if (typeof AudioAlerts !== 'undefined') { AudioAlerts.playRequestCoin(); }
        const parts = [];
        parts.push('💳 <strong>Payment Required</strong>');
        parts.push('Amount: ' + data.humanAmount + ' ' + data.cryptoType);
        const shortAddr = data.address.substring(0, 10) + '…' + data.address.slice(-6);
        parts.push('Address: <span class="pay-address-full" style="cursor:pointer;" title="Click to toggle full address">' + shortAddr + '</span>' +
                   ' <button class="copy-pay-address" data-address="' + data.address + '" style="margin-left:4px;padding:1px 4px;font-size:11px;cursor:pointer;">Copy</button>');
        // (Removed inline QR image to avoid duplication; dedicated pinned sidebar QR is used instead.)
        const $li = $('<li class="payment-info" style="white-space:normal;">').html(parts.join('<br>'));
        $('#messages').append($li);

        // Attach copy handler (delegated inside this LI to avoid duplicates)
        const fullAddress = data.address;
        $li.on('click', '.copy-pay-address', function(e) {
            e.preventDefault();
            const addr = $(this).data('address');
            const doCopy = async () => {
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(addr);
                    } else {
                        // Fallback
                        const ta = document.createElement('textarea');
                        ta.value = addr; document.body.appendChild(ta); ta.select();
                        document.execCommand('copy'); document.body.removeChild(ta);
                    }
                    $(this).text('Copied!');
                    setTimeout(() => { $(this).text('Copy'); }, 2000);
                } catch (err) {
                    console.error('Copy failed', err);
                    $(this).text('Error');
                    setTimeout(() => { $(this).text('Copy'); }, 2500);
                }
            };
            doCopy();
        });

        // Toggle short/full address on span click
        let showingFull = false;
        $li.on('click', '.pay-address-full', function() {
            showingFull = !showingFull;
            $(this).text(showingFull ? fullAddress : shortAddr);
        });
        UI.scrollChat();
        
        setTimeout(function() {
            $('#chatInput').focus();
        }, 100);
        SocketHandlers._setBannerStatus('Pay', '#0af');
        if (typeof Game !== 'undefined' && Game._paymentRequested) Game._paymentRequested();

        // Sidebar QR (persistent) - create/update separate from chat scroll
        if (data.qr) {
            let qrHolder = document.getElementById('paymentQRContainer');
            if (!qrHolder) {
                const statusDiv = document.querySelector('.status');
                if (statusDiv) {
                    qrHolder = document.createElement('div');
                    qrHolder.id = 'paymentQRContainer';
                    qrHolder.style.cssText = 'margin-top:6px;padding:8px;border:1px solid #0f0;background:#000;display:block;width:calc(100% - 18px);text-align:center;';
                    statusDiv.appendChild(qrHolder);
                }
            }
            if (qrHolder) {
                qrHolder.innerHTML = '<img style="image-rendering:pixelated;width:100%;height:auto;display:block;margin:0 auto;max-width:320px;" src="' + data.qr + '" alt="Payment QR" />';
            }
        } else {
            console.warn('Payment created but no QR data supplied by server.');
            let qrHolder = document.getElementById('paymentQRContainer');
            if (!qrHolder) {
                const statusDiv = document.querySelector('.status');
                if (statusDiv) {
                    qrHolder = document.createElement('div');
                    qrHolder.id = 'paymentQRContainer';
                    qrHolder.style.cssText = 'margin-top:6px;padding:4px;border:1px solid #f80;background:#000;display:inline-block;color:#f80;font-size:11px;max-width:150px;';
                    statusDiv.appendChild(qrHolder);
                }
            }
            if (qrHolder) {
                qrHolder.textContent = 'QR unavailable';
            }
        }
    },

    _lastDisplayedConfirmation: null,
    _confirmationTimestamps: {}, // paymentId -> ts
    onPaymentConfirmed: function(data) {
        console.log('Payment confirmed in block:', data);
        if (!data || !data.paymentId) return; // ignore malformed legacy event
        // Expire old confirmations (6h default) to prevent unbounded memory
        SocketHandlers._expireOldClientPaymentMarkers();
        if (SocketHandlers._lastDisplayedConfirmation === data.paymentId) return;
        SocketHandlers._lastDisplayedConfirmation = data.paymentId;
        SocketHandlers._confirmationTimestamps[data.paymentId] = Date.now();

        if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
            Game.drawWaitingScreen();
        }
        if (typeof Game !== 'undefined') {
            Game._pendingPaymentConfirmed();
        }

        $('#messages').append($('<li class="payment-success" style="color:#0f0;">').html(
            '✅ <strong>Payment confirmed in block.</strong> You are in the game queue.'
        ));
        UI.scrollChat();
        SocketHandlers._setBannerStatus('Confirmed', '#0f0');
        if (typeof AudioAlerts !== 'undefined' && AudioAlerts._enabled) {
            try { AudioAlerts.playFile('payment_confirmed'); } catch(_) {}
        }
    },

    _mempoolShownForPayment: new Set(),
    _mempoolTimestamps: {}, // paymentId -> ts
    onPaymentDetected: function(data) {
        console.log('Payment detected (mempool):', data);
        if (!data || !data.paymentId) return; // require paymentId for dedupe
        SocketHandlers._expireOldClientPaymentMarkers();
        if (SocketHandlers._mempoolShownForPayment.has(data.paymentId)) return;
        SocketHandlers._mempoolShownForPayment.add(data.paymentId);
        SocketHandlers._mempoolTimestamps[data.paymentId] = Date.now();
        if (typeof Game !== 'undefined') {
            Game._pendingPaymentDetected(data);
            if (Game.drawWaitingScreen) Game.drawWaitingScreen();
        }
        $('#messages').append($('<li class="payment-mempool" style="color:#0af;">').html(
            '🌀 <strong>Payment detected (mempool)</strong> – awaiting block confirmation...'
        ));
        UI.scrollChat();
        SocketHandlers._setBannerStatus('Mempool', '#0af');
        // Fallback audio trigger if AudioAlerts patched earlier failed to wrap or user enabled after patch
        if (typeof AudioAlerts !== 'undefined' && AudioAlerts._enabled) {
            try { AudioAlerts.playFile('payment_detected'); } catch(_) {}
        }
    },

    // Internal: periodic cleanup of client-side payment marker sets (invoked opportunistically)
    _expireOldClientPaymentMarkers: function() {
        const TTL = 6 * 60 * 60 * 1000; // 6 hours
        const now = Date.now();
        // Mempool markers
        for (const pid of Array.from(SocketHandlers._mempoolShownForPayment)) {
            const ts = SocketHandlers._mempoolTimestamps[pid];
            if (!ts || now - ts > TTL) {
                SocketHandlers._mempoolShownForPayment.delete(pid);
                delete SocketHandlers._mempoolTimestamps[pid];
            }
        }
        // Confirmation marker (single id tracking + map of timestamps)
        if (SocketHandlers._lastDisplayedConfirmation) {
            const lastId = SocketHandlers._lastDisplayedConfirmation;
            const ts = SocketHandlers._confirmationTimestamps[lastId];
            if (ts && now - ts > TTL) {
                delete SocketHandlers._confirmationTimestamps[lastId];
                // Allow new confirmation message for same id after TTL (rare, but cleans memory)
                SocketHandlers._lastDisplayedConfirmation = null;
            }
        }
    },

    onBlockHeight: function(data) {
        if (typeof UI !== 'undefined' && UI.updateBlockHeight) {
            UI.updateBlockHeight(data.blockHeight);
        }
        // Fallback: if status banner still says Connecting..., upgrade it
        const current = $('#statusValue').text();
        if (current === 'Connecting...') {
            SocketHandlers._setBannerStatus('Ready', '#0f0');
        }
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SocketHandlers;
}
