/**
 * Input handlers for the Wowngeon game
 */
const InputHandler = {
    _lastMoveTime: 0,
    _moveCooldown: 100, // Minimum 100ms between moves
    _pendingMove: null,
    _initialized: false, // Flag to prevent multiple initializations
    
    init: function() {
        if (this._initialized) {
            return;
        }
        
        this.setupChatForm();
        this.setupFocusHandlers();
        this.setupKeyboardControls();
        this.setupClickHandlers();
        this.setupModeToggle();
        this._initialized = true;
    },

    setupChatForm: function() {
        const MAX_CHAT_LENGTH = 200;

        // Character counter update
        $('#chatInput').on('input', function() {
            const len = $(this).val().length;
            const counter = $('#charCounter');
            counter.text(len + '/' + MAX_CHAT_LENGTH);
            // Change color when approaching limit
            if (len >= MAX_CHAT_LENGTH) {
                counter.css('color', '#f66');
            } else if (len >= MAX_CHAT_LENGTH * 0.8) {
                counter.css('color', '#fa0');
            } else {
                counter.css('color', '#666');
            }
        });

        $('#chatForm').submit(function(e) {
            e.preventDefault();
            var msg = $('#chatInput').val().trim();

            // Don't send empty messages
            if (!msg) return false;

            // If the message is "enter", always send it to server
            // The server will handle queueing logic and timing
            if (msg.toLowerCase() === 'enter') {
                socket.emit('chat message', msg);

                // Don't automatically switch to waiting screen - let the server control screen state
                // The server will send appropriate events (payment_created, waiting_status, etc.)
                // to control what the user sees

                // Add visual feedback that request was sent
                $('#messages').append($('<li style="color: #0f0;">').text("🔑 Processing game entry request..."));
                UI.scrollChat();
            } else {
                // Send other chat messages normally
                socket.emit('chat message', msg);
            }

            $('#chatInput').val('');
            $('#charCounter').text('0/' + MAX_CHAT_LENGTH).css('color', '#666');
            return false;
        });

        // Set initial focus to chat input
        $('#chatInput').focus();
        UI.updateFocusIndicator();
    },

    setupFocusHandlers: function() {
        // Add focus/blur listeners for visual indicator
        $('#chatInput').on('focus', UI.updateFocusIndicator).on('blur', UI.updateFocusIndicator);
        $('#game-display').on('focus', UI.updateFocusIndicator).on('blur', UI.updateFocusIndicator);

        // Make game display focusable
        $('#game-display').attr('tabindex', '-1');
    },

    setupKeyboardControls: function() {
        const self = this; // Store reference to InputHandler for use in event handler
        $(document).on('keydown', function(e) {
            // Handle ESC to leave spectate mode
            if (e.key === 'Escape' && typeof SocketHandlers !== 'undefined' && SocketHandlers._spectatorMode) {
                e.preventDefault();
                if (window.socket) {
                    socket.emit('leave_spectate');
                }
                return;
            }
            
            if (document.activeElement === $('#game-display')[0]) {
                if (Game && Game._gameActive) {
                    // Block movement input if spectating
                    if (typeof Game !== 'undefined' && Game._isSpectating) {
                        // In spectator mode - ignore movement keys
                        return;
                    }
                    
                    let dx = 0;
                    let dy = 0;
                    let moved = false;

                    let direction = null;
                    switch(e.key) {
                        case 'w': case 'ArrowUp':    direction = 'up';    dy = -1; moved = true; break;
                        case 's': case 'ArrowDown':  direction = 'down';  dy = 1;  moved = true; break;
                        case 'a': case 'ArrowLeft':  direction = 'left';  dx = -1; moved = true; break;
                        case 'd': case 'ArrowRight': direction = 'right'; dx = 1;  moved = true; break;
                    }

                    if (moved && direction) {
                        e.preventDefault(); // Prevent page scrolling
                        
                        // Implement movement throttling to prevent rapid-fire movement
                        const now = Date.now();
                        if (now - self._lastMoveTime >= self._moveCooldown) {
                            // Send move immediately if enough time has passed
                            socket.emit('player_move', { direction });
                            self._lastMoveTime = now;
                            self._pendingMove = null;
                        } else {
                            // Queue the move to be sent after cooldown
                            self._pendingMove = { direction };
                            const timeToWait = self._moveCooldown - (now - self._lastMoveTime);
                            setTimeout(() => {
                                if (self._pendingMove) {
                                    socket.emit('player_move', self._pendingMove);
                                    self._lastMoveTime = Date.now();
                                    self._pendingMove = null;
                                }
                            }, timeToWait);
                        }
                    }
                } else {
                    // Game display has focus but game is not active (welcome screen)
                    // Only handle animation toggle
                    if (e.key === 'A' || e.key === 'a') {
                        // Toggle animation on waiting screen
                        e.preventDefault();
                        if (typeof ScreenManager !== 'undefined') {
                            ScreenManager.toggleAnimation();
                        }
                    }
                }
            } else if (e.key === 'Enter' && document.activeElement !== $('#chatInput')[0]) {
                // If Enter is pressed and chat is not focused
                if (typeof Game !== 'undefined' && !Game._gameActive) {
                    // On welcome screen - start the game
                    e.preventDefault();
                    
                    const isDebugMode = window.location.hostname === 'localhost' || 
                                       window.location.hostname === '127.0.0.1' || 
                                       window.location.protocol === 'file:';
                    
                    socket.emit('chat message', 'enter');
                    
                    if (isDebugMode || ScreenManager.canEnterGame()) {
                        // Check if we should show waiting screen
                        const addressRequired = typeof SocketHandlers !== 'undefined' && SocketHandlers.payoutAddressRequired();
                        const hasAddress = typeof SocketHandlers !== 'undefined' && SocketHandlers._hasPayoutAddress;
                        const canAfford = typeof SocketHandlers !== 'undefined' && SocketHandlers.canAffordGame();
                        const isFree = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'FREE';

                        // Only show waiting screen if address is set (if required) and they can afford it (if credits)
                        const shouldShowWaiting = isFree || (canAfford && (!addressRequired || hasAddress));

                        if (shouldShowWaiting && typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                            // Optimistically set awaiting payment if needed
                            const isPaidCredits = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'PAID_CREDITS';
                            const hasEnoughCredits = typeof SocketHandlers !== 'undefined' && SocketHandlers._creditsBalance >= (SocketHandlers._creditsPerGame || 1);
                            
                            if (!isFree && typeof Game !== 'undefined' && !Game._unconfirmedPayment) {
                                if (!(isPaidCredits && hasEnoughCredits)) {
                                    Game._awaitingPayment = true;
                                }
                            }
                            ScreenManager.drawWaitingScreen();
                        }
                    } else {
                        $('#messages').append($('<li style="color: #ff0;">').text("* You have been added to the queue! Game will start after next block."));
                        UI.scrollChat();
                    }
                    
                    // Add visual feedback to chat
                    $('#messages').append($('<li style="color: #0f0;">').text("🔑 Game start requested..."));
                    UI.scrollChat();
                } else {
                    // Game is active or in other state - focus chat
                    $('#chatInput').focus();
                    UI.updateFocusIndicator();
                }
            }
        });
    },

    setupClickHandlers: function() {
        // Add click handling for the HTML START button
        $('#startButton').click(function(e) {
            // Show the wait-vs-drop-in TIMING choice whenever the game would start instantly (no
            // upfront payment): free play (this instance allows it), a FREE instance, or paid-credits
            // with credits in hand. The chosen payment method flows through auto_start / join_queue
            // unchanged — this modal only picks WHEN you enter.
            if (typeof SocketHandlers !== 'undefined') {
                var mode = SocketHandlers._gameMode;
                var freeAvailable = SocketHandlers._freePlayEnabled || mode === 'FREE';
                var hasCredits = SocketHandlers._creditsBalance >= (SocketHandlers._creditsPerGame || 1);
                var instantStart = freeAvailable || (mode === 'PAID_CREDITS' && hasCredits);
                if (instantStart) {
                    SocketHandlers.showEntryChoiceModal({ freeAvailable: freeAvailable, hasCredits: hasCredits });
                    return;
                }
            }

            // Default: attempt immediate start (payment-required modes go through their own flow)
            socket.emit('auto_start');

            // Check if we should show waiting screen
            const addressRequired = typeof SocketHandlers !== 'undefined' && SocketHandlers.payoutAddressRequired();
            const hasAddress = typeof SocketHandlers !== 'undefined' && SocketHandlers._hasPayoutAddress;
            const canAfford = typeof SocketHandlers !== 'undefined' && SocketHandlers.canAffordGame();
            const isFree = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'FREE';

            // We only show waiting screen if:
            // 1. It's free mode
            // 2. We have address (if required) AND (it's direct pay OR we have credits)
            const shouldShowWaiting = isFree || (canAfford && (!addressRequired || hasAddress));

            if (shouldShowWaiting) {
                // If in a paid mode but no payment detected yet, optimistically set awaiting payment
                // UNLESS it is credits mode and we already have enough credits
                const isPaidCredits = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'PAID_CREDITS';
                const hasEnoughCredits = typeof SocketHandlers !== 'undefined' && SocketHandlers._creditsBalance >= (SocketHandlers._creditsPerGame || 1);
                
                if (!isFree && typeof Game !== 'undefined' && !Game._unconfirmedPayment) {
                    if (!(isPaidCredits && hasEnoughCredits)) {
                        Game._awaitingPayment = true;
                    }
                }

                if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                    ScreenManager.drawWaitingScreen();
                }
            } else {
                // If not showing waiting screen, add helpful message to chat if missing address
                if (addressRequired && !hasAddress) {
                    $('#messages').append($('<li style="color: #ffa500;">').text("⚠️ Please set a payout address using the button below before starting."));
                    UI.scrollChat();
                }
            }

            $('#messages').append($('<li style="color: #0f0;">').text("🖱️ Game start requested..."));
            UI.scrollChat();
        });
        
        // Watch games button - toggle the games list panel
        $('#watchGamesButton').click(function(e) {
            const $panel = $('#gamesListPanel');
            if ($panel.length && $panel.is(':visible')) {
                $panel.hide();
            } else {
                // Request fresh game list and show panel
                if (window.socket) {
                    socket.emit('get_active_games', { page: 1, pageSize: 20 });
                }
                if (typeof SocketHandlers !== 'undefined') {
                    SocketHandlers._showGamesPanel();
                }
            }
        });
        
        // Add click handling for the animation toggle button
        $('#animationToggleButton').click(function(e) {
            
            if (typeof ScreenManager !== 'undefined' && ScreenManager.toggleAnimation) {
                ScreenManager.toggleAnimation();
                // Redraw the waiting screen to reflect the change
                if (typeof ScreenManager.drawWaitingScreen === 'function') {
                    ScreenManager.drawWaitingScreen();
                }
            }
            
            // Add visual feedback to chat
            const status = ScreenManager._animationEnabled ? "enabled" : "disabled";
            $('#messages').append($('<li style="color: #aa0;">').text(`🎬 Animation ${status}`));
            UI.scrollChat();
        });

        // Address management button
        $('#manageAddressButton').click(function(e) {
            e.preventDefault();
            if (window.socket) {
                socket.emit('address:prompt');
            }
            if (typeof AddressModal !== 'undefined') {
                AddressModal.show();
            }
        });
    },

    setupModeToggle: function() {
        var toggleButton = document.getElementById('toggle-mode');
        if (toggleButton) {
            toggleButton.addEventListener('click', function() {
                try {
                    toggleButton.textContent = 'Mode switching disabled';
                    toggleButton.disabled = true;
                } catch (e) {
                    console.error("Error switching display mode:", e);
                }
            });
        }
    }
};

// Ensure InputHandler is available globally
if (typeof window !== 'undefined') {
    window.InputHandler = InputHandler;
}

// Note: InputHandler.init() is called from index.html after DOM ready
// to ensure proper initialization order with other modules
