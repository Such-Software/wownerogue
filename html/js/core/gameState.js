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
    _lighting: {},
    _torches: [],

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
        this._lighting = {};
        this._torches = [];
        this._depth = 1;
        this._maxDepth = 1;
        
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
        return this._player;
    },

    initializeMap: function(mapData, initialVisibleTiles, screenWidth, screenHeight) {
        this._map = {};
        this._visibleTiles = {};
        this._exploredTiles = this._exploredTiles || {};

        let mapInitialized = false;

        // Map source precedence: mapData.tiles, then array mapData, then initialVisibleTiles.
        if (mapData && mapData.tiles && typeof mapData.tiles === 'object' && Object.keys(mapData.tiles).length > 0) {
            for (var yKey in mapData.tiles) {
                const y = parseInt(yKey);
                this._map[y] = {};
                for (var xKey in mapData.tiles[y]) {
                    const x = parseInt(xKey);
                    this._map[y][x] = mapData.tiles[y][x];
                }
            }
            mapInitialized = true;
        }
        else if (mapData && Array.isArray(mapData) && mapData.length > 0) {
            for (let y = 0; y < mapData.length; y++) {
                this._map[y] = {};
                if (mapData[y] && Array.isArray(mapData[y])) {
                    for (let x = 0; x < mapData[y].length; x++) {
                        this._map[y][x] = mapData[y][x];
                    }
                }
            }
            mapInitialized = true;
        }
        else if (initialVisibleTiles && typeof initialVisibleTiles === 'object' && Object.keys(initialVisibleTiles).length > 0) {
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
        }

        // Fallback: a bordered empty room so the client still renders without server map data.
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
        }

        return mapInitialized;
    },

    validatePlayerPosition: function(screenWidth, screenHeight) {
        if (!this._map[this._player.y] || this._map[this._player.y][this._player.x] === undefined) {
            console.error(`Player position (${this._player.x}, ${this._player.y}) is invalid or outside map boundaries. Attempting to find fallback.`);
            let foundFallback = false;
            for (let y_scan = 0; y_scan < screenHeight; y_scan++) {
                if (this._map[y_scan]) {
                    for (let x_scan = 0; x_scan < screenWidth; x_scan++) {
                        const tile = this._map[y_scan][x_scan];
                        // Floor is encoded either as 0 or as the tile ids "'1" / "'2".
                        if (tile === 0 || tile === "'1" || tile === "'2") {
                            this._player.x = x_scan;
                            this._player.y = y_scan;
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
        // The callback reports transparency: true for tiles that pass light, false for blockers.
        var fov = new ROT.FOV.PreciseShadowcasting(function(x, y) {
            if (!this._map[y] || this._map[y][x] === undefined) {
                return false; // Unknown tiles block light
            }
            const tile = this._map[y][x];
            // Floor is encoded either as 0 or as the tile ids "'1" / "'2".
            return tile === 0 || tile === "'1" || tile === "'2";
        }.bind(this));

        // A map built from initialVisibleTiles already carries visibility; only compute otherwise.
        if (!this._visibleTiles || Object.keys(this._visibleTiles).length === 0) {
            this._visibleTiles = {};
            fov.compute(this._player.x, this._player.y, 10, function(x, y, r, visibility) {
                if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
                if (this._map[y] && this._map[y][x] !== undefined) {
                    this._visibleTiles[y][x] = this._map[y][x];
                }
            }.bind(this));
        }

        // Explored tiles accumulate on player movement, so the initial FOV pass does not call
        // updateExploredTiles().
    },

    updateExploredTiles: function() {
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

            // A new depth is a new level: the accumulated map, explored and visible tiles belong to
            // the previous level and are cleared, otherwise its walls ghost through the fresh one.
            if (typeof data.depth === 'number' && data.depth !== this._depth) {
                this._depth = data.depth;
                if (typeof data.maxDepth === 'number') this._maxDepth = data.maxDepth;
                this._map = {};
                this._visibleTiles = {};
                this._exploredTiles = {};
                needsRedraw = true;
            }

            if (data.player) {
                this._player = data.player;
                needsRedraw = true;
            }
            
            if (data.monster !== undefined) {
                this._monster = data.monster;
                needsRedraw = true;
            }
            
            if (data.items !== undefined) {
                this._items = data.items;
                needsRedraw = true;
            }
            
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

            if (data.lighting !== undefined) {
                this._lighting = data.lighting;
                needsRedraw = true;
            }
            if (data.torches !== undefined) {
                this._torches = data.torches;
                needsRedraw = true;
            }

            // Visible tiles drive movement feedback, so they also refresh the explored set.
            if (data.visibleTiles && typeof data.visibleTiles === 'object' && Object.keys(data.visibleTiles).length > 0) {
                this._visibleTiles = data.visibleTiles;

                if (this._visibleTiles[18] && (this._visibleTiles[18][36] !== undefined || this._visibleTiles[18][35] !== undefined)) {
                    const clientDebug = `🔍 CLIENT y=18: x=35: ${this._visibleTiles[18][35]}, x=36: ${this._visibleTiles[18][36]}`;
                    if (window.GameDebug) window.GameDebug.updateDebugDisplay(clientDebug);
                }
                if (this._visibleTiles[16] && (this._visibleTiles[16][36] !== undefined || this._visibleTiles[16][35] !== undefined)) {
                    const clientDebug = `🔍 CLIENT y=16: x=35: ${this._visibleTiles[16][35]}, x=36: ${this._visibleTiles[16][36]}`;
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
        
        if (newX < 0 || newY < 0 || newX >= screenWidth || newY >= screenHeight) {
            console.warn("Attempted to move player outside of bounds:", newX, newY);
            return;
        }

        // Tile value 1 is wall; undefined is off-map. Both block movement.
        if (this._map[newY] && this._map[newY][newX] !== undefined && this._map[newY][newX] !== 1) {
            this._player.x = newX;
            this._player.y = newY;
            this.updateExploredTiles();
            return true;
        } else {
            return false;
        }
    },

    // Debug helpers: console output here is intentional.
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
            const char = (val === 1) ? '#' : "\'";
            const debugMsg = `Test mapping: value=${val} -> char='${char}'`;
            console.log(debugMsg);
            if (window.GameDebug) window.GameDebug.updateDebugDisplay(debugMsg);
        }
    },

    // Local FOV, used only when running without a server; in normal play the server owns FOV.
    // This definition shadows the earlier computeFieldOfView on the same object literal.
    computeFieldOfView: function() {
        if (!this._player) {
            console.warn("Cannot compute FOV: player not initialized");
            return;
        }

        const oldVisibleTiles = JSON.parse(JSON.stringify(this._visibleTiles));
        this._visibleTiles = {};

        const fov = new ROT.FOV.PreciseShadowcasting(function(x, y) {
            const tile = this._map[y] && this._map[y][x];
            // Floor is encoded either as 0 or as the tile ids "'1" / "'2".
            return tile === 0 || tile === "'1" || tile === "'2";
        }.bind(this));

        fov.compute(this._player.x, this._player.y, 6, function(x, y, r, visibility) {
            if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
            this._visibleTiles[y][x] = this._map[y] && this._map[y][x] !== undefined ? this._map[y][x] : 0;

            if (!this._exploredTiles[y]) this._exploredTiles[y] = {};
            this._exploredTiles[y][x] = this._map[y] && this._map[y][x] !== undefined ? this._map[y][x] : 0;
        }.bind(this));
    },

    // Snapshot consumed by the render kit and the legacy render engine.
    getGameStateForRender: function() {
        const renderState = {
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
            gameActive: this._gameActive,
            lighting: this._lighting,
            torches: this._torches
        };
        
        return renderState;
    },

    // This definition shadows the earlier movePlayer on the same object literal.
    movePlayer: function(dx, dy, screenWidth, screenHeight) {
        if (!this._player) {
            console.warn("Cannot move player: player not initialized");
            return false;
        }

        const newX = this._player.x + dx;
        const newY = this._player.y + dy;

        if (newX < 0 || newX >= screenWidth || newY < 0 || newY >= screenHeight) {
            return false;
        }

        // Tile value 1 is wall and blocks movement.
        if (this._map[newY] && this._map[newY][newX] === 1) {
            return false;
        }

        this._player.x = newX;
        this._player.y = newY;
        return true;
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.GameState = GameState;
}
