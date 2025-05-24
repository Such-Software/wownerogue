/**
 * ScreenManager - Handles drawing different game screens
 */
var ScreenManager = {
    displayManager: null,
    defaultFg: "#FFF",

    init: function(displayManager) {
        this.displayManager = displayManager;
    },

    drawWelcomeScreen: function() {
        if (!this.displayManager.isReady()) return;
        
        console.log("Drawing welcome screen");
        this.displayManager.clear();
        this.displayManager.drawBorder(this.defaultFg);
        
        // Draw content with centered text
        let y = 3;
        y = this.displayManager.drawCenteredText(y, "WOWGUE", this.defaultFg);
        y += 4;
        
        // Draw instructions
        y = this.displayManager.drawCenteredText(y, "Type enter to start!", this.defaultFg);
        y = this.displayManager.drawCenteredText(y, "Or type help...", this.defaultFg);
        y += 2;
        
        // Draw legend
        const centerX = Math.floor(this.displayManager.getScreenWidth() / 2) - 11;
        const symbols = this.displayManager.symbols;
        
        this.displayManager.draw(centerX, y, symbols.player, this.defaultFg, null);
        this.displayManager.drawText(centerX + 2, y, "- This is you", this.defaultFg);
        y++;
        
        this.displayManager.draw(centerX, y, symbols.exit, this.defaultFg, null);
        this.displayManager.drawText(centerX + 2, y, "- Escape the dungeon", this.defaultFg);
        y++;
        
        this.displayManager.draw(centerX, y, symbols.monster, this.defaultFg, null);
        this.displayManager.drawText(centerX + 2, y, "- Avoid the monster", this.defaultFg);
        y++;
        
        this.displayManager.draw(centerX, y, symbols.treasure, this.defaultFg, null);
        this.displayManager.drawText(centerX + 2, y, "- Secure the bag", this.defaultFg);
        y++;
        
        // Draw footer
        y += 1;
        this.displayManager.drawCenteredText(17, "Type enter in chat =", this.defaultFg);
    },

    drawWinScreen: function(hasTreasure) {
        if (!this.displayManager.isReady()) return;
        
        console.log("Drawing win screen, hasTreasure:", hasTreasure);
        this.displayManager.clear();
        this.displayManager.drawBorder(this.defaultFg);
        
        let y = 5;
        y = this.displayManager.drawCenteredText(y, "YOU ESCAPED!", this.defaultFg);
        y += 1;
        
        const subtitle = hasTreasure ? "WITH THE TREASURE!" : "ALIVE!";
        y = this.displayManager.drawCenteredText(y, subtitle, this.defaultFg);
        y += 2;
        
        if (hasTreasure) {
            y = this.displayManager.drawCenteredText(y, "You won extra Wownero!", this.defaultFg);
            y += 1;
        }
        
        y += 1;
        this.displayManager.drawCenteredText(y, "Type ENTER to retry", this.defaultFg);
    },

    drawLoseScreen: function(reason) {
        if (!this.displayManager.isReady()) return;
        
        console.log("Drawing lose screen, reason:", reason);
        this.displayManager.clear();
        this.displayManager.drawBorder(this.defaultFg);
        
        let y = 5;
        y = this.displayManager.drawCenteredText(y, "YOU DIED!", this.defaultFg);
        y += 1;
        
        let subtitle = "";
        if (reason === 'monster') {
            subtitle = "KILLED BY THE MONSTER";
        } else if (reason === 'timeout') {
            subtitle = "YOU RAN OUT OF TIME";
        }
        
        if (subtitle) {
            y = this.displayManager.drawCenteredText(y, subtitle, this.defaultFg);
            y += 1;
        }
        
        y += 2;
        this.displayManager.drawCenteredText(y, "Type ENTER to retry", this.defaultFg);
    },

    drawWaitingScreen: function() {
        if (!this.displayManager.isReady()) return;
        
        console.log("Drawing waiting screen");
        this.displayManager.clear();
        this.displayManager.drawBorder(this.defaultFg);
        
        const centerY = Math.floor(this.displayManager.getScreenHeight() / 2);
        this.displayManager.drawCenteredText(centerY, "Waiting for next block...", this.defaultFg);
    },

    drawGameScreen: function(gameState) {
        if (!this.displayManager.isReady()) return;
        
        console.log("Drawing game screen...");
        this.displayManager.clear();
        
        if (!gameState.player) {
            console.error("No player data in game state!");
            return;
        }
        
        const centerX = Math.floor(this.displayManager.getScreenWidth() / 2);
        const centerY = Math.floor(this.displayManager.getScreenHeight() / 2);
        const symbols = this.displayManager.symbols;
        const playerX = gameState.player.x;
        const playerY = gameState.player.y;
        
        // Draw visible tiles centered on player (absolute to relative coordinate conversion)
        for (let worldY in gameState.visibleTiles) {
            worldY = parseInt(worldY);
            for (let worldX in gameState.visibleTiles[worldY]) {
                worldX = parseInt(worldX);
                
                // Convert world coordinates to screen coordinates relative to player
                const screenX = centerX + (worldX - playerX);
                const screenY = centerY + (worldY - playerY);
                
                if (screenX >= 0 && screenY >= 0 && 
                    screenX < this.displayManager.getScreenWidth() && 
                    screenY < this.displayManager.getScreenHeight()) {
                    
                    const tileType = gameState.visibleTiles[worldY][worldX];
                    
                    if (tileType === 1) { // Wall
                        this.displayManager.draw(screenX, screenY, symbols.wall, this.defaultFg, null);
                    } else { // Floor
                        this.displayManager.draw(screenX, screenY, symbols.floor, this.defaultFg, null);
                    }
                }
            }
        }
        
        // Draw entities with stacking (now with correct coordinate conversion)
        this._drawEntityStacked(centerX, centerY, playerX, playerY, gameState.entrance, symbols.entrance, gameState.visibleTiles);
        this._drawEntityStacked(centerX, centerY, playerX, playerY, gameState.exit, symbols.exit, gameState.visibleTiles);
        this._drawEntityStacked(centerX, centerY, playerX, playerY, gameState.treasure, symbols.treasure, gameState.visibleTiles);
        this._drawEntityStacked(centerX, centerY, playerX, playerY, gameState.monster, symbols.monster, gameState.visibleTiles);
        
        // Always draw player at center
        const baseTile = gameState.visibleTiles[playerY] && gameState.visibleTiles[playerY][playerX] === 1 ? 
                        symbols.wall : symbols.floor;
        this.displayManager.draw(centerX, centerY, [baseTile, symbols.player], 
                               [this.defaultFg, this.defaultFg], [null, null]);
    },

    _drawEntityStacked: function(centerX, centerY, playerX, playerY, entity, symbol, visibleTiles) {
        if (!entity) return;
        
        const entityX = Array.isArray(entity) ? entity[0] : entity.x;
        const entityY = Array.isArray(entity) ? entity[1] : entity.y;
        
        // Convert world coordinates to screen coordinates relative to player
        const screenX = centerX + (entityX - playerX);
        const screenY = centerY + (entityY - playerY);
        
        if (screenX >= 0 && screenY >= 0 && 
            screenX < this.displayManager.getScreenWidth() && 
            screenY < this.displayManager.getScreenHeight()) {
            
            // Check if entity is visible
            if (visibleTiles[entityY] && visibleTiles[entityY][entityX] !== undefined) {
                const baseTile = visibleTiles[entityY][entityX] === 1 ? 
                                this.displayManager.symbols.wall : this.displayManager.symbols.floor;
                
                this.displayManager.draw(screenX, screenY, [baseTile, symbol], 
                                       [this.defaultFg, this.defaultFg], [null, null]);
            }
        }
    }
};
