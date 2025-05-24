/**
 * Input handlers for the Wowngeon game
 */
const InputHandler = {
    init: function() {
        this.setupChatForm();
        this.setupFocusHandlers();
        this.setupKeyboardControls();
        this.setupModeToggle();
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
                        console.log(`Attempting to move: dx=${dx}, dy=${dy}. Key: ${e.key}`);
                        e.preventDefault(); // Prevent page scrolling
                        socket.emit('player_move', { dx: dx, dy: dy });
                        console.log(`Emitted player_move: dx=${dx}, dy=${dy}`);
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

// Initialize input handlers when DOM is ready
$(function() {
    InputHandler.init();
});
