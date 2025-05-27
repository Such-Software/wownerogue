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
        this.setupClickHandlers();
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
            
            // If the message is "enter", always send it to server
            // The server will handle queueing logic and timing
            if (msg.toLowerCase() === 'enter') {
                console.log("🔑 'ENTER' COMMAND DETECTED - sending to server");
                socket.emit('chat message', msg);
                
                // Show appropriate screen based on current state
                const isDebugMode = window.location.hostname === 'localhost' || 
                                   window.location.hostname === '127.0.0.1' || 
                                   window.location.protocol === 'file:';
                
                if (isDebugMode || ScreenManager.canEnterGame()) {
                    console.log("✅ Can enter immediately - showing waiting screen");
                    if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                        ScreenManager.drawWaitingScreen();
                    }
                } else {
                    console.log("⏳ Will be queued - showing queue message");
                    $('#messages').append($('<li style="color: #ff0;">').text("* You have been added to the queue! Game will start after next block."));
                    UI.scrollChat();
                }
            } else {
                // Send other chat messages normally
                socket.emit('chat message', msg);
            }
            
            $('#chatInput').val('');
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
                    // Game display has focus but game is not active (welcome screen)
                    // Check for debug key 'D' to start immediately
                    if (e.key === 'D' || e.key === 'd') {
                        // Check if we're in debug mode (localhost)
                        const isDebugMode = window.location.hostname === 'localhost' || 
                                           window.location.hostname === '127.0.0.1' || 
                                           window.location.protocol === 'file:';
                        
                        if (isDebugMode) {
                            console.log("🔧 DEBUG: 'D' key pressed - starting game immediately");
                            e.preventDefault();
                            
                            // Emit enter command to start game immediately
                            socket.emit('chat message', 'enter');
                            
                            // Show waiting screen while game starts
                            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                                ScreenManager.drawWaitingScreen();
                            }
                            
                            // Add debug message to chat
                            $('#messages').append($('<li style="color: #0f0;">').text("🔧 DEBUG: Starting game immediately..."));
                            UI.scrollChat();
                        } else {
                            console.log("Debug key pressed but not in debug mode");
                        }
                    } else if (e.key === 'A' || e.key === 'a') {
                        // Toggle animation on waiting screen
                        console.log("🎬 'A' key pressed - toggling animation");
                        e.preventDefault();
                        if (typeof ScreenManager !== 'undefined') {
                            ScreenManager.toggleAnimation();
                        }
                    } else {
                        console.log("Game display has focus, but Game is not active.");
                    }
                }
            } else if (e.key === 'Enter' && document.activeElement !== $('#chatInput')[0]) {
                // If Enter is pressed and chat is not focused
                if (typeof Game !== 'undefined' && !Game._gameActive) {
                    // On welcome screen - start the game
                    console.log("🔑 Enter key pressed on welcome screen - starting game");
                    e.preventDefault();
                    
                    const isDebugMode = window.location.hostname === 'localhost' || 
                                       window.location.hostname === '127.0.0.1' || 
                                       window.location.protocol === 'file:';
                    
                    socket.emit('chat message', 'enter');
                    
                    if (isDebugMode || ScreenManager.canEnterGame()) {
                        console.log("✅ Can enter immediately - showing waiting screen");
                        if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                            ScreenManager.drawWaitingScreen();
                        }
                    } else {
                        console.log("⏳ Will be queued - showing queue message");
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
            console.log("🖱️ START button clicked - auto-starting game");
            
            // Use the new auto_start event for immediate entry
            socket.emit('auto_start');
            
            console.log("✅ Auto-start requested - showing waiting screen");
            if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                ScreenManager.drawWaitingScreen();
            }
            
            // Add visual feedback to chat
            $('#messages').append($('<li style="color: #0f0;">').text("🖱️ Game start requested..."));
            UI.scrollChat();
        });
        
        // Add click handling for the animation toggle button
        $('#animationToggleButton').click(function(e) {
            console.log("🎬 Animation toggle button clicked");
            
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
