/**
 * Socket event handlers for the Wowngeon game
 */
const SocketHandlers = {
    _initialized: false, // Flag to prevent multiple initializations
    
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
    },

    registerEventHandlers: function() {
        // Connection handlers
        socket.on('connect', this.onConnect);
        socket.on('welcome', this.onWelcome);
        socket.on('message', this.onMessage);
        socket.on('status_update', this.onStatusUpdate);
        socket.on('chat_broadcast', this.onChatBroadcast);
        
        // Game state handlers
        socket.on('waiting_status', this.onWaitingStatus);
        socket.on('game_start', this.onGameStart);
        socket.on('game_update', this.onGameUpdate);
        socket.on('game_over', this.onGameOver);
        socket.on('queue_cancelled', this.onQueueCancelled);
        
        // Payment/Address handlers
        socket.on('address_detected', this.onAddressDetected);
        socket.on('address_confirmed', this.onAddressConfirmed);
        
        // Block height handler (broadcast to all clients)
        socket.on('blockheight', this.onBlockHeight);
    },

    onConnect: function() {
        
        // Tell server our client ID
        socket.emit('register_client', {
            clientId: socket.id,
            userAgent: navigator.userAgent
        });
        
        // Auto-start removed - user must manually start game
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
        // Handle player-specific status updates
        
        // Display status message with appropriate styling
        const statusClass = data.type === 'error' ? 'error' : 'status';
        $('#messages').append($(`<li class="${statusClass}">`).text(data.message));
        UI.scrollChat();
    },

    onChatBroadcast: function(data) {
        // Handle chat messages broadcast to all players
        
        const timestamp = new Date(data.timestamp || Date.now()).toLocaleTimeString();
        const chatMsg = `[${timestamp}] ${data.username || 'Anonymous'}: ${data.message}`;
        
        $('#messages').append($('<li class="chat">').text(chatMsg));
        UI.scrollChat();
    },

    onWaitingStatus: function(data) {
        
        if (data.status === 'waiting') {
            $('#messages').append($('<li style="color:#ff0;">').text(data.message));
            
            // Show waiting screen
            if (typeof Game !== 'undefined' && Game.drawWaitingScreen) {
                Game.drawWaitingScreen();
            }
        }
        UI.scrollChat();
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
            // Pass all game data including lighting and torches
            var success = Game.startGame(data.player, data.map, data.monster, data.items, data.visibleTiles, data.lighting, data.torches);
            
            if (!success) {
                $('#messages').append($('<li class="error">').text("Game start failed. Check console for details."));
                if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            } else {
                // Shift focus to the game display area after successful game start
                $('#game-display').focus(); 
                UI.updateFocusIndicator();
            }
            
        } catch (err) {
            console.error("Error starting game:", err);
            $('#messages').append($('<li class="error">').text("Error: " + err.message));
        }
    },

    onGameUpdate: function(data) {
        
        if (data.visibleTiles) {
            if (window.GameDebug) window.GameDebug.updateDebugDisplay("SOCKET: Received game update with visibleTiles");
        }
        
        if (typeof Game !== 'undefined' && Game._gameActive) {
            Game.updateGameState(data);
        }
    },

    onGameOver: function(data) {
        
        // Update game state based on outcome
        if (typeof Game !== 'undefined') {
            if (data.status === 'won') {
                // Show win message
                $('#messages').append($('<li style="color:#0f0; font-weight:bold;">').text(
                    data.hasTreasure ? 
                    "YOU ESCAPED WITH THE TREASURE! YOU WON!" : 
                    "You escaped the dungeon alive!"
                ));
                
                // Draw win screen
                Game.drawWinScreen(data.hasTreasure);
            } else {
                // Show loss message
                const reason = data.reason || "unknown";
                let message = "You died in the dungeon!";
                
                if (reason === 'monster') {
                    message = "You were killed by the monster!";
                } else if (reason === 'timeout') {
                    message = "You didn't escape before the next block was found!";
                }
                
                $('#messages').append($('<li style="color:#f00; font-weight:bold;">').text(message));
                
                // Draw lose screen
                if (Game && Game.drawLoseScreen) {
                    Game.drawLoseScreen(reason);
                }
            }
            
            // Set game as inactive to prevent further movement
            if (Game) {
                Game._gameActive = false;
            }
            
            // Auto-return to title screen after 30 seconds
            setTimeout(() => {
                $('#messages').append($('<li style="color:#888;">').text("Returning to title screen..."));
                UI.scrollChat();
                
                // Return to welcome screen
                if (Game && Game._drawWelcomeScreen) {
                    Game._drawWelcomeScreen();
                }
                
                // Reset game state
                if (typeof GameState !== 'undefined') {
                    GameState.reset();
                }
                
                // Focus chat for new commands
                $('#chatInput').focus();
                UI.updateFocusIndicator();
            }, 30000); // 30 seconds
        }
        
        UI.scrollChat();
    },

    onQueueCancelled: function() {
        
        if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) {
            Game._drawWelcomeScreen();
        } else {
            console.error("Game or _drawWelcomeScreen not available");
        }
    },

    onBlockHeight: function(height) {
        UI.updateBlockHeight(height);
        $('#statusValue').text('Connected');
        $('#statusValue').css('color', '#0f0');
    },

    onAddressDetected: function(data) {
        // Handle address detection confirmation request
        console.log('Address detected:', data);
        
        // Display the confirmation message with styling
        const confirmationHtml = `
            <div class="address-confirmation" style="
                background: #ffe066; 
                color: #333; 
                padding: 10px; 
                margin: 5px 0; 
                border-radius: 4px;
                border-left: 4px solid #f0ad4e;
            ">
                <strong>🔍 ADDRESS DETECTED</strong><br>
                <strong>Type:</strong> ${data.type}<br>
                <strong>Address:</strong> <code style="word-break: break-all; font-size: 11px;">${data.address}</code><br><br>
                <strong style="color: #d9534f;">⚠️ WARNING: Verify this is YOUR address!</strong><br>
                <strong style="color: #d9534f;">⚠️ Clipboard viruses can change addresses!</strong><br><br>
                Type <strong>"confirm"</strong> to set as payout address or <strong>"cancel"</strong> to reject.
            </div>
        `;
        
        $('#messages').append($(confirmationHtml));
        UI.scrollChat();
        
        // Focus chat input for easy confirmation
        setTimeout(() => {
            $('#chatInput').focus();
        }, 100);
    },

    onAddressConfirmed: function(data) {
        // Handle successful address confirmation
        console.log('Address confirmed:', data);
        
        const confirmationHtml = `
            <div class="address-confirmed" style="
                background: #d4edda; 
                color: #155724; 
                padding: 10px; 
                margin: 5px 0; 
                border-radius: 4px;
                border-left: 4px solid #28a745;
            ">
                <strong>✅ PAYOUT ADDRESS CONFIRMED</strong><br>
                <strong>Type:</strong> ${data.type}<br>
                <strong>Address:</strong> <code style="word-break: break-all; font-size: 11px;">${data.address}</code><br><br>
                Future winnings will be sent to this address.
            </div>
        `;
        
        $('#messages').append($(confirmationHtml));
        UI.scrollChat();
    }
};

// Ensure SocketHandlers is available globally
if (typeof window !== 'undefined') {
    window.SocketHandlers = SocketHandlers;
}

// Note: SocketHandlers.init() is called from index.html after DOM ready
// to ensure proper initialization order with other modules
