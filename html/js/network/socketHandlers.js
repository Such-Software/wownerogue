/**
 * Socket event handlers for the Wownerogue game
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
        
        // Delegated handlers for proof copy buttons
        $(document).on('click', '.copy-hash-btn', function() {
            const hash = $(this).data('hash');
            if (hash) {
                SocketHandlers._copyToClipboard(hash, $(this));
            }
        });
        $(document).on('click', '.copy-seed-btn', function() {
            const seed = $(this).data('seed');
            if (seed) {
                SocketHandlers._copyToClipboard(seed, $(this));
            }
        });

        // If the low-level socket connected before handlers were registered, emulate onConnect.
        if (window.socket && window.socket.connected) {
            this.onConnect();
        }
    },
    
    _copyToClipboard: function(text, $btn) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                const origText = $btn.text();
                $btn.text('Copied!');
                setTimeout(function() { $btn.text(origText); }, 1500);
            });
        } else {
            // Fallback
            const $temp = $('<input>');
            $('body').append($temp);
            $temp.val(text).select();
            document.execCommand('copy');
            $temp.remove();
            const origText = $btn.text();
            $btn.text('Copied!');
            setTimeout(function() { $btn.text(origText); }, 1500);
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
        socket.on('chat_history', this.onChatHistory);
        
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
    socket.on('address_update_error', this.onAddressUpdateError);
    socket.on('address_prompt', this.onAddressPrompt);
        socket.on('game_mode_info', this.onGameModeInfo);
        socket.on('payment_created', this.onPaymentCreated);
        socket.on('payment_confirmed', this.onPaymentConfirmed);
        socket.on('payment_detected', this.onPaymentDetected);
    socket.on('credits_update', this.onCreditsUpdate);
        
        // Block height handler
        socket.on('blockheight', this.onBlockHeight);
        
        // Spectator handlers
        socket.on('active_games', this.onActiveGames);
        socket.on('spectate_start', this.onSpectateStart);
        socket.on('spectator_update', this.onSpectatorUpdate);
        socket.on('spectate_ended', this.onSpectateEnded);
    },

    onConnect: function() {
        if (SocketHandlers._didConnect) return; // prevent duplicate registration emission
        SocketHandlers._didConnect = true;
        // Include stored session token in a lightweight resume emit (if server did not get it via handshake)
        try {
            const existing = localStorage.getItem('wownerogue_token');
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
            try { localStorage.setItem('wownerogue_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('New session established. Token stored.'));
            UI.scrollChat();
        }
    },

    onSessionResumed: function(data) {
        if (data && data.token) {
            try { localStorage.setItem('wownerogue_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('Session resumed.'));
            UI.scrollChat();
        }
        if (data && typeof data.credits === 'number') {
            SocketHandlers._updateCreditsDisplay(data.credits);
        }
        if (data && data.payoutAddress) {
            $('#messages').append($('<li class="address-confirmed" style="color:#0f0;">').text('Payout address restored.'));
            UI.scrollChat();
            if (typeof AddressModal !== 'undefined') {
                AddressModal.setCurrentAddress(data.payoutAddress);
            }
        }
    },

    onCreditsUpdate: function(data) {
        if (!data) return;
        if (typeof data.balance === 'number') {
            SocketHandlers._updateCreditsDisplay(data.balance);
        }
    },

    // Default credits per game (overridden by game_mode_info)
    _creditsPerGame: 1,
    
    _updateCreditsDisplay: function(balance, creditsPerGame) {
        // Update stored creditsPerGame if provided
        if (creditsPerGame && creditsPerGame > 0) {
            SocketHandlers._creditsPerGame = creditsPerGame;
        }
        
        let el = document.getElementById('creditsDisplay');
        if (!el) {
            // Create a small unobtrusive badge in header if not present
            const header = document.getElementById('header') || document.body;
            el = document.createElement('div');
            el.id = 'creditsDisplay';
            el.style.cssText = 'position:absolute;top:4px;right:8px;font-size:12px;font-family:monospace;color:#0af;background:#111;padding:2px 6px;border:1px solid #044;border-radius:4px;';
            header.appendChild(el);
        }
        
        // Calculate games remaining
        const perGame = SocketHandlers._creditsPerGame || 1;
        const gamesRemaining = Math.floor(balance / perGame);
        
        // Show credits and games remaining
        if (gamesRemaining > 0) {
            el.textContent = 'Credits: ' + balance + ' (' + gamesRemaining + ' game' + (gamesRemaining !== 1 ? 's' : '') + ')';
        } else {
            el.textContent = 'Credits: ' + balance;
        }
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

    onChatHistory: function(data) {
        if (!data || !data.messages || !Array.isArray(data.messages)) return;
        
        // Add a separator for history messages
        if (data.messages.length > 0) {
            $('#messages').append($('<li class="chat-history-header" style="color: #666; font-style: italic; border-bottom: 1px solid #333; margin-bottom: 5px; padding-bottom: 5px;">').text('--- Recent Chat History ---'));
        }
        
        // Add each historical message
        data.messages.forEach(function(msg) {
            const msgElement = $('<li style="color: #888;">');
            const username = msg.username || (msg.socketId ? msg.socketId.substring(0, 6) : 'anon');
            msgElement.html('<strong>' + username + ':</strong> ' + msg.message);
            $('#messages').append(msgElement);
        });
        
        if (data.messages.length > 0) {
            $('#messages').append($('<li class="chat-history-footer" style="color: #666; font-style: italic; border-top: 1px solid #333; margin-top: 5px; padding-top: 5px;">').text('--- End of History ---'));
        }
        
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
        
        // Display provably fair commitment if present
        if (data && data.proof && data.proof.commitment) {
            const shortHash = data.proof.commitment.substring(0, 16) + '...';
            const $proofMsg = $('<li class="proof-commitment" style="color:#0af; font-size:11px;">').html(
                '🔐 <strong>Provably Fair:</strong> Game hash commitment: <code style="background:#001a00; padding:2px 4px; border-radius:3px;" title="' + 
                data.proof.commitment + '">' + shortHash + '</code> ' +
                '<button class="copy-hash-btn" style="font-size:10px; padding:1px 4px; cursor:pointer;" data-hash="' + 
                data.proof.commitment + '">Copy</button>'
            );
            $('#messages').append($proofMsg);
            
            // Store for later verification display
            SocketHandlers._currentGameProof = data.proof;
        }
        
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
        // Sound handled by AudioAlerts._patchSocketHandlers() - don't duplicate
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
        
        // Display provably fair verification info if present
        if (data && data.proof && data.proof.seed) {
            const shortSeed = data.proof.seed.substring(0, 16) + '...';
            const shortCommitment = data.proof.commitment.substring(0, 16) + '...';
            const verifyUrl = data.proof.verificationUrl || ('/verify/' + data.proof.gameId);
            
            const $proofReveal = $('<li class="proof-reveal" style="color:#4ade80; font-size:11px; margin-top:5px; padding:8px; background:rgba(0,50,0,0.5); border-radius:4px;">').html(
                '🔓 <strong>Game Verified:</strong><br>' +
                '<span style="color:#888;">Seed:</span> <code style="background:#001a00; padding:2px 4px; border-radius:3px;" title="' + 
                data.proof.seed + '">' + shortSeed + '</code> ' +
                '<button class="copy-seed-btn" style="font-size:10px; padding:1px 4px; cursor:pointer;" data-seed="' + 
                data.proof.seed + '">Copy</button><br>' +
                '<span style="color:#888;">Hash:</span> <code style="background:#001a00; padding:2px 4px; border-radius:3px;">' + shortCommitment + '</code><br>' +
                '<a href="' + verifyUrl + '" target="_blank" style="color:#0af;">🔗 Verify this game</a>'
            );
            $('#messages').append($proofReveal);
            
            // Clear stored proof
            SocketHandlers._currentGameProof = null;
        }
        
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
        
        // Cleanup previous address-related messages to reduce clutter
        $('#messages li').each(function() {
            const text = $(this).text();
            if (text.includes('Paste your payout address') || 
                text.includes('Detected payout address') || 
                text.includes('Type \'confirm\' to save') ||
                text.includes('Address detected. Type confirm')) {
                $(this).remove();
            }
        });

        $('#messages').append($('<li class="address-confirmed" style="color: #0f0; white-space: pre-line;">').text(data.message));
        UI.scrollChat();
        if (typeof AddressModal !== 'undefined') {
            AddressModal.onConfirmed(data);
        }
    },

    onAddressPrompt: function(data) {
        if (typeof AddressModal !== 'undefined') {
            AddressModal.show({
                existingAddress: data?.existingAddress || null,
                message: data?.message || null
            });
        }
    },

    onAddressUpdateError: function(data) {
        if (typeof AddressModal !== 'undefined') {
            AddressModal.handleError(data?.message || 'Failed to update address.');
        }
    },

    onGameModeInfo: function(data) {
        console.log('Game mode info received:', data);
        
        // Store creditsPerGame for calculating games remaining
        if (data.creditsPerGame) {
            SocketHandlers._creditsPerGame = data.creditsPerGame;
        }
        
        if (typeof UI !== 'undefined' && UI.updateGameTitle) {
            UI.updateGameTitle(data.cryptoType);
        }

        // Update ScreenManager with crypto type for welcome screen title
        if (typeof ScreenManager !== 'undefined' && ScreenManager.setCryptoType) {
            ScreenManager.setCryptoType(data.cryptoType);
        }

        // Display testnet/stagenet warning if applicable
        if (data.testnetWarning) {
            SocketHandlers._showNetworkWarning(data.testnetWarning, data.network);
        } else {
            SocketHandlers._hideNetworkWarning();
        }

        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.updateConfig(data);
            // Show shop button if payments enabled
            if (data.paymentsEnabled) {
                $('#shopButton').show();
            } else {
                $('#shopButton').hide();
            }
        }
    },

    _showNetworkWarning: function(message, network) {
        let $warning = $('#networkWarning');
        if (!$warning.length) {
            $warning = $('<div id="networkWarning"></div>');
            // Insert at top of container
            $('.container').prepend($warning);
        }
        const networkUpper = (network || 'stagenet').toUpperCase();
        $warning.html(`
            <div style="background:#ff6600; color:#000; padding:10px; text-align:center; font-weight:bold; font-size:14px; border-bottom:2px solid #ff0000;">
                ⚠️ ${networkUpper} MODE ⚠️<br>
                <span style="font-size:12px; font-weight:normal;">${message}</span>
            </div>
        `).show();
    },

    _hideNetworkWarning: function() {
        $('#networkWarning').hide();
    },

    onPaymentCreated: function(data) {
        console.log('Payment created:', data);
        if (typeof AudioAlerts !== 'undefined') { AudioAlerts.playRequestCoin(); }
        
        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.showPaymentRequest(data);
        }

        const parts = [];
        const reusedCopy = data.reused
            ? '🔁 <strong>Pending payment request still active.</strong> Use the same amount and address below.'
            : '💳 <strong>Payment Required</strong>';
        parts.push(reusedCopy);
        const displayAmount = data.humanAmount || data.amountFormatted || data.amount;
        parts.push('Amount: ' + displayAmount + ' ' + (data.cryptoType || ''));
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
        // Sound handled by AudioAlerts._patchSocketHandlers() - don't duplicate
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
        // Sound handled by AudioAlerts._patchSocketHandlers() - don't duplicate
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
        // Sync to ScreenManager for welcome screen display
        if (typeof ScreenManager !== 'undefined' && data.blockHeight) {
            ScreenManager._currentBlockHeight = data.blockHeight;
            // Redraw welcome screen if not in a game, not spectating, and not showing waiting screen
            if (typeof GameState !== 'undefined' && !GameState.isGameActive() && 
                typeof Game !== 'undefined' && !Game._isSpectating &&
                !ScreenManager.isShowingWaitingScreen()) {
                ScreenManager.drawWelcomeScreen();
            }
        }
        // Fallback: if status banner still says Connecting..., upgrade it
        const current = $('#statusValue').text();
        if (current === 'Connecting...') {
            SocketHandlers._setBannerStatus('Ready', '#0f0');
        }
    },

    // ====== SPECTATOR HANDLERS ======

    _spectatorMode: false,
    _spectatingGameId: null,
    _activeGames: [],

    onActiveGames: function(data) {
        if (!data || !data.games) return;
        SocketHandlers._activeGames = data.games;
        SocketHandlers._updateGamesListPanel(data);
    },

    onSpectateStart: function(data) {
        if (!data) return;
        SocketHandlers._spectatorMode = true;
        SocketHandlers._spectatingGameId = data.gameId;
        
        // Hide games panel
        SocketHandlers._hideGamesPanel();
        
        // Show spectator controls
        SocketHandlers._showSpectatorControls(data.playerId);
        
        // Start the game display in spectator mode
        if (typeof Game !== 'undefined' && data.initialState) {
            const state = data.initialState;
            try {
                // Use a modified startGame that marks as spectator
                Game._isSpectating = true;
                Game.startGame(
                    state.player,
                    state.map,
                    state.monster,
                    state.items || {},
                    state.visibleTiles,
                    state.lighting,
                    state.torches
                );
                
                $('#messages').append($('<li class="spectate-start" style="color:#0af;">').text(
                    '👁️ Now spectating player ' + data.playerId + '. Press ESC or click "Leave" to exit.'
                ));
                UI.scrollChat();
            } catch (err) {
                console.error('Failed to start spectator view:', err);
            }
        }
        
        SocketHandlers._setBannerStatus('Spectating', '#0af');
    },

    onSpectatorUpdate: function(data) {
        if (!data || !SocketHandlers._spectatorMode) return;
        
        // Update the game display with new state
        if (typeof Game !== 'undefined' && typeof Game.updateGameState === 'function') {
            Game.updateGameState(data.gameState);
        }
    },

    onSpectateEnded: function(data) {
        SocketHandlers._spectatorMode = false;
        SocketHandlers._spectatingGameId = null;
        
        if (typeof Game !== 'undefined') {
            Game._isSpectating = false;
        }
        
        // Hide spectator controls
        SocketHandlers._hideSpectatorControls();
        
        // Show end message
        const reason = data?.reason || 'unknown';
        const gameOverData = data?.gameOverData;
        
        let message = '👁️ Spectating ended';
        if (reason === 'game_over' && gameOverData) {
            message = '👁️ Game ended: ' + (gameOverData.status === 'won' ? '🏆 Player escaped!' : '💀 Player caught!');
        } else if (reason === 'user_left') {
            message = '👁️ Left spectator mode';
        }
        
        $('#messages').append($('<li class="spectate-end" style="color:#0af;">').text(message));
        UI.scrollChat();
        
        // Return to welcome screen
        if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWelcomeScreen) {
            ScreenManager.drawWelcomeScreen();
        }
        
        // Show games panel again
        SocketHandlers._showGamesPanel();
        
        SocketHandlers._setBannerStatus('Ready', '#0f0');
    },

    _updateGamesListPanel: function(data) {
        let $panel = $('#gamesListPanel');
        
        // Create panel if it doesn't exist
        if (!$panel.length) {
            $panel = $(`
                <div id="gamesListPanel" style="
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    width: 280px;
                    max-height: 400px;
                    background: rgba(0, 20, 0, 0.95);
                    border: 2px solid #0f0;
                    border-radius: 5px;
                    padding: 10px;
                    color: #0f0;
                    font-family: monospace;
                    font-size: 12px;
                    z-index: 1500;
                    overflow-y: auto;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #0f0; padding-bottom: 5px; margin-bottom: 10px;">
                        <strong>👁️ Live Games</strong>
                        <button id="gamesListClose" style="background: none; border: 1px solid #0f0; color: #0f0; cursor: pointer; padding: 2px 6px;">×</button>
                    </div>
                    <div id="pendingGamesContent"></div>
                    <div id="gamesListContent"></div>
                    <div id="gamesListPagination" style="border-top: 1px solid #0f0; padding-top: 5px; margin-top: 10px; text-align: center;"></div>
                </div>
            `);
            $('body').append($panel);
            
            // Close button handler
            $panel.on('click', '#gamesListClose', function() {
                $panel.hide();
            });
            
            // Spectate button handler (delegated)
            $panel.on('click', '.spectate-btn', function() {
                const gameId = $(this).data('gameid');
                if (gameId && window.socket) {
                    socket.emit('spectate_game', { gameId: gameId });
                }
            });
        }
        
        // Render pending games section
        const $pendingContent = $('#pendingGamesContent');
        $pendingContent.empty();
        
        if (data.pendingGames && data.pendingGames.length > 0) {
            $pendingContent.append(`
                <div style="color: #fa0; font-size: 11px; margin-bottom: 5px; border-bottom: 1px solid #550;">
                    ⏳ Pending (${data.pendingGames.length})
                </div>
            `);
            
            data.pendingGames.forEach(function(pending) {
                const waitTime = Math.floor((Date.now() - pending.queuedAt) / 1000);
                const status = pending.waitingForConfirmation ? '⏳ Confirming' : '✅ Ready';
                
                $pendingContent.append(`
                    <div style="
                        padding: 6px;
                        margin-bottom: 5px;
                        background: rgba(60, 40, 0, 0.5);
                        border: 1px solid #550;
                        border-radius: 3px;
                        font-size: 11px;
                    ">
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #fa0;">Player ${pending.playerId}</span>
                            <span style="color: #888;">${waitTime}s ago</span>
                        </div>
                        <div style="color: #888; margin-top: 2px;">
                            ${status} - waiting for next block
                        </div>
                    </div>
                `);
            });
        }
        
        // Render active games section
        const $content = $('#gamesListContent');
        $content.empty();
        
        if (!data.games || data.games.length === 0) {
            if (!data.pendingGames || data.pendingGames.length === 0) {
                $content.html('<div style="color: #888; text-align: center; padding: 20px;">No active games</div>');
            }
            return;
        }
        
        $content.append(`
            <div style="color: #0f0; font-size: 11px; margin-bottom: 5px; margin-top: 10px; border-bottom: 1px solid #050;">
                🎮 Live (${data.games.length})
            </div>
        `);
        
        // Render each game
        data.games.forEach(function(game) {
            const duration = game.durationSeconds || 0;
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const timeStr = mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
            
            const $gameItem = $(`
                <div class="game-list-item" style="
                    padding: 8px;
                    margin-bottom: 5px;
                    background: rgba(0, 40, 0, 0.5);
                    border: 1px solid #050;
                    border-radius: 3px;
                    cursor: pointer;
                " data-gameid="${game.gameId}">
                    <div style="display: flex; justify-content: space-between;">
                        <span style="color: #0f0;">Player ${game.playerId}</span>
                        <span style="color: #888; font-size: 10px;">${timeStr}</span>
                    </div>
                    <div style="font-size: 10px; color: #888; margin-top: 3px;">
                        ${game.moveCount} moves | 
                        ${game.hasTreasure ? '💎' : '⬜'} | 
                        👁️ ${game.spectatorCount}
                    </div>
                    <button class="spectate-btn" data-gameid="${game.gameId}" style="
                        width: 100%;
                        margin-top: 5px;
                        background: #050;
                        border: 1px solid #0f0;
                        color: #0f0;
                        padding: 4px;
                        cursor: pointer;
                        font-size: 11px;
                    ">👁️ Watch Game</button>
                </div>
            `);
            $content.append($gameItem);
        });
        
        // Pagination info
        const pag = data.pagination;
        if (pag && pag.totalGames > pag.pageSize) {
            $('#gamesListPagination').html(
                'Page ' + pag.page + '/' + pag.totalPages + 
                ' (' + pag.totalGames + ' games)'
            );
        } else {
            $('#gamesListPagination').html(pag ? pag.totalGames + ' game(s)' : '');
        }
        
        $panel.show();
    },

    _showGamesPanel: function() {
        $('#gamesListPanel').show();
    },

    _hideGamesPanel: function() {
        $('#gamesListPanel').hide();
    },

    _showSpectatorControls: function(playerId) {
        let $controls = $('#spectatorControls');
        
        if (!$controls.length) {
            $controls = $(`
                <div id="spectatorControls" style="
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    background: rgba(0, 20, 60, 0.95);
                    border: 2px solid #0af;
                    border-radius: 5px;
                    padding: 10px 15px;
                    color: #0af;
                    font-family: monospace;
                    font-size: 12px;
                    z-index: 1500;
                ">
                    <div style="margin-bottom: 8px;">
                        👁️ <strong>Spectating:</strong> <span id="spectatingPlayer">---</span>
                    </div>
                    <button id="leaveSpectate" style="
                        background: #500;
                        border: 1px solid #f55;
                        color: #f55;
                        padding: 6px 12px;
                        cursor: pointer;
                        width: 100%;
                    ">Leave Spectate</button>
                </div>
            `);
            $('body').append($controls);
            
            $controls.on('click', '#leaveSpectate', function() {
                if (window.socket) {
                    socket.emit('leave_spectate');
                }
            });
        }
        
        $('#spectatingPlayer').text(playerId);
        $controls.show();
    },

    _hideSpectatorControls: function() {
        $('#spectatorControls').hide();
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SocketHandlers;
}
