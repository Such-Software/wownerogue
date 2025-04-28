// This provides a mock socket when the real one isn't available
if (typeof window !== 'undefined' && !window.socket) {
    window.socket = {
        emit: function(event, data) {
            console.log("[Mock Socket] Would emit:", event, data);
        }
    };
}

var Game = {
    // Change dimensions to match the display options (25 × 19 tiles)
    _screenWidth: 25,   // Used for drawing coordinates (columns)
    _screenHeight: 19,  // Used for drawing coordinates (rows)
    _mapWidth: 25,      // Logical map width (should match display)
    _mapHeight: 19,     // Logical map height (should match display)
    _display: null,
    _map: null,
    _player: null,
    _monster: null,
    _exit: null,
    _entrance: null,
    _treasure: null,
    _gameActive: false,
    _message: "", // To display messages like 'waiting'
    _visibleTiles: {}, // Store currently visible tiles
    _exploredTiles: {}, // Store all tiles the player has seen
    _isTileMode: false, // Track if we're in tile mode

    _isFirefox: function() {
        return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    },

    init: function() {
        console.log("Initializing game");
        
        // Verify if tileset is actually loaded
        this.checkTileset(function(isLoaded) {
            if (isLoaded) {
                Game._setupTileDisplay();
            } else {
                Game._setupAsciiDisplay();
            }
            
            // Draw the welcome screen
            Game._drawWelcomeScreen();
            
            // Set up the keyboard handler
            Game._initializeKeyboardHandler();
        });
    },

    // Initialize game with data from server
    startGame: function(data) {
        console.log("Starting game with data:", data);
        
        if (!data) {
            console.error("No game data received!");
            return false;
        }
        
        try {
            // Set game as active
            this._gameActive = true;
            
            // Set all game properties from data
            this._player = data.player || { x: 12, y: 12 };
            this._monster = data.monster;
            this._entrance = data.entrance;
            this._exit = data.exit;
            this._treasure = data.treasure;
            
            // Get visible tiles, ensuring they're valid
            if (data.visibleTiles && typeof data.visibleTiles === 'object') {
                // Store the visible tiles
                this._visibleTiles = data.visibleTiles;
                console.log("Visible tiles:", Object.keys(this._visibleTiles).length, "rows");
            } else {
                // If no tiles, create a basic visible area around player
                console.log("No visible tiles provided, creating basic view");
                this._visibleTiles = {};
                const px = this._player.x;
                const py = this._player.y;
                
                // Create a 5x5 visible area around player
                for (let y = py-2; y <= py+2; y++) {
                    if (!this._visibleTiles[y]) this._visibleTiles[y] = {};
                    for (let x = px-2; x <= px+2; x++) {
                        this._visibleTiles[y][x] = 0; // Floor tiles
                    }
                }
            }
            
            // Update explored tiles
            this._updateExploredTiles();
            
            // Clear and redraw the screen
            this.clearDisplay();
            
            console.log("Drawing game screen for active game");
            console.log("Player position:", this._player);
            
            // Draw the game with explicit console logging after each step
            this._drawGameScreen();
            
            return true;
        } catch (err) {
            console.error("Error starting game:", err);
            return false;
        }
    },
    
    // Update game state with new data from server
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
                this._player = data.player;
            }
            
            // Update monster position
            if (data.monster !== undefined) {
                this._monster = data.monster;
            }
            
            // Update visible tiles
            if (data.visibleTiles && Object.keys(data.visibleTiles).length > 0) {
                console.log("Visible tiles updated:", Object.keys(data.visibleTiles).length, "rows");
                this._visibleTiles = data.visibleTiles;
                this._updateExploredTiles();
            }
            
            // Redraw the game screen
            console.log("Redrawing game screen after update");
            this._drawGameScreen();
        } catch (err) {
            console.error("Error updating game state:", err);
        }
    },
    
    _updateExploredTiles: function() {
        // Add all currently visible tiles to explored tiles
        for (var y in this._visibleTiles) {
            if (!this._exploredTiles[y]) this._exploredTiles[y] = {};
            
            for (var x in this._visibleTiles[y]) {
                this._exploredTiles[y][x] = this._visibleTiles[y][x];
            }
        }
    },
    
    clearDisplay: function() {
        // Clear the entire display area
        this._display.clear();
    },

    _drawGameScreen: function() {
        console.log("Drawing game screen...");
        
        // Clear the display
        this.clearDisplay();
        
        // Calculate screen center for display
        const centerX = Math.floor(this._screenWidth / 2);
        const centerY = Math.floor(this._screenHeight / 2);
        
        console.log("Screen center:", centerX, centerY);
        
        // Draw visible tiles centered on player
        for (let relY in this._visibleTiles) {
            relY = parseInt(relY);
            for (let relX in this._visibleTiles[relY]) {
                relX = parseInt(relX);
                
                // Convert to screen coordinates (centered)
                const screenX = centerX + relX;
                const screenY = centerY + relY;
                
                // Only draw if on screen
                if (screenX >= 0 && screenY >= 0 && screenX < this._screenWidth && screenY < this._screenHeight) {
                    const tileType = this._visibleTiles[relY][relX];
                    
                    // Draw tile based on type
                    if (tileType === 1) { // Wall
                        this._display.draw(screenX, screenY, '#', '#fff', '#000');
                    } else { // Floor
                        const tileChar = this.isAsciiMode() ? '.' : '\'';
                        this._display.draw(screenX, screenY, tileChar, '#888', '#000');
                    }
                }
            }
        }
        
        // Draw special entities if they exist in game state
        
        // Check for entrance/exit at player position
        const playerIsAtEntrance = this._entrance && 
                                  this._entrance.x === 0 && 
                                  this._entrance.y === 0;
        
        const playerIsAtExit = this._exit && 
                              this._exit[0] === 0 && 
                              this._exit[1] === 0;
        
        // Draw entrance if it exists in the game state
        if (this._entrance) {
            // Handle different data formats - could be [x,y] array or {x,y} object
            const entranceX = Array.isArray(this._entrance) ? this._entrance[0] : this._entrance.x;
            const entranceY = Array.isArray(this._entrance) ? this._entrance[1] : this._entrance.y;
            const entranceScreenX = centerX + entranceX; 
            const entranceScreenY = centerY + entranceY;
            
            console.log("Entrance position:", entranceX, entranceY);
            console.log("Player relative position:", this._player.x, this._player.y);
            
            if (entranceScreenX >= 0 && entranceScreenY >= 0 && 
                entranceScreenX < this._screenWidth && entranceScreenY < this._screenHeight) {
                // Draw entrance with bright green color for visibility
                this._display.draw(entranceScreenX, entranceScreenY, '<', '#0f0', '#000');
                console.log(`Drew entrance at screen position (${entranceScreenX},${entranceScreenY})`);
            }
        }
        
        // Draw exit if it exists in the game state
        if (this._exit) {
            // Handle different data formats - could be [x,y] array or {x,y} object
            const exitX = Array.isArray(this._exit) ? this._exit[0] : this._exit.x;
            const exitY = Array.isArray(this._exit) ? this._exit[1] : this._exit.y;
            const exitScreenX = centerX + exitX;
            const exitScreenY = centerY + exitY;
            
            console.log("Exit position:", exitX, exitY);
            
            if (exitScreenX >= 0 && exitScreenY >= 0 && 
                exitScreenX < this._screenWidth && exitScreenY < this._screenHeight) {
                // Draw exit with bright green color for visibility
                this._display.draw(exitScreenX, exitScreenY, '>', '#0f0', '#000');
                console.log(`Drew exit at screen position (${exitScreenX},${exitScreenY})`);
            }
        }
        
        // Draw treasure if it exists in the game state
        if (this._treasure) {
            const treasureX = Array.isArray(this._treasure) ? this._treasure[0] : this._treasure.x;
            const treasureY = Array.isArray(this._treasure) ? this._treasure[1] : this._treasure.y;
            const treasureScreenX = centerX + treasureX;
            const treasureScreenY = centerY + treasureY;
            
            if (treasureScreenX >= 0 && treasureScreenY >= 0 && 
                treasureScreenX < this._screenWidth && treasureScreenY < this._screenHeight) {
                this._display.draw(treasureScreenX, treasureScreenY, '$', '#ff0', '#000');
                console.log(`Drew treasure at screen position (${treasureScreenX},${treasureScreenY})`);
            }
        }
        
        // Draw monster if it exists in the game state
        if (this._monster) {
            const monsterX = this._monster.x;
            const monsterY = this._monster.y;
            const monsterScreenX = centerX + monsterX;
            const monsterScreenY = centerY + monsterY;
            
            if (monsterScreenX >= 0 && monsterScreenY >= 0 && 
                monsterScreenX < this._screenWidth && monsterScreenY < this._screenHeight) {
                this._display.draw(monsterScreenX, monsterScreenY, '~', '#f00', '#000');
                console.log(`Drew monster at screen position (${monsterScreenX},${monsterScreenY})`);
            }
        }
        
        // Always draw player at center of screen
        // Special case: If player is at entrance/exit, add visual indicator
        if (playerIsAtEntrance) {
            console.log("Player is at entrance - drawing special indicator");
            this._display.draw(centerX, centerY, '@', '#0ff', '#000'); // Special color for player on entrance
        } else if (playerIsAtExit) {
            console.log("Player is at exit - drawing special indicator");
            this._display.draw(centerX, centerY, '@', '#0ff', '#000'); // Special color for player on exit
        } else {
            this._display.draw(centerX, centerY, '@', '#ff0', '#000'); // Normal player
        }
        
        console.log(`Drew player at center of screen (${centerX},${centerY})`);
    },
    
    _isVisible: function(x, y) {
        // Check if a tile is currently visible
        return this._visibleTiles[y] && this._visibleTiles[y][x] !== undefined;
    },

    // Add this helper method near other drawing functions
    _drawBorder: function(color) {
        const w = this._screenWidth;
        const h = this._screenHeight;
        
        // Use the stored mode state to determine character
        const borderChar = this._isTileMode ? "#" : "+";
        color = color || '#888'; // Default color is gray
        
        // Draw the border
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) {
                if (x === 0 || y === 0 || x === w-1 || y === h-1) {
                    this._display.draw(x, y, borderChar, color, '#000');
                }
            }
        }
    },

    // Add these functions right before the closing }; of the Game object

    // Win screen
    drawWinScreen: function(hasTreasure) {
        console.log("Drawing win screen, hasTreasure:", hasTreasure);
        
        // Clear the display
        this.clearDisplay();
        
        // Draw green border
        this._drawBorder('#0f0');
        
        // Draw win message
        let y = 5;
        y = this._drawCenteredText(y, "YOU ESCAPED!", "green");
        y += 1;
        
        const subtitle = hasTreasure ? "WITH THE TREASURE!" : "ALIVE!";
        y = this._drawCenteredText(y, subtitle, "yellow");
        y += 2;
        
        if (hasTreasure) {
            y = this._drawCenteredText(y, "You won extra Wownero!", "yellow");
            y += 1;
        }
        
        y += 1;
        this._drawCenteredText(y, "Type ENTER to retry", "white");
    },

    // Lose screen
    drawLoseScreen: function(reason) {
        console.log("Drawing lose screen, reason:", reason);
        
        // Clear the display
        this.clearDisplay();
        
        // Draw red border
        this._drawBorder('#f00');
        
        // Draw lose message
        let y = 5;
        y = this._drawCenteredText(y, "YOU DIED!", "red");
        y += 1;
        
        let subtitle = "";
        if (reason === 'monster') {
            subtitle = "KILLED BY THE MONSTER";
        } else if (reason === 'timeout') {
            subtitle = "YOU RAN OUT OF TIME";
        }
        
        if (subtitle) {
            y = this._drawCenteredText(y, subtitle, "red");
            y += 1;
        }
        
        y += 2;
        this._drawCenteredText(y, "Type ENTER to retry", "white");
    },

    // Public welcome screen method - add if missing
    drawWelcomeScreen: function() {
        this._drawWelcomeScreen();
    },

    _drawWelcomeScreen: function() {
        console.log("Drawing welcome screen");
        
        // Clear the display
        this.clearDisplay();
        
        // Draw the border with gray color
        this._drawBorder('#888');
        
        // Draw content with centered text
        let y = 3;
        y = this._drawCenteredText(y, "WOWGUE", "white");
        y += 4;
        
        // Draw instructions
        y = this._drawCenteredText(y, "Type enter to start!", "yellow");
        y = this._drawCenteredText(y, "Or type help...", "yellow");
        y += 2;
        
        // Draw legend - keep these special characters with tile mappings
        const centerX = Math.floor(this._screenWidth / 2) - 11; // Manual alignment for legend
        this._display.drawText(centerX, y, "%c{cyan}@ %c{white}- This is you");     y++;
        this._display.drawText(centerX, y, "%c{green}> %c{white}- Escape the dungeon"); y++;
        this._display.drawText(centerX, y, "%c{red}~ %c{white}- Avoid the monster");  y++;
        this._display.drawText(centerX, y, "%c{yellow}$ %c{white}- Secure the bag");    y++;
        
        // Draw footer
        y += 1;
        this._drawCenteredText(17, "Type enter in chat =", "gray");
    },

    _initializeKeyboardHandler: function() {
        console.log("Initializing keyboard handler");
        
        // Use a local reference to avoid 'this' scope issues in event handler
        const game = this;
        
        // Add event listener for keydown
        window.addEventListener('keydown', function(e) {
            // Only process keys when game is active
            if (!game._gameActive) {
                return;
            }
            
            let direction = null;
            
            // Determine direction based on key
            switch (e.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                    direction = 'up';
                    break;
                    
                case 'ArrowDown':
                case 's':
                case 'S':
                    direction = 'down';
                    break;
                    
                case 'ArrowLeft':
                case 'a':
                case 'A':
                    direction = 'left';
                    break;
                    
                case 'ArrowRight':
                case 'd':
                case 'D':
                    direction = 'right';
                    break;
                    
                default:
                    // Not a movement key
                    return;
            }
            
            // Prevent default behavior for these keys (like scrolling)
            e.preventDefault();
            
            console.log(`Key pressed: ${e.key}, sending direction: ${direction}`);
            
            // Send the movement to the server
            if (window.socket && direction) {
                window.socket.emit('move', direction);
            }
        });
        
        console.log("Keyboard handler initialized");
    },

    // Mode switching methods
    isAsciiMode: function() {
        return !this._isTileMode;
    },

    switchToTileMode: function() {
        console.log("Switching to tile mode");
        
        if (!window.tileSet || !window.tileMap) {
            console.error("Cannot switch to tile mode: tileset or tilemap not available");
            return false;
        }
        
        // Save current game state and screen center
        const gameWasActive = this._gameActive;
        
        // Create new display with tile options
        const oldContainer = this._display.getContainer();
        const parentElement = oldContainer.parentElement;
        
        try {
            this._isTileMode = true; // Update mode state
            this._display = new ROT.Display({
                width: this._screenWidth,
                height: this._screenHeight,
                fontSize: 16,
                fontFamily: "monospace",
                fg: "#fff", 
                bg: "#000",
                layout: "tile",
                tileWidth: 32,
                tileHeight: 32,
                tileSet: window.tileSet,
                tileMap: window.tileMap
            });
            
            console.log("Created tile display with options:", this._display.getOptions());
            
            // Replace old container with new one
            if (parentElement) {
                parentElement.removeChild(oldContainer);
                parentElement.appendChild(this._display.getContainer());
            }
            
            // Redraw the screen
            if (gameWasActive) {
                this._drawGameScreen();
            } else {
                this._drawWelcomeScreen();
            }
            
            return true;
        } catch (err) {
            this._isTileMode = false; // Revert if failed
            console.error("Error switching to tile mode:", err);
            return false;
        }
    },

    switchToAsciiMode: function() {
        console.log("Switching to ASCII mode");
        
        // Save current game state
        const gameWasActive = this._gameActive;
        
        // Create new display with ASCII options
        const oldContainer = this._display.getContainer();
        const parentElement = oldContainer.parentElement;
        
        try {
            this._isTileMode = false; // Update mode state
            this._display = new ROT.Display({
                width: this._screenWidth,
                height: this._screenHeight,
                fontSize: 18,
                fontFamily: "monospace",
                fg: "#fff",
                bg: "#000",
                layout: "rect"
            });
            
            console.log("Created ASCII display with options:", this._display.getOptions());
            
            // Replace old container with new one
            if (parentElement) {
                parentElement.removeChild(oldContainer);
                parentElement.appendChild(this._display.getContainer());
            }
            
            // Redraw the screen
            if (gameWasActive) {
                this._drawGameScreen();
            } else {
                this._drawWelcomeScreen();
            }
            
            return true;
        } catch (err) {
            console.error("Error switching to ASCII mode:", err);
            return false;
        }
    },

    // Update the init function to properly handle the tileset

    init: function() {
        console.log("Initializing game");
        
        // Verify if tileset is actually loaded
        this.checkTileset(function(isLoaded) {
            if (isLoaded) {
                Game._setupTileDisplay();
            } else {
                Game._setupAsciiDisplay();
            }
            
            // Draw the welcome screen
            Game._drawWelcomeScreen();
            
            // Set up the keyboard handler
            Game._initializeKeyboardHandler();
        });
    },

    // Add helper function to check if tileset is truly loaded
    checkTileset: function(callback) {
        console.log("Checking if tileset is loaded...");
        
        // Give a short delay to ensure scripts are fully loaded
        setTimeout(function() {
            // More detailed logging to help debug
            console.log("Tileset check:");
            console.log("  window.tileSet exists:", !!window.tileSet);
            console.log("  window.tileMap exists:", !!window.tileMap);
            console.log("  tileMap keys:", window.tileMap ? Object.keys(window.tileMap).length : 0);
            
            // First do a quick check
            if (!window.tileSet || !window.tileMap || 
                !Object.keys(window.tileMap).length) {
                console.log("❌ Tileset or tilemap not available or empty");
                callback(false);
                return;
            }
            
            // For images, we need to make sure it's really loaded
            if (window.tileSet.complete) {
                console.log("✅ Tileset already loaded!");
                callback(true);
            } else {
                console.log("⏳ Tileset still loading, adding load event listener");
                // Add load listener to handle when it completes
                window.tileSet.addEventListener('load', function() {
                    console.log("✅ Tileset loaded via event!");
                    callback(true);
                });
                
                window.tileSet.addEventListener('error', function() {
                    console.log("❌ Error loading tileset");
                    callback(false);
                });
                
                // Set a timeout just in case
                setTimeout(function() {
                    if (!window.tileSet.complete) {
                        console.log("⏰ Tileset load timed out");
                        callback(false);
                    }
                }, 3000);
            }
        }, 100); // Short delay to ensure scripts are loaded
    },

    // Setup tile display
    _setupTileDisplay: function() {
        console.log("Setting up tile display");
        
        this._isTileMode = true; // Set tile mode state
        
        this._display = new ROT.Display({
            width: this._screenWidth,
            height: this._screenHeight,
            fontSize: 16,
            fontFamily: "monospace",
            fg: "#fff",
            bg: "#000",
            layout: "tile",
            tileWidth: 32,
            tileHeight: 32,
            tileSet: window.tileSet,
            tileMap: window.tileMap
        });
        
        // Place the display in the div with class "rotdis"
        const container = this._display.getContainer();
        const rotdisElement = document.querySelector(".rotdis");
        if (rotdisElement) {
            // Clear any existing content first
            rotdisElement.innerHTML = '';
            rotdisElement.appendChild(container);
        }
        
        console.log("✅ Tile display setup complete");
    },

    // Setup ASCII display
    _setupAsciiDisplay: function() {
        console.log("Setting up ASCII display");
        
        this._isTileMode = false; // Set ASCII mode state
        
        this._display = new ROT.Display({
            width: this._screenWidth,
            height: this._screenHeight,
            fontSize: 18,
            fontFamily: "monospace",
            fg: "#fff",
            bg: "#000",
            layout: "rect"
        });
        
        // Place the display in the div with class "rotdis"
        const container = this._display.getContainer();
        const rotdisElement = document.querySelector(".rotdis");
        if (rotdisElement) {
            // Clear any existing content first
            rotdisElement.innerHTML = '';
            rotdisElement.appendChild(container);
        }
        
        console.log("✅ ASCII display setup complete");
    },

    // Add this method to the Game object

    // Enhanced waiting screen with improved animation

    drawWaitingScreen: function() {
        console.log("Drawing waiting screen");
        
        // Clear the display
        this.clearDisplay();
        
        // Draw border
        this._drawBorder('#888');
        
        // Draw title
        this._drawCenteredText(5, "WAITING FOR DUNGEON...", "yellow");
        
        const _this = this;
        let dots = 0;
        let frame = 0;
        
        // Set up dungeon scene elements (static)
        const width = this._screenWidth;
        const centerY = 14;
        const floorY = centerY + 1;
        
        // Define wall positions - now as constants for collision detection
        const leftWallX = 5;
        const rightWallX = width - 6;
        
        // Store the interval ID so we can clear it later
        this._waitingInterval = setInterval(function() {
            // Clear the animation area only (not the whole screen)
            for (let x = 1; x < width-1; x++) {
                _this._display.draw(x, centerY, ' ', '#fff', '#000');
                _this._display.draw(x, centerY-1, ' ', '#fff', '#000');
            }
            
            // Draw floor
            for (let x = 1; x < width-1; x++) {
                _this._display.draw(x, floorY, '.', '#888', '#000');
            }
            
            // Draw walls and items (static elements)
            _this._display.draw(leftWallX, centerY, '#', '#fff', '#000');  // Left Wall
            _this._display.draw(rightWallX, centerY, '#', '#fff', '#000'); // Right Wall
            _this._display.draw(width-9, floorY-1, '$', '#ff0', '#000'); // Treasure
            _this._display.draw(width-4, floorY-1, '>', '#0f0', '#000'); // Exit
            
            // Calculate player position using a smoother sine wave
            // This gives a natural back-and-forth motion
            const playerPhase = (frame % 120) / 120; // 0.0 to 1.0 over 120 frames
            const playerSine = Math.sin(playerPhase * 2 * Math.PI);
            
            // Map the sine wave (-1 to 1) to the available space between walls
            // Add 0.5 to playerSine to map from [-1,1] to [-0.5,1.5], then clamp to [0,1]
            const normalizedPos = Math.max(0, Math.min(1, playerSine * 0.5 + 0.5));
            
            // Calculate player position, keeping a safe distance from walls
            const safeLeftX = leftWallX + 2;
            const safeRightX = rightWallX - 2;
            const playerX = Math.round(safeLeftX + normalizedPos * (safeRightX - safeLeftX));
            
            // Monster follows player with some lag and variation
            // Use a different phase for the monster to create pursuing behavior
            const monsterPhase = ((frame - 15) % 120) / 120; // 15 frames behind player
            const monsterSine = Math.sin(monsterPhase * 2 * Math.PI);
            const monsterNormPos = Math.max(0, Math.min(1, monsterSine * 0.5 + 0.5));
            
            // Monster stays in leftmost part of screen, never going beyond middle
            const monsterMaxX = Math.min(playerX - 2, Math.floor(width/2) - 2);
            const monsterMinX = leftWallX + 2;
            const monsterX = Math.round(monsterMinX + monsterNormPos * (monsterMaxX - monsterMinX));
            
            // Draw player and monster with proper collision detection
            _this._display.draw(playerX, centerY, '@', '#ff0', '#000');
            _this._display.draw(monsterX, centerY, '~', '#f00', '#000');
            
            // Proper waiting text animation - first clear the line
            const centerX = Math.floor(_this._screenWidth / 2);
            for (let x = centerX-10; x <= centerX+10; x++) {
                _this._display.draw(x, 10, ' ', '#fff', '#000');
            }
            
            // Now draw the waiting text with fixed position
            const waitingText = "Waiting";
            const dotsText = ".".repeat(dots % 4);
            const startX = centerX - Math.floor(waitingText.length / 2) - 2;
            _this._display.drawText(startX, 10, "%c{white}" + waitingText + dotsText);
            
            // Update animation counters
            dots++;
            frame++;
        }, 100); // Faster update rate for smoother animation
    },

    // Method to stop the waiting animation
    stopWaitingScreen: function() {
        if (this._waitingInterval) {
            clearInterval(this._waitingInterval);
            this._waitingInterval = null;
        }
    },

    // Add these helper functions for text and animation

    // Helper function to draw centered text
    _drawCenteredText: function(y, text, color) {
        const centerX = Math.floor(this._screenWidth / 2);
        const x = centerX - Math.floor(text.length / 2);
        
        // Handle color formatting
        if (color) {
            text = "%c{" + color + "}" + text;
        }
        
        this._display.drawText(x, y, text);
        return y + 1; // Return next line position
    }

}; // End of Game object

socket.on('game_start', function(data) {
    console.log("🎮 Game start received with data:", data);
    $('#messages').append($('<li class="game-start">').text("Starting game..."));
    
    if (!data) {
        $('#messages').append($('<li class="error">').text("Error: No game data received"));
        return;
    }
    
    try {
        // Start the game with received data
        var success = Game.startGame(data);
        console.log("Game start result:", success ? "SUCCESS" : "FAILED");
        
        if (!success) {
            $('#messages').append($('<li class="error">').text("Game start failed - trying ASCII mode"));
            
            // Try switching to ASCII mode
            if (document.getElementById('toggle-mode')) {
                document.getElementById('toggle-mode').click();
                setTimeout(function() {
                    Game.startGame(data);
                }, 100);
            }
        }
        
        window.focus();
    } catch (err) {
        console.error("Error starting game:", err);
        $('#messages').append($('<li class="error">').text("Error: " + err.message));
    }
});