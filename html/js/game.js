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

    init: function() {
        // Assuming 'options' is defined globally or passed correctly
        console.log("Creating ROT.Display with options:", options);
        try {
            this._display = new ROT.Display(options);
            console.log("ROT.Display created.");
            // Do not append here; we use external logic to append container
        } catch (e) {
            console.error("Error creating ROT.Display:", e);
            alert("Failed to initialize display. Check console for errors.");
            return;
        }

        // Initialize empty map representation based on _mapWidth and _mapHeight
        this._map = [];
        for (var i = 0; i < this._mapWidth; i++) {
            this._map[i] = [];
            for (var j = 0; j < this._mapHeight; j++) {
                // Default to wall visually; adjust as needed
                this._map[i][j] = 1;
            }
        }

        var game = this;
        // Set up keyboard input
        window.addEventListener("keydown", function(e) {
            var code = e.keyCode;

            // If game isn't active, ignore all keys except Enter
            if (!game._gameActive && code !== 13) {
                return;
            }

            // Enter key to start game
            if (code === 13 && !game._gameActive) {
                console.log("Enter pressed, sending 'enter' message to server.");
                socket.emit('chat message', 'enter');
                game._message = "Connecting...";
                game._drawWelcomeScreen();
                e.preventDefault();
                return;
            }

            // Movement controls
            var direction = "";
            switch (code) {
                case 38: case 75: case 87: // up, k, w
                    direction = "up";
                    break;
                case 40: case 74: case 83: // down, j, s
                    direction = "down";
                    break;
                case 37: case 72: case 65: // left, h, a
                    direction = "left";
                    break;
                case 39: case 76: case 68: // right, l, d
                    direction = "right";
                    break;
                default:
                    return;
            }

            if (direction && game._gameActive) {
                socket.emit('move', direction);
                e.preventDefault();
            }
        });

        // Draw welcome screen
        this._message = "Press Enter or type 'enter' to Play!";
        this._drawWelcomeScreen();
    },

    // Initialize game with data from server
    startGame: function(data) {
        console.log("Starting game with data:", data);
        
        this._map = data.map;
        this._player = data.player;
        this._monster = data.monster;
        this._entrance = data.entrance;
        this._exit = data.exit;
        this._treasure = data.treasure;
        this._gameActive = true;
        
        this._drawGameScreen();
    },

    clearDisplay: function() {
        // Clear the entire display area
        this._display.clear();
    },

    _drawGameScreen: function() {
        this.clearDisplay();

        // Draw map
        for (var x = 0; x < this._mapWidth; x++) {
            for (var y = 0; y < this._mapHeight; y++) {
                var tile = this._map[y] && this._map[y][x] ? this._map[y][x] : 1;
                
                if (tile === 0) {
                    this._display.draw(x, y, "'", "#fff"); // Floor
                } else {
                    this._display.draw(x, y, "#", "#777"); // Wall
                }
            }
        }

        // Draw special features
        if (this._entrance) {
            this._display.draw(this._entrance[0], this._entrance[1], "<", "#0f0");
        }
        
        if (this._exit) {
            this._display.draw(this._exit[0], this._exit[1], ">", "#0f0");
        }
        
        if (this._treasure && (!this._player || !this._player.hasTreasure)) {
            this._display.draw(this._treasure[0], this._treasure[1], "$", "#ff0");
        }

        // Draw player
        if (this._player) {
            this._display.draw(this._player.x, this._player.y, "@", "#fff");
        }

        // Draw monster
        if (this._monster) {
            this._display.draw(this._monster.x, this._monster.y, "~", "#f00");
        }

        // Draw status line
        var statusY = this._mapHeight; // Position below map
        this._display.drawText(0, statusY, "--------------------------------------------------------------------------------"); // Separator
        statusY++;

        var statusLine = `Use Arrows/WASD/HJKL. Find ($) and reach exit (>). Avoid (~).`;
        if (this._player && this._player.hasTreasure) {
            statusLine = "You have the treasure ($)! Reach the exit (>)!";
        }
        this._display.drawText(1, statusY, statusLine);
    },

    _drawWelcomeScreen: function() {
        this.clearDisplay();
        var y = 5;
        this._display.drawText(this._screenWidth / 2 - 5, y++, "%c{yellow}WOWGUE");
        y++;
        y+=2;
        this._display.drawText(this._screenWidth / 2 - 10, y++, "@ - This is you");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "> - Escape the dungeon");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "~ - Avoid the monster");
        this._display.drawText(this._screenWidth / 2 - 10, y++, "$ - Find the treasure");
        y+=2;
        // Display dynamic message (like waiting or error)
        if (this._message) {
             this._display.drawText(this._screenWidth / 2 - this._message.length / 2, y++, `%c{yellow}${this._message}`);
        }
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
    }
};