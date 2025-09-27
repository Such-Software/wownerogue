// WaitingScreenAnimator - Handles waiting screen animations and visual effects
var WaitingScreenAnimator = {
    _animationEnabled: true,
    _waitingAnimationInterval: null,
    _animating: false,
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

    init: function() {
        this._animationEnabled = true;
        this._waitingAnimationInterval = null;
        this.resetAnimation();
    },

    drawStaticWaitingScreen: function(screenWidth, screenHeight, drawBorderFn, drawCenteredTextFn) {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();
        
        // Draw border
        drawBorderFn();
        
        let y = Math.floor(screenHeight / 2) - 2;
        drawCenteredTextFn(y, "Waiting for next block...");
        drawCenteredTextFn(y + 1, "Your game will start soon");
        
        // Draw a simple but elegant static dungeon scene
        const centerX = Math.floor(screenWidth / 2);
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

    drawAnimatedWaitingScreen: function(screenWidth, screenHeight, drawBorderFn, drawCenteredTextFn) {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();
        
        // Draw border
        drawBorderFn();
        
        // Fixed-position animated text
        let y = Math.floor(screenHeight / 2) - 8;
        let baseText = "Awaiting next block";
        if (typeof Game !== 'undefined') {
            if (Game._awaitingPayment) baseText = 'Awaiting payment';
            else if (Game._unconfirmedPayment) baseText = 'Awaiting next block'; // mempool seen
        }
        const dots = ".".repeat((Math.floor(Date.now() / 500) % 4));
        const paddedDots = dots.padEnd(3, " ");
        drawCenteredTextFn(y, `${baseText}${paddedDots}`);
        
        // ✨ EPIC DUNGEON SCENE WITH PROPER TRANSPARENCY ✨
        const roomStartX = 6;
        const roomEndX = 44;
        const roomStartY = 8;
        const roomEndY = 16;
        const time = Date.now();
        
        // 🏛️ BASE DUNGEON FLOOR - Dark stone with subtle variation
        for (let x = roomStartX; x <= roomEndX; x++) {
            for (let dy = roomStartY; dy <= roomEndY; dy++) {
                if (x >= 0 && x < screenWidth && dy >= 0 && dy < screenHeight) {
                    const floorTile = GameTiles.getFloorTile(true);
                    
                    // Dark atmospheric base - no white foregrounds!
                    const baseAlpha = 0.1 + Math.sin(x * 0.2 + dy * 0.3) * 0.05;
                    display.draw(x, dy, floorTile, `rgba(100, 80, 60, ${baseAlpha})`, "transparent");
                }
            }
        }
        
        // 🧱 DUNGEON WALLS - Ancient stone with moss
        for (let x = roomStartX; x <= roomEndX; x++) {
            if (x >= 0 && x < screenWidth) {
                const wallGlow = 0.2 + Math.sin(time * 0.001 + x * 0.1) * 0.1;
                display.draw(x, roomStartY - 1, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
                display.draw(x, roomEndY + 1, "#", `rgba(80, 70, 50, ${wallGlow})`, "transparent");
            }
        }
        for (let dy = roomStartY; dy <= roomEndY; dy++) {
            if (dy >= 0 && dy < screenHeight) {
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
            if (torch.x >= 0 && torch.x < screenWidth && torch.y >= 0 && torch.y < screenHeight) {
                // Main torch flame - animated intensity with tile stack
                const flameIntensity = 0.6 + Math.sin(time / 200 + i) * 0.4;
                const flameColor = `rgba(255, ${100 + flameIntensity * 100}, 20, ${flameIntensity})`;
                const wallGlow = 0.2 + Math.sin(time * 0.001 + torch.x * 0.1) * 0.1;
                const wallColor = `rgba(80, 70, 50, ${wallGlow})`;
                
                // Use tile stack for proper layering: wall + torch
                const ch = ["#", "torch"];
                const fg = [wallColor, flameColor];
                const bg = ["transparent", "transparent"];
                display.draw(torch.x, torch.y, ch, fg, bg);
                
                // Light pool around torch - warm orange glow
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
        this.updateAnimation();
        const anim = this._waitingAnimation;
        
        // 💎 LEGENDARY TREASURE - Pulsating with magical energy
        if (anim.treasureX >= 0 && anim.treasureX < screenWidth) {
            // Treasure magical effects - golden glow with sparkles
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
        if (anim.playerX >= 0 && anim.playerX < screenWidth) {
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
            
            // Bright ethereal footsteps / halo around player to indicate "primed" status
            if (anim.phase === 'enter' || anim.phase === 'escape' || anim.phase === 'chase') {
                const ringPulse = 0.35 + Math.sin(time / 250) * 0.25; // stronger, faster pulse
                const innerPulse = 0.15 + Math.sin(time / 180 + 1.2) * 0.15;
                const ringColor = (alpha) => `rgba(180, 230, 255, ${alpha})`;
                const floorTile = GameTiles.getFloorTile();

                // 8-way surrounding ring
                const ringOffsets = [
                    {dx: -1, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: -1}, {dx: 0, dy: 1}, // cardinal
                    {dx: -1, dy: -1}, {dx: 1, dy: -1}, {dx: -1, dy: 1}, {dx: 1, dy: 1} // diagonal
                ];
                for (let i = 0; i < ringOffsets.length; i++) {
                    const rx = anim.playerX + ringOffsets[i].dx;
                    const ry = anim.playerY + ringOffsets[i].dy;
                    if (rx >= roomStartX && rx <= roomEndX && ry >= roomStartY && ry <= roomEndY) {
                        // subtle variation per tile
                        const phaseShift = (i / ringOffsets.length) * Math.PI * 2;
                        const alpha = (ringPulse * 0.6) + Math.sin(time / 300 + phaseShift) * 0.15;
                        display.draw(rx, ry, floorTile, ringColor(Math.max(0, alpha)), 'transparent');
                    }
                }

                // Trailing footprint path (a few tiles behind)
                for (let trail = 1; trail <= 3; trail++) {
                    const tx = anim.playerX - trail;
                    const ty = anim.playerY;
                    if (tx >= roomStartX && tx <= roomEndX && ty >= roomStartY && ty <= roomEndY) {
                        const decay = Math.max(0, 0.5 - trail * 0.15);
                        const alpha = innerPulse * decay;
                        if (alpha > 0.03) {
                            display.draw(tx, ty, floorTile, `rgba(120, 200, 255, ${alpha})`, 'transparent');
                        }
                    }
                }
            }
        }
        
        // 👹 TERRIFYING MONSTER - Darkness incarnate with red menace
        if (anim.monsterX >= 0 && anim.monsterX < screenWidth) {
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

    updateAnimation: function() {
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
                if (anim.exitStartFrame === undefined) {
                    anim.exitStartFrame = anim.frameCount;
                }
                if (anim.frameCount - anim.exitStartFrame > 40) { // ~4s at 10fps
                    this.resetAnimation();
                } else {
                    if (anim.monsterX < 48) {
                        anim.monsterX++;
                    }
                }
                break;
        }
    },

    resetAnimation: function() {
        // Track cycle count for variation
        if (typeof this._cycleCount === 'undefined') this._cycleCount = 0;
        this._cycleCount++;

        // Random variant selection after first loop
        const variant = this._cycleCount === 1 ? 'classic' : (Math.random() < 0.33 ? 'reverse' : (Math.random() < 0.5 ? 'race' : 'ambush'));
        const basePlayerX = 8;
        const baseMonsterX = 5;
        let playerStart = basePlayerX;
        let monsterStart = baseMonsterX;
        let treasureX = 35;
        let initialPhase = 'enter';

        switch(variant) {
            case 'reverse':
                // Swap sides: player closer to treasure, monster further back
                playerStart = 25 + Math.floor(Math.random()*4);
                monsterStart = playerStart - 10;
                treasureX = playerStart + 5 + Math.floor(Math.random()*3);
                break;
            case 'race':
                // Both start near entrance racing for treasure
                playerStart = 6;
                monsterStart = 4;
                treasureX = 40 + Math.floor(Math.random()*3);
                break;
            case 'ambush':
                // Monster waits near treasure
                playerStart = 8;
                monsterStart = 30 + Math.floor(Math.random()*3);
                treasureX = monsterStart + 3;
                initialPhase = 'chase'; // jump into chase faster
                break;
            default:
                // classic
                break;
        }

        this._waitingAnimation = {
            frame: 0,
            playerX: playerStart,     // variant start
            playerY: 12,
            monsterX: monsterStart,    // variant start
            monsterY: 12,
            treasureX: treasureX,  // variant treasure
            treasureY: 12,
            phase: initialPhase,
            frameCount: 0,
            direction: 1
        };
    },

    toggleAnimation: function() {
        this._animationEnabled = !this._animationEnabled;
        console.log("WaitingScreenAnimator: Animation toggled:", this._animationEnabled ? "enabled" : "disabled");
        
        if (!this._animationEnabled) {
            this.resetAnimation();
        }
        
        return this._animationEnabled;
    },

    startAnimation: function() {
        if (this._animating) return; // already running
        // Clear any existing interval defensively
        if (this._waitingAnimationInterval) {
            clearInterval(this._waitingAnimationInterval);
        }
        this._animating = true;
        this._waitingAnimationInterval = setInterval(() => {
            if (this._animationEnabled && !GameState.isGameActive()) {
                // Draw only the animated frame WITHOUT restarting the loop (avoid recursion)
                if (typeof ScreenManager !== 'undefined' && ScreenManager.drawWaitingScreen) {
                    ScreenManager.drawWaitingScreen(true); // pass flag to skip auto-start
                }
            } else {
                this.stopAnimation();
            }
        }, 100); // 10 FPS
    },

    stopAnimation: function() {
        if (this._waitingAnimationInterval) {
            clearInterval(this._waitingAnimationInterval);
            this._waitingAnimationInterval = null;
        }
        this._animating = false;
        this.resetAnimation();
    },

    isAnimationEnabled: function() {
        return this._animationEnabled;
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.WaitingScreenAnimator = WaitingScreenAnimator;
}
