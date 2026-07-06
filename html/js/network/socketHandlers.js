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

    _hasPayoutAddress: false,
    _creditsBalance: 0,
    _gameMode: null, // set from the server's game-modes event; was previously declared
                     // twice in this object literal (the later `null` silently won)

    _directPayoutsEnabled: false,
    _paymentsEnabled: false,

    payoutAddressRequired: function() {
        if (this._gameMode === 'PAID_SINGLE' && this._directPayoutsEnabled) return true;
        if (this._gameMode === 'PAID_CREDITS' && this._creditsPayoutsEnabled) return true;
        return false;
    },

    canAffordGame: function() {
        if (this._gameMode === 'FREE') return true;
        if (this._gameMode === 'PAID_SINGLE') return true; // Payment will be requested
        if (this._gameMode === 'PAID_CREDITS') {
            return this._creditsBalance >= (this._creditsPerGame || 1);
        }
        return false;
    },

    _updateAddressButtonStatus: function(hasAddress) {
        const $btn = $('#manageAddressButton');
        this._hasPayoutAddress = !!hasAddress;
        if (!$btn.length) return;
        
        if (hasAddress) {
            // Address is set - show green indicator
            $btn.css({
                'background': '#053655',
                'color': '#0ff',
                'border-color': '#0ff'
            });
            $btn.html('✅ Payout Address Set');
        } else {
            // No address - show warning indicator (yellow/orange)
            $btn.css({
                'background': '#553300',
                'color': '#ffa500',
                'border-color': '#ffa500'
            });
            $btn.html('⚠️ Set Payout Address');
        }
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
        socket.on('chat_deleted', this.onChatDeleted);
        socket.on('chat_error', this.onChatError);

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
        socket.on('show_payment_options', this.onShowPaymentOptions);
        socket.on('balance_critical', this.onBalanceCritical);
    socket.on('credits_update', this.onCreditsUpdate);
        socket.on('user_count', this.onUserCount);
        
        // Block height handler
        socket.on('blockheight', this.onBlockHeight);
        
        // Early entry handlers
        socket.on('early_entry_success', this.onEarlyEntrySuccess);
        socket.on('early_entry_error', this.onEarlyEntryError);
        
        // Spectator handlers
        socket.on('active_games', this.onActiveGames);
        socket.on('spectate_start', this.onSpectateStart);
        socket.on('spectator_update', this.onSpectatorUpdate);
        socket.on('spectate_ended', this.onSpectateEnded);

        // Global win feed (someone escaped) -> floating toast
        socket.on('win_feed', this.onWinFeed);
    },

    // Show a transient "someone just escaped" toast so the room feels alive. Toasts stack in a
    // fixed container (top-right), auto-dismiss, and never block the UI.
    onWinFeed: function(data) {
        if (!data) return;
        var name = String(data.name || 'Someone').slice(0, 24);
        var bag = data.treasure ? ' 💰 with the bag' : '';
        var paid = data.paid ? ' <span style="color:#fbbf24;">(payout!)</span>' : '';
        try {
            var $c = $('#win-feed');
            if (!$c.length) {
                $c = $('<div id="win-feed"></div>').appendTo('body');
            }
            var $t = $('<div class="win-toast"></div>').html(
                '🏆 <strong>' + escapeHtml(name) + '</strong> escaped' + bag + paid
            );
            $c.append($t);
            // Fade in, hold, fade out, remove.
            requestAnimationFrame(function () { $t.addClass('show'); });
            setTimeout(function () { $t.removeClass('show'); }, 5000);
            setTimeout(function () { $t.remove(); }, 5600);
            // Cap the number of simultaneous toasts.
            var $all = $c.children('.win-toast');
            if ($all.length > 4) { $all.first().remove(); }
        } catch (e) { /* non-critical */ }
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
            // New session = no address set yet
            SocketHandlers._updateAddressButtonStatus(false);
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
            SocketHandlers._updateAddressButtonStatus(true);
        } else {
            SocketHandlers._updateAddressButtonStatus(false);
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
        // Store current balance
        this._creditsBalance = balance;

        // Update stored creditsPerGame if provided
        if (creditsPerGame && creditsPerGame > 0) {
            SocketHandlers._creditsPerGame = creditsPerGame;
        }

        var el = document.getElementById('creditsDisplay');
        if (!el) return;

        // Calculate games remaining
        var perGame = SocketHandlers._creditsPerGame || 1;
        var gamesRemaining = Math.floor(balance / perGame);

        // Show/hide based on balance
        if (balance > 0) {
            el.style.display = 'block';
            if (gamesRemaining > 0) {
                el.textContent = 'Credits: ' + balance + ' (' + gamesRemaining + ' game' + (gamesRemaining !== 1 ? 's' : '') + ')';
            } else {
                el.textContent = 'Credits: ' + balance;
            }
        } else {
            el.style.display = 'none';
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
            // Escape both fields — chat content is attacker-controlled. Defense in depth:
            // the server also escapes, but the client must never trust that.
            msgElement.html('<strong>' + escapeHtml(String(data.socketId).substring(0, 6)) + ':</strong> ' + escapeHtml(data.message));
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

        // Add each historical message with data-msg-id for deletion support
        data.messages.forEach(function(msg) {
            const msgElement = $('<li style="color: #888;">');
            if (msg.id) {
                msgElement.attr('data-msg-id', msg.id);
            }
            const username = msg.playerId || msg.username || (msg.socketId ? msg.socketId.substring(0, 6) : 'anon');
            const isSystem = msg.type === 'system' || msg.socketId === 'system';
            if (isSystem) {
                msgElement.addClass('status');
            }
            // Add timestamp if available
            let timeStr = '';
            if (msg.timestamp) {
                timeStr = '<span style="color:#555;font-size:10px;">[' + SocketHandlers._formatTimeAgo(new Date(msg.timestamp)) + ']</span> ';
            }
            msgElement.html(timeStr + '<strong>' + escapeHtml(username) + ':</strong> ' + escapeHtml(msg.message));
            $('#messages').append(msgElement);
        });

        if (data.messages.length > 0) {
            $('#messages').append($('<li class="chat-history-footer" style="color: #666; font-style: italic; border-top: 1px solid #333; margin-top: 5px; padding-top: 5px;">').text('--- End of History ---'));
        }

        UI.scrollChat();
    },

    onChatDeleted: function(data) {
        if (!data || !data.messageId) return;
        // Remove deleted message from view with fade effect
        $('#messages li[data-msg-id="' + data.messageId + '"]').fadeOut(200, function() {
            $(this).remove();
        });
    },

    onChatError: function(data) {
        if (!data || !data.message) return;
        $('#messages').append($('<li class="error" style="color:#f66;">').text(data.message));
        UI.scrollChat();
    },

    _formatTimeAgo: function(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
        return Math.floor(seconds / 86400) + 'd ago';
    },

    onWaitingStatus: function(data) {
        if (data.status === 'waiting') {
            $('#messages').append($('<li style="color:#ff0;">').text(data.message));
            
            // Check if we should show waiting screen
            const addressRequired = SocketHandlers.payoutAddressRequired();
            const hasAddress = SocketHandlers._hasPayoutAddress;
            const canAfford = SocketHandlers.canAffordGame();
            const isFree = SocketHandlers._gameMode === 'FREE';

            const shouldShowWaiting = isFree || (canAfford && (!addressRequired || hasAddress));

            if (shouldShowWaiting && typeof Game !== 'undefined' && Game.drawWaitingScreen) {
                Game.drawWaitingScreen();
            }
        }
        UI.scrollChat();
    },

    onQueueJoined: function(data) {
        console.log('Queue joined:', data);
        
        // Mark as queued and update early entry button
        SocketHandlers._isQueued = true;
        SocketHandlers._updateEarlyEntryButton();
        
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
        // Clear queued state
        SocketHandlers._isQueued = false;
        SocketHandlers._updateEarlyEntryButton();
        
        // Hide any lingering QR code
        SocketHandlers.hidePaymentQR();
        
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
        
        const won = data && (data.status === 'won' || data.reason === 'escaped');

        // Show payout notification for wins
        if (won && data.payout && data.payout.amount) {
            var decimals = (SocketHandlers._cryptoType === 'WOW') ? 11 : 12;
            var amountFormatted = (data.payout.amount / Math.pow(10, decimals)).toFixed(4);
            var currency = SocketHandlers._currencyLabel || SocketHandlers._cryptoType || 'WOW';
            var multiplierText = data.payout.multiplier ? ' (' + data.payout.multiplier + 'x)' : '';
            var treasureText = data.payout.treasure ? ' + Treasure bonus!' : '';
            $('#messages').append($('<li style="color:#4ade80; font-weight:bold; padding:4px 0;">').html(
                '💰 Payout queued: ' + amountFormatted + ' ' + currency + multiplierText + treasureText
            ));
        }

        // Offer a one-tap "Share to X" on wins (brag mechanic). The verify link unfurls with a
        // social card (OG meta on the /verify page), so a shared tweet shows a preview.
        if (won) {
            SocketHandlers._appendShareWin(data);
        }

        UI.scrollChat();
        if (won) {
            SocketHandlers._setBannerStatus('Won', '#0f0');
        } else {
            SocketHandlers._setBannerStatus('Lost', '#f00');
        }
    },

    // Build an absolute verify URL for this game (used by the share button).
    _verifyUrlFor: function(data) {
        var path = (data && data.proof && (data.proof.verificationUrl ||
            (data.proof.gameId ? '/verify/' + data.proof.gameId : null)));
        if (!path) return null;
        try { return new URL(path, window.location.origin).href; }
        catch (e) { return window.location.origin + path; }
    },

    _appendShareWin: function(data) {
        var url = SocketHandlers._verifyUrlFor(data);
        if (!url) return; // no proof -> nothing to verify/share

        var bag = data && data.treasure ? ' with the bag 💰' : '';
        var score = (data && typeof data.score === 'number') ? (' (score ' + data.score + ')') : '';
        var text = '🏆 I escaped the dungeon' + bag + score + ' in this provably-fair crypto roguelike!';
        var intent = 'https://twitter.com/intent/tweet?text=' +
            encodeURIComponent(text) + '&url=' + encodeURIComponent(url);

        var $row = $('<li class="share-win" style="margin-top:6px; padding:8px; background:rgba(0,40,0,0.4); border-radius:4px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">');
        $row.append($('<strong style="color:#4ade80;">').text('Brag about it:'));

        var $x = $('<button type="button" class="share-x-btn" style="cursor:pointer; background:#000; color:#fff; border:1px solid #555; border-radius:4px; padding:4px 10px; font-size:12px;">𝕏 Share to X</button>');
        $x.on('click', function () { window.open(intent, '_blank', 'noopener'); });

        var $copy = $('<button type="button" class="share-copy-btn" style="cursor:pointer; background:#053655; color:#0af; border:1px solid #0af; border-radius:4px; padding:4px 10px; font-size:12px;">🔗 Copy link</button>');
        $copy.on('click', function () {
            var done = function () { $copy.text('✅ Copied!'); setTimeout(function () { $copy.text('🔗 Copy link'); }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt('Copy this link:', url); });
            } else { window.prompt('Copy this link:', url); }
        });

        $row.append($x).append($copy);
        $('#messages').append($row);
    },

    onQueueCancelled: function(data) {
        // Clear queued state
        SocketHandlers._isQueued = false;
        SocketHandlers._updateEarlyEntryButton();
        
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
        // Update button to show address is set (unless cancelled)
        if (!data.cancelled && data.address) {
            SocketHandlers._updateAddressButtonStatus(true);
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
        
        // Store game mode and early entry config
        SocketHandlers._gameMode = data.mode;
        SocketHandlers._earlyEntryConfig = data.earlyEntry || { enabled: false };
        SocketHandlers._creditsPayoutsEnabled = !!data.creditsPayoutsEnabled;
        SocketHandlers._directPayoutsEnabled = !!data.directPayoutsEnabled;
        SocketHandlers._paymentsEnabled = !!data.paymentsEnabled;
        SocketHandlers._smirkEnabled = data.smirkEnabled !== false; // Default to true if not specified
        SocketHandlers._cryptoType = data.cryptoType || 'WOW';
        SocketHandlers._currencyLabel = data.currencyLabel || data.cryptoType || 'WOW'; // sXMR on stagenet
        SocketHandlers._explorerTxUrl = data.explorerTxUrl || null;

        // Mode availability (Solo / Tavern / Multiplayer). Backward compatible: if the server
        // doesn't send `modes`, assume solo-only (the historical behavior).
        var modes = data.modes || { solo: true, tavern: false, multiplayer: false };
        SocketHandlers._modes = modes;
        if (modes.tavern) { $('#tavernButton').show(); } else { $('#tavernButton').hide(); }
        // Tavern-only / no single-player instance: don't surface the solo start button.
        if (modes.solo === false) { $('#startButton').hide(); }

        // Initialize Smirk auth if enabled and not already initialized
        if (SocketHandlers._smirkEnabled && typeof SmirkAuth !== 'undefined' && !SmirkAuth._initialized) {
            SmirkAuth.init();
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

        // Update HelpModal with config
        if (typeof HelpModal !== 'undefined') {
            HelpModal.updateConfig(data);
        }
        
        // Update early entry button visibility
        SocketHandlers._updateEarlyEntryButton();
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

        // Try Smirk native payment if user is connected via Smirk
        if (typeof SmirkAuth !== 'undefined' && SmirkAuth._isLinked && SmirkAuth.isAvailable() &&
            typeof window.smirk !== 'undefined' && window.smirk.requestPayment) {
            SocketHandlers._trySmirkPayment(data);
            return;
        }

        // Normal flow: show payment modal + chat message + QR
        SocketHandlers._showPaymentFlow(data);
    },

    /**
     * Attempt payment via Smirk wallet extension.
     * Falls back to normal address/QR flow on rejection or error.
     */
    _trySmirkPayment: async function(data) {
        $('#messages').append($('<li class="status">').text('Opening Smirk wallet for payment...'));
        UI.scrollChat();

        try {
            // Use human-readable amount (e.g. "1"), NOT atomic units (e.g. 100000000000)
            var payAmount = data.humanAmount || data.amountFormatted || String(data.amount);
            var description = 'Single game entry';
            if (data.paymentType === 'credits_package') {
                description = 'Buy ' + (data.package ? data.package.credits : '') + ' credits';
            } else if (data.paymentType === 'cosmetic_pack') {
                description = 'Unlock ' + (data.package ? (data.package.label || data.package.id || 'premium pack') : 'premium pack');
            }

            await window.smirk.requestPayment({
                address: data.address,
                amount: payAmount,
                asset: (SocketHandlers._cryptoType || 'WOW').toLowerCase(),
                description: description
            });

            // User confirmed in Smirk — TX submitted, server monitoring handles the rest
            $('#messages').append($('<li class="status" style="color:#4ade80;">').text(
                'Payment sent via Smirk! Waiting for confirmation...'
            ));
            UI.scrollChat();

            // Show payment UI in "waiting for confirmation" state
            if (typeof PaymentUI !== 'undefined') {
                PaymentUI.showPaymentRequest(data);
                $('#payment-status').html('<span style="color:#4ade80;">Payment sent via Smirk — awaiting confirmation...</span>');
            }
            SocketHandlers._setBannerStatus('Pay', '#0af');
            if (typeof Game !== 'undefined' && Game._paymentRequested) Game._paymentRequested();
            if (typeof Game !== 'undefined' && Game.drawWaitingScreen) Game.drawWaitingScreen();

        } catch (err) {
            console.log('Smirk payment declined/failed, falling back to manual:', err);
            var errMsg = String(err.message || err || '').toLowerCase();

            // Check if this is a user-initiated denial vs extension error
            var isUserDenied = errMsg.indexOf('denied') !== -1 ||
                               errMsg.indexOf('rejected') !== -1 ||
                               errMsg.indexOf('cancelled') !== -1 ||
                               errMsg.indexOf('user') !== -1;

            if (isUserDenied) {
                $('#messages').append($('<li class="status">').text(
                    'Smirk payment cancelled. Use the address below.'
                ));
            } else {
                // Extension error (context invalidated, service worker issue, etc.)
                $('#messages').append($('<li class="status" style="color:#f59e0b;">').text(
                    'Smirk payment unavailable — using manual payment. Try refreshing the page to fix Smirk.'
                ));
                SmirkAuth._isLinked = false;
            }
            UI.scrollChat();

            // Fall back to normal address/QR flow
            SocketHandlers._showPaymentFlow(data);
        }
    },

    /**
     * Show normal payment flow: modal + chat message + QR code
     */
    _showPaymentFlow: function(data) {
        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.showPaymentRequest(data);
        }

        const parts = [];
        const reusedCopy = data.reused
            ? '🔁 <strong>Pending payment request still active.</strong> Use the same amount and address below.'
            : '💳 <strong>Payment Required</strong>';
        parts.push(reusedCopy);
        const displayAmount = data.humanAmount || data.amountFormatted || data.amount;
        parts.push('Amount: ' + displayAmount + ' ' + (data.currencyLabel || SocketHandlers._currencyLabel || data.cryptoType || ''));
        const shortAddr = data.address.substring(0, 10) + '…' + data.address.slice(-6);
        parts.push('Address: <span class="pay-address-full" style="cursor:pointer;" title="Click to toggle full address">' + shortAddr + '</span>' +
                   ' <button class="copy-pay-address" data-address="' + data.address + '" style="margin-left:4px;padding:1px 4px;font-size:11px;cursor:pointer;">Copy</button>');
        const $li = $('<li class="payment-info" style="white-space:normal;">').html(parts.join('<br>'));
        $('#messages').append($li);

        // Attach copy handler
        const fullAddress = data.address;
        $li.on('click', '.copy-pay-address', function(e) {
            e.preventDefault();
            const addr = $(this).data('address');
            const doCopy = async () => {
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(addr);
                    } else {
                        var ta = document.createElement('textarea');
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
        var showingFull = false;
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

        if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
            Game.drawWaitingScreen();
        }

        // Sidebar QR (persistent) - create/update separate from chat scroll
        if (data.qr) {
            let qrHolder = document.getElementById('paymentQRContainer');
            if (!qrHolder) {
                const statusDiv = document.querySelector('.status');
                if (statusDiv) {
                    qrHolder = document.createElement('div');
                    qrHolder.id = 'paymentQRContainer';
                    qrHolder.style.cssText = 'position:relative;margin-top:6px;padding:8px;border:1px solid #0f0;background:#000;display:block;width:calc(100% - 18px);text-align:center;';
                    statusDiv.appendChild(qrHolder);
                }
            }
            if (qrHolder) {
                // Create close button
                const closeBtn = '<div onclick="SocketHandlers.hidePaymentQR()" style="position:absolute;top:4px;right:8px;cursor:pointer;font-size:16px;color:#0f0;font-weight:bold;z-index:10;" title="Close QR code">✕</div>';
                qrHolder.innerHTML = closeBtn + '<img style="image-rendering:pixelated;width:100%;height:auto;display:block;margin:0 auto;max-width:320px;" src="' + data.qr + '" alt="Payment QR" />';
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
    
    // Helper to hide/remove the payment QR code container
    hidePaymentQR: function() {
        const qrHolder = document.getElementById('paymentQRContainer');
        if (qrHolder) {
            qrHolder.remove();
        }
    },

    onShowPaymentOptions: function(data) {
        console.log('Show payment options:', data);
        // Show the payment options modal so user can choose how to play
        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.show();
        }
    },

    onBalanceCritical: function(data) {
        console.warn('Balance critical - games halted:', data);

        const message = data?.message || 'Sorry, the house balance is too low to initiate new games. Please try again later.';

        // Show a modal to the user
        SocketHandlers._showBalanceCriticalModal(message);

        // Also show in chat
        $('#messages').append($('<li class="error" style="color: #ff6600; font-weight: bold;">').text('⚠️ ' + message));
        UI.scrollChat();

        SocketHandlers._setBannerStatus('Unavailable', '#ff6600');
    },

    _showBalanceCriticalModal: function(message) {
        // Remove any existing modal
        $('#balanceCriticalModal').remove();

        const $modal = $(`
            <div id="balanceCriticalModal" style="
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.85);
                z-index: 2000;
                display: flex;
                align-items: center;
                justify-content: center;
            ">
                <div style="
                    background: linear-gradient(180deg, #220000, #110000);
                    border: 3px solid #ff3300;
                    border-radius: 10px;
                    padding: 30px 40px;
                    max-width: 450px;
                    text-align: center;
                    color: #fff;
                    font-family: monospace;
                    box-shadow: 0 0 30px rgba(255, 51, 0, 0.5);
                ">
                    <div style="font-size: 48px; margin-bottom: 15px;">⚠️</div>
                    <h2 style="color: #ff6600; margin: 0 0 20px 0; font-size: 20px;">Service Temporarily Unavailable</h2>
                    <p style="color: #ffcc99; margin: 0 0 25px 0; line-height: 1.6; font-size: 14px;">
                        ${message}
                    </p>
                    <button id="balanceCriticalOK" style="
                        background: linear-gradient(180deg, #663300, #331100);
                        border: 2px solid #ff6600;
                        color: #ffcc00;
                        padding: 12px 30px;
                        font-family: monospace;
                        font-size: 14px;
                        cursor: pointer;
                        border-radius: 5px;
                    ">OK</button>
                </div>
            </div>
        `);

        $('body').append($modal);

        // Close handlers
        $modal.on('click', '#balanceCriticalOK', function() {
            $modal.fadeOut(200, function() { $modal.remove(); });
        });

        // Also close on clicking outside
        $modal.on('click', function(e) {
            if (e.target === $modal[0]) {
                $modal.fadeOut(200, function() { $modal.remove(); });
            }
        });

        // Close on ESC key
        $(document).one('keydown.balanceCritical', function(e) {
            if (e.key === 'Escape') {
                $modal.fadeOut(200, function() { $modal.remove(); });
            }
        });
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

        // Hide the QR code now that payment is confirmed
        SocketHandlers.hidePaymentQR();

        // Credits purchase: return to home screen (no game queue)
        if (data.creditsAdded || data.newBalance !== undefined) {
            if (typeof Game !== 'undefined') {
                Game._pendingPaymentConfirmed();
            }
            // Return to welcome/home screen so user can start a game
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWelcomeScreen) {
                ScreenManager.drawWelcomeScreen();
            }
            $('#messages').append($('<li class="payment-success" style="color:#0f0;">').html(
                '✅ <strong>Credits purchased!</strong> Type \'enter\' or click START GAME to play.'
            ));
            UI.scrollChat();
            SocketHandlers._setBannerStatus('Credits Added', '#0f0');
        } else {
            // Single game payment: show waiting screen (player is in queue)
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
        }
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

        // Hide the QR code now that payment was detected
        SocketHandlers.hidePaymentQR();

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

    onUserCount: function(data) {
        console.log('👥 User count received:', data);
        if (!data || typeof data.count !== 'number') return;
        SocketHandlers._updateUserCountDisplay(data.count);
    },

    _updateUserCountDisplay: function(count) {
        let el = document.getElementById('userCountDisplay');
        if (!el) {
            // Create display element next to connection status
            const statusDiv = document.querySelector('.status') || document.getElementById('connectionStatus')?.parentElement;
            if (statusDiv) {
                el = document.createElement('div');
                el.id = 'userCountDisplay';
                el.style.cssText = 'font-size:12px;color:#0af;margin-top:2px;';
                statusDiv.appendChild(el);
            }
        }
        if (el) {
            const plural = count === 1 ? '' : 's';
            el.innerHTML = `👥 <span style="color:#4ade80;">${count}</span> player${plural} online`;
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
        SocketHandlers._updateLiveCta(data);
    },

    // "Land on action": when live games are in progress, surface a prominent, dismissible CTA
    // in the status area so a new visitor immediately sees the room is alive and can jump into
    // spectating with one click. Deliberately NON-intrusive — it never hijacks the canvas or
    // interrupts someone who came to play (hidden while in a game / spectating, and dismissible).
    _liveCtaDismissed: false,
    _updateLiveCta: function(data) {
        var el = document.getElementById('liveCta');
        if (!el) return;
        var liveCount = (data.games || []).length;
        var inGame = (typeof Game !== 'undefined' && (Game._gameActive || Game._isSpectating)) || SocketHandlers._spectatorMode || SocketHandlers._isQueued;
        var panelOpen = $('#gamesListPanel').is(':visible');

        if (liveCount > 0 && !inGame && !panelOpen && !SocketHandlers._liveCtaDismissed) {
            el.innerHTML = '🔴 ' + liveCount + ' game' + (liveCount === 1 ? '' : 's') +
                ' live right now — <span style="text-decoration:underline;">watch &raquo;</span>';
            el.style.display = 'block';
            if (!el._bound) {
                el._bound = true;
                el.addEventListener('click', function () {
                    SocketHandlers._liveCtaDismissed = true; // don't nag after they engage
                    el.style.display = 'none';
                    if (window.socket) socket.emit('get_active_games', { page: 1, pageSize: 20 });
                    SocketHandlers._showGamesPanel();
                });
            }
        } else {
            el.style.display = 'none';
        }
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
    },

    // =====================
    // Early Entry Functions
    // =====================

    _earlyEntryConfig: { enabled: false },
    _isQueued: false,
    
    /**
     * Check if early entry is currently allowed based on mode and config
     */
    isEarlyEntryAllowed: function() {
        const config = this._earlyEntryConfig;
        if (!config || !config.enabled) return false;
        
        const mode = this._gameMode;
        if (mode === 'FREE' && config.allowInFreeMode) return true;
        if (mode === 'PAID_CREDITS' && config.allowInCreditsMode) return true;
        
        return false;
    },
    
    /**
     * Update early entry button visibility based on current state
     */
    _updateEarlyEntryButton: function() {
        let $btn = $('#earlyEntryButton');
        
        // Create button if it doesn't exist
        if (!$btn.length) {
            $btn = $(`
                <button id="earlyEntryButton" style="
                    display: none;
                    background: linear-gradient(180deg, #662200, #441100);
                    border: 2px solid #ff6600;
                    color: #ffcc00;
                    padding: 8px 16px;
                    font-family: monospace;
                    font-size: 14px;
                    cursor: pointer;
                    margin: 5px;
                    border-radius: 4px;
                    text-shadow: 0 0 5px #ff3300;
                    animation: earlyEntryPulse 2s infinite;
                ">⚡ ENTER NOW (RISKY!) ⚡</button>
            `);

            // Add CSS animation
            if (!$('#earlyEntryStyles').length) {
                $('head').append(`
                    <style id="earlyEntryStyles">
                        @keyframes earlyEntryPulse {
                            0%, 100% { box-shadow: 0 0 5px #ff6600; }
                            50% { box-shadow: 0 0 15px #ff6600, 0 0 25px #ff3300; }
                        }
                        #earlyEntryButton:hover {
                            background: linear-gradient(180deg, #883300, #551100) !important;
                            transform: scale(1.05);
                        }
                    </style>
                `);
            }
            
            // Insert near animation toggle button
            const $animBtn = $('#animationToggleButton');
            if ($animBtn.length) {
                $animBtn.after($btn);
            } else {
                // Fallback - add to header area
                $('#header').append($btn);
            }
            
            // Click handler
            $btn.on('click', function() {
                SocketHandlers.requestEarlyEntry();
            });
        }
        
        // Show/hide based on whether we're queued and early entry is allowed
        if (this._isQueued && this.isEarlyEntryAllowed()) {
            // Update button text to show credit cost when in paid mode
            var mode = this._gameMode;
            if (mode === 'PAID_CREDITS' || mode === 'MIXED') {
                var cost = this._creditsPerGame || 1;
                $btn.text('⚡ ENTER NOW (' + cost + ' credit, RISKY!) ⚡');
            } else {
                $btn.text('⚡ ENTER NOW (RISKY!) ⚡');
            }
            $btn.show();
        } else {
            $btn.hide();
        }
    },

    /**
     * Request early entry from the server
     */
    requestEarlyEntry: function() {
        if (!window.socket) return;

        // Confirm before spending credits
        var mode = this._gameMode;
        var msg = 'Enter the dungeon NOW?\n\nYou will die when the next block is found!';
        if (mode === 'PAID_CREDITS' || mode === 'MIXED') {
            var cost = this._creditsPerGame || 1;
            msg = 'Use ' + cost + ' credit to enter the dungeon NOW?\n\nYou will die when the next block is found!';
        }
        if (!confirm(msg)) return;

        // Disable button to prevent double-clicks
        var $btn = $('#earlyEntryButton');
        $btn.prop('disabled', true).text('⏳ Entering...');

        socket.emit('early_entry');
    },
    
    /**
     * Handle early entry success
     */
    onEarlyEntrySuccess: function(data) {
        console.log('Early entry success:', data);
        SocketHandlers._isQueued = false;
        SocketHandlers._updateEarlyEntryButton();
        
        // The game_start event will follow - just show feedback
        $('#messages').append($('<li class="status" style="color:#ff6600;">').text('⚡ Early entry! Race to escape before the next block!'));
        UI.scrollChat();
    },
    
    /**
     * Handle early entry error
     */
    onEarlyEntryError: function(data) {
        console.error('Early entry error:', data);

        // Re-enable button
        const $btn = $('#earlyEntryButton');
        $btn.prop('disabled', false).text('⚡ ENTER NOW (RISKY!) ⚡');

        const message = data?.message || 'Early entry not available';
        $('#messages').append($('<li class="error" style="color:#f00;">').text('Early entry failed: ' + message));
        UI.scrollChat();
    },

    // =====================
    // Entry Choice Modal
    // =====================

    showEntryChoiceModal: function() {
        // Remove any existing modal
        $('#entryChoiceOverlay').remove();

        var cost = this._creditsPerGame || 1;
        var $overlay = $('<div id="entryChoiceOverlay">').css({
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.7)', zIndex: 3000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        var $modal = $('<div>').css({
            background: '#0a1a0a', border: '2px solid #0f0', borderRadius: '8px',
            padding: '24px', maxWidth: '420px', width: '90%', color: '#0f0',
            fontFamily: 'monospace', textAlign: 'center'
        });

        $modal.html(
            '<div style="font-size:18px; font-weight:bold; margin-bottom:16px;">How do you want to enter?</div>' +
            '<div style="font-size:12px; color:#888; margin-bottom:20px;">Cost: ' + cost + ' credit per game</div>' +
            '<button id="entryChoiceNow" style="' +
                'display:block; width:100%; padding:12px; margin-bottom:10px; cursor:pointer; ' +
                'background:linear-gradient(180deg,#662200,#441100); border:2px solid #ff6600; ' +
                'color:#ffcc00; font-family:monospace; font-size:14px; font-weight:bold; border-radius:4px;' +
            '">⚡ Start Now (risky)<br><span style="font-size:11px; font-weight:normal; color:#cc9966;">Game starts immediately — you die when next block arrives</span></button>' +
            '<button id="entryChoiceQueue" style="' +
                'display:block; width:100%; padding:12px; margin-bottom:10px; cursor:pointer; ' +
                'background:linear-gradient(180deg,#003300,#001a00); border:2px solid #0f0; ' +
                'color:#0f0; font-family:monospace; font-size:14px; font-weight:bold; border-radius:4px;' +
            '">🛡️ Wait for Next Block (safe)<br><span style="font-size:11px; font-weight:normal; color:#6a6;">Queues you — full block window to escape</span></button>' +
            '<button id="entryChoiceCancel" style="' +
                'display:block; width:100%; padding:8px; cursor:pointer; ' +
                'background:transparent; border:1px solid #555; color:#888; ' +
                'font-family:monospace; font-size:12px; border-radius:4px;' +
            '">Cancel</button>'
        );

        $overlay.append($modal);
        $('body').append($overlay);

        // Handlers
        $('#entryChoiceNow').on('click', function() {
            $('#entryChoiceOverlay').remove();
            socket.emit('auto_start');
            $('#messages').append($('<li style="color:#ff6600;">').text('⚡ Starting game immediately...'));
            UI.scrollChat();
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                ScreenManager.drawWaitingScreen();
            }
        });

        $('#entryChoiceQueue').on('click', function() {
            $('#entryChoiceOverlay').remove();
            socket.emit('join_queue');
            $('#messages').append($('<li style="color:#0f0;">').text('🛡️ Joining queue — waiting for next block...'));
            UI.scrollChat();
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                ScreenManager.drawWaitingScreen();
            }
        });

        $('#entryChoiceCancel').on('click', function() {
            $('#entryChoiceOverlay').remove();
        });

        // Close on overlay click (outside modal)
        $overlay.on('click', function(e) {
            if (e.target === this) {
                $('#entryChoiceOverlay').remove();
            }
        });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SocketHandlers;
}
