// Refactored Game Object - Main game controller using modular architecture
// This provides a mock socket when the real one isn't available
if (typeof window !== 'undefined' && !window.socket) {
    window.socket = {
        emit: function(event, data) {
            // Mock socket emit - removed debug logging
        }
    };
}

var Game = {
    _screenWidth: 25, // Default values, will be updated from options
    _screenHeight: 19,
    _inputEnabled: true,
    _messageLog: [],
    _maxLogMessages: 5,
    _unconfirmedPayment: false,
    _unconfirmedPaymentInfo: null,

    init: function() {
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

    startGame: function(playerData, mapData, monsterData, itemData, initialVisibleTiles, lightingData, torchData) {
        if (!this._ensureDisplay()) {
            console.error("Game: Cannot start game, display not ready.");
            return false;
        }

        DisplayManager.clearDisplay();
        
        // Force clear all display caches and artifacts
        if (typeof DisplayManager !== 'undefined' && DisplayManager.forceClearToBlack) {
            DisplayManager.forceClearToBlack();
        }
        
        // Stop the block simulation to prevent welcome screen from interfering
        if (typeof ScreenManager !== 'undefined' && ScreenManager.stopBlockSimulation) {
            ScreenManager.stopBlockSimulation();
        }
        
        try {
            GameState.setGameActive(true);

            // Clear any previous game state but preserve what we need for initialization
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

            // Initialize lighting and torch data
            if (lightingData) {
                GameState._lighting = lightingData;
            }
            if (torchData) {
                GameState._torches = torchData;
            }

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

            if (!GameState._map[GameState._player.y] || GameState._map[GameState._player.y][GameState._player.x] === undefined) {
                console.error(`Player position (${GameState._player.x}, ${GameState._player.y}) is STILL invalid before drawing. Map issue?`);
                ScreenManager.drawCenteredText(10, "Error: Player invalid for draw!");
                return false;
            }

            this._drawGameScreen();
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
            this._drawGameScreen();
        }
    },

    // Legacy alias (some handlers referenced updateGame previously)
    updateGame: function(data) {
        return this.updateGameState(data);
    },

    // Handle game over event from server
    endGame: function(data) {
        try {
            GameState.setGameActive(false);
            // Decide which screen to draw
            if (data && data.reason === 'monster') {
                if (ScreenManager.drawLoseScreen) ScreenManager.drawLoseScreen('monster');
            } else if (data && data.reason === 'escaped') {
                if (ScreenManager.drawWinScreen) ScreenManager.drawWinScreen(data.treasure || false);
            } else if (data && data.reason === 'timeout') {
                if (ScreenManager.drawLoseScreen) ScreenManager.drawLoseScreen('timeout');
            } else {
                if (ScreenManager.drawLoseScreen) ScreenManager.drawLoseScreen('other');
            }

            // After short delay, allow user to return to title with Enter/start
            const score = data && typeof data.score === 'number' ? data.score : 0;
            const treasure = !!(data && data.treasure);

            // Display score / treasure info overlay
            if (ScreenManager && ScreenManager.drawCenteredText && DisplayManager.ensureDisplay()) {
                const baseY = Math.floor(ScreenManager._screenHeight / 2) + 5;
                ScreenManager.drawCenteredText(baseY, `Score: ${score}`);
                if (treasure) {
                    ScreenManager.drawCenteredText(baseY + 1, 'You secured the treasure!');
                }
            }

            // Debounce + delayed activation of restart
            this._awaitingRestart = false;
            const activateDelay = 800; // ms before we accept Enter
            const autoReturnDelay = 10000; // auto return after 10s

            // Show hint after activation delay
            setTimeout(() => {
                this._awaitingRestart = true;
                if (ScreenManager && ScreenManager.drawCenteredText && DisplayManager.ensureDisplay()) {
                    const y = ScreenManager._screenHeight - 2;
                    const fullHint = 'Press Enter to return to title';
                    const shortHint = 'Press Enter';
                    const maxLen = ScreenManager._screenWidth - 2; // leave small margin
                    const hint = fullHint.length > maxLen ? shortHint : fullHint;
                    ScreenManager.drawCenteredText(y, hint);
                }
            }, activateDelay);

            // Auto return timer
            clearTimeout(this._autoReturnTimer);
            this._autoReturnTimer = setTimeout(() => {
                if (this._awaitingRestart) {
                    this._awaitingRestart = false;
                    if (ScreenManager && ScreenManager.drawWelcomeScreen) {
                        ScreenManager.drawWelcomeScreen();
                    }
                }
            }, autoReturnDelay);

            // One-time listener setup
            if (!this._restartListenerAttached) {
                this._restartListenerAttached = true;
                document.addEventListener('keydown', (e) => {
                    if (!this._awaitingRestart) return;
                    if (e.key === 'Enter') {
                        this._awaitingRestart = false;
                        clearTimeout(this._autoReturnTimer);
                        if (ScreenManager && ScreenManager.drawWelcomeScreen) {
                            ScreenManager.drawWelcomeScreen();
                        }
                        const chatInput = document.getElementById('chatInput');
                        if (chatInput) chatInput.focus();
                    }
                });
            }
        } catch (err) {
            console.error('Error handling endGame:', err);
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
        // Overlay unconfirmed payment badge if present
        if (this._unconfirmedPayment && typeof ScreenManager !== 'undefined' && DisplayManager.ensureDisplay()) {
            const display = DisplayManager.getDisplay();
            const badgeText = 'Unconfirmed (mempool)';
            const xStart = Math.max(1, Math.floor((this._screenWidth - badgeText.length) / 2));
            const y = 1; // top line inside border
            for (let i = 0; i < badgeText.length; i++) {
                display.draw(xStart + i, y, badgeText[i], 'rgba(180,230,255,0.9)', 'transparent');
            }
            // Small pulsing dot
            const pulse = 0.4 + Math.sin(Date.now()/300)*0.4;
            display.draw(xStart - 2, y, '●', `rgba(120,200,255,${pulse})`, 'transparent');
        }
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

// Payment state helpers
Game._pendingPaymentDetected = function(info) {
    this._unconfirmedPayment = true;
    this._unconfirmedPaymentInfo = info || {};
};

Game._pendingPaymentConfirmed = function() {
    this._unconfirmedPayment = false;
    this._unconfirmedPaymentInfo = null;
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
