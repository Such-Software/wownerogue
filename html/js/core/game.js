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
    _awaitingPayment: false,
    _isSpectating: false, // True when viewing someone else's game
    _gameActive: false, // True when game is running (playing or spectating)

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

            // JUICE: kick off the FX overlay (ambient embers + flicker + particle loop).
            // Purely additive; all calls are no-ops if the FX overlay module is absent.
            this._fxStart();

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
        // JUICE: snapshot treasure/item count so we can detect a server-driven pickup below.
        const prevTreasureCount = (window.FX) ? this._fxTreasureCells().length : 0;

        const needsRedraw = GameState.updateGameState(data);

        // Redraw the game screen if any relevant data changed
        if (needsRedraw) {
            this._drawGameScreen();
        }

        // JUICE: react to server-driven changes (pickups, proximity) with FX.
        if (window.FX && needsRedraw) {
            try {
                const newTreasureCount = this._fxTreasureCells().length;
                if (newTreasureCount < prevTreasureCount) {
                    // A treasure/item vanished near us -> gold burst (pickup).
                    const pp = this._playerScreenPixel();
                    window.FX.burst(pp.x, pp.y, '#ffd700', 28);
                } else {
                    // Otherwise run proximity effects for server-authoritative moves.
                    this._fxOnPlayerMoved();
                }
            } catch (e) { /* FX is best-effort; never break gameplay */ }
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

            // JUICE: celebratory or fatal FX on the outcome. Loop keeps running so the
            // burst/shake actually renders; it is torn down on return-to-title (below).
            if (window.FX) {
                try {
                    const pp = this._playerScreenPixel();
                    const escaped = !!(data && data.reason === 'escaped');
                    if (escaped) {
                        // Win: gold burst + brief bright flash.
                        window.FX.burst(pp.x, pp.y, '#ffd700', 40);
                        window.FX.flash('rgba(255,215,0,1)', 0.35, 400);
                        if (data && data.treasure) {
                            window.FX.burst(pp.x, pp.y, '#fbbf24', 24);
                        }
                    } else {
                        // Loss (monster / timeout / other): shake + red flash.
                        window.FX.shake(12, 500);
                        window.FX.flash('rgba(255,0,0,1)', 0.4, 450);
                    }
                    // Gameplay is over: quiet the ambient torch embers.
                    if (window.FX.setAmbient) window.FX.setAmbient(false);
                } catch (e) { /* best-effort */ }
            }

            // After short delay, allow user to return to title with Enter/start
            const score = data && typeof data.score === 'number' ? data.score : 0;
            const treasure = !!(data && data.treasure);

            // Display score / treasure info overlay
            if (ScreenManager && ScreenManager.drawCenteredText && DisplayManager.ensureDisplay()) {
                const baseY = Math.floor(ScreenManager._screenHeight / 2) + 5;
                ScreenManager.drawCenteredText(baseY, `Score: ${score}`);
                if (treasure) {
                    ScreenManager.drawCenteredText(baseY + 1, 'Treasure secured!');
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
                    this._fxStop(); // JUICE: tear down FX loop so it never leaks
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
                        this._fxStop(); // JUICE: tear down FX loop so it never leaks
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
        const gameState = GameState.getGameStateForRender();
        // Render the dungeon through the render kit (Tiled / ASCII / Iso / 3D + unlocked packs) with
        // a player-centered camera + goblin monster sprite. The legacy RenderEngine remains a HARD
        // fallback (used only if the kit is unavailable or a render throws), so the game never blanks.
        var rk = false;
        if (window.RK && RK.SPGame && RK.SPGame.available()) {
            RK.SPGame.show();
            rk = RK.SPGame.render(gameState, {
                cryptoType: (window.ScreenManager && ScreenManager._cryptoType) || undefined,
                playerAppearance: (window.SinglePlayerAvatar && SinglePlayerAvatar.currentAppearance)
                    ? SinglePlayerAvatar.currentAppearance() : null,
                isSpectating: this._isSpectating
            });
        }
        if (!rk) {
            if (window.RK && RK.SPGame) RK.SPGame.hide();
            if (!this._ensureDisplay()) return;
            RenderEngine.drawGameScreen(gameState);
            if (window.FX) {
                try { this._fxSyncLighting(); } catch (e) { /* best-effort */ }
            }
        }
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
            display.draw(xStart - 2, y, '*', `rgba(120,200,255,${pulse})`, 'transparent');
        }
    },

    stopWaitingScreen: function() {
        this._awaitingPayment = false;
        this._unconfirmedPayment = false;
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
            // JUICE: sparkle near treasure, gold burst on pickup, red edge pulse near monsters.
            if (window.FX) {
                try { this._fxOnPlayerMoved(); } catch (e) { /* best-effort */ }
            }
        }
    },

    // ------------------------------------------------------------------
    // JUICE / FX helpers. These ONLY call the window.FX overlay API (GFX1);
    // they never define it. Every call is guarded so the game stays fully
    // functional when the FX module is absent (match.html / tavern.html).
    // Coordinates are computed with the SAME camera-centered mapping the
    // renderer uses (the player is always drawn at the screen center).
    // ------------------------------------------------------------------

    // The ROT.js display container is the base canvas FX layers above.
    _baseCanvas: function() {
        if (typeof DisplayManager === 'undefined' || !DisplayManager.getDisplay) return null;
        var display = DisplayManager.getDisplay();
        return (display && display.getContainer) ? display.getContainer() : null;
    },

    // Convert a world cell -> center pixel in base-canvas space.
    _cellToScreenPixel: function(wx, wy) {
        var cell = (window.options && window.options.tileWidth) ? window.options.tileWidth : 32;
        var centerX = Math.floor(this._screenWidth / 2);
        var centerY = Math.floor(this._screenHeight / 2);
        var player = (GameState && GameState._player) ? GameState._player : { x: wx, y: wy };
        var sx = wx - player.x + centerX;
        var sy = wy - player.y + centerY;
        return { x: sx * cell + cell / 2, y: sy * cell + cell / 2, cell: cell };
    },

    // The player is camera-centered, so this is always the center of the view.
    _playerScreenPixel: function() {
        var p = (GameState && GameState._player) ? GameState._player : { x: 0, y: 0 };
        return this._cellToScreenPixel(p.x, p.y);
    },

    // Chebyshev (king-move) distance — matches the grid feel.
    _fxDist: function(ax, ay, bx, by) {
        return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
    },

    // Collect every treasure/item world cell currently known.
    _fxTreasureCells: function() {
        var cells = [];
        if (typeof GameState === 'undefined') return cells;
        var t = GameState._treasure;
        if (t && typeof t[0] === 'number' && typeof t[1] === 'number') {
            cells.push({ x: t[0], y: t[1] });
        }
        var items = GameState._items;
        if (items) {
            for (var k in items) {
                if (items.hasOwnProperty(k)) {
                    var it = items[k];
                    if (it && typeof it.x === 'number' && typeof it.y === 'number') {
                        cells.push({ x: it.x, y: it.y });
                    }
                }
            }
        }
        return cells;
    },

    // Fire proximity/pickup FX for the player's current position.
    _fxOnPlayerMoved: function() {
        if (!window.FX) return;
        var player = (GameState && GameState._player) ? GameState._player : null;
        if (!player) return;

        var pp = this._playerScreenPixel();

        // Treasure proximity: on-cell => gold burst, nearby => sparkle.
        var cells = this._fxTreasureCells();
        var onTreasure = false, nearTreasure = false;
        for (var i = 0; i < cells.length; i++) {
            var d = this._fxDist(player.x, player.y, cells[i].x, cells[i].y);
            if (d === 0) onTreasure = true;
            else if (d <= 2) nearTreasure = true;
        }
        if (onTreasure && window.FX.burst) {
            window.FX.burst(pp.x, pp.y, '#ffd700', 24);
        } else if (nearTreasure && window.FX.sparkle) {
            window.FX.sparkle(pp.x, pp.y, '#fbbf24');
        }

        // NOTE: removed the monster-proximity red screen flash — it fired on nearly every step
        // (monster usually within 3 tiles) and read as a constant annoying pulse. The monster is
        // already visible on-screen, so proximity needs no full-screen flash. Reserve FX.flash for
        // genuine one-shot events (win/lose in handleGameOver).
    },

    // Attach + start the FX loop for a fresh game.
    _fxStart: function() {
        if (!window.FX) return;
        this._fxLastMonsterFlash = 0;
        try {
            var base = this._baseCanvas();
            if (base && window.FX.attach) window.FX.attach(base);
            if (window.FX.setAmbient) window.FX.setAmbient(true);
            if (window.FX.start) window.FX.start();
        } catch (e) { /* best-effort */ }
    },

    // Stop + clear the FX loop so requestAnimationFrame never leaks.
    _fxStop: function() {
        if (!window.FX) return;
        try {
            if (window.FX.setAmbient) window.FX.setAmbient(false);
            if (window.FX.stop) window.FX.stop();
            if (window.FX.clear) window.FX.clear();
        } catch (e) { /* best-effort */ }
    },

    // Keep the overlay aligned and feed it the camera-centered player position.
    _fxSyncLighting: function() {
        if (!window.FX) return;
        var base = this._baseCanvas();
        if (!base) return;
        if (window.FX.syncTo) window.FX.syncTo(base);
        if (window.FX.renderLighting && GameState && GameState._player) {
            var pp = this._playerScreenPixel();
            window.FX.renderLighting(pp.x, pp.y, pp.cell, { torches: GameState._torches || [] });
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
    this._awaitingPayment = false; // no longer just awaiting creation; we've seen a tx
};

Game._pendingPaymentConfirmed = function() {
    this._unconfirmedPayment = false;
    this._unconfirmedPaymentInfo = null;
    this._awaitingPayment = false;
};

Game._paymentRequested = function() {
    this._awaitingPayment = true;
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
