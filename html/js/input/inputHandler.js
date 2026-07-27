/**
 * Input handlers for the Wowngeon game
 */

// Is a blocking dialog on screen?
//
// The document-level Enter shortcut submits a ranked (paid-intent) entry. The entry-choice and
// payment modals advertise "ENTER" on their own cards, so anything that takes over the screen must
// swallow the shortcut; otherwise Enter submits an entry the player has not chosen and the
// following click submits a second one.
function modalIsOpen() {
    if (document.getElementById('entryChoiceOverlay')) return true;
    var overlays = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < overlays.length; i++) {
        if (!overlays[i].classList.contains('hidden')) return true;
    }
    var paymentUi = document.getElementById('payment-ui');
    if (paymentUi && paymentUi.offsetParent !== null) return true;
    return false;
}

// Enter inside any text field belongs to that field, not to the game.
function typingInAField() {
    var el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
}

const InputHandler = {
    _lastMoveTime: 0,
    _moveCooldown: 100, // Minimum 100ms between moves
    _pendingMove: null,
    _initialized: false, // Guards against repeated init() calls binding duplicate handlers
    
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

        $('#chatInput').on('input', function() {
            const len = $(this).val().length;
            const counter = $('#charCounter');
            counter.text(len + '/' + MAX_CHAT_LENGTH);
            // Red at the limit, amber within the last 20%.
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

            if (!msg) return false;

            // "enter" always goes to the server, which owns queueing logic and timing.
            if (msg.toLowerCase() === 'enter') {
                if (typeof SocketHandlers !== 'undefined' && SocketHandlers.emitFairGameStart) {
                    if (!SocketHandlers.emitFairGameStart('join_queue')) return false;
                } else {
                    socket.emit('chat message', msg);
                }

                // The server controls screen state via payment_created, waiting_status and similar
                // events, so this path does not switch to the waiting screen itself.
                $('#messages').append($('<li style="color: #0f0;">').text("🔑 Processing game entry request..."));
                UI.scrollChat();
            } else {
                socket.emit('chat message', msg);
            }

            $('#chatInput').val('');
            $('#charCounter').text('0/' + MAX_CHAT_LENGTH).css('color', '#666');
            return false;
        });

        $('#chatInput').focus();
        UI.updateFocusIndicator();
    },

    setupFocusHandlers: function() {
        // Focus/blur drive the visual focus indicator.
        $('#chatInput').on('focus', UI.updateFocusIndicator).on('blur', UI.updateFocusIndicator);
        $('#game-display').on('focus', UI.updateFocusIndicator).on('blur', UI.updateFocusIndicator);

        // tabindex -1 makes the game display programmatically focusable without entering tab order.
        $('#game-display').attr('tabindex', '-1');
    },

    setupKeyboardControls: function() {
        const self = this; // The keydown handler runs with its own `this`, so capture InputHandler.
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape' && typeof SocketHandlers !== 'undefined' && SocketHandlers._spectatorMode) {
                e.preventDefault();
                if (window.socket) {
                    socket.emit('leave_spectate');
                }
                return;
            }
            
            if (document.activeElement === $('#game-display')[0]) {
                if (Game && Game._gameActive) {
                    // Spectators drive no character, so movement keys are ignored.
                    if (typeof Game !== 'undefined' && Game._isSpectating) {
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
                        e.preventDefault(); // Arrow keys would otherwise scroll the page.

                        // Moves are throttled to one per _moveCooldown; a move arriving inside the
                        // window replaces any pending one so only the latest direction is sent.
                        const now = Date.now();
                        if (now - self._lastMoveTime >= self._moveCooldown) {
                            socket.emit('player_move', { direction });
                            self._lastMoveTime = now;
                            self._pendingMove = null;
                        } else {
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
                    // Game display has focus with no active game (welcome/waiting screen): the only
                    // key handled is the animation toggle.
                    if (e.key === 'A' || e.key === 'a') {
                        e.preventDefault();
                        if (typeof ScreenManager !== 'undefined') {
                            ScreenManager.toggleAnimation();
                        }
                    }
                }
            } else if (e.key === 'Enter' && document.activeElement !== $('#chatInput')[0]
                       && !modalIsOpen() && !typingInAField()) {
                if (typeof Game !== 'undefined' && !Game._gameActive) {
                    // Enter on the welcome screen requests a game start.
                    e.preventDefault();

                    const isDebugMode = window.location.hostname === 'localhost' || 
                                       window.location.hostname === '127.0.0.1' || 
                                       window.location.protocol === 'file:';
                    
                    if (typeof SocketHandlers !== 'undefined' && SocketHandlers.emitFairGameStart) {
                        if (!SocketHandlers.emitFairGameStart('join_queue')) return;
                    } else {
                        socket.emit('chat message', 'enter');
                    }
                    
                    if (isDebugMode || ScreenManager.canEnterGame()) {
                        const addressRequired = typeof SocketHandlers !== 'undefined' && SocketHandlers.payoutAddressRequired();
                        const hasAddress = typeof SocketHandlers !== 'undefined' && SocketHandlers._hasPayoutAddress;
                        const canAfford = typeof SocketHandlers !== 'undefined' && SocketHandlers.canAffordGame();
                        const isFree = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'FREE';

                        // Free play always waits; otherwise the player needs an affordable entry and,
                        // where required, a payout address on file.
                        const shouldShowWaiting = isFree || (canAfford && (!addressRequired || hasAddress));

                        if (shouldShowWaiting && typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                            // Paid entries show the awaiting-payment state up front, except when
                            // credits mode already has enough credits to cover the game.
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
                    
                    $('#messages').append($('<li style="color: #0f0;">').text("🔑 Game start requested..."));
                    UI.scrollChat();
                } else {
                    // With a game active, Enter moves focus to chat.
                    $('#chatInput').focus();
                    UI.updateFocusIndicator();
                }
            }
        });
    },

    setupClickHandlers: function() {
        $('#startButton').click(function(e) {
            // The wait-vs-drop-in timing choice appears whenever the game would start instantly with
            // no upfront payment: free play enabled, a FREE instance, or paid-credits with credits in
            // hand. The modal only picks when you enter; the payment method still flows through
            // auto_start / join_queue unchanged.
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

            // Otherwise attempt an immediate start; payment-required modes go through their own flow.
            if (typeof SocketHandlers !== 'undefined' && SocketHandlers.emitFairGameStart) {
                if (!SocketHandlers.emitFairGameStart('auto_start')) return;
            } else {
                socket.emit('auto_start');
            }

            const addressRequired = typeof SocketHandlers !== 'undefined' && SocketHandlers.payoutAddressRequired();
            const hasAddress = typeof SocketHandlers !== 'undefined' && SocketHandlers._hasPayoutAddress;
            const canAfford = typeof SocketHandlers !== 'undefined' && SocketHandlers.canAffordGame();
            const isFree = typeof SocketHandlers !== 'undefined' && SocketHandlers._gameMode === 'FREE';

            // Free play always waits; otherwise the player needs an affordable entry and, where
            // required, a payout address on file.
            const shouldShowWaiting = isFree || (canAfford && (!addressRequired || hasAddress));

            if (shouldShowWaiting) {
                // Paid modes with no payment detected yet show the awaiting-payment state, except
                // when credits mode already has enough credits to cover the game.
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
                // A missing payout address is the actionable case, so name it in chat.
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
                if (window.socket) {
                    socket.emit('get_active_games', { page: 1, pageSize: 20 });
                }
                if (typeof SocketHandlers !== 'undefined') {
                    SocketHandlers._showGamesPanel();
                }
            }
        });
        
        $('#animationToggleButton').click(function(e) {

            if (typeof ScreenManager !== 'undefined' && ScreenManager.toggleAnimation) {
                ScreenManager.toggleAnimation();
                // The waiting screen is drawn once, so it needs a redraw to pick up the new setting.
                if (typeof ScreenManager.drawWaitingScreen === 'function') {
                    ScreenManager.drawWaitingScreen();
                }
            }

            const status = ScreenManager._animationEnabled ? "enabled" : "disabled";
            $('#messages').append($('<li style="color: #aa0;">').text(`🎬 Animation ${status}`));
            UI.scrollChat();
        });

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

if (typeof window !== 'undefined') {
    window.InputHandler = InputHandler;
}

// index.html calls InputHandler.init() after DOM ready, once the modules it reaches into
// (UI, Game, ScreenManager, SocketHandlers) are defined.
