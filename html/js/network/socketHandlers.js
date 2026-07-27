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
    _gameMode: null, // Set from the server's game-modes event. Declare it exactly once: a duplicate
                     // key in this object literal would silently shadow the other.

    _directModeEnabled: false,
    _directPayoutsEnabled: false,
    _paymentsEnabled: false,
    _isSmirkExplicitlyEnabled: function(data) {
        return !!data && data.smirkEnabled === true;
    },
    _fairnessOffer: null,
    _pendingFairnessAttempt: null,

    _randomClientSeed: function() {
        try {
            if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return null;
            var bytes = new Uint8Array(32);
            window.crypto.getRandomValues(bytes);
            return Array.prototype.map.call(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        } catch (e) { return null; }
    },

    /** Build a start payload only after receiving the server's commitment. */
    fairnessAttempt: function(extra) {
        var offer = this._fairnessOffer;
        if (!offer || !offer.offerId || !/^[0-9a-f]{64}$/i.test(String(offer.commitment || ''))) {
            socket.emit('fairness_offer_request');
            $('#messages').append($('<li class="status" style="color:#ffcc00;">').text('Preparing a fairness commitment; try again in a moment.'));
            if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
            return null;
        }
        // The player's contribution is generated only AFTER selecting the published commitment.
        var clientSeed = this._randomClientSeed();
        if (!clientSeed) {
            $('#messages').append($('<li class="error">').text('Secure randomness is unavailable in this browser; the game was not started.'));
            return null;
        }
        var payload = Object.assign({}, extra || {}, {
            fairnessOfferId: offer.offerId,
            clientSeed: clientSeed
        });
        this._pendingFairnessAttempt = {
            offerId: offer.offerId,
            commitment: offer.commitment,
            clientSeed: clientSeed
        };
        return payload;
    },

    emitFairGameStart: function(eventName, extra, acknowledgementReady) {
        var paidIntent = !(extra && extra.free === true);
        var existingAcknowledgement = paidIntent
            && typeof CommerceConsent !== 'undefined'
            && CommerceConsent.acknowledgement
            ? CommerceConsent.acknowledgement()
            : null;
        if (paidIntent && !acknowledgementReady && !existingAcknowledgement
            && typeof CommerceConsent !== 'undefined' && CommerceConsent.require) {
            CommerceConsent.require(function(acknowledgement) {
                var acknowledgedExtra = Object.assign({}, extra || {});
                if (acknowledgement) acknowledgedExtra.legalAcknowledgement = acknowledgement;
                if (SocketHandlers.emitFairGameStart(eventName, acknowledgedExtra, true)) {
                    $('#entryChoiceOverlay').remove();
                    if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) ScreenManager.drawWaitingScreen();
                }
            });
            return false;
        }
        var acknowledgedPayload = Object.assign({}, extra || {});
        if (existingAcknowledgement) acknowledgedPayload.legalAcknowledgement = existingAcknowledgement;
        var payload = this.fairnessAttempt(acknowledgedPayload);
        if (!payload) return false;
        socket.emit(eventName, payload);
        return true;
    },

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
            $btn.css({
                'background': '#053655',
                'color': '#0ff',
                'border-color': '#0ff'
            });
            $btn.html('✅ Payout Address Set');
        } else {
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
            // execCommand fallback for browsers without the async clipboard API.
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
        socket.on('disconnect', function() {
            if (typeof CommerceConsent !== 'undefined' && CommerceConsent.clear) {
                CommerceConsent.clear();
            }
        });
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
        socket.on('game_settlement_pending', this.onGameSettlementPending);
        socket.on('fairness_offer', this.onFairnessOffer);
        socket.on('fairness_error', this.onFairnessError);
        // Discrete in-run events. The descend event is what tells the player a new entrance means a
        // deeper level rather than a reset.
        socket.on('game_event', function (data) {
            if (!data || !data.event) return;
            var $m = $('#messages');
            if (data.event === 'descend') {
                var lvl = (data.depth && data.maxDepth) ? ('Level ' + data.depth + ' of ' + data.maxDepth + '. ') : '';
                $m.append($('<li class="status" style="color:#ffcc00; font-weight:bold;">')
                    .text('⬇️ Stairs down! ' + lvl + 'Keep going: escape before the block!'));
                var lvlTitle = (data.depth && data.maxDepth) ? ('⬇ LEVEL ' + data.depth + ' / ' + data.maxDepth) : '⬇ DESCEND';
                SocketHandlers.showEventBanner(lvlTitle, 'Deeper in: escape before the block!', '#ffcc00');
            } else if (data.event === 'treasure_found') {
                $m.append($('<li class="status" style="color:#fbbf24; font-weight:bold;">').text('💰 Treasure secured!'));
                SocketHandlers.showEventBanner('💰 TREASURE SECURED', 'Now get to the stairs and escape!', '#fbbf24');
            } else return;
            if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
        });
        socket.on('queue_cancelled', this.onQueueCancelled);
        
        // Payment/Address handlers
        socket.on('address_detected', this.onAddressDetected);
        socket.on('address_confirmed', this.onAddressConfirmed);
        socket.on('address_update_error', this.onAddressUpdateError);
        socket.on('address_prompt', this.onAddressPrompt);
        socket.on('game_mode_info', this.onGameModeInfo);
        socket.on('payment_created', this.onPaymentCreated);
        socket.on('commerce_ack_required', this.onCommerceAcknowledgementRequired);
        socket.on('payment_confirmed', this.onPaymentConfirmed);
        socket.on('payment_detected', this.onPaymentDetected);
        socket.on('show_payment_options', this.onShowPaymentOptions);
        socket.on('balance_critical', this.onBalanceCritical);
        socket.on('credits_update', this.onCreditsUpdate);
        socket.on('identity_update', this.onIdentityUpdate);
        socket.on('identity_error', this.onIdentityError);
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

    // Transient "someone just escaped" toast. Toasts stack in a fixed top-right container,
    // auto-dismiss, and never block the UI.
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
            requestAnimationFrame(function () { $t.addClass('show'); });
            setTimeout(function () { $t.removeClass('show'); }, 5000);
            setTimeout(function () { $t.remove(); }, 5600);
            // Cap the number of simultaneous toasts.
            var $all = $c.children('.win-toast');
            if ($all.length > 4) { $all.first().remove(); }
        } catch (e) { /* non-critical */ }
    },

    onFairnessOffer: function(data) {
        if (!data || !data.offerId || !/^[0-9a-f]{64}$/i.test(String(data.commitment || ''))) return;
        SocketHandlers._fairnessOffer = data;
    },

    onFairnessError: function(data) {
        SocketHandlers._pendingFairnessAttempt = null;
        var message = (data && data.message) || 'Fairness offer could not be consumed. Please retry.';
        $('#messages').append($('<li class="error">').text(message));
        if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
        socket.emit('fairness_offer_request');
    },

    onConnect: function() {
        if (SocketHandlers._didConnect) return; // prevent duplicate registration emission
        SocketHandlers._didConnect = true;
        // The token is supplied in Socket.IO's handshake auth object by index.html. Do not copy
        // it into a query string: reverse proxies commonly log URLs, which would leak sessions.
        socket.emit('register_client', {
            clientId: socket.id,
            userAgent: navigator.userAgent
        });
        socket.emit('identity:get');
        SocketHandlers._setBannerStatus('Connected', '#0f0');
    },

    onSessionToken: function(data) {
        if (data && data.token) {
            try { localStorage.setItem('wownerogue_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('New session established. Token stored.'));
            UI.scrollChat();
            // A new session carries no payout address.
            SocketHandlers._updateAddressButtonStatus(false);
            SocketHandlers._refreshSmirkLinked();
        }
    },

    // The server rotates the session token on every resume, so an initial SmirkAuth.checkStatus()
    // can race the rotation and 403 with the stale token, leaving _isLinked=false and disabling
    // one-click Smirk payment. Re-check once the fresh token is stored.
    _refreshSmirkLinked: function() {
        if (typeof SmirkAuth !== 'undefined' && SmirkAuth.checkStatus &&
            SmirkAuth.isAvailable && SmirkAuth.isAvailable()) {
            try { SmirkAuth.checkStatus(); } catch (e) { /* non-critical */ }
        }
    },

    onSessionResumed: function(data) {
        if (data && data.token) {
            try { localStorage.setItem('wownerogue_token', data.token); } catch(e) {}
            $('#messages').append($('<li class="status">').text('Session resumed.'));
            UI.scrollChat();
            SocketHandlers._refreshSmirkLinked();
        }
        if (data && typeof data.credits === 'number') {
            SocketHandlers._updateCreditsDisplay(data.credits);
        }
        if (typeof SinglePlayerAvatar !== 'undefined') {
            SinglePlayerAvatar.applyEntitlements({
                credits: data && data.credits,
                totalCreditsPurchased: data && data.totalCreditsPurchased
            });
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
        if (typeof SinglePlayerAvatar !== 'undefined') {
            SinglePlayerAvatar.applyEntitlements({
                credits: data.balance,
                balance: data.balance,
                totalCreditsPurchased: data.totalCreditsPurchased,
                total_credits_purchased: data.total_credits_purchased
            });
        }
    },

    onIdentityUpdate: function(data) {
        if (typeof SinglePlayerAvatar !== 'undefined') {
            SinglePlayerAvatar.applyIdentity(data);
        }
    },

    onIdentityError: function(data) {
        if (data && data.message) {
            $('#messages').append($('<li class="error" style="color:#f66;">').text(data.message));
            UI.scrollChat();
        }
    },

    // Default credits per game (overridden by game_mode_info)
    _creditsPerGame: 1,
    
    _updateCreditsDisplay: function(balance, creditsPerGame) {
        this._creditsBalance = balance;

        if (creditsPerGame && creditsPerGame > 0) {
            SocketHandlers._creditsPerGame = creditsPerGame;
        }

        var el = document.getElementById('creditsDisplay');
        if (!el) return;

        var perGame = SocketHandlers._creditsPerGame || 1;
        var gamesRemaining = Math.floor(balance / perGame);

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

    // One-shot banner over the game view for headline in-run events (descend / treasure). It is
    // pointer-events:none so it never eats input, and it removes itself when the animation ends.
    showEventBanner: function(title, sub, color) {
        color = color || '#ffcc00';
        var host = document.getElementById('game-display') || document.body;
        if (!document.getElementById('evt-banner-style')) {
            var st = document.createElement('style');
            st.id = 'evt-banner-style';
            st.textContent =
                '@keyframes evtBannerIn{0%{opacity:0;transform:translate(-50%,-50%) scale(.6)}' +
                '12%{opacity:1;transform:translate(-50%,-50%) scale(1.12)}' +
                '22%{transform:translate(-50%,-50%) scale(1)}' +
                '76%{opacity:1;transform:translate(-50%,-50%) scale(1)}' +
                '100%{opacity:0;transform:translate(-50%,-50%) scale(1.05)}}';
            document.head.appendChild(st);
        }
        // Only one banner is on screen at a time.
        var prev = document.getElementById('evt-banner');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

        var b = document.createElement('div');
        b.id = 'evt-banner';
        var positioned = host.id === 'game-display'; // #game-display is position:relative
        b.style.cssText = (positioned ? 'position:absolute;' : 'position:fixed;') +
            'left:50%;top:34%;z-index:30;pointer-events:none;text-align:center;' +
            'font-family:ui-monospace,monospace;animation:evtBannerIn 2600ms ease-out forwards;';
        b.innerHTML =
            '<div style="font-size:38px;font-weight:900;letter-spacing:2px;color:' + color + ';' +
            'text-shadow:0 3px 0 #000,0 0 20px ' + color + '99;">' + title + '</div>' +
            (sub ? '<div style="font-size:15px;color:#e6ead0;margin-top:8px;text-shadow:0 2px 6px #000;">' + sub + '</div>' : '');
        host.appendChild(b);
        setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 2650);
        // Optional colored flash, only when the FX overlay is present.
        try { if (window.FX && window.FX.flash) window.FX.flash(color, 0.16, 320); } catch (e) {}
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
            // Generic payment message; more granular handlers override this later.
            SocketHandlers._setBannerStatus('Payment', '#0af');
            if (typeof AudioAlerts !== 'undefined') { AudioAlerts.playRequestCoin(); }
        } else if (data.type === 'error') {
            SocketHandlers._setBannerStatus('Error', '#f00');
        } else if (data.type === 'success') {
            SocketHandlers._setBannerStatus('Success', '#0f0');
        }
    },

    // Chat text arrives already HTML-escaped by the server; that is the delivery contract, since the
    // tavern renders it as HTML directly. Decoding the exact five entities the server writes and
    // rendering through a TEXT node avoids double encoding (apostrophes as &#39;, ampersands as
    // &amp;) while keeping the message unparseable as markup, so the client never has to trust that
    // the server escaped it.
    _chatText: function(value) {
        return String(value == null ? '' : value)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&'); // Last, mirroring the server escaping & first.
    },

    // <strong>sender:</strong> followed by the message as a text node.
    _chatLine: function(msgElement, sender, message) {
        const strong = document.createElement('strong');
        strong.textContent = SocketHandlers._chatText(sender) + ':';
        msgElement.append(strong);
        msgElement.append(document.createTextNode(' ' + SocketHandlers._chatText(message)));
    },

    onChatBroadcast: function(data) {
        const msgElement = $('<li style="color: #aaa;">');
        // Prefer non-sensitive attribution fields; the server does not send the raw full socket.id.
        // The short slice covers older payloads only.
        const sender = data.username || data.playerId || data.publicId ||
            (data.socketId ? String(data.socketId).substring(0, 6) : null);
        if (sender) {
            SocketHandlers._chatLine(msgElement, String(sender), data.message);
        } else {
            msgElement.text(SocketHandlers._chatText(data.message));
        }
        $('#messages').append(msgElement);
        UI.scrollChat();
    },

    onChatHistory: function(data) {
        if (!data || !data.messages || !Array.isArray(data.messages)) return;

        if (data.messages.length > 0) {
            $('#messages').append($('<li class="chat-history-header" style="color: #666; font-style: italic; border-bottom: 1px solid #333; margin-bottom: 5px; padding-bottom: 5px;">').text('--- Recent Chat History ---'));
        }

        // data-msg-id lets chat_deleted find and remove a specific line later.
        data.messages.forEach(function(msg) {
            const msgElement = $('<li style="color: #888;">');
            if (msg.id) {
                msgElement.attr('data-msg-id', msg.id);
            }
            const username = msg.playerId || msg.username || msg.publicId || (msg.socketId ? msg.socketId.substring(0, 6) : 'anon');
            const isSystem = msg.type === 'system' || msg.socketId === 'system';
            if (isSystem) {
                msgElement.addClass('status');
            }
            if (msg.timestamp) {
                const stamp = document.createElement('span');
                stamp.style.cssText = 'color:#555;font-size:10px;';
                stamp.textContent = '[' + SocketHandlers._formatTimeAgo(new Date(msg.timestamp)) + '] ';
                msgElement.append(stamp);
            }
            SocketHandlers._chatLine(msgElement, username, msg.message);
            $('#messages').append(msgElement);
        });

        if (data.messages.length > 0) {
            $('#messages').append($('<li class="chat-history-footer" style="color: #666; font-style: italic; border-top: 1px solid #333; margin-top: 5px; padding-top: 5px;">').text('--- End of History ---'));
        }

        UI.scrollChat();
    },

    onChatDeleted: function(data) {
        if (!data || !data.messageId) return;
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
        SocketHandlers._isQueued = false;
        SocketHandlers._updateEarlyEntryButton();

        SocketHandlers.hidePaymentQR();

        // The game is starting, so the transient entry line is no longer accurate.
        $('#messages').find('.entry-progress').remove();
        $('#messages').append($('<li class="game-start">').text("Starting game..."));

        if (data && data.proof && data.proof.commitment) {
            var attempted = SocketHandlers._pendingFairnessAttempt;
            var proofMatchesAttempt = !attempted || (
                data.proof.offerId === attempted.offerId &&
                data.proof.commitment === attempted.commitment &&
                data.proof.clientSeed === attempted.clientSeed
            );
            const shortHash = data.proof.commitment.substring(0, 16) + '...';
            const shortClientSeed = data.proof.clientSeed
                ? data.proof.clientSeed.substring(0, 16) + '...'
                : '(legacy empty seed)';
            const $proofMsg = $('<li class="proof-commitment" style="color:#0af; font-size:11px;">').html(
                '🔐 <strong>Provably Fair:</strong> Game hash commitment: <code style="background:#001a00; padding:2px 4px; border-radius:3px;" title="' + 
                data.proof.commitment + '">' + shortHash + '</code> ' +
                '<button class="copy-hash-btn" style="font-size:10px; padding:1px 4px; cursor:pointer;" data-hash="' + 
                data.proof.commitment + '">Copy</button><br>' +
                '<span style="color:#888;">Accepted client seed:</span> <code>' + shortClientSeed + '</code>'
            );
            $('#messages').append($proofMsg);
            if (!proofMatchesAttempt) {
                $('#messages').append($('<li class="error">').text('⚠️ Fairness proof mismatch: the server did not echo the offer/client seed used for this attempt.'));
            }
            SocketHandlers._pendingFairnessAttempt = null;

            // Held for the reveal rendered at game over.
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
                // The game is live and rendering, so the "Starting game..." transient is dropped.
                // The server's "Game started!" success line is the standing status.
                $('#messages').find('.game-start').remove();
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
        // AudioAlerts._patchSocketHandlers() plays the sound for this event.
    },

    onGameUpdate: function(data) {
        // Game exposes updateGameState(); updateGame is only an alias some builds may add.
        if (typeof Game !== 'undefined') {
            if (Game.updateGameState) {
                Game.updateGameState(data);
            } else if (Game.updateGame) {
                Game.updateGame(data);
            } else {
                console.warn('Game update received but no updateGameState()/updateGame() method found on Game.');
            }
        }
        UI.scrollChat();
    },

    onGameSettlementPending: function() {
        // The server withholds game_over until the authoritative completion and any payout
        // obligation commit together. This keeps the player informed without publishing a result
        // PostgreSQL cannot yet prove, and without offering another entry mid-retry.
        $('#messages').find('.solo-settlement-pending').remove();
        $('#messages').append($('<li class="status solo-settlement-pending" style="color:#ffcc00;">')
            .text('Result pending durable settlement · retrying safely…'));
        SocketHandlers._setBannerStatus('Saving result…', '#ffcc00');
        UI.scrollChat();
    },

    onGameOver: function(data) {
        $('#messages').find('.solo-settlement-pending').remove();
        $('#messages').append($('<li class="game-over">').text("Game Over: " + data.message));
        
        if (data && data.proof && data.proof.seed) {
            const serverSeed = data.proof.serverSeed || '';
            const effectiveSeed = data.proof.effectiveSeed || data.proof.seed;
            const clientSeed = data.proof.clientSeed || '';
            const shortServerSeed = serverSeed ? serverSeed.substring(0, 16) + '...' : '(unavailable)';
            const shortEffectiveSeed = effectiveSeed.substring(0, 16) + '...';
            const shortClientSeed = clientSeed ? clientSeed.substring(0, 16) + '...' : '(legacy empty seed)';
            const shortCommitment = data.proof.commitment.substring(0, 16) + '...';
            const verifyUrl = data.proof.verificationUrl || ('/verify/' + data.proof.gameId);
            
            const $proofReveal = $('<li class="proof-reveal" style="color:#4ade80; font-size:11px; margin-top:5px; padding:8px; background:rgba(0,50,0,0.5); border-radius:4px;">').html(
                '🔓 <strong>Proof revealed:</strong><br>' +
                '<span style="color:#888;">Server seed:</span> <code style="background:#001a00; padding:2px 4px; border-radius:3px;" title="' +
                serverSeed + '">' + shortServerSeed + '</code> ' +
                '<button class="copy-seed-btn" style="font-size:10px; padding:1px 4px; cursor:pointer;" data-seed="' + 
                serverSeed + '">Copy</button><br>' +
                '<span style="color:#888;">Client seed:</span> <code>' + shortClientSeed + '</code><br>' +
                '<span style="color:#888;">Effective seed:</span> <code title="' + effectiveSeed + '">' + shortEffectiveSeed + '</code><br>' +
                '<span style="color:#888;">Hash:</span> <code style="background:#001a00; padding:2px 4px; border-radius:3px;">' + shortCommitment + '</code><br>' +
                '<a href="' + verifyUrl + '" target="_blank" style="color:#0af;">🔗 Verify this game</a>'
            );
            $('#messages').append($proofReveal);

            SocketHandlers._currentGameProof = null;
        }
        
        if (typeof Game !== 'undefined') {
            if (Game.endGame) {
                Game.endGame(data);
            } else if (Game.drawLoseScreen && data && data.reason) {
                // Minimal fallback when endGame is absent.
                if (data.reason === 'monster') Game.drawLoseScreen('monster');
            }
        }
        
        const won = data && (data.status === 'won' || data.reason === 'escaped');

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

        // The verify link carries OG meta on the /verify page, so a shared post unfurls a preview.
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

    // Absolute verify URL for this game, used by the share button.
    _verifyUrlFor: function(data) {
        var path = (data && data.proof && (data.proof.verificationUrl ||
            (data.proof.gameId ? '/verify/' + data.proof.gameId : null)));
        if (!path) return null;
        try { return new URL(path, window.location.origin).href; }
        catch (e) { return window.location.origin + path; }
    },

    _appendShareWin: function(data) {
        var url = SocketHandlers._verifyUrlFor(data);
        if (!url) return; // Without a proof there is nothing to verify or share.

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
        
        // Drop the earlier address prompts now that the address is confirmed.
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
        
        if (data.creditsPerGame) {
            SocketHandlers._creditsPerGame = data.creditsPerGame;
        }

        SocketHandlers._gameMode = data.mode;
        SocketHandlers._freePlayEnabled = !!data.freePlayEnabled;
        SocketHandlers._earlyEntryConfig = data.earlyEntry || { enabled: false };
        SocketHandlers._creditsPayoutsEnabled = !!data.creditsPayoutsEnabled;
        SocketHandlers._directModeEnabled = !!data.directModeEnabled;
        SocketHandlers._directPayoutsEnabled = !!data.directPayoutsEnabled;
        SocketHandlers._paymentsEnabled = !!data.paymentsEnabled;
        SocketHandlers._smirkEnabled = SocketHandlers._isSmirkExplicitlyEnabled(data);
        SocketHandlers._cryptoType = data.cryptoType || 'WOW';
        SocketHandlers._currencyLabel = data.currencyLabel || data.cryptoType || 'WOW'; // e.g. sXMR on stagenet
        SocketHandlers._explorerTxUrl = data.explorerTxUrl || null;
        if (typeof Leaderboard !== 'undefined' && Leaderboard.updateConfig) {
            Leaderboard.updateConfig(data);
        }
        // Prestige-only users are never asked for a payout address, so the UI never implies paid
        // entries award crypto. Match crypto counts only when its economy is admitted.
        var matchCryptoPayouts = !!(data.modes && data.modes.match && data.modes.match.economies
            && data.modes.match.economies.crypto_race);
        var anyPayouts = SocketHandlers._creditsPayoutsEnabled
            || SocketHandlers._directPayoutsEnabled || matchCryptoPayouts;
        $('#manageAddressButton').toggle(anyPayouts);
        if (data.entitlements && typeof SinglePlayerAvatar !== 'undefined') {
            SinglePlayerAvatar.applyEntitlements(data.entitlements);
        }

        // Mode availability (Solo / Tavern / Multiplayer). A server that omits `modes` is treated
        // as solo-only.
        var modes = data.modes || { solo: true, tavern: false, multiplayer: false };
        SocketHandlers._modes = modes;
        if (modes.tavern) { $('#tavernButton').show(); } else { $('#tavernButton').hide(); }
        // A tavern-only instance has no single-player entry point.
        if (modes.solo === false) { $('#startButton').hide(); }

        if (SocketHandlers._smirkEnabled && typeof SmirkAuth !== 'undefined' && !SmirkAuth._initialized) {
            SmirkAuth.init();
        }

        if (typeof UI !== 'undefined' && UI.updateGameTitle) {
            UI.updateGameTitle(data.cryptoType);
        }

        // ScreenManager uses the crypto type in the welcome screen title.
        if (typeof ScreenManager !== 'undefined' && ScreenManager.setCryptoType) {
            ScreenManager.setCryptoType(data.cryptoType);
        }

        if (data.testnetWarning) {
            SocketHandlers._showNetworkWarning(data.testnetWarning, data.network);
        } else {
            SocketHandlers._hideNetworkWarning();
        }

        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.updateConfig(data);
            if (data.paymentsEnabled) {
                $('#shopButton').show();
            } else {
                $('#shopButton').hide();
            }
        }

        if (typeof HelpModal !== 'undefined') {
            HelpModal.updateConfig(data);
        }

        SocketHandlers._updateEarlyEntryButton();
    },

    _showNetworkWarning: function(message, network) {
        let $warning = $('#networkWarning');
        if (!$warning.length) {
            $warning = $('<div id="networkWarning"></div>');
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

        // Native Smirk payment is only possible while the user is linked through the extension.
        if (typeof SmirkAuth !== 'undefined' && SmirkAuth._isLinked && SmirkAuth.isAvailable() &&
            typeof window.smirk !== 'undefined' && window.smirk.requestPayment) {
            SocketHandlers._trySmirkPayment(data);
            return;
        }

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
            // Smirk expects a human-readable amount (e.g. "1"), not atomic units.
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

            // The user confirmed in Smirk and the transaction is submitted; server-side monitoring
            // handles confirmation from here.
            $('#messages').append($('<li class="status" style="color:#4ade80;">').text(
                'Payment sent via Smirk! Waiting for confirmation...'
            ));
            UI.scrollChat();

            if (typeof PaymentUI !== 'undefined') {
                PaymentUI.showPaymentRequest(data);
                $('#payment-status').html('<span style="color:#4ade80;">Payment sent via Smirk, awaiting confirmation...</span>');
            }
            SocketHandlers._setBannerStatus('Pay', '#0af');
            if (typeof Game !== 'undefined' && Game._paymentRequested) Game._paymentRequested();
            if (typeof Game !== 'undefined' && Game.drawWaitingScreen) Game.drawWaitingScreen();

        } catch (err) {
            console.log('Smirk payment declined/failed, falling back to manual:', err);
            var errMsg = String(err.message || err || '').toLowerCase();

            // Distinguish a user-initiated denial from an extension error.
            var isUserDenied = errMsg.indexOf('denied') !== -1 ||
                               errMsg.indexOf('rejected') !== -1 ||
                               errMsg.indexOf('cancelled') !== -1 ||
                               errMsg.indexOf('user') !== -1;

            if (isUserDenied) {
                $('#messages').append($('<li class="status">').text(
                    'Smirk payment cancelled. Use the address below.'
                ));
            } else {
                // Extension error: invalidated context, service worker issue, and similar.
                $('#messages').append($('<li class="status" style="color:#f59e0b;">').text(
                    'Smirk payment unavailable, using manual payment. Refresh the page to restore Smirk.'
                ));
                SmirkAuth._isLinked = false;
            }
            UI.scrollChat();

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

        // The sidebar QR lives outside the chat log so it persists as messages scroll.
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
    
    // Removes the payment QR container from the sidebar.
    hidePaymentQR: function() {
        const qrHolder = document.getElementById('paymentQRContainer');
        if (qrHolder) {
            qrHolder.remove();
        }
    },

    onShowPaymentOptions: function(data) {
        console.log('Show payment options:', data);
        if (typeof PaymentUI !== 'undefined') {
            PaymentUI.show();
        }
    },

    onCommerceAcknowledgementRequired: function(data) {
        var message = data && (data.message || data.error)
            || 'Review the paid-play disclosures before continuing.';
        $('#messages').append($('<li class="status" style="color:#fbbf24;">').text(message));
        if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
        if (typeof CommerceConsent !== 'undefined' && CommerceConsent.require) {
            var refreshed = CommerceConsent.reject
                ? CommerceConsent.reject(data)
                : Promise.resolve();
            refreshed.catch(function() { return null; }).then(function() {
                CommerceConsent.require(function() {
                    $('#messages').append($('<li class="status" style="color:#aaa;">').text('Disclosures acknowledged. Retry the paid action when ready.'));
                    if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
                });
            });
        }
    },

    onBalanceCritical: function(data) {
        console.warn('Balance critical, games halted:', data);

        const message = data?.message || 'Sorry, the house balance is too low to initiate new games. Please try again later.';

        SocketHandlers._showBalanceCriticalModal(message);

        $('#messages').append($('<li class="error" style="color: #ff6600; font-weight: bold;">').text('⚠️ ' + message));
        UI.scrollChat();

        SocketHandlers._setBannerStatus('Unavailable', '#ff6600');
    },

    _showBalanceCriticalModal: function(message) {
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

        $modal.on('click', '#balanceCriticalOK', function() {
            $modal.fadeOut(200, function() { $modal.remove(); });
        });

        // Clicking the backdrop closes the modal.
        $modal.on('click', function(e) {
            if (e.target === $modal[0]) {
                $modal.fadeOut(200, function() { $modal.remove(); });
            }
        });

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
        if (!data || !data.paymentId) return; // A payload without a paymentId cannot be deduped.
        SocketHandlers._expireOldClientPaymentMarkers();
        if (SocketHandlers._lastDisplayedConfirmation === data.paymentId) return;
        SocketHandlers._lastDisplayedConfirmation = data.paymentId;
        SocketHandlers._confirmationTimestamps[data.paymentId] = Date.now();

        SocketHandlers.hidePaymentQR();

        // A credits purchase does not enqueue a game, so the player returns to the welcome screen.
        if (data.creditsAdded || data.newBalance !== undefined) {
            if (typeof Game !== 'undefined') {
                Game._pendingPaymentConfirmed();
            }
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWelcomeScreen) {
                ScreenManager.drawWelcomeScreen();
            }
            $('#messages').append($('<li class="payment-success" style="color:#0f0;">').html(
                '✅ <strong>Credits purchased!</strong> Type \'enter\' or click START GAME to play.'
            ));
            UI.scrollChat();
            SocketHandlers._setBannerStatus('Credits Added', '#0f0');
        } else {
            // A single-game payment puts the player in the queue, so show the waiting screen.
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
        // AudioAlerts._patchSocketHandlers() plays the sound for this event.
    },

    _mempoolShownForPayment: new Set(),
    _mempoolTimestamps: {}, // paymentId -> ts
    onPaymentDetected: function(data) {
        console.log('Payment detected (mempool):', data);
        if (!data || !data.paymentId) return; // A payload without a paymentId cannot be deduped.
        SocketHandlers._expireOldClientPaymentMarkers();
        if (SocketHandlers._mempoolShownForPayment.has(data.paymentId)) return;
        SocketHandlers._mempoolShownForPayment.add(data.paymentId);
        SocketHandlers._mempoolTimestamps[data.paymentId] = Date.now();

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
        // AudioAlerts._patchSocketHandlers() plays the sound for this event.
    },

    // Bounds the client-side payment marker sets. Called opportunistically from the payment
    // handlers rather than on a timer.
    _expireOldClientPaymentMarkers: function() {
        const TTL = 6 * 60 * 60 * 1000; // 6 hours
        const now = Date.now();
        for (const pid of Array.from(SocketHandlers._mempoolShownForPayment)) {
            const ts = SocketHandlers._mempoolTimestamps[pid];
            if (!ts || now - ts > TTL) {
                SocketHandlers._mempoolShownForPayment.delete(pid);
                delete SocketHandlers._mempoolTimestamps[pid];
            }
        }
        if (SocketHandlers._lastDisplayedConfirmation) {
            const lastId = SocketHandlers._lastDisplayedConfirmation;
            const ts = SocketHandlers._confirmationTimestamps[lastId];
            if (ts && now - ts > TTL) {
                delete SocketHandlers._confirmationTimestamps[lastId];
                // Clearing the id frees the entry; the same id may display again after the TTL.
                SocketHandlers._lastDisplayedConfirmation = null;
            }
        }
    },

    onBlockHeight: function(data) {
        if (typeof UI !== 'undefined' && UI.updateBlockHeight) {
            UI.updateBlockHeight(data.blockHeight);
        }
        // ScreenManager shows the height on the welcome screen.
        if (typeof ScreenManager !== 'undefined' && data.blockHeight) {
            ScreenManager._currentBlockHeight = data.blockHeight;
            // Redrawing is only safe when no game, spectator view, or waiting screen owns the canvas.
            if (typeof GameState !== 'undefined' && !GameState.isGameActive() && 
                typeof Game !== 'undefined' && !Game._isSpectating &&
                !ScreenManager.isShowingWaitingScreen()) {
                ScreenManager.drawWelcomeScreen();
            }
        }
        // A banner still reading Connecting... has missed its status event; this block height
        // proves the connection is live.
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

    // Dismissible call to action in the status area, shown only when live games exist. It stays out
    // of the canvas and hides while the visitor is in a game, queued, or spectating, so it never
    // interrupts play.
    _liveCtaDismissed: false,
    _updateLiveCta: function(data) {
        var el = document.getElementById('liveCta');
        if (!el) return;
        var liveCount = (data.games || []).length;
        var inGame = (typeof Game !== 'undefined' && (Game._gameActive || Game._isSpectating)) || SocketHandlers._spectatorMode || SocketHandlers._isQueued;
        var panelOpen = $('#gamesListPanel').is(':visible');

        if (liveCount > 0 && !inGame && !panelOpen && !SocketHandlers._liveCtaDismissed) {
            el.innerHTML = '🔴 ' + liveCount + ' game' + (liveCount === 1 ? '' : 's') +
                ' live right now: <span style="text-decoration:underline;">watch &raquo;</span>';
            el.style.display = 'block';
            if (!el._bound) {
                el._bound = true;
                el.addEventListener('click', function () {
                    SocketHandlers._liveCtaDismissed = true; // Engaging once suppresses it for the session.
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
        
        SocketHandlers._hideGamesPanel();

        SocketHandlers._showSpectatorControls(data.playerId);

        if (typeof Game !== 'undefined' && data.initialState) {
            const state = data.initialState;
            try {
                // _isSpectating is set before startGame so the run renders read-only.
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
        
        SocketHandlers._hideSpectatorControls();

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

        if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWelcomeScreen) {
            ScreenManager.drawWelcomeScreen();
        }

        SocketHandlers._showGamesPanel();
        
        SocketHandlers._setBannerStatus('Ready', '#0f0');
    },

    _updateGamesListPanel: function(data) {
        let $panel = $('#gamesListPanel');
        
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
            
            $panel.on('click', '#gamesListClose', function() {
                $panel.hide();
            });

            // Delegated: game rows are re-rendered on every active_games update.
            $panel.on('click', '.spectate-btn', function() {
                const gameId = $(this).data('gameid');
                if (gameId && window.socket) {
                    socket.emit('spectate_game', { gameId: gameId });
                }
            });
        }
        
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
     * Whether early entry is allowed for the current mode and server config.
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
     * Sets early entry button visibility and label from the current state.
     */
    _updateEarlyEntryButton: function() {
        let $btn = $('#earlyEntryButton');

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
            
            const $animBtn = $('#animationToggleButton');
            if ($animBtn.length) {
                $animBtn.after($btn);
            } else {
                $('#header').append($btn);
            }

            $btn.on('click', function() {
                SocketHandlers.requestEarlyEntry();
            });
        }
        
        if (this._isQueued && this.isEarlyEntryAllowed()) {
            // Paid modes name the credit cost in the label.
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
     * Requests early entry from the server after confirming the credit spend.
     */
    requestEarlyEntry: function() {
        if (!window.socket) return;

        var mode = this._gameMode;
        var msg = 'Enter the dungeon NOW?\n\nYou will die when the next block is found!';
        if (mode === 'PAID_CREDITS' || mode === 'MIXED') {
            var cost = this._creditsPerGame || 1;
            msg = 'Use ' + cost + ' credit to enter the dungeon NOW?\n\nYou will die when the next block is found!';
        }
        if (!confirm(msg)) return;

        // Disabling the button prevents a second entry request while the first is in flight.
        var $btn = $('#earlyEntryButton');
        $btn.prop('disabled', true).text('⏳ Entering...');

        if (!SocketHandlers.emitFairGameStart('early_entry')) {
            $btn.prop('disabled', false).text('⚡ ENTER NOW (RISKY!) ⚡');
        }
    },
    
    onEarlyEntrySuccess: function(data) {
        console.log('Early entry success:', data);
        SocketHandlers._isQueued = false;
        SocketHandlers._updateEarlyEntryButton();

        // game_start follows and draws the run; this line is acknowledgement only.
        $('#messages').append($('<li class="status" style="color:#ff6600;">').text('⚡ Early entry! Race to escape before the next block!'));
        UI.scrollChat();
    },
    
    onEarlyEntryError: function(data) {
        console.error('Early entry error:', data);

        const $btn = $('#earlyEntryButton');
        $btn.prop('disabled', false).text('⚡ ENTER NOW (RISKY!) ⚡');

        const message = data?.message || 'Early entry not available';
        $('#messages').append($('<li class="error" style="color:#f00;">').text('Early entry failed: ' + message));
        UI.scrollChat();
    },

    // =====================
    // Entry Choice Modal
    // =====================

    // A single dialog covering both timing and entry type, so the player answers one modal rather
    // than a timing modal followed by a payment modal. Each card emits the final intent: Free sends
    // {free:true} so the server skips its own options modal, Ranked spends a credit or opens the
    // payment UI. Nothing starts until a card is clicked.
    showEntryChoiceModal: function(opts) {
        opts = opts || {};
        $('#entryChoiceOverlay').remove();
        var freeAvailable = !!opts.freeAvailable;
        var hasCredits = !!opts.hasCredits;
        var cost = this._creditsPerGame || 1;
        var currency = this._currencyLabel || 'WOW';
        var creditEntry = cost + (cost === 1 ? ' credit' : ' credits');
        var buyRankedEntry = SocketHandlers._directModeEnabled
            ? 'Buy a single entry or credits with ' + currency
            : 'Buy credits with ' + currency;
        var timing = 'wait'; // Waiting for the next block is the non-risky option.

        var $overlay = $('<div id="entryChoiceOverlay">').css({
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.74)', zIndex: 3000, display: 'flex',
            alignItems: 'center', justifyContent: 'center'
        });
        var $modal = $('<div>').css({
            background: 'linear-gradient(180deg,#101609,#0b0f07)', border: '1px solid #33421f',
            borderRadius: '12px', width: '92%', maxWidth: '480px', color: '#e6ead0',
            fontFamily: 'monospace', boxShadow: '0 22px 60px rgba(0,0,0,.6)', overflow: 'hidden'
        });

        function seg(id, on, t, d, danger) {
            var col = on ? (danger ? '#ff6a1a' : '#4fd463') : '#8b9a78';
            var bg = on ? (danger ? 'linear-gradient(180deg,#4a1c05,#2a1103)' : 'linear-gradient(180deg,#123a17,#0b2410)') : '#0a0f07';
            var bc = on ? (danger ? '#ff6a1a' : '#4fd463') : '#33421f';
            return '<button id="' + id + '" style="flex:1;text-align:left;cursor:pointer;font-family:monospace;' +
                'background:' + bg + ';border:1px solid ' + bc + ';border-radius:7px;padding:10px 11px;color:' + col + ';">' +
                '<span style="display:block;font-size:13px;font-weight:bold;color:' + (on ? '#fff' : '#e6ead0') + '">' + t + '</span>' +
                '<span style="display:block;font-size:10.5px;margin-top:2px;">' + d + '</span></button>';
        }
        function entryCard(id, k, t, s, accent) {
            return '<div id="' + id + '" style="display:flex;align-items:center;gap:11px;cursor:pointer;' +
                'background:#0a0f07;border:1px solid ' + accent + ';border-radius:8px;padding:11px 12px;margin-bottom:9px;">' +
                '<span style="font-size:21px;width:26px;text-align:center;">' + k + '</span>' +
                '<div style="flex:1;"><div style="font-size:14px;font-weight:bold;color:#fff;">' + t + '</div>' +
                '<div style="font-size:10.5px;color:#8b9a78;margin-top:2px;">' + s + '</div></div>' +
                '<span style="font-size:12px;letter-spacing:1px;color:' + accent + ';">ENTER &#9656;</span></div>';
        }
        function begin(msg, emit) {
            if (emit() === false) return;
            $('#entryChoiceOverlay').remove();
            // Transient entry line, cleared in onGameStart once the game is live so it cannot read
            // as "still starting" beside a running game. The queued variant stays visible for the
            // whole block wait; only a started game removes it.
            $('#messages').append($('<li class="entry-progress" style="color:#f0a828;">').text(msg));
            if (typeof UI !== 'undefined' && UI.scrollChat) UI.scrollChat();
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) ScreenManager.drawWaitingScreen();
        }
        function pay() {
            $('#entryChoiceOverlay').remove();
            if (typeof PaymentUI !== 'undefined' && PaymentUI.show) PaymentUI.show();
        }
        function render() {
            $modal.html(
                '<div style="display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid #25301c;">' +
                    '<span style="font-size:20px;">&#9876;</span>' +
                    '<h2 style="margin:0;font-size:18px;letter-spacing:1px;color:#fff;">Enter the Dungeon</h2>' +
                    '<span id="ecX" style="margin-left:auto;color:#5d6a4c;border:1px solid #33421f;border-radius:5px;padding:2px 8px;font-size:12px;cursor:pointer;">esc</span>' +
                '</div>' +
                '<div style="padding:15px 18px;">' +
                    '<div style="font-size:10px;letter-spacing:2px;color:#5d6a4c;text-transform:uppercase;font-weight:bold;margin-bottom:7px;">1 &middot; When do you drop in?</div>' +
                    '<div style="display:flex;gap:8px;margin-bottom:15px;">' +
                        seg('ecWait', timing === 'wait', '&#128737; Next block', 'Start fresh &middot; blocks land at random', false) +
                        seg('ecNow', timing === 'now', '&#9889; Right now', 'Jump in &middot; race the time left', true) +
                    '</div>' +
                    '<div style="font-size:10px;letter-spacing:2px;color:#5d6a4c;text-transform:uppercase;font-weight:bold;margin-bottom:7px;">2 &middot; Choose your entry</div>' +
                    (freeAvailable ? entryCard('ecFree', '&#127379;', 'Free Play', 'No cost &middot; Pleb leaderboard', '#123a17') : '') +
                    entryCard('ecRank', '&#128176;', 'Ranked', (hasCredits ? creditEntry : buyRankedEntry) + ' &middot; Hall of Champions', '#2a1a4a') +
                    '<div style="margin-top:6px;font-size:11px;"><a id="ecBuy" style="color:#f0a828;cursor:pointer;">&#43; Buy credits (bulk discount)</a></div>' +
                '</div>'
            );
            $('#ecWait').on('click', function () { timing = 'wait'; render(); });
            $('#ecNow').on('click', function () { timing = 'now'; render(); });
            $('#ecX').on('click', function () { $('#entryChoiceOverlay').remove(); });
            $('#ecFree').on('click', function () {
                if (timing === 'now') begin('⚡ Free game: dropping in...', function () { return SocketHandlers.emitFairGameStart('auto_start', { free: true }); });
                else begin('🛡️ Free game: queued for the next block...', function () { return SocketHandlers.emitFairGameStart('join_queue', { free: true }); });
            });
            $('#ecRank').on('click', function () {
                if (!hasCredits) { pay(); return; }
                if (timing === 'now') begin('⚡ Ranked: dropping in now...', function () { return SocketHandlers.emitFairGameStart('auto_start'); });
                else begin('🛡️ Ranked: queued for the next block...', function () { return SocketHandlers.emitFairGameStart('join_queue'); });
            });
            $('#ecBuy').on('click', pay);
        }

        $overlay.append($modal).on('click', function (e) { if (e.target === this) $('#entryChoiceOverlay').remove(); });
        $('body').append($overlay);
        render();
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SocketHandlers;
}
