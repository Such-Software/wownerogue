/**
 * DisplayManager - Handles all ROT.js display operations
 */
var DisplayManager = {
    _display: null,
    _screenWidth: 0,
    _screenHeight: 0,
    _displayReady: false,
    _isTileMode: true,
    
    // Visual representation constants
    symbols: {
        player: "@",
        wall: "#",
        floor: "'",
        monster: "~",
        exit: ">",
        entrance: "<",
        treasure: "$",
        border: "+"
    },

    init: function(screenWidth, screenHeight, containerId) {
        console.log("DisplayManager.init called");
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;
        
        var displayOptions = {
            width: this._screenWidth,
            height: this._screenHeight,
            forceSquareRatio: true,
            layout: "tile",
            bg: window.options.bg,
            fg: window.options.fg || "#FFF",
            tileWidth: window.options.tileWidth,
            tileHeight: window.options.tileHeight,
            tileSet: window.options.tileSet,
            tileMap: window.options.tileMap,
            tileColorize: false
        };

        try {
            var gameDisplayContainer = document.getElementById(containerId);
            if (!gameDisplayContainer) {
                console.error("Game display container not found:", containerId);
                return false;
            }
            
            this._display = new ROT.Display(displayOptions);
            gameDisplayContainer.innerHTML = '';
            gameDisplayContainer.appendChild(this._display.getContainer());
            
            console.log("ROT.Display initialized successfully");
            this._displayReady = true;
            return true;
        } catch (e) {
            console.error("Error initializing ROT.Display:", e);
            this._displayReady = false;
            return false;
        }
    },

    isReady: function() {
        return this._display && this._displayReady;
    },

    clear: function() {
        if (!this.isReady()) return;
        
        const display = this._display;
        display._data = {};
        display._dirty = {};
        
        var canvas = display.getContainer();
        if (canvas && typeof canvas.getContext === 'function') {
            var ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.fillStyle = "#000000";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
        }
    },

    draw: function(x, y, char, fg, bg) {
        if (!this.isReady()) return;
        this._display.draw(x, y, char, fg, bg);
    },

    drawText: function(x, y, text, fg) {
        if (!this.isReady()) return;
        if (fg) {
            this._display.drawText(x, y, `%c{${fg}}${text}`);
        } else {
            this._display.drawText(x, y, text);
        }
    },

    drawCenteredText: function(y, text, fg) {
        if (!this.isReady()) return y;
        const x = Math.floor((this._screenWidth - text.length) / 2);
        this.drawText(x, y, text, fg);
        return y + 1;
    },

    drawBorder: function(fg) {
        if (!this.isReady()) return;
        const borderChar = this.symbols.border;
        const color = fg || "#FFF";
        
        for (let x = 0; x < this._screenWidth; x++) {
            for (let y = 0; y < this._screenHeight; y++) {
                if (x === 0 || y === 0 || x === this._screenWidth-1 || y === this._screenHeight-1) {
                    this.draw(x, y, borderChar, color, null);
                }
            }
        }
    },

    getScreenWidth: function() {
        return this._screenWidth;
    },

    getScreenHeight: function() {
        return this._screenHeight;
    }
};
