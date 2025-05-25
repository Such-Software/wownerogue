// RenderEngine - Handles game screen rendering and drawing logic
var RenderEngine = {
    defaultFg: "#FFF",

    init: function(screenWidth, screenHeight) {
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;
    },

    isVisible: function(x, y, visibleTiles) {
        return visibleTiles[y] && visibleTiles[y][x] !== undefined;
    },

    drawGameScreen: function(gameState) {
        if (!DisplayManager.ensureDisplay()) return;
        
        const display = DisplayManager.getDisplay();
        const player = gameState.player;
        const monster = gameState.monster;
        const items = gameState.items;
        const entrance = gameState.entrance;
        const exit = gameState.exit;
        const treasure = gameState.treasure;
        const visibleTiles = gameState.visibleTiles;
        const exploredTiles = gameState.exploredTiles;
        const message = gameState.message;
        
        const playerWX = player.x;
        const playerWY = player.y;
        const centerX = Math.floor(this._screenWidth / 2);
        const centerY = Math.floor(this._screenHeight / 2);

        const topLeftWX = playerWX - centerX;
        const topLeftWY = playerWY - centerY;

        for (let sy = 0; sy < this._screenHeight; sy++) {
            for (let sx = 0; sx < this._screenWidth; sx++) {
                const wx = topLeftWX + sx;
                const wy = topLeftWY + sy;

                let charStack = [];
                let fgStack = []; 
                let bgStack = []; 

                let baseChar = ' ';
                let baseFg = this.defaultFg;
                let tileType;

                // Render base terrain
                if (this.isVisible(wx, wy, visibleTiles)) {
                    tileType = visibleTiles[wy][wx];
                    baseFg = this.defaultFg;
                    
                    // Fix: Handle all possible tile values explicitly and ensure they map to valid characters
                    if (tileType === 1) {
                        baseChar = '#'; // Wall
                    } else if (tileType === 0) {
                        baseChar = "'"; // Floor
                    } else {
                        baseChar = "'"; // Default to floor for safety
                        tileType = 0;
                    }
                } else if (exploredTiles[wy] && exploredTiles[wy][wx] !== undefined) {
                    tileType = exploredTiles[wy][wx];
                    baseFg = this.defaultFg;
                    
                    // Fix: Handle all possible tile values explicitly for explored tiles too
                    if (tileType === 1) {
                        baseChar = '#'; // Wall
                    } else if (tileType === 0) {
                        baseChar = "'"; // Floor
                    } else {
                        baseChar = "'"; // Default to floor for safety
                        tileType = 0;
                    }
                } else {
                    // No visible or explored tile - render empty space
                    baseChar = ' ';
                    baseFg = this.defaultFg;
                }
                
                // Only add to stacks if we have a valid character
                if (baseChar && baseChar !== ' ') {
                    charStack.push(baseChar);
                    fgStack.push("transparent"); // Use transparent for all base tiles
                    bgStack.push("transparent"); // Use transparent for all base tiles
                }

                // Render items
                if (items) {
                    for (const itemKey in items) {
                        if (items.hasOwnProperty(itemKey)) {
                            const currentItem = items[itemKey];
                            if (currentItem && currentItem.x === wx && currentItem.y === wy && this.isVisible(wx, wy, visibleTiles)) {
                                charStack.push('$');
                                fgStack.push("transparent"); // Use transparent for now
                                bgStack.push("transparent");
                            }
                        }
                    }
                }
                
                // Render entrance
                if (entrance && entrance[0] === wx && entrance[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('<');
                    fgStack.push("transparent"); // Use transparent for now
                    bgStack.push("transparent");
                }
                
                // Render exit
                if (exit && exit[0] === wx && exit[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('>');
                    fgStack.push("transparent"); // Use transparent for now
                    bgStack.push("transparent");
                }
                
                // Render treasure
                if (treasure && treasure[0] === wx && treasure[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('$');
                    fgStack.push("transparent"); // Use transparent for now
                    bgStack.push("transparent");
                }
                
                // Render monster
                if (monster && monster.x === wx && monster.y === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('~'); 
                    fgStack.push("transparent"); // Use transparent for now
                    bgStack.push("transparent");
                }
                
                // Render player (always on top)
                if (wx === playerWX && wy === playerWY) {
                    charStack.push('@'); 
                    fgStack.push("transparent"); // Use transparent for now
                    bgStack.push("transparent");
                }
                
                if (charStack.length > 0) {
                    // Validate array lengths
                    while (fgStack.length < charStack.length) fgStack.push("transparent");
                    while (bgStack.length < charStack.length) bgStack.push("transparent");
                    
                    // Validate characters are in tileMap
                    for (let i = 0; i < charStack.length; i++) {
                        if (!charStack[i] || (window.options?.tileMap && !window.options.tileMap.hasOwnProperty(charStack[i]))) {
                            charStack[i] = "'";
                        }
                        if (!fgStack[i]) fgStack[i] = "transparent";
                        if (!bgStack[i]) bgStack[i] = "transparent";
                    }
                    
                    try {
                        display.draw(sx, sy, charStack, fgStack, bgStack);
                    } catch (error) {
                        display.draw(sx, sy, ["'"], ["transparent"], ["transparent"]);
                    }
                }
            }
        }

        // Render message at bottom if present
        if (message) {
            ScreenManager.drawCenteredText(this._screenHeight - 1, message);
        }
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.RenderEngine = RenderEngine;
}
