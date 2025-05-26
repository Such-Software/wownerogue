/**
 * Socket event handlers for the Wowngeon game
 */
const SocketHandlers = {
    _initialized: false, // Flag to prevent multiple initializations
    
    init: function() {
        if (this._initialized) {
            console.warn("SocketHandlers.init() called multiple times - ignoring duplicate call");
            return;
        }
        
        if (!window.socket) {
            console.error("Socket not available!");
            return;
        }

        console.log("SocketHandlers: Initializing for the first time...");
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
        
        // Block height handler (broadcast to all clients)
        socket.on('blockheight', this.onBlockHeight);
    },

    onConnect: function() {
        console.log("Connected with socket ID:", socket.id);
        
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
        console.log("📨 STATUS UPDATE received:", data);
        
        // Display status message with appropriate styling
        const statusClass = data.type === 'error' ? 'error' : 'status';
        $('#messages').append($(`<li class="${statusClass}">`).text(data.message));
        UI.scrollChat();
    },

    onChatBroadcast: function(data) {
        // Handle chat messages broadcast to all players
        console.log("💬 CHAT BROADCAST received:", data);
        
        const timestamp = new Date(data.timestamp || Date.now()).toLocaleTimeString();
        const chatMsg = `[${timestamp}] ${data.username || 'Anonymous'}: ${data.message}`;
        
        $('#messages').append($('<li class="chat">').text(chatMsg));
        UI.scrollChat();
    },

    onWaitingStatus: function(data) {
        console.log("🕒 WAITING STATUS received:", data);
        
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
        console.log("🎮 Game start received with data:", data);
        console.log("🔍 DETAILED DATA CHECK:");
        console.log("  - Player:", data?.player);
        console.log("  - Map keys:", data?.map ? Object.keys(data.map).length : "NO MAP");
        console.log("  - Monster:", data?.monster);
        console.log("  - Items:", data?.items);
        console.log("  - VisibleTiles keys:", data?.visibleTiles ? Object.keys(data.visibleTiles).length : "NO VISIBLE TILES");
        
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
            // Use the original game.js structure
            var success = Game.startGame(data.player, data.map, data.monster, data.items, data.visibleTiles);
            console.log("Game start result:", success ? "SUCCESS" : "FAILED");
            
            if (!success) {
                $('#messages').append($('<li class="error">').text("Game start failed. Check console for details."));
                console.log("❌ GAME START FAILED - reverting to welcome screen");
                if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) Game._drawWelcomeScreen(); 
            } else {
                // Draw the initial game screen - the game draws itself after startGame()
                console.log("Game started successfully, initial screen should be drawn");
                
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
        // Debug log to see what data we're receiving
        if (data.visibleTiles) {
            const debugMsg = "🔍 SOCKET: Received game update with visibleTiles";
            console.log(debugMsg);
            if (window.GameDebug) window.GameDebug.updateDebugDisplay(debugMsg);
            
            // Check for specific coordinates that are problematic
            if (data.visibleTiles[18] && (data.visibleTiles[18][36] !== undefined || data.visibleTiles[18][35] !== undefined)) {
                const coordDebug = `🔍 SOCKET y=18: x=35: ${data.visibleTiles[18][35]}, x=36: ${data.visibleTiles[18][36]}`;
                console.log(coordDebug);
                if (window.GameDebug) window.GameDebug.updateDebugDisplay(coordDebug);
            }
            if (data.visibleTiles[16] && (data.visibleTiles[16][36] !== undefined || data.visibleTiles[16][35] !== undefined)) {
                const coordDebug = `🔍 SOCKET y=16: x=35: ${data.visibleTiles[16][35]}, x=36: ${data.visibleTiles[16][36]}`;
                console.log(coordDebug);
                if (window.GameDebug) window.GameDebug.updateDebugDisplay(coordDebug);
            }
        }
        
        if (typeof Game !== 'undefined' && Game._gameActive) {
            Game.updateGameState(data);
        }
    },

    onGameOver: function(data) {
        console.log("🎮 GAME OVER received:", data);
        
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
            console.log("⏰ Setting 30-second timer to return to title screen...");
            setTimeout(() => {
                console.log("⏰ 30 seconds elapsed - returning to title screen");
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
        console.log("Queue cancelled, returning to welcome screen");
        
        if (typeof Game !== 'undefined' && Game._drawWelcomeScreen) {
            Game._drawWelcomeScreen();
        } else {
            console.error("Game or _drawWelcomeScreen not available");
        }
    },

    onBlockHeight: function(height) {
        console.log(`📈 BLOCK HEIGHT: ${height}`);
        UI.updateBlockHeight(height);
        $('#statusValue').text('Connected');
        $('#statusValue').css('color', '#0f0');
    }
};

// Ensure SocketHandlers is available globally
if (typeof window !== 'undefined') {
    window.SocketHandlers = SocketHandlers;
}

// Note: SocketHandlers.init() is called from index.html after DOM ready
// to ensure proper initialization order with other modules
