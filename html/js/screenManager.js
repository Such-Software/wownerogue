// ScreenManager - Handles different screen states and UI drawing
var ScreenManager = {
    defaultFg: "#FFF",
    _currentBlockHeight: 0,
    _blockTimer: null,
    _updateInterval: null,  // Track the update interval separately
    _waitingForBlock: false,

    init: function(screenWidth, screenHeight) {
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;
        this._currentBlockHeight = 0;
        this._waitingForBlock = false;
        this._updateInterval = null;  // Initialize update interval tracker
    },

    drawCenteredText: function(y, text, color) {
        if (!DisplayManager.ensureDisplay()) return y;
        const display = DisplayManager.getDisplay();
        
        // Filter text to only include valid characters
        let filteredText = "";
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (window.options?.tileMap?.hasOwnProperty(char) || char === ' ') {
                filteredText += char;
            } else {
                filteredText += "?";
            }
        }
        
        const x = Math.floor((this._screenWidth - filteredText.length) / 2);
        const finalColor = color || this.defaultFg;
        display.drawText(x, y, `%c{${finalColor}}${filteredText}`);
        return y + 1;
    },

    drawBorder: function() {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();

        for (var i = 0; i < this._screenWidth; i++) {
            display.draw(i, 0, "-", this.defaultFg, null);
            display.draw(i, this._screenHeight - 1, "-", this.defaultFg, null);
        }
        for (var j = 1; j < this._screenHeight - 1; j++) {
            display.draw(0, j, "|", this.defaultFg, null);
            display.draw(this._screenWidth - 1, j, "|", this.defaultFg, null);
        }
    },

    drawWelcomeScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

        let y = Math.floor(this._screenHeight / 4);
        y = this.drawCenteredText(y, "THE WOWNGEON", this.defaultFg);
        y = this.drawCenteredText(y + 2, "A Wownero Roguelike", this.defaultFg);
        
        y = this.drawCenteredText(y + 3, "Waiting for next block...", this.defaultFg);
        y = this.drawCenteredText(y + 1, `Block Height: ${this._currentBlockHeight}`, "#0f0");
        
        const isDebugMode = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.protocol === 'file:';
        
        // Control HTML START button visibility
        const startButton = document.getElementById('startButton');
        if (startButton) {
            if (this._waitingForBlock && !isDebugMode) {
                startButton.style.display = 'none';
                y = this.drawCenteredText(y + 2, "Mining in progress...", "#ff0");
            } else {
                startButton.style.display = 'block';
                y = this.drawCenteredText(y + 2, "Press ENTER or click START to queue", "#0f0");
            }
        }
        
        // Debug button (shown only in development)
        if (isDebugMode) {
            this.drawCenteredText(y + 3, "[DEBUG: Press 'D' to start immediately]", "#666");
        }
        
        this.drawCenteredText(y + 5, "Good luck, adventurer!", this.defaultFg);
    },

    // Start simulated block mining (30 second intervals)
    startBlockSimulation: function() {
        console.log("Starting block simulation...");
        this._currentBlockHeight = Math.floor(Math.random() * 1000000) + 3200000; // Realistic Wownero block height
        this._waitingForBlock = true;
        
        // Update welcome screen every second during mining
        this._updateInterval = setInterval(() => {
            if (this._waitingForBlock && !GameState.isGameActive()) {
                this.drawWelcomeScreen();
            } else {
                if (this._updateInterval) {
                    clearInterval(this._updateInterval);
                    this._updateInterval = null;
                }
            }
        }, 1000);
        
        // Simulate new block every 30 seconds
        this._blockTimer = setInterval(() => {
            if (!GameState.isGameActive()) {  // Only continue if game is not active
                this._currentBlockHeight++;
                this._waitingForBlock = false;
                this.drawWelcomeScreen();
                
                // Show block found message briefly
                setTimeout(() => {
                    if (!DisplayManager.ensureDisplay() || GameState.isGameActive()) return;
                    let y = Math.floor(this._screenHeight / 2);
                    this.drawCenteredText(y, "*** NEW BLOCK FOUND! ***", "#0f0");
                    this.drawCenteredText(y + 1, "You may now enter the dungeon!", "#0f0");
                    
                    // Allow entry for 5 seconds
                    setTimeout(() => {
                        if (!GameState.isGameActive()) {
                            this._waitingForBlock = true;
                            this.drawWelcomeScreen();
                        }
                    }, 5000);
                }, 500);
            }
        }, 30000); // 30 second intervals
    },

    // Stop block simulation
    stopBlockSimulation: function() {
        console.log("Stopping block simulation and clearing all intervals...");
        if (this._blockTimer) {
            clearInterval(this._blockTimer);
            this._blockTimer = null;
        }
        if (this._updateInterval) {
            clearInterval(this._updateInterval);
            this._updateInterval = null;
        }
        this._waitingForBlock = false;
    },

    // Check if player can enter (not waiting for block or debug mode)
    canEnterGame: function() {
        const isDebugMode = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.protocol === 'file:';
        return !this._waitingForBlock || isDebugMode;
    },

    drawWinScreen: function(hasTreasure) {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

        let y = this.drawCenteredText(Math.floor(this._screenHeight / 3), "CONGRATULATIONS!");
        if (hasTreasure) {
            y = this.drawCenteredText(y + 2, "You escaped with the treasure!");
        } else {
            y = this.drawCenteredText(y + 2, "You escaped the dungeon!");
        }
        this.drawCenteredText(y + 3, "A true hero of Wownero!");
    },

    drawLoseScreen: function(reason) {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

        let y = this.drawCenteredText(Math.floor(this._screenHeight / 3), "YOU HAVE PERISHED");
        if (reason === 'monster') {
            y = this.drawCenteredText(y + 2, "Slain by a fearsome beast.");
        } else if (reason === 'timeout') {
            y = this.drawCenteredText(y + 2, "The dungeon claimed you before the next block.");
        } else {
            y = this.drawCenteredText(y + 2, "Your adventure ends here.");
        }
        this.drawCenteredText(y + 3, "Better luck next time.");
    },

    drawWaitingScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

        let y = Math.floor(this._screenHeight / 2) - 2;
        y = this.drawCenteredText(y, "*  MINING IN PROGRESS  *", "#ff0");
        y = this.drawCenteredText(y + 2, `Current Block: ${this._currentBlockHeight}`, "#0f0");
        y = this.drawCenteredText(y + 1, "Waiting for next block to enter...", this.defaultFg);
        
        // Animated dots
        const dots = ".".repeat((Math.floor(Date.now() / 500) % 4));
        this.drawCenteredText(y + 2, `Mining${dots}`, "#666");
    },

    stopWaitingScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.ScreenManager = ScreenManager;
}
