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
    
    _isFirefox: function() {
        return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    },

    init: function() {
        console.log("Initializing Game...");
        
        // Check for Firefox
        var isFirefox = this._isFirefox();
        if (isFirefox) {
            console.log("Firefox detected, applying special handling");
        }
        
        try {
            // Create a display with the defined options
            var displayOptions = { ...options }; // Clone options
            
            // Firefox-specific tweaks if needed
            if (isFirefox) {
                // Force numerical dimensions for Firefox
                displayOptions.width = parseInt(displayOptions.width);
                displayOptions.height = parseInt(displayOptions.height);
            }
            
            console.log("Creating ROT.Display with options:", displayOptions);
            this._display = new ROT.Display(displayOptions);
            console.log("ROT.Display created.");
            
            // Get the DOM element and append display
            var container = document.querySelector('.rotdis');
            console.log("Found display container:", container);
            
            if (container) {
                // Clear any existing content
                container.innerHTML = '';
                
                // Add the new canvas
                var canvas = this._display.getContainer();
                
                // Firefox-specific attributes
                if (isFirefox) {
                    canvas.style.width = 'auto';
                    canvas.style.height = 'auto';
                    canvas.style.display = 'block';
                    canvas.style.margin = 'auto';
                }
                
                container.appendChild(canvas);
                console.log("Display container attached to DOM");
                
                // Draw initial welcome screen
                console.log("Drawing initial welcome screen");
                this._drawWelcomeScreen();
                
                // Extra check for Firefox
                if (isFirefox) {
                    // Give Firefox a moment to render properly
                    setTimeout(() => {
                        console.log("Firefox re-render check");
                        this._drawWelcomeScreen();
                    }, 100);
                }
                
            } else {
                console.error("Could not find .rotdis container");
            }
        } catch (e) {
            console.error("Error during game initialization:", e);
        }

        // Initialize empty map
        this._map = [];
        for (var i = 0; i < this._mapWidth; i++) {
            this._map[i] = [];
            for (var j = 0; j < this._mapHeight; j++) {
                // Default to wall visually; adjust as needed
                this._map[i][j] = 1;
            }
        }

        var game = this;
        // Set up keyboard input - ONLY FOR MOVEMENT, not for starting the game
        window.addEventListener("keydown", function(e) {
            // Check if an input/textarea has focus - if so, don't capture keys for game
            const activeElement = document.activeElement;
            const isInputFocused = activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.id === 'm' // Your chat input id
            );
            
            // If input is focused or game isn't active, don't process game controls
            if (isInputFocused || !game._gameActive) {
                return;
            }

            // Movement controls (only when game is active AND no input has focus)
            var direction = "";
            switch (e.keyCode) {
                case 38: case 75: case 87: // up, k, w
                    direction = "up";
                    e.preventDefault(); // Prevent page scrolling
                    break;
                case 40: case 74: case 83: // down, j, s
                    direction = "down";
                    e.preventDefault(); // Prevent page scrolling
                    break;
                case 37: case 72: case 65: // left, h, a
                    direction = "left";
                    e.preventDefault(); // Prevent page scrolling
                    break;
                case 39: case 76: case 68: // right, l, d
                    direction = "right";
                    e.preventDefault(); // Prevent page scrolling
                    break;
                default:
                    return;
            }

            // If a direction key was pressed, update local state and send to server
            if (direction) {
                console.log("Game state updated:", direction);
                
                // Send the move command to the server
                if (window.socket) {
                    console.log("Sending move command to server:", direction);
                    window.socket.emit('move', direction);
                }
            }
        });

        // Force draw welcome screen
        this._gameActive = false;
        this._message = "Type 'enter' in chat to play!";
        console.log("Drawing initial welcome screen");
        this._drawWelcomeScreen();
        
        // Verify welcome screen was drawn by checking for canvas content
        setTimeout(() => {
            const container = this._display.getContainer();
            const canvas = container.querySelector("canvas");
            if (canvas) {
                console.log("Canvas dimensions:", canvas.width, canvas.height);
                console.log("Canvas is visible:", canvas.style.display !== "none");
            }
        }, 500);
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
                        this._display.draw(screenX, screenY, '.', '#888', '#000');
                    }
                }
            }
        }
        
        // Always draw player at center of screen
        this._display.draw(centerX, centerY, '@', '#ff0', '#000');
        console.log("Drew player at center:", centerX, centerY);
        
        // Draw other entities if visible (treasure, exit, entrance)
        // ... additional drawing code for other entities ...
        
        console.log("Game screen drawing complete");
    },
    
    _isVisible: function(x, y) {
        // Check if a tile is currently visible
        return this._visibleTiles[y] && this._visibleTiles[y][x] !== undefined;
    },
    
    // Add these functions to your client-side Game object (not the server-side one)

    // Function to switch to ASCII mode
    switchToAsciiMode: function() {
        console.log("Switching to ASCII mode");
        
        var asciiOptions = {
            width: 25,
            height: 19,
            fontSize: 16,
            fontFamily: "monospace",
            bg: "#000",
            fg: "#fff"
        };
        
        try {
            // Create new display with ASCII mode
            var newDisplay = new ROT.Display(asciiOptions);
            
            // Replace the existing display
            var container = document.querySelector('.rotdis');
            if (container) {
                container.innerHTML = '';
                container.appendChild(newDisplay.getContainer());
                this._display = newDisplay;
                
                // Redraw current game state
                if (this._gameActive) {
                    this._drawGameScreen();
                } else {
                    this._drawWelcomeScreen();
                }
            } else {
                console.error("Could not find .rotdis container");
            }
        } catch (err) {
            console.error("Error switching to ASCII mode:", err);
        }
    },

    // Fix the welcome screen drawing
    _drawWelcomeScreen: function() {
        console.log("Drawing welcome screen...");
        this._display.clear();
        
        // Draw borders
        for (var x = 0; x < this._display.getOptions().width; x++) {
            for (var y = 0; y < this._display.getOptions().height; y++) {
                if (x === 0 || y === 0 || x === this._display.getOptions().width-1 || y === this._display.getOptions().height-1) {
                    this._display.draw(x, y, "#", "#666", "#000");
                }
            }
        }
        
        // Draw welcome text
        var centerX = Math.floor(this._display.getOptions().width / 2);
        var centerY = Math.floor(this._display.getOptions().height / 2);
        
        // For ASCII mode, we can use drawText with colors
        var y = 5;
        this._display.drawText(this._screenWidth / 2 - 5, y++, "%c{yellow}WOWGUE");
        y++;
        this._display.drawText(this._screenWidth / 2 - 11, y++, "Type enter to start!");
        this._display.drawText(this._screenWidth / 2 - 11, y++, "Or type help...");
        y+=2;
        this._display.drawText(this._screenWidth / 2 - 10, y++, "@ - This is you");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "> - Escape the dungeon");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "~ - Avoid the wonster");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "$ - Secure the bag");
        y+=2;
    
        // Draw instructions
        this._display.drawText(2, this._display.getOptions().height - 2, "Type enter in chat =");
    },

    _drawWinScreen: function(hasTreasure) {
        this.clearDisplay();
        var y = 5;
        this._display.drawText(this._screenWidth / 2 - 5, y++, "%c{green}YOU WIN!");
        y++;
        
        if (hasTreasure) {
            this._display.drawText(this._screenWidth / 2 - 15, y++, "You found the treasure and escaped!");
        } else {
            this._display.drawText(this._screenWidth / 2 - 10, y++, "You escaped the dungeon!");
        }
        
        y++;
        this._gameActive = false;
        this._message = "Press Enter to Play Again!";
        this._display.drawText(this._screenWidth / 2 - (this._message.length / 2), y++, `%c{yellow}${this._message}`);
    },

    _drawLoseScreen: function(reason) {
        this.clearDisplay();
        var y = 5;
        this._display.drawText(this._screenWidth / 2 - 5, y++, "%c{red}GAME OVER!");
        y++;

        if (reason === 'timeout') {
            this._display.drawText(this._screenWidth / 2 - 20, y++, "You didn't escape before the next block!");
        } else if (reason === 'caught') {
            this._display.drawText(this._screenWidth / 2 - 15, y++, "The monster caught you!");
        } else {
             this._display.drawText(this._screenWidth / 2 - 10, y++, `Reason: ${reason}`);
        }
        
        y++;
        this._gameActive = false;
        this._message = "Press Enter to Play Again!";
        this._display.drawText(this._screenWidth / 2 - (this._message.length / 2), y++, `%c{yellow}${this._message}`);
    },

    getDisplay: function() {
        return this._display;
    },
    
    getScreenWidth: function() {
        return this._screenWidth;
    },
    
    getScreenHeight: function() {
        return this._screenHeight;
    },

    // Add these functions to your Game object

    // Check if we're in ASCII mode
    isAsciiMode: function() {
        if (!this._display) return false;
        var options = this._display.getOptions();
        return !options.layout || options.layout !== "tile";
    },

    // Switch to ASCII mode
    switchToAsciiMode: function() {
        console.log("Switching to ASCII mode");
        
        var asciiOptions = {
            width: 25,
            height: 19,
            fontSize: 16,
            fontFamily: "monospace",
            bg: "#000",
            fg: "#fff"
        };
        
        try {
            // Create new display with ASCII mode
            var newDisplay = new ROT.Display(asciiOptions);
            
            // Replace the existing display in DOM
            var container = document.querySelector('.rotdis');
            if (container) {
                container.innerHTML = '';
                container.appendChild(newDisplay.getContainer());
                
                // Update the game's display reference
                this._display = newDisplay;
                
                console.log("Switched to ASCII mode successfully");
                
                // Redraw current game state
                if (this._gameActive) {
                    this._drawGameScreen();
                } else {
                    this._drawWelcomeScreen();
                }
                
                return true;
            } else {
                console.error("Could not find .rotdis container to replace display");
                return false;
            }
        } catch (err) {
            console.error("Error switching to ASCII mode:", err);
            return false;
        }
    },

    // Switch to tile mode
    switchToTileMode: function() {
        console.log("Switching to tile mode");
        
        try {
            // Create new display with tile mode
            var newDisplay = new ROT.Display(options);
            
            // Replace the existing display in DOM
            var container = document.querySelector('.rotdis');
            if (container) {
                container.innerHTML = '';
                container.appendChild(newDisplay.getContainer());
                
                // Update the game's display reference
                this._display = newDisplay;
                
                console.log("Switched to tile mode successfully");
                
                // Redraw current game state
                if (this._gameActive) {
                    this._drawGameScreen();
                } else {
                    this._drawWelcomeScreen();
                }
                
                return true;
            } else {
                console.error("Could not find .rotdis container to replace display");
                return false;
            }
        } catch (err) {
            console.error("Error switching to tile mode:", err);
            return false;
        }
    }
};

socket.on('game_start', function(data) {
    console.log("🎮 Game start received with data:", data);
    $('#messages').append($('<li class="game-start">').text("Starting game..."));
    
    if (!data) {
        $('#messages').append($('<li class="error">').text("Error: No game data received"));
        return;
    }
    
    try {
        // Make sure all game UI elements are visible
        $('.container, .banner, .rotdis, .chat-container').css('display', '');
        
        // Display what we received
        $('#messages').append($('<li>').text(`Entering the dungeon...`));
        
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