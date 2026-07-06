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
        
        // Ensure we have a clean display first
        DisplayManager.clearDisplay();
        
        const display = DisplayManager.getDisplay();
        const player = gameState.player;
        const monster = gameState.monster;
        const items = gameState.items;
        const entrance = gameState.entrance;
        const exit = gameState.exit;
        const treasure = gameState.treasure;
        const torches = gameState.torches || []; // New torch positions
        const visibleTiles = gameState.visibleTiles || {};
        const exploredTiles = gameState.exploredTiles || {};
        const lighting = gameState.lighting || {}; // Lighting data from server
        const message = gameState.message;
        
        // Get configured tile types from options
        const playerTile = window.GameTiles ? window.GameTiles.getPlayerTile() : '@';
        const treasureTile = window.GameTiles ? window.GameTiles.getTreasureTile() : '$W';
        const monsterTile = window.GameTiles ? window.GameTiles.getMonsterTile() : '~';
        const torchTile = window.GameTiles ? window.GameTiles.getTorchTile() : 'torch';
        
        const playerWX = player.x;
        const playerWY = player.y;
        const centerX = Math.floor(this._screenWidth / 2);
        const centerY = Math.floor(this._screenHeight / 2);
        const avatarOverlayReady = !!(window.SinglePlayerAvatar &&
            window.SinglePlayerAvatar.canDrawPlayer &&
            window.SinglePlayerAvatar.canDrawPlayer(gameState));

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

                // Debug log for a specific tile if needed - replace with actual test coordinates
                // const wx_test = 10, wy_test = 10; // Example coordinates
                // if (wx === wx_test && wy === wy_test) {
                //     console.log(`RenderEngine DEBUG: Tile (${wx},${wy}) raw lighting data: ${lighting[wy] ? lighting[wy][wx] : 'N/A'}`);
                // }

                // Render base terrain
                if (this.isVisible(wx, wy, visibleTiles)) {
                    tileType = visibleTiles[wy][wx];
                    baseFg = this.defaultFg;
                    
                    // Handle new string-based tile system
                    if (tileType === '#') {
                        baseChar = '#'; // Wall
                    } else if (tileType === "'1" || tileType === "'2") {
                        baseChar = tileType; // Use the specific floor tile type
                    } else if (tileType === 'torch') {
                        baseChar = '#'; // Torch tiles are walls with torches on top
                    } else if (tileType === 1) {
                        baseChar = '#'; // Legacy wall support
                    } else if (tileType === 0) {
                        baseChar = "'1"; // Legacy floor support - use primary floor
                    } else {
                        // Use the tile type directly if it's a string
                        baseChar = tileType || "'1"; // Default to primary floor for safety
                    }
                    
                } else if (exploredTiles[wy] && exploredTiles[wy][wx] !== undefined) {
                    tileType = exploredTiles[wy][wx];
                    baseFg = this.defaultFg;
                    
                    // Handle new string-based tile system for explored tiles
                    if (tileType === '#') {
                        baseChar = '#'; // Wall
                    } else if (tileType === "'1" || tileType === "'2") {
                        baseChar = tileType; // Use the specific floor tile type
                    } else if (tileType === 'torch') {
                        baseChar = '#'; // Torch tiles are walls with torches on top
                    } else if (tileType === 1) {
                        baseChar = '#'; // Legacy wall support
                    } else if (tileType === 0) {
                        baseChar = "'1"; // Legacy floor support - use primary floor
                    } else {
                        // Use the tile type directly if it's a string
                        baseChar = tileType || "'1"; // Default to primary floor for safety
                    }
                } else {
                    // No visible or explored tile - render empty space
                    baseChar = ' ';
                    baseFg = this.defaultFg;
                }
                
                // Only add to stacks if we have a valid character
                if (baseChar && baseChar !== ' ') {
                    charStack.push(baseChar);
                    
                    // Get lighting information for this tile
                    const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                    
                    // Apply lighting shadows for terrain
                    const isCurrentlyVisible = this.isVisible(wx, wy, visibleTiles);

                    // Added log to inspect lightingAlpha for visible, lit tiles
                    // if (isCurrentlyVisible && lightingAlpha > 0.01) { // Using 0.01 to catch small, non-zero alphas
                    //     console.log(`RenderEngine TRACE: Tile (${wx},${wy}), Visible: ${isCurrentlyVisible}, lightingAlpha: ${lightingAlpha.toFixed(3)}, from: ${lighting[wy] ? lighting[wy][wx].toFixed(3) : 'N/A'}`);
                    // }

                    if (isCurrentlyVisible) {
                        if (lightingAlpha > 0) {
                            // Apply torch shadow using foreground overlay
                            fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                        } else {
                            // Normal tile with no shadow
                            fgStack.push("transparent");
                        }
                    } else {
                        // Explored but not currently visible - apply darker shadow
                        fgStack.push(`rgba(0, 0, 0, 0.7)`);
                    }
                    
                    bgStack.push("transparent"); // Always transparent background for terrain
                }

                // Render items
                if (items) {
                    for (const itemKey in items) {
                        if (items.hasOwnProperty(itemKey)) {
                            const currentItem = items[itemKey];
                            if (currentItem && currentItem.x === wx && currentItem.y === wy && this.isVisible(wx, wy, visibleTiles)) {
                                charStack.push('$');
                                // Apply torch lighting to items
                                const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                                if (lightingAlpha > 0) {
                                    fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                                } else {
                                    fgStack.push("transparent");
                                }
                                bgStack.push("transparent");
                            }
                        }
                    }
                }
                
                // Render entrance
                if (entrance && entrance[0] === wx && entrance[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('<');
                    // Apply torch lighting to entrance
                    const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                    if (lightingAlpha > 0) {
                        fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                    } else {
                        fgStack.push("transparent");
                    }
                    bgStack.push("transparent");
                }
                
                // Render exit
                if (exit && exit[0] === wx && exit[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push('>');
                    // Apply torch lighting to exit
                    const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                    if (lightingAlpha > 0) {
                        fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                    } else {
                        fgStack.push("transparent");
                    }
                    bgStack.push("transparent");
                }
                
                // Render treasure
                if (treasure && treasure[0] === wx && treasure[1] === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push(treasureTile);
                    // Apply torch lighting to treasure
                    const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                    if (lightingAlpha > 0) {
                        fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                    } else {
                        fgStack.push("transparent");
                    }
                    bgStack.push("transparent");
                }
                
                // Render torches (check if this tile has a torch)
                if (this.isVisible(wx, wy, visibleTiles) && visibleTiles[wy][wx] === 'torch') {
                    charStack.push(torchTile);
                    // Don't apply shadows to torches since they're light sources
                    fgStack.push("transparent");
                    bgStack.push("transparent");
                }
                
                // Render monster
                if (monster && monster.x === wx && monster.y === wy && this.isVisible(wx, wy, visibleTiles)) {
                    charStack.push(monsterTile); 
                    // Apply torch lighting to monster
                    const lightingAlpha = (lighting[wy] && lighting[wy][wx]) ? lighting[wy][wx] : 0.0;
                    if (lightingAlpha > 0) {
                        fgStack.push(`rgba(0, 0, 0, ${Math.min(lightingAlpha, 0.8)})`);
                    } else {
                        fgStack.push("transparent");
                    }
                    bgStack.push("transparent");
                }
                
                // Render player (always on top)
                if (wx === playerWX && wy === playerWY) {
                    if (!avatarOverlayReady) {
                        charStack.push(playerTile);
                        // Don't apply shadows to player - keep them clearly visible
                        fgStack.push("transparent");
                        bgStack.push("transparent");
                    }
                }
                
                if (charStack.length > 0) {
                    // Validate array lengths
                    while (fgStack.length < charStack.length) fgStack.push("transparent");
                    while (bgStack.length < charStack.length) bgStack.push("transparent");
                    
                    // Validate characters are in tileMap
                    for (let i = 0; i < charStack.length; i++) {
                        if (!charStack[i] || (window.options?.tileMap && !window.options.tileMap.hasOwnProperty(charStack[i]))) {
                            // Default to primary floor if tile not found
                            charStack[i] = "'1";
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

        if (avatarOverlayReady && window.SinglePlayerAvatar.drawPlayer) {
            window.SinglePlayerAvatar.drawPlayer(gameState, {
                screenX: centerX,
                screenY: centerY,
                cell: window.options ? window.options.tileWidth : 32
            });
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
