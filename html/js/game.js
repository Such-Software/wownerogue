// Refactored Game Object - Main game controller using modular architecture
// This provides a mock socket when the real one isn't available
if (typeof window !== 'undefined' && !window.socket) {
    window.socket = {
        emit: function(event, data) {
            console.log("[Mock Socket] Would emit:", event, data);
        }
    };
}

var Game = {
    _screenWidth: 25, // Default values, will be updated from options
    _screenHeight: 19,
    _inputEnabled: true,
    _messageLog: [],
    _maxLogMessages: 5,

    init: function() {
        console.log("Game.init called - Modular version");
        
        // Update screen dimensions from options
        if (typeof options !== 'undefined') {
            this._screenWidth = options.width || 25;
            this._screenHeight = options.height || 19;
        }
        
        // Initialize all modules
        if (!DisplayManager.init(this._screenWidth, this._screenHeight)) {
            return false;
        }
        
        ScreenManager.init(this._screenWidth, this._screenHeight);
        RenderEngine.init(this._screenWidth, this._screenHeight);
        GameState.init();
        
        // Draw welcome screen
        ScreenManager.drawWelcomeScreen();
        
        return true;
    },

    _ensureDisplay: function() {
        return DisplayManager.ensureDisplay();
    },

    _isFirefox: function() {
        return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    },

    startGame: function(playerData, mapData, monsterData, itemData, initialVisibleTiles) {
        if (!this._ensureDisplay()) {
            console.error("Game: Cannot start game, display not ready.");
            return false;
        }
        console.log("Game: startGame called. PlayerData:", playerData, "MapData:", mapData, "InitialVisibleTiles:", initialVisibleTiles);

        DisplayManager.clearDisplay();
        
        // Force clear all display caches and artifacts
        if (typeof DisplayManager !== 'undefined' && DisplayManager.forceClearToBlack) {
            console.log("✅ Force clearing display to prevent artifacts...");
            DisplayManager.forceClearToBlack();
        }
        
        // Stop the block simulation to prevent welcome screen from interfering
        if (typeof ScreenManager !== 'undefined' && ScreenManager.stopBlockSimulation) {
            console.log("✅ Stopping block simulation...");
            ScreenManager.stopBlockSimulation();
        }
        
        try {
            GameState.setGameActive(true);

            // Clear any previous game state but preserve what we need for initialization
            console.log("✅ Clearing previous game state (but preserving server data)...");
            GameState._exploredTiles = {};
            // Don't clear _visibleTiles yet - let initializeMap handle it properly
            GameState._map = {};
            GameState._items = {};
            GameState._monster = null;
            GameState._entrance = null;
            GameState._exit = null;
            GameState._treasure = null;

            // Initialize player
            GameState.initializePlayer(playerData);

            // Initialize other game objects
            GameState._monster = monsterData;
            GameState._items = itemData;
            GameState._entrance = null;
            GameState._exit = null;
            GameState._treasure = null;

            // Initialize map and validate player position
            GameState.initializeMap(mapData, initialVisibleTiles, this._screenWidth, this._screenHeight);
            
            if (!GameState.validatePlayerPosition(this._screenWidth, this._screenHeight)) {
                ScreenManager.drawCenteredText(10, "Error: Map invalid / No player start!");
                return false;
            }

            // Compute field of view
            GameState.computeFieldOfView();

            // Setup scheduler and engine
            if (!GameState._scheduler) GameState._scheduler = new ROT.Scheduler.Simple();
            else GameState._scheduler.clear();
            if (!GameState._engine) GameState._engine = new ROT.Engine(GameState._scheduler);

            GameState._scheduler.add(GameState._player, true);

            console.log("Player coordinates before drawing game screen:", GameState._player.x, GameState._player.y);
            if (!GameState._map[GameState._player.y] || GameState._map[GameState._player.y][GameState._player.x] === undefined) {
                console.error(`Player position (${GameState._player.x}, ${GameState._player.y}) is STILL invalid before drawing. Map issue?`);
                ScreenManager.drawCenteredText(10, "Error: Player invalid for draw!");
                return false;
            }

            this._drawGameScreen();
            console.log("Game started successfully and initial screen drawn.");
            return true;

        } catch (err) {
            console.error("Error during Game.startGame:", err);
            console.error("Error name:", err.name, "Error message:", err.message, "Stack:", err.stack);
            if (err.message && (err.message.includes("_map") || err.message.includes("Cannot read properties of undefined"))) {
                console.error("Detailed error info: Player:", GameState._player, "Map keys:", Object.keys(GameState._map || {}).length);
            }
            try {
                ScreenManager.drawCenteredText(10, "Error starting game!");
                ScreenManager.drawCenteredText(12, "Check console (F12) for details.");
            } catch (drawError) {
                console.error("Failed to draw error message on screen:", drawError);
            }
            return false;
        }
    },
    
    // Update game state with new data from server
    updateGameState: function(data) {
        const needsRedraw = GameState.updateGameState(data);
        
        // Redraw the game screen if any relevant data changed
        if (needsRedraw) {
            console.log("Redrawing game screen due to game update.");
            this._drawGameScreen();
        }
    },

    clearDisplay: function() {
        DisplayManager.clearDisplay();
    },

    _drawGameScreen: function() {
        if (!this._ensureDisplay()) return;
        const gameState = GameState.getGameStateForRender();
        RenderEngine.drawGameScreen(gameState);
    },

    // Screen drawing methods - delegate to ScreenManager
    _drawWelcomeScreen: function() {
        ScreenManager.drawWelcomeScreen();
    },

    drawWinScreen: function(hasTreasure) {
        ScreenManager.drawWinScreen(hasTreasure);
    },

    drawLoseScreen: function(reason) {
        ScreenManager.drawLoseScreen(reason);
    },

    drawWaitingScreen: function() {
        ScreenManager.drawWaitingScreen();
    },

    stopWaitingScreen: function() {
        ScreenManager.stopWaitingScreen();
    },

    // Display mode switching - delegate to DisplayManager
    switchToAsciiMode: function() {
        DisplayManager.switchToAsciiMode();
    },

    switchToTileMode: function() {
        DisplayManager.switchToTileMode();
    },

    // Player movement - delegate to GameState
    movePlayer: function(dx, dy) {
        const moved = GameState.movePlayer(dx, dy, this._screenWidth, this._screenHeight);
        if (moved) {
            this._drawGameScreen();
        }
    },

    // Debug functions - delegate to GameState
    debugPrintMap: function() {
        GameState.debugPrintMap(this._screenWidth, this._screenHeight);
    },

    debugTileMapping: function() {
        GameState.debugTileMapping();
    },

    // Properties for backward compatibility
    get _gameActive() {
        return GameState.isGameActive();
    },

    set _gameActive(value) {
        GameState.setGameActive(value);
    },

    get _player() {
        return GameState._player;
    },

    get _monster() {
        return GameState._monster;
    },

    get _map() {
        return GameState._map;
    },

    get _items() {
        return GameState._items;
    },

    get _visibleTiles() {
        return GameState._visibleTiles;
    },

    get _exploredTiles() {
        return GameState._exploredTiles;
    }
};

// Debug utility functions (keep as-is for compatibility)
const GameDebug = {
    log: function(message) {
        console.log(message);
        this.updateDebugDisplay(message);
        this.sendToServer(message);
    },
    
    updateDebugDisplay: function(message) {
        const debugContent = document.getElementById('debug-content');
        if (debugContent) {
            const timestamp = new Date().toLocaleTimeString();
            debugContent.innerHTML += `<div>[${timestamp}] ${message}</div>`;
            // Keep only last 10 debug messages
            const lines = debugContent.children;
            if (lines.length > 10) {
                debugContent.removeChild(lines[0]);
            }
            // Auto-scroll to bottom
            const debugDisplay = document.getElementById('debug-display');
            debugDisplay.scrollTop = debugDisplay.scrollHeight;
        }
    },
    
    sendToServer: function(message) {
        try {
            fetch('/debug', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: message })
            }).catch(err => {
                // Silently fail if server unavailable
            });
        } catch (err) {
            // Silently fail
        }
    }
};

// Make them available globally
if (typeof window !== 'undefined') {
    window.Game = Game;
    window.GameDebug = GameDebug;
}
