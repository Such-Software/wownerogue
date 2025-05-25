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
            console.warn("InputHandler.init() called multiple times - ignoring duplicate call");
            return;
        }
        
        console.log("InputHandler: Initializing for the first time...");
        this.setupChatForm();
        this.setupFocusHandlers();
        this.setupKeyboardControls();
        this.setupModeToggle();
        this._initialized = true;
    },

    setupChatForm: function() {
        $('#chatForm').submit(function(e) {
            e.preventDefault();
            var msg = $('#chatInput').val().trim();
            
            // Don't send empty messages
            if (!msg) return false;
            
            console.log("📝 SENDING CHAT:", msg);
            socket.emit('chat message', msg);
            $('#chatInput').val('');
            
            // If the message is "enter", show the waiting screen
            if (msg.toLowerCase() === 'enter') {
                console.log("🔑 'ENTER' COMMAND DETECTED - expecting game_start response");
                
                // Show waiting screen
                if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
                    Game.drawWaitingScreen();
                }
            }
            
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
            if (document.activeElement === $('#game-display')[0]) {
                if (Game && Game._gameActive) {
                    let dx = 0;
                    let dy = 0;
                    let moved = false;

                    switch(e.key) {
                        case 'w': case 'ArrowUp':    dy = -1; moved = true; break;
                        case 's': case 'ArrowDown':  dy = 1;  moved = true; break;
                        case 'a': case 'ArrowLeft':  dx = -1; moved = true; break;
                        case 'd': case 'ArrowRight': dx = 1;  moved = true; break;
                    }

                    if (moved) {
                        console.log(`🎹 KEYDOWN: dx=${dx}, dy=${dy}, key=${e.key}, time=${Date.now()}`);
                        e.preventDefault(); // Prevent page scrolling
                        
                        // Implement movement throttling to prevent rapid-fire movement
                        const now = Date.now();
                        if (now - self._lastMoveTime >= self._moveCooldown) {
                            // Send move immediately if enough time has passed
                            socket.emit('player_move', { dx: dx, dy: dy });
                            console.log(`✅ EMITTED player_move: dx=${dx}, dy=${dy}`);
                            self._lastMoveTime = now;
                            self._pendingMove = null;
                        } else {
                            // Queue the move to be sent after cooldown
                            self._pendingMove = { dx: dx, dy: dy };
                            const timeToWait = self._moveCooldown - (now - self._lastMoveTime);
                            console.log(`⏳ QUEUED move: dx=${dx}, dy=${dy}, waiting ${timeToWait}ms`);
                            setTimeout(() => {
                                if (self._pendingMove) {
                                    socket.emit('player_move', self._pendingMove);
                                    console.log(`✅ EMITTED queued player_move: dx=${self._pendingMove.dx}, dy=${self._pendingMove.dy}`);
                                    self._lastMoveTime = Date.now();
                                    self._pendingMove = null;
                                }
                            }, timeToWait);
                        }
                    }
                } else {
                    console.log("Game display has focus, but Game is not active.");
                }
            } else if (e.key === 'Enter' && document.activeElement !== $('#chatInput')[0]) {
                // If Enter is pressed and chat is not focused, focus chat
                $('#chatInput').focus();
                UI.updateFocusIndicator();
            }
        });
    },

    setupModeToggle: function() {
        var toggleButton = document.getElementById('toggle-mode');
        if (toggleButton) {
            toggleButton.addEventListener('click', function() {
                try {
                    console.log("Display mode switching is no longer needed - modes are equivalent");
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
