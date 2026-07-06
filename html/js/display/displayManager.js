// DisplayManager - Handles ROT.Display initialization and clearing
var DisplayManager = {
    _display: null,
    _displayReady: false,
    _screenWidth: null,
    _screenHeight: null,

    init: function(screenWidth, screenHeight) {
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;

        var displayOptions = {
            width: this._screenWidth,
            height: this._screenHeight,
            forceSquareRatio: true,
        };

        displayOptions.layout = "tile";
        displayOptions.bg = window.options.bg;
        displayOptions.fg = window.options.fg || "#FFF";
        displayOptions.tileWidth = window.options.tileWidth;
        displayOptions.tileHeight = window.options.tileHeight;
        displayOptions.tileSet = window.options.tileSet;
        displayOptions.tileMap = window.options.tileMap;
        displayOptions.tileColorize = true; // Enable colorization for tile stacks

        try {
            var gameDisplayContainer = document.getElementById("game-display");
            if (!gameDisplayContainer) {
                console.error("Game display container #game-display not found in HTML!");
                alert("Error: Game display container #game-display not found. Cannot start game.");
                return false;
            }
            
            this._display = new ROT.Display(displayOptions);
            gameDisplayContainer.innerHTML = '';
            gameDisplayContainer.appendChild(this._display.getContainer());
            this._displayReady = true;
            return true;

        } catch (e) {
            console.error("Error initializing ROT.Display:", e);
            alert("Failed to initialize game display. Error: " + e.message + ". Check console for details.");
            this._displayReady = false;
            return false;
        }
    },

    getDisplay: function() {
        return this._display;
    },

    isReady: function() {
        return this._display && this._displayReady;
    },

    ensureDisplay: function() {
        if (!this._display || !this._displayReady) {
            return false;
        }
        return true;
    },    forceClearToBlack: function() {
        if (!this.ensureDisplay()) {
            console.warn("DisplayManager.forceClearToBlack: Display not ready, aborting.");
            return;
        }
        
        const display = this._display;

        // Step 1: Clear ROT.js's internal data cache and dirty flags
        display._data = {};
        display._dirty = {};

        // Step 2: Force redraw entire screen with blank characters
        for (let x = 0; x < this._screenWidth; x++) {
            for (let y = 0; y < this._screenHeight; y++) {
                display.draw(x, y, ' ', '#000', '#000');
            }
        }

        // Step 3: Directly clear the visual canvas to black
        var canvas = display.getContainer();
        if (canvas && typeof canvas.getContext === 'function') {
            var ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.fillStyle = "#000000";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            } else {
                console.warn("DisplayManager.forceClearToBlack: Failed to get 2D context from canvas.");
                this._fallbackClear(display);
            }
        } else {
            console.warn("DisplayManager.forceClearToBlack: Display container is not a canvas or does not exist. Attempting fallback clear.");
            this._fallbackClear(display);
        }
    },

    _fallbackClear: function(display) {
        console.warn("DisplayManager.forceClearToBlack: Using fallback clear method.");
        const originalBg = display.getOptions().bg;
        try {
            if (display._options) {
                display._options.bg = "#000000";
            }
            display.clear();
        } catch (e) {
            console.error("Error during fallback clear:", e);
        } finally {
            if (display._options) {
                display._options.bg = originalBg;
            }
        }
    },

    clearDisplay: function() {
        if (!this.ensureDisplay()) return;
        this.forceClearToBlack();
        if (window.SinglePlayerAvatar && window.SinglePlayerAvatar.clearOverlay) {
            window.SinglePlayerAvatar.clearOverlay();
        }
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.DisplayManager = DisplayManager;
}
