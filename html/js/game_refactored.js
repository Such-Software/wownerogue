// This provides a mock socket when the real one isn't available
if (typeof window !== 'undefined' && !window.socket) {
    window.socket = {
        emit: function(event, data) {
            console.log("[Mock Socket] Would emit:", event, data);
        }
    };
}

/**
 * Main Game object - coordinates all the managers
 */
var Game = {
    // Managers
    displayManager: DisplayManager,
    screenManager: ScreenManager,
    inputHandler: InputHandler,
    gameState: GameState,
    
    // Config
    _screenWidth: options.width,
    _screenHeight: options.height,

    init: function() {
        console.log("Game.init called");
        
        // Initialize all managers
        if (!this.displayManager.init(this._screenWidth, this._screenHeight, "game-display")) {
            console.error("Failed to initialize display manager");
            return false;
        }
        
        this.screenManager.init(this.displayManager);
        this.gameState.init();
        this.inputHandler.init();
        
        // Set up input handler events
        const self = this;
        this.inputHandler.on('movement', function(direction) {
            console.log("Movement input received:", direction);
        });
        
        // Draw welcome screen
        this.screenManager.drawWelcomeScreen();
        
        console.log("Game initialization complete");
        return true;
    },

    startGame: function(data) {
        console.log("🎮 Game start received with data:", data);
        
        if (!this.gameState.startGame(data)) {
            console.error("Failed to start game");
            return false;
        }
        
        // Activate input handling
        this.inputHandler.setGameActive(true);
        this.gameState.setGameActive(true);
        
        // Draw the game screen
        this.screenManager.drawGameScreen(this.gameState.getGameData());
        
        return true;
    },

    updateGameState: function(data) {
        if (!this.gameState.updateGameState(data)) {
            console.error("Failed to update game state");
            return;
        }
        
        // Redraw the screen if game is active
        if (this.gameState.isGameActive()) {
            this.screenManager.drawGameScreen(this.gameState.getGameData());
        }
    },

    showWinScreen: function(hasTreasure) {
        this.inputHandler.setGameActive(false);
        this.gameState.setGameActive(false);
        this.screenManager.drawWinScreen(hasTreasure);
    },

    showLoseScreen: function(reason) {
        this.inputHandler.setGameActive(false);
        this.gameState.setGameActive(false);
        this.screenManager.drawLoseScreen(reason);
    },

    showWaitingScreen: function() {
        this.inputHandler.setGameActive(false);
        this.gameState.setGameActive(false);
        this.screenManager.drawWaitingScreen();
    },

    showWelcomeScreen: function() {
        this.inputHandler.setGameActive(false);
        this.gameState.setGameActive(false);
        this.screenManager.drawWelcomeScreen();
    },

    clearDisplay: function() {
        this.displayManager.clear();
    }
};

// Socket event handlers
if (typeof window !== 'undefined' && window.socket) {
    socket.on('game_start', function(data) {
        console.log("🎮 Game start received with data:", data);
        Game.startGame(data);
    });

    socket.on('game_update', function(data) {
        Game.updateGameState(data);
    });

    socket.on('waiting_status', function(data) {
        console.log("Waiting status received:", data);
        Game.showWaitingScreen();
    });

    socket.on('queue_cancelled', function() {
        console.log("Queue cancelled, returning to welcome screen");
        Game.showWelcomeScreen();
    });

    socket.on('game_over', function(data) {
        console.log("Game over received:", data);
        
        if (data.status === 'won') {
            Game.showWinScreen(data.hasTreasure);
        } else {
            Game.showLoseScreen(data.reason);
        }
    });
}
