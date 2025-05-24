// This provides a mock socket when the real one isn't available
if (typeof window !== 'undefined' && !window.socket) {
    window.socket = {
        emit: function(event, data) {
            console.log("[Mock Socket] Would emit:", event, data);
        }
    };
}

var Game = {
    _display: null,
    _screenWidth: options.width,
    _screenHeight: options.height,
    _displayReady: false, // Flag to indicate if _display is initialized
    _player: null,
    defaultFg: "#FFF", // Define defaultFg here
    // _defaultBg: null, // Standard for transparent/display default
    _monster: null,
    _map: {},
    _items: {},
    _gameInProgress: false,
    _inputEnabled: true,
    _messageLog: [],
    _maxLogMessages: 5,

    init: function() {
        console.log("Game.init called. 'this' is Game:", this === Game);
        console.log("Is this.checkTileset a function?", typeof this.checkTileset);


            var displayOptions = {
                width: this._screenWidth,
                height: this._screenHeight,
                forceSquareRatio: true, // Good for both modes generally
            };

                displayOptions.layout = "tile";
                displayOptions.bg = window.options.bg; // Should be "transparent"
                displayOptions.fg = window.options.fg || "#FFF"; // Default foreground for text not in tileMap
                displayOptions.tileWidth = window.options.tileWidth;
                displayOptions.tileHeight = window.options.tileHeight;
                displayOptions.tileSet = window.options.tileSet;
                displayOptions.tileMap = window.options.tileMap;
                displayOptions.tileColorize = false; // Render tiles as-is from the tileset

            try {
                var gameDisplayContainer = document.getElementById("game-display");
                if (!gameDisplayContainer) {
                    console.error("Game display container #game-display not found in HTML!");
                    alert("Error: Game display container #game-display not found. Cannot start game.");
                    return;
                }
                this._display = new ROT.Display(displayOptions);
                gameDisplayContainer.innerHTML = ''; // Clear any previous content (e.g., loading messages)
                gameDisplayContainer.appendChild(this._display.getContainer());
                console.log("ROT.Display initialized and appended. Display object:", this._display);
                this._displayReady = true; // Set flag AFTER successful initialization
                console.log("Game display initialized. _displayReady set to true.");

                // Now that the display is ready, other things can happen,
                // like drawing the welcome screen or enabling socket event handlers fully.
                this._drawWelcomeScreen(); // Example: draw initial screen

            } catch (e) {
                console.error("Error initializing ROT.Display:", e);
                alert("Failed to initialize game display. Error: " + e.message + ". Check console for details.");
                this._displayReady = false; // Explicitly false on error
            }
        }, // Removed .bind(this) - not needed for object literal methods
    

    _ensureDisplay: function() {
        if (!this._display || !this._displayReady) {
            console.warn("Display not ready or not initialized. Aborting drawing/game operation.");
            return false;
        }
        return true;
    },

    _forceClearToBlack: function() {
        if (!this._ensureDisplay()) {
            console.warn("Game._forceClearToBlack: Display not ready, aborting.");
            return;
        }
        // console.log("Game: _forceClearToBlack called at " + new Date().toLocaleTimeString());

        const display = this._display;

        // Step 1: Clear ROT.js's internal data cache and dirty flags.
        // This ensures that ROT.js starts with a clean slate for what it thinks is on screen.
        display._data = {};
        display._dirty = {};
        // console.log("Game._forceClearToBlack: Cleared display._data and display._dirty.");

        // Step 2: Directly clear the visual canvas to black.
        // This bypasses ROT.js's drawing for the initial clear, ensuring it's black.
        var canvas = display.getContainer(); // This is typically the <canvas> element
        if (canvas && typeof canvas.getContext === 'function') {
            var ctx = canvas.getContext("2d");
            if (ctx) {
                // console.log(`Game._forceClearToBlack: Clearing canvas (${canvas.width}x${canvas.height}) to black.`);
                ctx.fillStyle = "#000000";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            } else {
                console.warn("Game._forceClearToBlack: Failed to get 2D context from canvas.");
                this._fallbackClear(display);
            }
        } else {
            console.warn("Game._forceClearToBlack: Display container is not a canvas or does not exist. Attempting fallback clear.");
            this._fallbackClear(display);
        }
        // After this, the canvas is black. ROT.js's _data and _dirty are empty.
        // Subsequent display.draw() calls (e.g., in _drawWelcomeScreen) will populate
        // _data and _dirty for the specific cells they affect.
        // The ROT.js _draw() loop will then only process these newly dirtied cells,
        // for which _data will exist.
    },

    // Helper for fallback clear if direct canvas manipulation fails
    _fallbackClear: function(display) {
        console.warn("Game._forceClearToBlack: Using fallback clear method.");
        const originalBg = display.getOptions().bg; // Get current bg from display's options
        try {
            if (display._options) { // Ensure _options exists
                display._options.bg = "#000000"; // Set to black for the clear
            }
            display.clear(); // Use ROT.js's own clear method.
                             // This will use the (now black) _options.bg.
        } catch (e) {
            console.error("Error during fallback clear:", e);
        } finally {
            if (display._options) { // Ensure _options exists before restoring
                display._options.bg = originalBg; // Restore original background
            }
        }
    },

    // Add a helper for default colors to avoid errors if options.colors is not fully defined
    // _getColor: function(type, defaultColor) {
    // return (options.colors && options.colors[type]) ? options.colors[type] : defaultColor;
    // }, // REMOVED

    _isFirefox: function() {
        return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    },

    startGame: function(playerData, mapData, monsterData, itemData, initialVisibleTiles) { // Added initialVisibleTiles
        if (!this._ensureDisplay()) {
            console.error("Game: Cannot start game, display not ready.");
            return false;
        }
        console.log("Game: startGame called. PlayerData:", playerData, "MapData:", mapData, "InitialVisibleTiles:", initialVisibleTiles);

        this.clearDisplay();
        try {
            this._gameActive = true;

            // Robust player initialization
            if (playerData && typeof playerData.x === 'number' && typeof playerData.y === 'number') {
                this._player = { x: playerData.x, y: playerData.y };
            } else {
                console.warn("Invalid or missing playerData.x/y, using default player position.", playerData);
                this._player = { x: 12, y: 12 }; // Default position
            }
            console.log("Player initialized to:", this._player);

            this._monster = monsterData; // Assuming monsterData is structured correctly or null
            this._items = itemData;      // Fixed: Use _items instead of _item
            
            // Initialize entrance, exit, treasure from the game data
            this._entrance = null;
            this._exit = null;
            this._treasure = null;

            this._map = {};
            this._visibleTiles = {}; // Clear/initialize visible tiles
            this._exploredTiles = this._exploredTiles || {}; // Initialize exploredTiles if it doesn't exist, or keep existing

            let mapInitialized = false;

            if (mapData && mapData.tiles && typeof mapData.tiles === 'object' && Object.keys(mapData.tiles).length > 0) {
                console.log("Initializing map from mapData.tiles:", mapData.tiles);
                for (var yKey in mapData.tiles) {
                    const y = parseInt(yKey);
                    this._map[y] = {};
                    for (var xKey in mapData.tiles[y]) {
                        const x = parseInt(xKey);
                        this._map[y][x] = mapData.tiles[y][x];
                    }
                }
                mapInitialized = true;
                console.log("Game map initialized from mapData.tiles:", this._map);
            } else if (mapData && Array.isArray(mapData) && mapData.length > 0) {
                console.warn("Received array-based mapData, attempting to convert.");
                for (let y = 0; y < mapData.length; y++) {
                    this._map[y] = {};
                    if (mapData[y] && Array.isArray(mapData[y])) {
                        for (let x = 0; x < mapData[y].length; x++) {
                            this._map[y][x] = mapData[y][x];
                        }
                    }
                }
                mapInitialized = true;
                console.log("Game map initialized from array-based mapData:", this._map);
            } else if (initialVisibleTiles && typeof initialVisibleTiles === 'object' && Object.keys(initialVisibleTiles).length > 0) {
                console.log("Initializing _visibleTiles from server-sent initialVisibleTiles and inferring _map for FOV.");
                this._visibleTiles = JSON.parse(JSON.stringify(initialVisibleTiles)); // Deep copy

                for (const yKey in this._visibleTiles) {
                    const y = parseInt(yKey);
                    this._map[y] = this._map[y] || {};
                    for (const xKey in this._visibleTiles[y]) {
                        const x = parseInt(xKey);
                        // Store the tile type (0 for floor, 1 for wall, etc.) into _map
                        // This allows client-side FOV to know about passability.
                        this._map[y][x] = this._visibleTiles[y][x];
                    }
                }
                mapInitialized = true;
                console.log("Game map partially initialized for FOV from initialVisibleTiles:", this._map);
                console.log("_visibleTiles set directly from initialVisibleTiles:", this._visibleTiles);
            }

            if (!mapInitialized) {
                console.warn("No valid mapData or initialVisibleTiles provided. Creating default map for testing. mapData:", mapData, "initialVisibleTiles:", initialVisibleTiles);
                const defaultMapWidth = this._screenWidth;
                const defaultMapHeight = this._screenHeight;
                for (let y = 0; y < defaultMapHeight; y++) {
                    this._map[y] = {};
                    for (let x = 0; x < defaultMapWidth; x++) {
                        this._map[y][x] = (x === 0 || x === defaultMapWidth - 1 || y === 0 || y === defaultMapHeight - 1) ? 1 : 0;
                    }
                }
                // Adjust player position if it's in a wall of the default map
                if (this._map[this._player.y] && this._map[this._player.y][this._player.x] === 1) {
                     this._player.x = Math.floor(defaultMapWidth / 2);
                     this._player.y = Math.floor(defaultMapHeight / 2);
                     if (this._map[this._player.y][this._player.x] === 1) { // If center is still wall (tiny map)
                         this._map[this._player.y][this._player.x] = 0; // Force floor
                     }
                }
                console.log("Default game map created. Player position:", this._player.x, this._player.y);
            }

            // Validate player position against the map
            if (!this._map[this._player.y] || this._map[this._player.y][this._player.x] === undefined) {
                console.error(`Player position (${this._player.x}, ${this._player.y}) is invalid or outside map boundaries AFTER map init. Attempting to find fallback.`);
                let foundFallback = false;
                for (let y_scan = 0; y_scan < this._screenHeight; y_scan++) { // Iterate within screen bounds for fallback
                    if (this._map[y_scan]) {
                        for (let x_scan = 0; x_scan < this._screenWidth; x_scan++) {
                            if (this._map[y_scan][x_scan] === 0) { // Find first floor tile
                                this._player.x = x_scan;
                                this._player.y = y_scan;
                                console.warn(`Player moved to fallback position: (${this._player.x}, ${this._player.y})`);
                                foundFallback = true; break;
                            }
                        }
                    }
                    if (foundFallback) break;
                }
                if (!foundFallback) {
                    console.error("Could not find a valid fallback starting position for the player on the map.");
                    this._drawCenteredText(10, "Error: Map invalid / No player start!");
                    return false;
                }
            }

            // Initialize FOV
            // FOV requires a map where 0 is passable, other numbers are not.
            var fov = new ROT.FOV.PreciseShadowcasting(function(x, y) {
                return (this._map[y] && this._map[y][x] !== undefined) ? (this._map[y][x] === 0) : false;
            }.bind(this));

            // If map was NOT built from initialVisibleTiles, compute FOV now.
            // If it WAS built from initialVisibleTiles, _visibleTiles is already set.
            // However, we run _updateExploredTiles and FOV compute to ensure consistency and explore.
            if (!(initialVisibleTiles && typeof initialVisibleTiles === 'object' && Object.keys(initialVisibleTiles).length > 0)) {
                this._visibleTiles = {}; // Clear if not set by server
                fov.compute(this._player.x, this._player.y, 10, function(x, y, r, visibility) {
                    if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
                    if (this._map[y] && this._map[y][x] !== undefined) {
                        this._visibleTiles[y][x] = this._map[y][x];
                    }
                }.bind(this));
            }
            
            this._updateExploredTiles(); // Add all currently visible tiles to explored tiles
            console.log("Initial FOV computed/processed. Visible tiles count:", Object.keys(this._visibleTiles).reduce((acc, yKey) => acc + Object.keys(this._visibleTiles[yKey]).length, 0));

            if (!this._scheduler) this._scheduler = new ROT.Scheduler.Simple();
            else this._scheduler.clear();
            if (!this._engine) this._engine = new ROT.Engine(this._scheduler);

            this._scheduler.add(this._player, true);
            // this._engine.start(); // KEEP COMMENTED for now

            console.log("Player coordinates before drawing game screen:", this._player.x, this._player.y);
            if (!this._map[this._player.y] || this._map[this._player.y][this._player.x] === undefined) {
                console.error(`Player position (${this._player.x}, ${this._player.y}) is STILL invalid before drawing. Map issue?`);
                this._drawCenteredText(10, "Error: Player invalid for draw!");
                return false;
            }

            this._drawGameScreen();
            console.log("Game started successfully and initial screen drawn.");
            return true;

        } catch (err) {
            console.error("Error during Game.startGame:", err);
            console.error("Error name:", err.name, "Error message:", err.message, "Stack:", err.stack);
            if (err.message && (err.message.includes("_map") || err.message.includes("Cannot read properties of undefined"))) {
                console.error("Detailed error info: Player:", this._player, "Map keys:", Object.keys(this._map || {}).length);
            }
            try {
                this._drawCenteredText(10, "Error starting game!");
                this._drawCenteredText(12, "Check console (F12) for details.");
            } catch (drawError) {
                console.error("Failed to draw error message on screen:", drawError);
            }
            return false;
        }
    },
    
    // Update game state with new data from server
    updateGameState: function(data) {
        console.log("🎲 Game.updateGameState received data:", data);
        
        if (!this._gameActive) {
            console.warn("Game.updateGameState called, but game is not active. Ignoring update.");
            return;
        }
        if (!data) {
            console.error("Game.updateGameState: No update data received!");
            return;
        }
        
        try {
            let needsRedraw = false;

            // Update player state
            if (data.player) {
                // console.log("Player state updated:", data.player);
                this._player = data.player;
                needsRedraw = true;
            }
            
            // Update monster state
            if (data.monster !== undefined) { // Check for undefined to allow null for no monster
                // console.log("Monster state updated:", data.monster);
                this._monster = data.monster;
                needsRedraw = true;
            }
            
            // Update items
            if (data.items !== undefined) { // Check for undefined to allow empty or null
                // console.log("Items state updated:", data.items);
                this._items = data.items; // Ensure this is _items, not _item
                needsRedraw = true;
            }
            
            // Update entrance, exit, treasure
            if (data.entrance !== undefined) {
                this._entrance = data.entrance;
                needsRedraw = true;
            }
            if (data.exit !== undefined) {
                this._exit = data.exit;
                needsRedraw = true;
            }
            if (data.treasure !== undefined) {
                this._treasure = data.treasure;
                needsRedraw = true;
            }

            // Update visible tiles (most critical for movement feedback)
            if (data.visibleTiles && typeof data.visibleTiles === 'object' && Object.keys(data.visibleTiles).length > 0) {
                console.log("Visible tiles updated. Number of rows:", Object.keys(data.visibleTiles).length);
                this._visibleTiles = data.visibleTiles;
                this._updateExploredTiles(); // This is important for fog of war
                needsRedraw = true;
            } else if (data.visibleTiles) {
                // console.log("Received visibleTiles, but it was empty or not an object:", data.visibleTiles);
            }
            
            // Redraw the game screen if any relevant data changed
            if (needsRedraw) {
                console.log("Redrawing game screen due to game update.");
                this._drawGameScreen();
            } else {
                // console.log("Game.updateGameState: No relevant data changed that requires a redraw.");
            }
        } catch (err) {
            console.error("Error in Game.updateGameState:", err);
        }
    },
    
    _updateExploredTiles: function() {
        // Add all currently visible tiles to explored tiles
        for (var yKey in this._visibleTiles) {
            const y = parseInt(yKey);
            if (!this._exploredTiles[y]) this._exploredTiles[y] = {};
            for (var xKey in this._visibleTiles[y]) {
                const x = parseInt(xKey);
                this._exploredTiles[y][x] = this._visibleTiles[y][x];
            }
        }
    },
    
    clearDisplay: function() {
        if (!this._ensureDisplay()) return;
        this._forceClearToBlack();
        // console.log("Display cleared via _forceClearToBlack");
    },

    _drawGameScreen: function() {
        if (!this._ensureDisplay()) return;
        
        const playerWX = this._player.x;
        const playerWY = this._player.y;
        const centerX = Math.floor(this._screenWidth / 2);
        const centerY = Math.floor(this._screenHeight / 2);

        const topLeftWX = playerWX - centerX;
        const topLeftWY = playerWY - centerY;

        for (let sy = 0; sy < this._screenHeight; sy++) {
            for (let sx = 0; sx < this._screenWidth; sx++) {
                const wx = topLeftWX + sx;
                const wy = topLeftWY + sy;

                let charStack = [];
                let fgStack = []; 
                let bgStack = []; 

                let baseChar = ' ';
                let baseFg = this.defaultFg; // Use this.defaultFg
                let tileType;

                if (this._visibleTiles[wy] && this._visibleTiles[wy][wx] !== undefined) {
                    tileType = this._visibleTiles[wy][wx];
                    baseFg = this.defaultFg; // Use this.defaultFg
                    baseChar = (tileType === 1) ? '#' : "'"; // Fixed: Always use ' for floor
                } else if (this._exploredTiles[wy] && this._exploredTiles[wy][wx] !== undefined) {
                    tileType = this._exploredTiles[wy][wx];
                    baseFg = this.defaultFg; // Use this.defaultFg
                    baseChar = (tileType === 1) ? '#' : "'"; // Fixed: Always use ' for floor
                }
                charStack.push(baseChar);
                fgStack.push(baseFg); 
                bgStack.push(null);

                // Items, Monsters, Player drawing logic
                // Render items (fix property name from _item to _items)
                if (this._items) {
                    for (const itemKey in this._items) {
                        if (this._items.hasOwnProperty(itemKey)) {
                            const currentItem = this._items[itemKey];
                            if (currentItem && currentItem.x === wx && currentItem.y === wy && this._isVisible(wx, wy)) {
                                charStack.push('$');
                                fgStack.push(this.defaultFg);
                                bgStack.push(null);
                            }
                        }
                    }
                }
                
                // Render entrance
                if (this._entrance && this._entrance[0] === wx && this._entrance[1] === wy && this._isVisible(wx, wy)) {
                    charStack.push('<');
                    fgStack.push('#0f0'); // Green for entrance
                    bgStack.push(null);
                }
                
                // Render exit
                if (this._exit && this._exit[0] === wx && this._exit[1] === wy && this._isVisible(wx, wy)) {
                    charStack.push('>');
                    fgStack.push('#f0f'); // Magenta for exit
                    bgStack.push(null);
                }
                
                // Render treasure
                if (this._treasure && this._treasure[0] === wx && this._treasure[1] === wy && this._isVisible(wx, wy)) {
                    charStack.push('$');
                    fgStack.push('#ff0'); // Yellow for treasure
                    bgStack.push(null);
                }
                
                // Render monster
                if (this._monster && this._monster.x === wx && this._monster.y === wy && this._isVisible(wx, wy)) {
                    charStack.push('~'); 
                    fgStack.push('#f00'); // Red for monster
                    bgStack.push(null);
                }
                
                // Render player (always on top)
                if (wx === playerWX && wy === playerWY) {
                    charStack.push('@'); 
                    fgStack.push(this.defaultFg);
                    bgStack.push(null);
                }
                
                if (charStack.length > 0) {
                     this._display.draw(sx, sy, charStack, fgStack, bgStack);
                }
            }
        }

        if (this._message) {
            this._drawCenteredText(this._screenHeight - 1, this._message);
        }
    },

    _drawCenteredText: function(y, text, color) { // Restored color parameter
        if (!this._ensureDisplay()) return y;
        const x = Math.floor((this._screenWidth - text.length) / 2);
        const finalColor = color || this.defaultFg; // Use provided color or defaultFg
        this._display.drawText(x, y, `%c{${finalColor}}${text}`); // Use color in drawText
        return y + 1;
    },

    _isVisible: function(x, y) {
        return this._visibleTiles[y] && this._visibleTiles[y][x] !== undefined;
    },

    _drawBorder: function() { // NEW SIGNATURE
        if (!this._ensureDisplay()) return;
        // console.log("Drawing border. Tile mode: " + this._isTileMode);

        for (var i = 0; i < this._screenWidth; i++) {
            // this._display.draw(i, 0, "-", this._getColor("border_fg"), this._getColor("border_bg")); // OLD
            // this._display.draw(i, this._screenHeight - 1, "-", this._getColor("border_fg"), this._getColor("border_bg")); // OLD
            this._display.draw(i, 0, "-", this.defaultFg, null); // NEW
            this._display.draw(i, this._screenHeight - 1, "-", this.defaultFg, null); // NEW
        }
        for (var j = 1; j < this._screenHeight - 1; j++) {
            // this._display.draw(0, j, "|", this._getColor("border_fg"), this._getColor("border_bg")); // OLD
            // this._display.draw(this._screenWidth - 1, j, "|", this._getColor("border_fg"), this._getColor("border_bg")); // OLD
            this._display.draw(0, j, "|", this.defaultFg, null); // NEW
            this._display.draw(this._screenWidth - 1, j, "|", this.defaultFg, null); // NEW
        }
    },

    _drawWelcomeScreen: function() {
        if (!this._ensureDisplay()) return;
        this.clearDisplay();
        // console.log("Drawing welcome screen. Tile mode: " + this._isTileMode);

        let y = Math.floor(this._screenHeight / 4);
        y = this._drawCenteredText(y, "THE WOWNGEON", this.defaultFg); // Use this.defaultFg
        y = this._drawCenteredText(y + 2, "A Wownero Roguelike", this.defaultFg); // Use this.defaultFg
        
        // Original text regarding game start
        y = this._drawCenteredText(y + 3, "Type 'ENTER' in chat", this.defaultFg);
        y = this._drawCenteredText(y + 1, "to begin your descent...", this.defaultFg);
        this._drawCenteredText(y + 3, "Good luck, adventurer!", this.defaultFg);
    },

    drawWinScreen: function(hasTreasure) {
        if (!this._ensureDisplay()) return;
        this.clearDisplay();
        // console.log("Drawing win screen. Tile mode: " + this._isTileMode);

        let y = this._drawCenteredText(Math.floor(this._screenHeight / 3), "CONGRATULATIONS!");
        if (hasTreasure) {
            y = this._drawCenteredText(y + 2, "You escaped with the treasure!");
        } else {
            y = this._drawCenteredText(y + 2, "You escaped the dungeon!");
        }
        this._drawCenteredText(y + 3, "A true hero of Wownero!");
    },

    drawLoseScreen: function(reason) {
        if (!this._ensureDisplay()) return;
        this.clearDisplay();
        // console.log("Drawing lose screen. Tile mode: " + this._isTileMode);

        let y = this._drawCenteredText(Math.floor(this._screenHeight / 3), "YOU HAVE PERISHED");
        if (reason === 'monster') {
            y = this._drawCenteredText(y + 2, "Slain by a fearsome beast.");
        } else if (reason === 'timeout') {
            y = this._drawCenteredText(y + 2, "The dungeon claimed you before the next block.");
        } else {
            y = this._drawCenteredText(y + 2, "Your adventure ends here.");
        }
        this._drawCenteredText(y + 3, "Better luck next time.");
    },

    drawWaitingScreen: function() {
        if (!this._ensureDisplay()) return;
        this.clearDisplay(); // Clear it off
        // console.log("Drawing waiting screen");

        var text = "Waiting for server...";
        // Use _drawCenteredText for consistency and color handling
        this._drawCenteredText(Math.floor(this._screenHeight / 2), text, this.defaultFg);
    },

    // Method to stop the waiting animation
    stopWaitingScreen: function() {
        if (!this._ensureDisplay()) return;
        this.clearDisplay(); // Clear it off
        // console.log("Stopping waiting screen (clearing display)");
        // Typically, another screen (like game screen) will be drawn immediately after.
    },

    // Helper function to draw centered text
    _drawCenteredText: function(y, text, color) { // Restored color parameter
        if (!this._ensureDisplay()) return y;
        const x = Math.floor((this._screenWidth - text.length) / 2);
        const finalColor = color || this.defaultFg; // Use provided color or defaultFg
        this._display.drawText(x, y, `%c{${finalColor}}${text}`); // Use color in drawText
        return y + 1;
    },

    switchToAsciiMode: function() {
        console.log("Game.switchToAsciiMode called.");
        this._isTileMode = false;
        window.options.layout = "rect";

        if (this._display) {
            console.log("Display exists, attempting to re-initialize for ASCII mode.");
            var gameDisplayContainer = document.getElementById("game-display");
            if (gameDisplayContainer) gameDisplayContainer.innerHTML = '<p style="color:white;">Switching to ASCII mode, display will re-initialize...</p>';
            
            this._display = null;
            this._displayReady = false;
            this.init(); // Re-trigger initialization
        } else {
            console.log("Display does not exist yet, init() will handle ASCII mode based on _isTileMode flag.");
            this.init(); // This will now initialize in ASCII mode due to the flag
        }
    },

    switchToTileMode: function() {
        console.log("Game.switchToTileMode called.");
        this._isTileMode = true;
        window.options.layout = "tile";

        if (this._display) {
            console.log("Display exists, attempting to re-initialize for TILE mode.");
            var gameDisplayContainer = document.getElementById("game-display");
            if (gameDisplayContainer) gameDisplayContainer.innerHTML = '<p style="color:white;">Switching to TILE mode, display will re-initialize...</p>';
            
            this._display = null;
            this._displayReady = false;
            this.init(); // Re-trigger initialization
        } else {
            console.log("Display does not exist yet, init() will handle TILE mode based on _isTileMode flag.");
            this.init(); // This will now initialize in TILE mode due to the flag
        }
    },

    // New method to handle player movement
    movePlayer: function(dx, dy) {
        if (!this._ensureDisplay()) return;
        
        const newX = this._player.x + dx;
        const newY = this._player.y + dy;
        
        // Basic bounds checking
        if (newX < 0 || newY < 0 || newX >= this._screenWidth || newY >= this._screenHeight) {
            console.warn("Attempted to move player outside of bounds:", newX, newY);
            return;
        }
        
        // Check if the new position is a wall (1) or out of map bounds
        if (this._map[newY] && this._map[newY][newX] !== undefined && this._map[newY][newX] !== 1) {
            // Move the player
            this._player.x = newX;
            this._player.y = newY;
            console.log("Player moved to:", this._player.x, this._player.y);
            
            // Update visibility and redraw
            this._updateExploredTiles();
            this._drawGameScreen();
        } else {
            console.log("Move blocked by wall or invalid map data at:", newX, newY);
        }
    },

    // Debug function to print the map to console
    debugPrintMap: function() {
        console.log("Current game map:");
        for (let y = 0; y < this._screenHeight; y++) {
            let row = "";
            for (let x = 0; x < this._screenWidth; x++) {
                if (this._map[y] && this._map[y][x] !== undefined) {
                    row += this._map[y][x] + " ";
                } else {
                    row += "? "; // Unknown/undefined area
                }
            }
            console.log(row);
        }
    }
};

// Additional global or helper functions can be added here