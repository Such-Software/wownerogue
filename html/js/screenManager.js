// ScreenManager - Handles different screen states and UI drawing
var ScreenManager = {
    defaultFg: "#FFF",
    _currentBlockHeight: 0,
    _blockTimer: null,
    _updateInterval: null,  // Track the update interval separately
    _waitingForBlock: false,
    _animationEnabled: true,
    _waitingAnimation: {
        frame: 0,
        playerX: 8,
        playerY: 12,
        monsterX: 5, 
        monsterY: 12,
        treasureX: 35,
        treasureY: 12,
        phase: 'enter',
        frameCount: 0,
        direction: 1
    },

    init: function(screenWidth, screenHeight) {
        this._screenWidth = screenWidth;
        this._screenHeight = screenHeight;
        this._currentBlockHeight = 0;
        this._waitingForBlock = false;
        this._updateInterval = null;  // Initialize update interval tracker
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
        DisplayManager.clearDisplay();
        
        // Draw the border
        this.drawBorder();
        
        // Draw content
        let y = 3;
        this.drawCenteredText(y, "WOWGUE");
        y += 4;
        
        // Draw instructions
        this.drawCenteredText(y, "Type enter to queue!");
        this.drawCenteredText(y + 1, "Or use START GAME");
        y += 3;
        
        // Draw legend with special tile handling
        const display = DisplayManager.getDisplay();
        const legendItems = [
            { tile: "@2", text: "This is you" },
            { tile: ">", text: " Escape the dungeon" }, 
            { tile: "~", text: " Avoid the monster" },
            { tile: "$M", text: "Secure the bag" }
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
        
        // Draw current block info
        y += 2;
        this.drawCenteredText(y, `Current Block: ${this._currentBlockHeight}`);
        
        // Control HTML button visibility
        const startButton = document.getElementById('startButton');
        if (startButton) {
            startButton.style.display = 'block';
        }
        
        // Hide animation button on welcome screen
        this.hideAnimationButton();
        
        // Debug button (shown only in development)
        const isDebugMode = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.protocol === 'file:';
        if (isDebugMode) {
            this.drawCenteredText(this._screenHeight - 3, "[DEBUG: Press D]");
        }
    },



    drawStaticWaitingScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();
        
        // Draw border
        this.drawBorder();
        
        let y = Math.floor(this._screenHeight / 2) - 2;
        this.drawCenteredText(y, "Waiting for next block...");
        this.drawCenteredText(y + 1, "Your game will start soon");
        
        // Draw a simple but elegant static dungeon scene
        const centerX = Math.floor(this._screenWidth / 2);
        const roomY = y + 3;
        
        // Draw a simple room outline
        const roomWidth = 12;
        const startX = centerX - Math.floor(roomWidth / 2);
        
        // Room walls
        for (let x = startX; x < startX + roomWidth; x++) {
            display.draw(x, roomY - 1, "#", "transparent", "transparent"); // Top wall
            display.draw(x, roomY + 1, "#", "transparent", "transparent"); // Bottom wall
        }
        display.draw(startX - 1, roomY, "#", "transparent", "transparent");     // Left wall
        display.draw(startX + roomWidth, roomY, "#", "transparent", "transparent"); // Right wall
        
        // Floor tiles
        for (let x = startX; x < startX + roomWidth; x++) {
            display.draw(x, roomY, GameTiles.getFloorTile(), "white", "transparent");
        }
        
        // Entrance and exit
        display.draw(startX - 2, roomY, "<", "transparent", "transparent");     // Entrance
        display.draw(startX + roomWidth + 1, roomY, ">", "transparent", "transparent"); // Exit
        
        // Characters in static positions
        display.draw(startX + 2, roomY, GameTiles.getPlayerTile(), "white", "transparent");     // Player
        display.draw(centerX, roomY, GameTiles.getTreasureTile(), "white", "transparent");        // Treasure
        display.draw(startX + roomWidth - 2, roomY, GameTiles.getMonsterTile(), "white", "transparent"); // Monster
        
        // Add some decorative floor elements
        display.draw(startX + 1, roomY, GameTiles.getFloorTile(true), "white", "transparent");     // Floor variation
        display.draw(startX + roomWidth - 1, roomY, GameTiles.getFloorTile(true), "white", "transparent"); // Floor variation
    },

    drawAnimatedWaitingScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();
        
        // Draw border
        this.drawBorder();
        
        // Fixed-position animated text
        let y = Math.floor(this._screenHeight / 2) - 8;
        const baseText = "Waiting for next block";
        const dots = ".".repeat((Math.floor(Date.now() / 500) % 4));
        const paddedDots = dots.padEnd(3, " ");
        this.drawCenteredText(y, `${baseText}${paddedDots}`);
        
        // ✨ EPIC DUNGEON SCENE WITH PROPER TRANSPARENCY ✨
        const roomStartX = 6;
        const roomEndX = 44;
        const roomStartY = 8;
        const roomEndY = 16;
        const time = Date.now();
        
        // 🏛️ BASE DUNGEON FLOOR - Dark stone with subtle variation
        for (let x = roomStartX; x <= roomEndX; x++) {
            for (let dy = roomStartY; dy <= roomEndY; dy++) {
                if (x >= 0 && x < this._screenWidth && dy >= 0 && dy < this._screenHeight) {
                    const floorTile = GameTiles.getFloorTile(true);
                    
                    // Dark atmospheric base - no white foregrounds!
                    const baseAlpha = 0.1 + Math.sin(x * 0.2 + dy * 0.3) * 0.05;
                    display.draw(x, dy, floorTile, `rgba(100, 80, 60, ${baseAlpha})`, "transparent");
                }
            }
        }
        
        // 🧱 DUNGEON WALLS - Ancient stone with moss
        for (let x = roomStartX - 1; x <= roomEndX + 1; x++) {
            if (x >= 0 && x < this._screenWidth) {
                const wallGlow = 0.2 + Math.sin(time * 0.001 + x * 0.1) * 0.1;
                display.draw(x, roomStartY - 1, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
                display.draw(x, roomEndY + 1, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
            }
        }
        for (let dy = roomStartY; dy <= roomEndY; dy++) {
            if (dy >= 0 && dy < this._screenHeight) {
                const wallGlow = 0.2 + Math.sin(time * 0.001 + dy * 0.1) * 0.1;
                display.draw(roomStartX - 1, dy, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
                display.draw(roomEndX + 1, dy, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
            }
        }
        
        // 🔥 MYSTICAL TORCHES - Dancing flames with heat distortion
        const torchPositions = [
            {x: roomStartX - 1, y: roomStartY + 2},
            {x: roomEndX + 1, y: roomStartY + 2},
            {x: roomStartX - 1, y: roomEndY - 2},
            {x: roomEndX + 1, y: roomEndY - 2}
        ];
        
        for (let i = 0; i < torchPositions.length; i++) {
            const torch = torchPositions[i];
            if (torch.x >= 0 && torch.x < this._screenWidth && torch.y >= 0 && torch.y < this._screenHeight) {
                // Main torch flame - animated intensity with tile stack
                const flameIntensity = 0.7 + Math.sin(time / 120 + i * 1.2) * 0.3;
                const flameColor = `rgba(255, ${100 + flameIntensity * 100}, 20, ${flameIntensity})`;
                
                // Use tile stack: wall + torch for proper layering
                const wallGlow = 0.2 + Math.sin(time * 0.001 + torch.x * 0.1) * 0.1;
                const ch = ["#", "torch"];
                const fg = [`rgba(80, 70, 50, ${wallGlow})`, flameColor];
                const bg = ["transparent", "transparent"];
                display.draw(torch.x, torch.y, ch, fg, bg);
                
                // Heat distortion around torch
                const heatPositions = [
                    {x: torch.x, y: torch.y - 1}, {x: torch.x, y: torch.y + 1},
                    {x: torch.x - 1, y: torch.y}, {x: torch.x + 1, y: torch.y}
                ];
                
                for (let heat of heatPositions) {
                    if (heat.x >= roomStartX && heat.x <= roomEndX && heat.y >= roomStartY && heat.y <= roomEndY) {
                        const shimmer = 0.1 + Math.sin(time / 80 + heat.x + heat.y) * 0.05;
                        const floorTile = GameTiles.getFloorTile();
                        display.draw(heat.x, heat.y, floorTile, `rgba(255, 150, 50, ${shimmer})`, "transparent");
                    }
                }
                
                // Torch light radius - warm orange glow
                const lightRadius = 3 + Math.sin(time / 200 + i) * 0.5;
                for (let lx = torch.x - 3; lx <= torch.x + 3; lx++) {
                    for (let ly = torch.y - 3; ly <= torch.y + 3; ly++) {
                        if (lx >= roomStartX && lx <= roomEndX && ly >= roomStartY && ly <= roomEndY) {
                            const dist = Math.sqrt((lx - torch.x) ** 2 + (ly - torch.y) ** 2);
                            if (dist <= lightRadius) {
                                const lightIntensity = Math.max(0, (lightRadius - dist) / lightRadius);
                                const warmth = 0.05 + lightIntensity * 0.15;
                                const floorTile = GameTiles.getFloorTile();
                                display.draw(lx, ly, floorTile, `rgba(255, 180, 80, ${warmth})`, "transparent");
                            }
                        }
                    }
                }
            }
        }
        
        // Update character positions
        this.updateWaitingAnimation();
        const anim = this._waitingAnimation;
        
        // 💎 LEGENDARY TREASURE - Pulsating with magical energy
        if (anim.treasureX >= 0 && anim.treasureX < this._screenWidth) {
            const treasurePulse = 0.6 + Math.sin(time / 250) * 0.4;
            const magicShimmer = Math.sin(time / 100) * 0.3 + 0.7;
            
            // Main treasure glow with tile stack
            const treasureGlow = `rgba(255, 215, 0, ${treasurePulse})`;
            const floorTile = GameTiles.getFloorTile();
            const baseAlpha = 0.1 + Math.sin(anim.treasureX * 0.2 + anim.treasureY * 0.3) * 0.05;
            const ch = [floorTile, GameTiles.getTreasureTile()];
            const fg = [`rgba(100, 80, 60, ${baseAlpha})`, treasureGlow];
            const bg = ["transparent", "transparent"];
            display.draw(anim.treasureX, anim.treasureY, ch, fg, bg);
            
            // Magic sparkles around treasure
            const sparklePositions = [
                {x: anim.treasureX - 1, y: anim.treasureY - 1},
                {x: anim.treasureX + 1, y: anim.treasureY + 1},
                {x: anim.treasureX - 1, y: anim.treasureY + 1},
                {x: anim.treasureX + 1, y: anim.treasureY - 1}
            ];
            
            for (let sparkle of sparklePositions) {
                if (sparkle.x >= roomStartX && sparkle.x <= roomEndX && sparkle.y >= roomStartY && sparkle.y <= roomEndY) {
                    const sparkleIntensity = Math.max(0, Math.sin(time / 150 + sparkle.x + sparkle.y) * 0.4);
                    if (sparkleIntensity > 0.2) {
                        const floorTile = GameTiles.getFloorTile();
                        display.draw(sparkle.x, sparkle.y, floorTile, `rgba(255, 255, 150, ${sparkleIntensity})`, "transparent");
                    }
                }
            }
        }
        
        // 🧙‍♂️ HEROIC PLAYER - Glowing with determination
        if (anim.playerX >= 0 && anim.playerX < this._screenWidth) {
            // Player aura - heroic blue/white glow
            const heroGlow = 0.4 + Math.sin(time / 300) * 0.2;
            const heroColor = `rgba(100, 150, 255, ${heroGlow})`;
            
            // Use tile stack: floor + player for proper layering
            const floorTile = GameTiles.getFloorTile();
            const baseAlpha = 0.1 + Math.sin(anim.playerX * 0.2 + anim.playerY * 0.3) * 0.05;
            const ch = [floorTile, "@"];
            const fg = [`rgba(100, 80, 60, ${baseAlpha})`, heroColor];
            const bg = ["transparent", "transparent"];
            display.draw(anim.playerX, anim.playerY, ch, fg, bg);
            
            // Light footsteps behind player
            if (anim.phase === 'enter' || anim.phase === 'escape') {
                const footstepX = anim.playerX - 1;
                if (footstepX >= roomStartX && footstepX <= roomEndX) {
                    const footstepGlow = Math.max(0, Math.sin(time / 400) * 0.2);
                    const floorTile = GameTiles.getFloorTile();
                    display.draw(footstepX, anim.playerY, floorTile, `rgba(150, 200, 255, ${footstepGlow})`, "transparent");
                }
            }
        }
        
        // 👹 TERRIFYING MONSTER - Darkness incarnate with red menace
        if (anim.monsterX >= 0 && anim.monsterX < this._screenWidth) {
            // Monster's menacing red glow - more intense than before
            const menacePulse = 0.3 + Math.sin(time / 180) * 0.4;
            const fearColor = `rgba(255, 30, 30, ${menacePulse})`;
            
            // Use tile stack: floor + monster for proper layering
            const floorTile = GameTiles.getFloorTile();
            const baseAlpha = 0.1 + Math.sin(anim.monsterX * 0.2 + anim.monsterY * 0.3) * 0.05;
            const ch = [floorTile, "~"];
            const fg = [`rgba(100, 80, 60, ${baseAlpha})`, fearColor];
            const bg = ["transparent", "transparent"];
            display.draw(anim.monsterX, anim.monsterY, ch, fg, bg);
            
            // Spreading darkness around monster
            const shadowRadius = 2 + Math.sin(time / 220) * 0.5;
            for (let sx = anim.monsterX - 2; sx <= anim.monsterX + 2; sx++) {
                for (let sy = anim.monsterY - 2; sy <= anim.monsterY + 2; sy++) {
                    if (sx >= roomStartX && sx <= roomEndX && sy >= roomStartY && sy <= roomEndY) {
                        const dist = Math.sqrt((sx - anim.monsterX) ** 2 + (sy - anim.monsterY) ** 2);
                        if (dist <= shadowRadius && !(sx === anim.monsterX && sy === anim.monsterY)) {
                            const shadowIntensity = Math.max(0, (shadowRadius - dist) / shadowRadius * 0.3);
                            const darkPulse = Math.sin(time / 300 + dist) * 0.1;
                            const floorTile = GameTiles.getFloorTile();
                            display.draw(sx, sy, floorTile, `rgba(100, 0, 0, ${shadowIntensity + darkPulse})`, "transparent");
                        }
                    }
                }
            }
        }
        
        // 🚪 MYSTICAL PORTALS - Entrance and exit with swirling energy
        const portalPulse = 0.3 + Math.sin(time / 400) * 0.2;
        const entranceGlow = `rgba(50, 255, 50, ${portalPulse})`;  // Green entrance
        const exitGlow = `rgba(255, 100, 255, ${portalPulse})`;    // Purple exit
        
        display.draw(roomStartX - 1, 12, '<', entranceGlow, "transparent");
        display.draw(roomEndX + 1, 12, '>', exitGlow, "transparent");
    },

    updateWaitingAnimation: function() {
        const anim = this._waitingAnimation;
        anim.frameCount++;
        
        // Smooth animation timing - update every 4 frames for fluid movement
        if (anim.frameCount % 4 !== 0) return;
        
        switch(anim.phase) {
            case 'enter':
                // Player enters from left, smooth movement toward treasure
                if (anim.playerX < anim.treasureX - 2) {
                    anim.playerX++;
                } else {
                    anim.phase = 'monster_enter';
                }
                break;
                
            case 'monster_enter':
                // Monster enters and starts chase
                if (anim.monsterX < anim.playerX - 3) {
                    anim.monsterX++;
                } else {
                    anim.phase = 'chase';
                }
                break;
                
            case 'chase':
                // Dramatic chase sequence - both moving
                if (anim.playerX < anim.treasureX) {
                    anim.playerX++;
                    if (anim.monsterX < anim.playerX - 2) {
                        anim.monsterX++;
                    }
                } else {
                    anim.treasureX = -1; // Player gets treasure
                    anim.phase = Math.random() < 0.7 ? 'escape' : 'caught';
                }
                break;
                
            case 'escape':
                // Player successfully escapes with treasure
                if (anim.playerX < 46) {
                    anim.playerX++;
                    if (anim.monsterX < anim.playerX - 1) {
                        anim.monsterX++;
                    }
                } else {
                    anim.phase = 'exit';
                }
                break;
                
            case 'caught':
                // Monster catches player - dramatic end
                if (anim.monsterX < anim.playerX) {
                    anim.monsterX++;
                } else {
                    anim.playerX = -1; // Player vanishes
                    anim.phase = 'exit';
                }
                break;
                
            case 'exit':
                // Brief pause then reset
                if (anim.frameCount > anim.frameCount + 20) {
                    this.resetWaitingAnimation();
                } else {
                    // Monster exits
                    if (anim.monsterX < 48) {
                        anim.monsterX++;
                    }
                }
                break;
        }
    },

    resetWaitingAnimation: function() {
        this._waitingAnimation = {
            frame: 0,
            playerX: 8,     // Start near entrance
            playerY: 12,
            monsterX: 5,    // Start at entrance
            monsterY: 12,
            treasureX: 35,  // Treasure near exit
            treasureY: 12,
            phase: 'enter',
            frameCount: 0,
            direction: 1
        };
    },

    toggleAnimation: function() {
        this._animationEnabled = !this._animationEnabled;
        console.log("Animation toggled:", this._animationEnabled ? "enabled" : "disabled");
        
        if (!this._animationEnabled) {
            this.resetWaitingAnimation();
        }
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

        let y = Math.floor(this._screenHeight / 3);
        this.drawCenteredText(y, "CONGRATULATIONS!");
        
        if (hasTreasure) {
            this.drawCenteredText(y + 2, "You escaped with the treasure!");
        } else {
            this.drawCenteredText(y + 2, "You escaped the dungeon!");
        }
        this.drawCenteredText(y + 3, "A true hero of Wownero!");
    },

    drawLoseScreen: function(reason) {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();

                let y = Math.floor(this._screenHeight / 3);
        this.drawCenteredText(y, "YOU HAVE PERISHED");
        
        if (reason === 'monster') {
            this.drawCenteredText(y + 2, "Slain by a fearsome beast.");
        } else if (reason === 'timeout') {
            this.drawCenteredText(y + 2, "The dungeon claimed you before the next block.");
        } else {
            this.drawCenteredText(y + 2, "Your adventure ends here.");
        }
        this.drawCenteredText(y + 3, "Better luck next time.");
    },

    drawWaitingScreen: function() {
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();
        
        console.log("🎬 Drawing waiting screen, animation enabled:", this._animationEnabled);
        
        if (this._animationEnabled) {
            this.drawAnimatedWaitingScreen();
        } else {
            this.drawStaticWaitingScreen();
        }
        
        // Show the animation toggle button
        this.showAnimationButton();
        
        // Start animation loop if not already running
        if (this._animationEnabled && !this._waitingAnimationInterval) {
            this.startWaitingAnimation();
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
            animButton.textContent = this._animationEnabled ? '🎬 DISABLE ANIMATION' : '🎬 ENABLE ANIMATION';
            console.log("✅ Animation button shown:", animButton.textContent);
        } else {
            console.warn("❌ Animation button element not found!");
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
            console.warn("🔧 Animation button not found, checking if it exists in DOM...");
            // Try to find it by class or create it if missing
            const statusDiv = document.querySelector('.status');
            if (statusDiv) {
                const existingButtons = statusDiv.querySelectorAll('button');
                console.log("Found buttons in status div:", existingButtons.length);
                for (let btn of existingButtons) {
                    console.log("Button:", btn.id, btn.textContent);
                }
            }
            return false;
        }
        
        return true;
    },

    startWaitingAnimation: function() {
        // Clear any existing interval
        if (this._waitingAnimationInterval) {
            clearInterval(this._waitingAnimationInterval);
        }
        
        // Start new animation loop
        this._waitingAnimationInterval = setInterval(() => {
            if (this._animationEnabled && !GameState.isGameActive()) {
                this.drawWaitingScreen();
            } else {
                this.stopWaitingAnimation();
            }
        }, 100); // 10 FPS animation
    },

    stopWaitingAnimation: function() {
        if (this._waitingAnimationInterval) {
            clearInterval(this._waitingAnimationInterval);
            this._waitingAnimationInterval = null;
        }
        this.resetWaitingAnimation();
    },

    stopWaitingScreen: function() {
        this.stopWaitingAnimation();
        this.hideAnimationButton();
        if (!DisplayManager.ensureDisplay()) return;
        DisplayManager.clearDisplay();
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.ScreenManager = ScreenManager;
}
