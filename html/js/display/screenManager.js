// ScreenManager - Handles different screen states and UI drawing
var ScreenManager = {
    defaultFg: "#FFF",
    _currentBlockHeight: 0,
    _blockTimer: null,
    _updateInterval: null,  // Track the update interval separately
    _waitingForBlock: false,
    _isShowingWaitingScreen: false,  // Track if waiting screen is active
    _cryptoType: 'WOW',  // Default to WOW, updated on game mode info

    // Get the game title based on crypto type
    getGameTitle: function() {
        return this._cryptoType === 'XMR' ? 'MONEROGUE' : 'WOWNEROGUE';
    },

    // Set crypto type (called from socket handlers)
    setCryptoType: function(cryptoType) {
        this._cryptoType = cryptoType || 'WOW';
    },

    // Check if waiting screen is currently being shown
    isShowingWaitingScreen: function() {
        return this._isShowingWaitingScreen;
    },

    init: function(screenWidth, screenHeight) {
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;
        this._currentBlockHeight = 0;
        this._waitingForBlock = false;
        this._isShowingWaitingScreen = false;
        this._updateInterval = null;  // Initialize update interval tracker
        this._cryptoType = 'WOW';
        
        // Initialize the waiting screen animator
        if (typeof WaitingScreenAnimator !== 'undefined') {
            WaitingScreenAnimator.init();
        }
    },

    drawText: function(x, y, text) {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (window.options?.tileMap?.hasOwnProperty(char) || char === ' ') {
                display.draw(x + i, y, char, "transparent", "transparent");
            } else {
                display.draw(x + i, y, "?", "transparent", "transparent");
            }
        }
    },

    drawCenteredText: function(y, text) {
        const x = Math.floor((this._screenWidth - text.length) / 2);
        this.drawText(x, y, text);
    },

    drawBorder: function() {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();

        // Use wall tiles (#) for borders - these are guaranteed to exist in tileMap
        const borderChar = "#";  // Wall tile at [64, 32]
        
        // Draw top and bottom borders
        for (var i = 0; i < this._screenWidth; i++) {
            display.draw(i, 0, borderChar, "transparent", "transparent");
            display.draw(i, this._screenHeight - 1, borderChar, "transparent", "transparent");
        }
        
        // Draw left and right borders
        for (var j = 1; j < this._screenHeight - 1; j++) {
            display.draw(0, j, borderChar, "transparent", "transparent");
            display.draw(this._screenWidth - 1, j, borderChar, "transparent", "transparent");
        }
    },

    drawWelcomeScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        
        // Mark that we're NOT showing the waiting screen
        this._isShowingWaitingScreen = false;
        
        DisplayManager.clearDisplay();
        
        // Draw the border
        this.drawBorder();
        
        // Draw content - use dynamic title based on crypto type
        let y = 3;
        this.drawCenteredText(y, this.getGameTitle());
        y += 3;
        
        // Draw instructions
        this.drawCenteredText(y, "Type enter to queue!");
        this.drawCenteredText(y + 1, "Or use START GAME");
        y += 3;
        
        // Draw legend with special tile handling
        const display = DisplayManager.getDisplay();
        // Use dynamic treasure tile based on crypto type
        const treasureTile = (typeof GameTiles !== 'undefined' && GameTiles.getTreasureTile) 
            ? GameTiles.getTreasureTile() 
            : (this._cryptoType === 'XMR' ? '$M' : '$W');
        const legendItems = [
            { tile: "@2", text: "This is you" },
            { tile: ">", text: " Escape the dungeon" }, 
            { tile: "~", text: " Avoid the monster" },
            { tile: treasureTile, text: "Secure the bag" }
        ];
        
        const centerX = Math.floor(this._screenWidth / 2) - 10;
        for (let item of legendItems) {
            let x = centerX;
            
            // Draw the special tile
            if (window.options?.tileMap?.hasOwnProperty(item.tile)) {
                display.draw(x, y, item.tile, "transparent", "transparent");
                x += item.tile.length;
            } else {
                display.draw(x, y, "?", "transparent", "transparent");
                x += 1;
            }
            
            // Draw the descriptive text
            this.drawText(x, y, item.text);
            y++;
        }
        
        // Draw current block info on two lines
        y += 2;
        this.drawCenteredText(y, "Current Block:");
        y += 1;
        this.drawCenteredText(y, `${this._currentBlockHeight}`);
        
        // Control HTML button visibility
        const startButton = document.getElementById('startButton');
        if (startButton) {
            startButton.style.display = 'block';
        }
        
        // Hide animation button on welcome screen
        this.hideAnimationButton();
        
        // Debug mode detection (for future use)
        const isDebugMode = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.protocol === 'file:';
    },




    toggleAnimation: function() {
        if (typeof WaitingScreenAnimator !== 'undefined') {
            WaitingScreenAnimator.toggleAnimation();
        }
    },

    // Start simulated block mining (30 second intervals)
    startBlockSimulation: function() {
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
                    this.drawCenteredText(y, "*** NEW BLOCK FOUND! ***");
                    this.drawCenteredText(y + 1, "You may now enter the dungeon!");
                    
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

        let y = Math.floor(this._screenHeight / 3);
        this.drawCenteredText(y, "CONGRATULATIONS!");
        
        if (hasTreasure) {
            this.drawCenteredText(y + 2, "You got the treasure!");
        } else {
            this.drawCenteredText(y + 2, "You escaped alive!");
        }
        this.drawCenteredText(y + 3, "Hero of Wownero!");
    },

    drawLoseScreen: function(reason) {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

        let y = Math.floor(this._screenHeight / 3);
        this.drawCenteredText(y, "YOU HAVE PERISHED");
        
        if (reason === 'monster') {
            this.drawCenteredText(y + 2, "Slain by a beast.");
        } else if (reason === 'timeout') {
            this.drawCenteredText(y + 2, "Time ran out.");
        } else {
            this.drawCenteredText(y + 2, "Your adventure ends.");
        }
        this.drawCenteredText(y + 3, "Better luck next time.");
    },

    drawWaitingScreen: function(_internalLoopCall = false) {
        if (!DisplayManager.ensureDisplay()) return;
        
        // Mark that we're showing the waiting screen
        this._isShowingWaitingScreen = true;
        
        DisplayManager.clearDisplay();
        
        const animationEnabled = (typeof WaitingScreenAnimator !== 'undefined') ? 
            WaitingScreenAnimator.isAnimationEnabled() : false;
        
        // Delegate to WaitingScreenAnimator with proper parameters
        if (typeof WaitingScreenAnimator !== 'undefined') {
            if (animationEnabled) {
                WaitingScreenAnimator.drawAnimatedWaitingScreen(
                    this._screenWidth, 
                    this._screenHeight, 
                    this.drawBorder.bind(this), 
                    this.drawCenteredText.bind(this)
                );
            } else {
                WaitingScreenAnimator.drawStaticWaitingScreen(
                    this._screenWidth, 
                    this._screenHeight, 
                    this.drawBorder.bind(this), 
                    this.drawCenteredText.bind(this)
                );
            }
        } else {
            // Fallback if WaitingScreenAnimator is not available
            this.drawFallbackWaitingScreen();
        }
        
        // Show the animation toggle button
        this.showAnimationButton();
        
        // Start animation loop if not already running
        // Only start the animator if this wasn't invoked from inside the animator loop
        if (! _internalLoopCall && animationEnabled && typeof WaitingScreenAnimator !== 'undefined') {
            WaitingScreenAnimator.startAnimation();
        }
    },

    showAnimationButton: function() {
        // First ensure the button exists
        if (!this.ensureAnimationButton()) {
            console.error("❌ Cannot show animation button - element missing from DOM");
            return;
        }
        
        const animButton = document.getElementById('animationToggleButton');
        if (animButton) {
            animButton.style.display = 'inline-block';
            animButton.style.visibility = 'visible';
            
            const animationEnabled = (typeof WaitingScreenAnimator !== 'undefined') ? 
                WaitingScreenAnimator.isAnimationEnabled() : false;
            animButton.textContent = animationEnabled ? '🎬 DISABLE ANIMATION' : '🎬 ENABLE ANIMATION';
        } else {
            // Animation button element not found - non-critical warning
            // console.warn("❌ Animation button element not found!");
        }
    },

    hideAnimationButton: function() {
        const animButton = document.getElementById('animationToggleButton');
        if (animButton) {
            animButton.style.display = 'none';
        }
    },

    ensureAnimationButton: function() {
        let animButton = document.getElementById('animationToggleButton');
        
        if (!animButton) {
            // Animation button not found - create or handle missing button
            const statusDiv = document.querySelector('.status');
            if (statusDiv) {
                const existingButtons = statusDiv.querySelectorAll('button');
                // Check existing buttons for debugging
                for (let btn of existingButtons) {
                    // Button discovery for debugging
                }
            }
            return false;
        }
        
        return true;
    },

    stopWaitingScreen: function() {
        if (typeof WaitingScreenAnimator !== 'undefined') {
            WaitingScreenAnimator.stopAnimation();
        }
        this.hideAnimationButton();
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();
    },

    drawFallbackWaitingScreen: function() {
        this.drawBorder();
        let y = Math.floor(this._screenHeight / 2) - 1;
        this.drawCenteredText(y, "Waiting for next block...");
        this.drawCenteredText(y + 1, "Loading animation module...");
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.ScreenManager = ScreenManager;
}
