/**
 * GameState - Manages game state and data
 */
var GameState = {
    player: null,
    monster: null,
    entrance: null,
    exit: null,
    treasure: null,
    visibleTiles: {},
    exploredTiles: {},
    gameActive: false,
    map: {},
    items: {},

    init: function() {
        this.reset();
    },

    reset: function() {
        this.player = null;
        this.monster = null;
        this.entrance = null;
        this.exit = null;
        this.treasure = null;
        this.visibleTiles = {};
        this.exploredTiles = {};
        this.gameActive = false;
        this.map = {};
        this.items = {};
    },

    startGame: function(data) {
        console.log("Starting game with data:", data);
        
        if (!data) {
            console.error("No game data received!");
            return false;
        }
        
        try {
            this.gameActive = true;
            
            // Set player position
            this.player = data.player || { x: 12, y: 12 };
            this.monster = data.monster;
            this.entrance = data.entrance;
            this.exit = data.exit;
            this.treasure = data.treasure;
            
            // Set visible tiles
            if (data.visibleTiles && typeof data.visibleTiles === 'object') {
                this.visibleTiles = data.visibleTiles;
                console.log("Visible tiles:", Object.keys(this.visibleTiles).length, "rows");
            } else {
                // Create a basic visible area around player
                console.log("No visible tiles provided, creating basic view");
                this.visibleTiles = {};
                const px = this.player.x;
                const py = this.player.y;
                
                for (let y = py-2; y <= py+2; y++) {
                    if (!this.visibleTiles[y]) this.visibleTiles[y] = {};
                    for (let x = px-2; x <= px+2; x++) {
                        this.visibleTiles[y][x] = 0; // Floor tiles
                    }
                }
            }
            
            // Update explored tiles
            this.updateExploredTiles();
            
            return true;
        } catch (err) {
            console.error("Error starting game:", err);
            return false;
        }
    },

    updateGameState: function(data) {
        console.log("🎲 Updating game state with:", data);
        
        if (!data) {
            console.error("No update data received!");
            return;
        }
        
        try {
            // Update player position
            if (data.player) {
                console.log("Player position updated:", data.player);
                this.player = data.player;
            }
            
            // Update monster position
            if (data.monster !== undefined) {
                this.monster = data.monster;
            }
            
            // Update visible tiles
            if (data.visibleTiles && Object.keys(data.visibleTiles).length > 0) {
                console.log("Visible tiles updated:", Object.keys(data.visibleTiles).length, "rows");
                this.visibleTiles = data.visibleTiles;
                this.updateExploredTiles();
            }
            
            return true;
        } catch (err) {
            console.error("Error updating game state:", err);
            return false;
        }
    },

    updateExploredTiles: function() {
        // Add all currently visible tiles to explored tiles
        for (var y in this.visibleTiles) {
            if (!this.exploredTiles[y]) this.exploredTiles[y] = {};
            
            for (var x in this.visibleTiles[y]) {
                this.exploredTiles[y][x] = this.visibleTiles[y][x];
            }
        }
    },

    setGameActive: function(active) {
        this.gameActive = active;
    },

    isGameActive: function() {
        return this.gameActive;
    },

    getGameData: function() {
        return {
            player: this.player,
            monster: this.monster,
            entrance: this.entrance,
            exit: this.exit,
            treasure: this.treasure,
            visibleTiles: this.visibleTiles,
            exploredTiles: this.exploredTiles,
            gameActive: this.gameActive,
            map: this.map,
            items: this.items
        };
    }
};
