// GameState - Handles game state management and updates
var GameState = {
    _player: null,
    _monster: null,
    _map: {},
    _items: {},
    _gameActive: false,
    _visibleTiles: {},
    _exploredTiles: {},
    _entrance: null,
    _exit: null,
    _treasure: null,
    _message: null,
    _scheduler: null,
    _engine: null,

    init: function() {
        this.reset();
    },

    reset: function() {
        this._player = null;
        this._monster = null;
        this._map = {};
        this._items = {};
        this._gameActive = false;
        this._visibleTiles = {};
        this._exploredTiles = {};
        this._entrance = null;
        this._exit = null;
        this._treasure = null;
        this._message = null;
        
        if (this._scheduler) this._scheduler.clear();
        if (!this._scheduler) this._scheduler = new ROT.Scheduler.Simple();
        if (!this._engine) this._engine = new ROT.Engine(this._scheduler);
    },

    setGameActive: function(active) {
        this._gameActive = active;
    },

    isGameActive: function() {
        return this._gameActive;
    },

    initializePlayer: function(playerData) {
        if (playerData && typeof playerData.x === 'number' && typeof playerData.y === 'number') {
            this._player = { x: playerData.x, y: playerData.y };
        } else {
            console.warn("Invalid or missing playerData.x/y, using default player position.", playerData);
            this._player = { x: 12, y: 12 }; // Default position
        }
        // console.log("Player initialized to:", this._player);
        return this._player;
    },

    initializeMap: function(mapData, initialVisibleTiles, screenWidth, screenHeight) {
        this._map = {};
        this._visibleTiles = {};
        this._exploredTiles = this._exploredTiles || {};

        let mapInitialized = false;

        // Try to initialize from mapData.tiles
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
        } 
        // Try array-based mapData
        else if (mapData && Array.isArray(mapData) && mapData.length > 0) {
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
        } 
        // Try initialVisibleTiles
        else if (initialVisibleTiles && typeof initialVisibleTiles === 'object' && Object.keys(initialVisibleTiles).length > 0) {
            console.log("Initializing _visibleTiles from server-sent initialVisibleTiles and inferring _map for FOV.");
            this._visibleTiles = JSON.parse(JSON.stringify(initialVisibleTiles)); // Deep copy

            for (const yKey in this._visibleTiles) {
                const y = parseInt(yKey);
                this._map[y] = this._map[y] || {};
                for (const xKey in this._visibleTiles[y]) {
                    const x = parseInt(xKey);
                    this._map[y][x] = this._visibleTiles[y][x];
                }
            }
            mapInitialized = true;
            console.log("Game map partially initialized for FOV from initialVisibleTiles:", this._map);
            console.log("_visibleTiles set directly from initialVisibleTiles:", this._visibleTiles);
        }

        // Create default map if nothing worked
        if (!mapInitialized) {
            console.warn("No valid mapData or initialVisibleTiles provided. Creating default map for testing.");
            const defaultMapWidth = screenWidth;
            const defaultMapHeight = screenHeight;
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
                if (this._map[this._player.y][this._player.x] === 1) {
                    this._map[this._player.y][this._player.x] = 0; // Force floor
                }
            }
            console.log("Default game map created. Player position:", this._player.x, this._player.y);
        }

        return mapInitialized;
    },

    validatePlayerPosition: function(screenWidth, screenHeight) {
        // Validate player position against the map
        if (!this._map[this._player.y] || this._map[this._player.y][this._player.x] === undefined) {
            console.error(`Player position (${this._player.x}, ${this._player.y}) is invalid or outside map boundaries. Attempting to find fallback.`);
            let foundFallback = false;
            for (let y_scan = 0; y_scan < screenHeight; y_scan++) {
                if (this._map[y_scan]) {
                    for (let x_scan = 0; x_scan < screenWidth; x_scan++) {
                        const tile = this._map[y_scan][x_scan];
                        // Check for both legacy (0) and new ("'1", "'2") floor tiles
                        if (tile === 0 || tile === "'1" || tile === "'2") {
                            this._player.x = x_scan;
                            this._player.y = y_scan;
                            console.warn(`Player moved to fallback position: (${this._player.x}, ${this._player.y})`);
                            foundFallback = true; 
                            break;
                        }
                    }
                }
                if (foundFallback) break;
            }
            if (!foundFallback) {
                console.error("Could not find a valid fallback starting position for the player on the map.");
                return false;
            }
        }
        return true;
    },

    computeFieldOfView: function() {
        // Initialize FOV with corrected wall detection callback
        var fov = new ROT.FOV.PreciseShadowcasting(function(x, y) {
            // Return true if the tile is transparent (walkable), false if it blocks light
            if (!this._map[y] || this._map[y][x] === undefined) {
                return false; // Unknown tiles block light
            }
            const tile = this._map[y][x];
            // Check for both legacy (0) and new ("'1", "'2") floor tiles
            return tile === 0 || tile === "'1" || tile === "'2";
        }.bind(this));

        // If map was NOT built from initialVisibleTiles, compute FOV now
        if (!this._visibleTiles || Object.keys(this._visibleTiles).length === 0) {
            this._visibleTiles = {};
            fov.compute(this._player.x, this._player.y, 10, function(x, y, r, visibility) {
                if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
                if (this._map[y] && this._map[y][x] !== undefined) {
                    this._visibleTiles[y][x] = this._map[y][x];
                }
            }.bind(this));
        }
        
        // NOTE: Don't call updateExploredTiles() here on initial game load
        // Explored tiles should only be updated when player moves, not on first FOV computation
        console.log("Initial FOV computed/processed. Visible tiles count:", Object.keys(this._visibleTiles).reduce((acc, yKey) => acc + Object.keys(this._visibleTiles[yKey]).length, 0));
    },

    updateExploredTiles: function() {
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

    updateGameState: function(data) {
        console.log("🎲 GameState.updateGameState received data:", data);
        
        if (!this._gameActive) {
            console.warn("GameState.updateGameState called, but game is not active. Ignoring update.");
            return false;
        }
        if (!data) {
            console.error("GameState.updateGameState: No update data received!");
            return false;
        }
        
        try {
            let needsRedraw = false;

            // Update player state
            if (data.player) {
                this._player = data.player;
                needsRedraw = true;
            }
            
            // Update monster state
            if (data.monster !== undefined) {
                this._monster = data.monster;
                needsRedraw = true;
            }
            
            // Update items
            if (data.items !== undefined) {
                this._items = data.items;
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
                
                // Debug log for specific problematic coordinates 
                if (this._visibleTiles[18] && (this._visibleTiles[18][36] !== undefined || this._visibleTiles[18][35] !== undefined)) {
                    const clientDebug = `🔍 CLIENT y=18: x=35: ${this._visibleTiles[18][35]}, x=36: ${this._visibleTiles[18][36]}`;
                    console.log(clientDebug);
                    if (window.GameDebug) window.GameDebug.updateDebugDisplay(clientDebug);
                }
                if (this._visibleTiles[16] && (this._visibleTiles[16][36] !== undefined || this._visibleTiles[16][35] !== undefined)) {
                    const clientDebug = `🔍 CLIENT y=16: x=35: ${this._visibleTiles[16][35]}, x=36: ${this._visibleTiles[16][36]}`;
                    console.log(clientDebug);
                    if (window.GameDebug) window.GameDebug.updateDebugDisplay(clientDebug);
                }
                
                this.updateExploredTiles();
                needsRedraw = true;
            }
            
            return needsRedraw;
        } catch (err) {
            console.error("Error in GameState.updateGameState:", err);
            return false;
        }
    },

    movePlayer: function(dx, dy, screenWidth, screenHeight) {
        if (!DisplayManager.ensureDisplay()) return;
        
        const newX = this._player.x + dx;
        const newY = this._player.y + dy;
        
        // Basic bounds checking
        if (newX < 0 || newY < 0 || newX >= screenWidth || newY >= screenHeight) {
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
            this.updateExploredTiles();
            return true;
        } else {
            console.log("Move blocked by wall or invalid map data at:", newX, newY);
            return false;
        }
    },

    getGameStateForRender: function() {
        return {
            player: this._player,
            monster: this._monster,
            items: this._items,
            entrance: this._entrance,
            exit: this._exit,
            treasure: this._treasure,
            visibleTiles: this._visibleTiles,
            exploredTiles: this._exploredTiles,
            message: this._message
        };
    },

    // Debug functions
    debugPrintMap: function(screenWidth, screenHeight) {
        console.log("Current game map:");
        for (let y = 0; y < screenHeight; y++) {
            let row = "";
            for (let x = 0; x < screenWidth; x++) {
                if (this._map[y] && this._map[y][x] !== undefined) {
                    row += this._map[y][x] + " ";
                } else {
                    row += "? "; // Unknown/undefined area
                }
            }
            console.log(row);
        }
    },

    debugTileMapping: function() {
        const testValues = [0, 1, undefined, null];
        for (const val of testValues) {
            const char = (val === 1) ? '#' : "'";
            const debugMsg = `Test mapping: value=${val} -> char='${char}'`;
            console.log(debugMsg);
            if (window.GameDebug) window.GameDebug.updateDebugDisplay(debugMsg);
        }
    },

    // Compute field of view for the player (LOCAL TESTING ONLY - server handles FOV)
    computeFieldOfView: function() {
        if (!this._player) {
            console.warn("Cannot compute FOV: player not initialized");
            return;
        }

        console.log("⚠️  LOCAL FOV COMPUTATION (should only be used for testing without server)");
        
        const oldVisibleTiles = JSON.parse(JSON.stringify(this._visibleTiles));
        this._visibleTiles = {};

        const fov = new ROT.FOV.PreciseShadowcasting(function(x, y) {
            const tile = this._map[y] && this._map[y][x];
            // Check for both legacy (0) and new ("'1", "'2") floor tiles
            return tile === 0 || tile === "'1" || tile === "'2";
        }.bind(this));

        fov.compute(this._player.x, this._player.y, 6, function(x, y, r, visibility) {
            if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
            this._visibleTiles[y][x] = this._map[y] && this._map[y][x] !== undefined ? this._map[y][x] : 0;
            
            // Mark as explored
            if (!this._exploredTiles[y]) this._exploredTiles[y] = {};
            this._exploredTiles[y][x] = this._map[y] && this._map[y][x] !== undefined ? this._map[y][x] : 0;
        }.bind(this));

        console.log("FOV computed for player at:", this._player.x, this._player.y);
        console.log("Visible tiles:", Object.keys(this._visibleTiles).length);
    },

    // Update game state with new data from server
    updateGameState: function(data) {
        let needsRedraw = false;

        if (data.player && (data.player.x !== this._player.x || data.player.y !== this._player.y)) {
            this._player = data.player;
            needsRedraw = true;
        }

        if (data.monster) {
            this._monster = data.monster;
            needsRedraw = true;
        }

        if (data.items) {
            this._items = data.items;
            needsRedraw = true;
        }

        if (data.map) {
            this._map = data.map;
            needsRedraw = true;
        }

        // Handle visibleTiles from server (this is the FOV data)
        if (data.visibleTiles) {
            this._visibleTiles = data.visibleTiles;
            
            // Update explored tiles with newly visible areas
            for (const yKey in this._visibleTiles) {
                const y = parseInt(yKey);
                if (!this._exploredTiles[y]) this._exploredTiles[y] = {};
                for (const xKey in this._visibleTiles[y]) {
                    const x = parseInt(xKey);
                    this._exploredTiles[y][x] = this._visibleTiles[y][x];
                }
            }
            
            // console.log("Updated visibleTiles from server, visible tile count:", 
            //     Object.keys(this._visibleTiles).reduce((count, y) => count + Object.keys(this._visibleTiles[y]).length, 0));
            needsRedraw = true;
        }

        if (data.entrance) {
            this._entrance = data.entrance;
            needsRedraw = true;
        }

        if (data.exit) {
            this._exit = data.exit;
            needsRedraw = true;
        }

        if (data.treasure !== undefined) {
            this._treasure = data.treasure;
            needsRedraw = true;
        }

        if (data.message) {
            this._message = data.message;
            needsRedraw = true;
        }

        return needsRedraw;
    },

    // Get game state data for rendering
    getGameStateForRender: function() {
        return {
            map: this._map,
            player: this._player,
            monster: this._monster,
            items: this._items,
            entrance: this._entrance,
            exit: this._exit,
            treasure: this._treasure,
            visibleTiles: this._visibleTiles,
            exploredTiles: this._exploredTiles,
            message: this._message,
            gameActive: this._gameActive
        };
    },

    // Move player and update game state
    movePlayer: function(dx, dy, screenWidth, screenHeight) {
        if (!this._player) {
            console.warn("Cannot move player: player not initialized");
            return false;
        }

        const newX = this._player.x + dx;
        const newY = this._player.y + dy;

        // Check bounds
        if (newX < 0 || newX >= screenWidth || newY < 0 || newY >= screenHeight) {
            // console.log("Player move blocked: out of bounds");
            return false;
        }

        // Check if the new position is passable
        if (this._map[newY] && this._map[newY][newX] === 1) {
            // console.log("Player move blocked: wall at", newX, newY);
            return false;
        }

        // Update player position
        this._player.x = newX;
        this._player.y = newY;

        // Recompute field of view
        this.computeFieldOfView();

        // console.log("Player moved to:", this._player.x, this._player.y);
        return true;
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.GameState = GameState;
}
