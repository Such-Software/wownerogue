// WaitingScreenAnimator - Handles waiting screen animations and visual effects
var WaitingScreenAnimator = {
    _animationEnabled: true,
    _waitingAnimationInterval: null,
    _animating: false,
    // GFX3: FX overlay ambient state (additive; no-op unless window.FX exists)
    _fxAmbientOn: false,
    _fxTick: 0,
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
    // Separate animation state for "Awaiting payment" treasure hunt
    _paymentAnimation: {
        playerX: 8,
        playerY: 12,
        treasureX: 25,
        treasureY: 12,
        monsters: [], // pack of monsters {x, y}
        phase: 'approach', // approach, grab, escape, devoured
        frameCount: 0,
        outcome: 'escape', // pre-determined: 'escape' or 'devoured'
        treasureScale: 1.0, // for pulsing effect
        hasTreasure: false
    },

    init: function() {
        this._animationEnabled = true;
        this._waitingAnimationInterval = null;
        this.resetAnimation();
        this.resetPaymentAnimation();
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

    // ===== GFX3: FX overlay helpers (additive, always guarded) =====
    _fxBaseCanvas: function() {
        try {
            var d = (typeof DisplayManager !== 'undefined' && DisplayManager.getDisplay)
                ? DisplayManager.getDisplay() : null;
            return (d && d.getContainer) ? d.getContainer() : null;
        } catch (e) { return null; }
    },

    // Turn on the torchlight gradient + drifting embers overlay behind the
    // scripted char-cell waiting animation. No-op unless window.FX is present.
    _startAmbientFX: function() {
        if (!window.FX) return;
        if (this._fxAmbientOn) return;
        var canvas = this._fxBaseCanvas();
        if (!canvas) return;
        try {
            if (window.FX.attach) window.FX.attach(canvas);
            if (window.FX.syncTo) window.FX.syncTo(canvas);
            if (window.FX.setAmbient) window.FX.setAmbient(true);
            if (window.FX.start) window.FX.start();
            this._fxAmbientOn = true;
        } catch (e) { /* additive: never break the waiting screen */ }
    },

    _stopAmbientFX: function() {
        this._fxAmbientOn = false;
        if (!window.FX) return;
        try {
            if (window.FX.setAmbient) window.FX.setAmbient(false);
            if (window.FX.stop) window.FX.stop();
            if (window.FX.clear) window.FX.clear();
        } catch (e) { /* ignore */ }
    },

    // Emit gentle amber embers rising from the scripted torch positions.
    // Throttled so we don't flood the FX particle system.
    _emitTorchEmbers: function(torchPositions, screenWidth, screenHeight) {
        if (!window.FX || !window.FX.sparkle) return;
        if (!torchPositions || !torchPositions.length) return;
        var canvas = this._fxBaseCanvas();
        if (!canvas || !screenWidth || !screenHeight) return;
        this._fxTick = (this._fxTick + 1) % 1000000;
        // Only emit on every 3rd frame to keep the embers subtle.
        if (this._fxTick % 3 !== 0) return;
        var cellW = canvas.width / screenWidth;
        var cellH = canvas.height / screenHeight;
        // One torch per emit, cycling through the scripted positions.
        var t = torchPositions[this._fxTick % torchPositions.length];
        if (!t) return;
        if (t.x < 0 || t.x >= screenWidth || t.y < 0 || t.y >= screenHeight) return;
        var px = (t.x + 0.5) * cellW;
        var py = (t.y + 0.5) * cellH;
        try {
            window.FX.sparkle(px, py, 'rgba(255, 170, 60, 0.9)');
        } catch (e) { /* ignore */ }
    },

    // JUICE: a one-shot particle burst at a grid cell (treasure grab / escape / death). Purely
    // additive over window.FX — no-op if FX is absent — and tile-agnostic, so it works identically
    // in every pack (it draws particles, never tiles). `spread` in grid cells, `count` particles.
    _burst: function(gridX, gridY, color, count, screenWidth, screenHeight, spread) {
        if (!window.FX || !window.FX.sparkle) return;
        var canvas = this._fxBaseCanvas();
        if (!canvas || !screenWidth || !screenHeight) return;
        var cellW = canvas.width / screenWidth;
        var cellH = canvas.height / screenHeight;
        var s = spread || 1.6;
        for (var i = 0; i < count; i++) {
            var a = (i / count) * Math.PI * 2 + (this._fxTick || 0) * 0.3;
            var r = ((i * 2654435761 % 100) / 100) * s; // deterministic-ish scatter, no Math.random churn
            var px = (gridX + 0.5 + Math.cos(a) * r) * cellW;
            var py = (gridY + 0.5 + Math.sin(a) * r) * cellH;
            try { window.FX.sparkle(px, py, color); } catch (e) { /* ignore */ }
        }
    },

    drawAnimatedWaitingScreen: function(screenWidth, screenHeight, drawBorderFn, drawCenteredTextFn) {
        if (!DisplayManager.ensureDisplay()) return;
        const display = DisplayManager.getDisplay();

        // Draw border
        drawBorderFn();

        // GFX3: layer the torchlight + ember FX overlay on top of the ROT scene
        this._startAmbientFX();

        // Check if we're in "Awaiting payment" mode - use treasure hunt animation
        const isAwaitingPayment = typeof Game !== 'undefined' && Game._awaitingPayment;
        
        if (!isAwaitingPayment) {
            // Use the treasure hunt animation for queue waiting (the longer wait)
            this.drawPaymentAnimation(screenWidth, screenHeight, drawCenteredTextFn);
            return;
        }
        
        // Fixed-position animated text. The label reflects the ACTUAL wait state, not this function's
        // historical name — the two animations were wired to the opposite labels. This branch runs
        // while genuinely awaiting a payment.
        let y = Math.floor(screenHeight / 2) - 8;
        let baseText = (typeof Game !== 'undefined' && Game._awaitingPayment) ? 'Awaiting payment' : 'Awaiting next block';
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

        // GFX3: drifting embers from the scripted torch positions
        this._emitTorchEmbers(torchPositions, screenWidth, screenHeight);

        // Update character positions
        this.updateAnimation();
        const anim = this._waitingAnimation;

        // JUICE: burst on the beats — treasure grabbed (treasureX flips to -1), escape, or caught.
        if (this._epicPhase !== anim.phase) {
            if (anim.phase === 'escape')     this._burst(anim.playerX, anim.playerY, 'rgba(255,220,90,0.95)', 18, screenWidth, screenHeight, 1.8);
            else if (anim.phase === 'caught') this._burst(anim.monsterX, anim.playerY, 'rgba(255,70,70,0.95)', 22, screenWidth, screenHeight, 2.2);
            this._epicPhase = anim.phase;
        }

        // ===== PHASE 1: DRAW ALL GLOW EFFECTS FIRST =====
        // This ensures glow appears behind entities
        
        // Monster red glow (draw first so monster appears on top)
        if (anim.monsterX >= 0 && anim.monsterX < screenWidth) {
            const floorTile = GameTiles.getFloorTile();
            for (let sx = anim.monsterX - 2; sx <= anim.monsterX + 2; sx++) {
                for (let sy = anim.monsterY - 2; sy <= anim.monsterY + 2; sy++) {
                    if (sx >= roomStartX && sx <= roomEndX && sy >= roomStartY && sy <= roomEndY) {
                        const dist = Math.sqrt((sx - anim.monsterX) ** 2 + (sy - anim.monsterY) ** 2);
                        if (dist <= 2 && !(sx === anim.monsterX && sy === anim.monsterY)) {
                            const glowIntensity = Math.max(0, (2 - dist) / 2 * 0.25);
                            const glowPulse = Math.sin(time / 300 + dist) * 0.1;
                            display.draw(sx, sy, floorTile, `rgba(200, 50, 50, ${glowIntensity + glowPulse})`, "transparent");
                        }
                    }
                }
            }
        }
        
        // Player aura glow (draw before player)
        if (anim.playerX >= 0 && anim.playerX < screenWidth) {
            if (anim.phase === 'enter' || anim.phase === 'escape' || anim.phase === 'chase') {
                const ringPulse = 0.35 + Math.sin(time / 250) * 0.25;
                const innerPulse = 0.15 + Math.sin(time / 180 + 1.2) * 0.15;
                const ringColor = (alpha) => `rgba(180, 230, 255, ${alpha})`;
                const floorTile = GameTiles.getFloorTile();

                // 8-way surrounding ring
                const ringOffsets = [
                    {dx: -1, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: -1}, {dx: 0, dy: 1},
                    {dx: -1, dy: -1}, {dx: 1, dy: -1}, {dx: -1, dy: 1}, {dx: 1, dy: 1}
                ];
                for (let i = 0; i < ringOffsets.length; i++) {
                    const rx = anim.playerX + ringOffsets[i].dx;
                    const ry = anim.playerY + ringOffsets[i].dy;
                    if (rx >= roomStartX && rx <= roomEndX && ry >= roomStartY && ry <= roomEndY) {
                        const phaseShift = (i / ringOffsets.length) * Math.PI * 2;
                        const alpha = (ringPulse * 0.6) + Math.sin(time / 300 + phaseShift) * 0.15;
                        display.draw(rx, ry, floorTile, ringColor(Math.max(0, alpha)), 'transparent');
                    }
                }

                // Trailing footprint path
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
        
        // Treasure sparkles glow (draw before treasure)
        if (anim.treasureX >= 0 && anim.treasureX < screenWidth) {
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
        
        // ===== PHASE 2: DRAW ENTITIES ON TOP OF GLOW =====
        
        // 💎 LEGENDARY TREASURE
        if (anim.treasureX >= 0 && anim.treasureX < screenWidth) {
            const treasurePulse = 0.6 + Math.sin(time / 250) * 0.4;
            const treasureGlow = `rgba(255, 215, 0, ${treasurePulse})`;
            const floorTile = GameTiles.getFloorTile();
            const baseAlpha = 0.1 + Math.sin(anim.treasureX * 0.2 + anim.treasureY * 0.3) * 0.05;
            display.draw(anim.treasureX, anim.treasureY, [floorTile, GameTiles.getTreasureTile()], 
                [`rgba(100, 80, 60, ${baseAlpha})`, treasureGlow], ["transparent", "transparent"]);
        }
        
        // 🧙‍♂️ HEROIC PLAYER
        if (anim.playerX >= 0 && anim.playerX < screenWidth) {
            const heroGlow = 0.4 + Math.sin(time / 300) * 0.2;
            const heroColor = `rgba(100, 150, 255, ${heroGlow})`;
            const floorTile = GameTiles.getFloorTile();
            const playerTile = GameTiles.getPlayerTile();
            const baseAlpha = 0.1 + Math.sin(anim.playerX * 0.2 + anim.playerY * 0.3) * 0.05;
            display.draw(anim.playerX, anim.playerY, [floorTile, playerTile], 
                [`rgba(100, 80, 60, ${baseAlpha})`, heroColor], ["transparent", "transparent"]);
        }
        
        // 👹 TERRIFYING MONSTER
        if (anim.monsterX >= 0 && anim.monsterX < screenWidth) {
            const menacePulse = 0.3 + Math.sin(time / 180) * 0.4;
            const fearColor = `rgba(255, 30, 30, ${menacePulse})`;
            const floorTile = GameTiles.getFloorTile();
            const monsterTile = GameTiles.getMonsterTile();
            const baseAlpha = 0.1 + Math.sin(anim.monsterX * 0.2 + anim.monsterY * 0.3) * 0.05;
            display.draw(anim.monsterX, anim.monsterY, [floorTile, monsterTile], 
                [`rgba(100, 80, 60, ${baseAlpha})`, fearColor], ["transparent", "transparent"]);
        }
        
        // 🚪 MYSTICAL PORTALS - Entrance and exit with swirling energy
        const portalPulse = 0.3 + Math.sin(time / 400) * 0.2;
        const entranceGlow = `rgba(50, 255, 50, ${portalPulse})`;  // Green entrance
        const exitGlow = `rgba(255, 100, 255, ${portalPulse})`;    // Purple exit
        
        display.draw(roomStartX - 1, 12, '<', entranceGlow, "transparent");
        display.draw(roomEndX + 1, 12, '>', exitGlow, "transparent");
    },

    // ========== PAYMENT WAITING ANIMATION ==========
    // Special "treasure hunt" animation shown while awaiting payment
    // Player runs for BIG pulsating treasure, always gets it,
    // then either escapes or gets overwhelmed by a monster pack
    
    drawPaymentAnimation: function(screenWidth, screenHeight, drawCenteredTextFn) {
        const display = DisplayManager.getDisplay();
        const anim = this._paymentAnimation;
        const time = Date.now();
        
        // Fixed-position animated text. This treasure-hunt animation runs for the block-QUEUE wait
        // (see drawAnimatedWaitingScreen routing), so show the block label unless we're genuinely
        // awaiting a payment. (Function name is historical — do not trust it for the label.)
        let y = Math.floor(screenHeight / 2) - 8;
        const dots = ".".repeat((Math.floor(time / 500) % 4));
        const paddedDots = dots.padEnd(3, " ");
        const label = (typeof Game !== 'undefined' && Game._awaitingPayment) ? 'Awaiting payment' : 'Awaiting next block';
        drawCenteredTextFn(y, `${label}${paddedDots}`);
        
        // Room dimensions - relative to actual screen size
        const roomStartX = 1;
        const roomEndX = screenWidth - 2;
        const roomStartY = Math.floor(screenHeight / 2) - 4;
        const roomEndY = Math.floor(screenHeight / 2) + 4;
        const centerY = Math.floor(screenHeight / 2);
        
        // Store room bounds for animation updates
        anim.roomStartX = roomStartX;
        anim.roomEndX = roomEndX;
        anim.roomStartY = roomStartY;
        anim.roomEndY = roomEndY;
        
        // Sync Y positions to actual screen center (handles first frame after reset)
        if (anim.playerY !== centerY) {
            anim.playerY = centerY;
            anim.treasureY = centerY;
        }
        
        // Ensure treasure is within visible bounds
        if (anim.treasureX > roomEndX - 3) {
            anim.treasureX = roomEndX - 3;
        }
        
        // 🏛️ BASE DUNGEON FLOOR
        for (let x = roomStartX; x <= roomEndX; x++) {
            for (let dy = roomStartY; dy <= roomEndY; dy++) {
                if (x >= 0 && x < screenWidth && dy >= 0 && dy < screenHeight) {
                    const floorTile = GameTiles.getFloorTile(true);
                    const baseAlpha = 0.1 + Math.sin(x * 0.2 + dy * 0.3) * 0.05;
                    display.draw(x, dy, floorTile, `rgba(100, 80, 60, ${baseAlpha})`, "transparent");
                }
            }
        }
        
        // 🧱 DUNGEON WALLS
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
        
        // 🔥 TORCHES for atmosphere (positioned relative to room)
        const torchPositions = [
            {x: roomStartX - 1, y: roomStartY + 1},
            {x: roomEndX + 1, y: roomStartY + 1},
            {x: roomStartX - 1, y: roomEndY - 1},
            {x: roomEndX + 1, y: roomEndY - 1}
        ];
        
        for (let i = 0; i < torchPositions.length; i++) {
            const torch = torchPositions[i];
            if (torch.x >= 0 && torch.x < screenWidth && torch.y >= 0 && torch.y < screenHeight) {
                const flameIntensity = 0.6 + Math.sin(time / 200 + i) * 0.4;
                const flameColor = `rgba(255, ${100 + flameIntensity * 100}, 20, ${flameIntensity})`;
                const wallGlow = 0.2 + Math.sin(time * 0.001 + torch.x * 0.1) * 0.1;
                const wallColor = `rgba(80, 70, 50, ${wallGlow})`;
                display.draw(torch.x, torch.y, ["#", "torch"], [wallColor, flameColor], ["transparent", "transparent"]);
            }
        }

        // GFX3: drifting embers from the scripted torch positions
        this._emitTorchEmbers(torchPositions, screenWidth, screenHeight);

        // Update animation state
        this.updatePaymentAnimation();

        // JUICE: fire a one-shot particle burst on each dramatic beat (grab / escape / death).
        if (this._payPhase !== anim.phase) {
            if (anim.phase === 'grab')    this._burst(anim.treasureX, anim.treasureY, 'rgba(255,220,90,0.95)', 18, screenWidth, screenHeight, 1.8);
            else if (anim.phase === 'escaped') this._burst(anim.playerX, anim.playerY, 'rgba(130,255,150,0.95)', 22, screenWidth, screenHeight, 2.2);
            this._payPhase = anim.phase;
        }
        const _pGone = (anim.playerX === -1);
        if (_pGone && !this._payDeathBurst) {
            this._burst(anim.deathX || anim.treasureX, anim.deathY || centerY, 'rgba(255,70,70,0.95)', 24, screenWidth, screenHeight, 2.4);
            this._payDeathBurst = true;
        } else if (!_pGone) {
            this._payDeathBurst = false;
        }

        // 💎💎💎 MEGA TREASURE - BIG pulsating with intense golden glow
        if (!anim.hasTreasure && anim.treasureX >= roomStartX && anim.treasureX <= roomEndX) {
            // Intense pulsing effect - the treasure is CALLING to the player
            const megaPulse = 0.7 + Math.sin(time / 150) * 0.3;
            const shimmer = 0.5 + Math.sin(time / 80) * 0.5;
            
            // Massive golden aura around treasure (3-tile radius)
            for (let tx = anim.treasureX - 3; tx <= anim.treasureX + 3; tx++) {
                for (let ty = anim.treasureY - 2; ty <= anim.treasureY + 2; ty++) {
                    if (tx >= roomStartX && tx <= roomEndX && ty >= roomStartY && ty <= roomEndY) {
                        const dist = Math.sqrt((tx - anim.treasureX) ** 2 + (ty - anim.treasureY) ** 2);
                        if (dist <= 3 && dist > 0) {
                            const auraIntensity = Math.max(0, (3 - dist) / 3) * megaPulse * 0.4;
                            const floorTile = GameTiles.getFloorTile();
                            display.draw(tx, ty, floorTile, `rgba(255, 200, 50, ${auraIntensity})`, "transparent");
                        }
                    }
                }
            }
            
            // Sparkle ring around treasure - use floor tiles with bright golden color
            const sparkleRadius = 2;
            for (let angle = 0; angle < 8; angle++) {
                const sparkleAngle = (angle / 8) * Math.PI * 2 + time / 500;
                const sx = Math.round(anim.treasureX + Math.cos(sparkleAngle) * sparkleRadius);
                const sy = Math.round(anim.treasureY + Math.sin(sparkleAngle) * sparkleRadius * 0.6);
                if (sx >= roomStartX && sx <= roomEndX && sy >= roomStartY && sy <= roomEndY) {
                    const sparkleIntensity = 0.5 + Math.sin(time / 100 + angle) * 0.4;
                    if (sparkleIntensity > 0.3) {
                        const floorTile = GameTiles.getFloorTile();
                        // Bright white-gold sparkle effect on floor tile
                        display.draw(sx, sy, floorTile, `rgba(255, 255, 180, ${sparkleIntensity})`, "transparent");
                    }
                }
            }
            
            // The treasure itself - LARGE and glowing
            const treasureGlow = `rgba(255, 215, 0, ${megaPulse})`;
            const floorTile = GameTiles.getFloorTile();
            display.draw(anim.treasureX, anim.treasureY, [floorTile, GameTiles.getTreasureTile()], 
                [`rgba(100, 80, 60, 0.1)`, treasureGlow], ["transparent", "transparent"]);
        }
        
        // 🧙‍♂️ HEROIC PLAYER
        if (anim.playerX >= roomStartX && anim.playerX <= roomEndX + 2) {
            const heroGlow = anim.hasTreasure 
                ? 0.6 + Math.sin(time / 200) * 0.3  // Brighter when has treasure
                : 0.4 + Math.sin(time / 300) * 0.2;
            
            // If player has treasure, show golden glow instead of blue
            const heroColor = anim.hasTreasure 
                ? `rgba(255, 200, 50, ${heroGlow})`  // Golden when carrying treasure
                : `rgba(100, 150, 255, ${heroGlow})`;
            
            const floorTile = GameTiles.getFloorTile();
            const playerTile = GameTiles.getPlayerTile();
            display.draw(anim.playerX, anim.playerY, [floorTile, playerTile], 
                [`rgba(100, 80, 60, 0.1)`, heroColor], ["transparent", "transparent"]);
            
            // Determination aura when running for treasure
            if (anim.phase === 'approach' || anim.phase === 'escape') {
                const ringPulse = 0.3 + Math.sin(time / 200) * 0.2;
                const ringColor = anim.hasTreasure 
                    ? `rgba(255, 220, 100, ${ringPulse})`
                    : `rgba(180, 230, 255, ${ringPulse})`;
                    
                const ringOffsets = [{dx: -1, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: -1}, {dx: 0, dy: 1}];
                for (const off of ringOffsets) {
                    const rx = anim.playerX + off.dx;
                    const ry = anim.playerY + off.dy;
                    if (rx >= roomStartX && rx <= roomEndX && ry >= roomStartY && ry <= roomEndY) {
                        display.draw(rx, ry, floorTile, ringColor, 'transparent');
                    }
                }
            }
        }
        
        // 👹👹👹 MONSTER PACK - Spread out formation, no overlapping
        // Only draw monsters that are on valid integer grid positions
        const drawnPositions = new Set(); // Track drawn positions to avoid overlap
        
        for (let i = 0; i < anim.monsters.length; i++) {
            const m = anim.monsters[i];
            // Round to grid position
            const gridX = Math.round(m.x);
            const gridY = Math.round(m.y);
            const posKey = `${gridX},${gridY}`;
            
            // Skip if position already has a monster or out of bounds
            if (drawnPositions.has(posKey)) continue;
            if (gridX < roomStartX - 1 || gridX > roomEndX + 1) continue;
            if (gridY < roomStartY || gridY > roomEndY) continue;
            
            drawnPositions.add(posKey);
            
            // Draw red glow around this monster position
            const floorTile = GameTiles.getFloorTile();
            for (let sx = gridX - 1; sx <= gridX + 1; sx++) {
                for (let sy = gridY - 1; sy <= gridY + 1; sy++) {
                    if (sx >= roomStartX && sx <= roomEndX && sy >= roomStartY && sy <= roomEndY) {
                        if (!(sx === gridX && sy === gridY)) {
                            const glowIntensity = 0.2 + Math.sin(time / 200 + i) * 0.1;
                            display.draw(sx, sy, floorTile, `rgba(180, 40, 40, ${glowIntensity})`, "transparent");
                        }
                    }
                }
            }
            
            // Draw monster on top
            const menacePulse = 0.5 + Math.sin(time / 150 + i * 0.7) * 0.4;
            const fearColor = `rgba(255, 40, 40, ${menacePulse})`;
            const monsterTile = GameTiles.getMonsterTile();
            display.draw(gridX, gridY, [floorTile, monsterTile], 
                [`rgba(100, 80, 60, 0.1)`, fearColor], ["transparent", "transparent"]);
        }
        
        // DEATH EFFECT when devoured - expanding red flash
        if (anim.phase === 'devoured' && anim.playerX === -1) {
            const deathX = anim.deathX || 25;
            const deathY = anim.deathY || 12;
            const deathAge = anim.frameCount - (anim.deathFrame || 0);
            
            // Expanding red shockwave using floor tiles
            if (deathAge < 30) {
                const expandRadius = 1 + deathAge * 0.15;
                const fadeOut = Math.max(0, 1 - deathAge / 30);
                const floorTile = GameTiles.getFloorTile();
                
                for (let angle = 0; angle < 8; angle++) {
                    const particleAngle = (angle / 8) * Math.PI * 2;
                    const px = Math.round(deathX + Math.cos(particleAngle) * expandRadius);
                    const py = Math.round(deathY + Math.sin(particleAngle) * expandRadius * 0.5);
                    if (px >= roomStartX && px <= roomEndX && py >= roomStartY && py <= roomEndY) {
                        // Bright red flash expanding outward
                        display.draw(px, py, floorTile, `rgba(255, 80, 80, ${fadeOut * 0.9})`, "transparent");
                    }
                }
                
                // Central bright flash
                if (deathAge < 15) {
                    display.draw(deathX, deathY, floorTile, `rgba(255, 200, 200, ${fadeOut})`, "transparent");
                }
            }
        }
        
        // 🚪 PORTALS (positioned at room center height)
        const portalPulse = 0.3 + Math.sin(time / 400) * 0.2;
        const entranceGlow = `rgba(50, 255, 50, ${portalPulse})`;
        const exitGlow = `rgba(255, 100, 255, ${portalPulse})`;
        display.draw(roomStartX - 1, centerY, '<', entranceGlow, "transparent");
        display.draw(roomEndX + 1, centerY, '>', exitGlow, "transparent");
        
        // ESCAPE SUCCESS indicator
        if (anim.phase === 'escaped') {
            // Draw "ESCAPED!" text using floor tiles as background
            const escapeY = Math.floor(screenHeight / 2) + 3;
            const escapeText = "ESCAPED!";
            const startX = Math.floor((screenWidth - escapeText.length) / 2);
            const successPulse = 0.8 + Math.sin(time / 150) * 0.2;
            const floorTile = GameTiles.getFloorTile();
            
            for (let i = 0; i < escapeText.length; i++) {
                const char = escapeText[i];
                // Draw floor tile first, then letter on top
                display.draw(startX + i, escapeY, [floorTile, char], 
                    [`rgba(100, 80, 60, 0.1)`, `rgba(255, 220, 100, ${successPulse})`], 
                    ["transparent", "transparent"]);
            }
        }
    },
    
    updatePaymentAnimation: function() {
        const anim = this._paymentAnimation;
        anim.frameCount++;
        
        // Animate every 5 frames for smooth but readable movement
        if (anim.frameCount % 5 !== 0) return;
        
        // Use stored room bounds (set by drawPaymentAnimation)
        const roomStartX = anim.roomStartX || 1;
        const roomEndX = anim.roomEndX || 23;
        const centerY = anim.playerY; // Use player's Y as center reference
        
        switch(anim.phase) {
            case 'approach':
                // Player moves toward treasure
                if (anim.playerX < anim.treasureX - 1) {
                    anim.playerX++;
                } else {
                    // Player grabs treasure!
                    anim.hasTreasure = true;
                    anim.phase = 'grab';
                    anim.grabFrame = anim.frameCount;
                }
                break;
                
            case 'grab':
                // Brief pause to show player got treasure
                if (anim.frameCount - anim.grabFrame > 8) {
                    // Spawn monster pack in a spread-out formation
                    anim.monsters = [];
                    const monsterCount = 3; // Fewer monsters, better spaced
                    
                    // Spawn in a V-formation behind the player (left side of screen)
                    const spawnX = roomStartX + 1;
                    const formations = [
                        {x: spawnX, y: centerY},          // Center
                        {x: spawnX, y: centerY - 2},      // Top
                        {x: spawnX, y: centerY + 2},      // Bottom
                    ];
                    
                    for (let i = 0; i < monsterCount; i++) {
                        const pos = formations[i];
                        anim.monsters.push({
                            x: pos.x, 
                            y: pos.y, 
                            speed: 1.2 + i * 0.1,  // Slight speed variation
                            targetY: centerY + (i - 1) * 2  // Spread vertically during chase
                        });
                    }
                    
                    anim.phase = anim.outcome; // 'escape' or 'devoured'
                }
                break;
                
            case 'escape':
                // Player runs toward exit, monsters chase but player escapes
                if (anim.playerX < roomEndX) {
                    anim.playerX += 2; // Player moves fast when escaping!
                } else {
                    anim.phase = 'escaped';
                    anim.escapedFrame = anim.frameCount;
                }
                
                // Monsters chase in formation, staying spread out
                for (let i = 0; i < anim.monsters.length; i++) {
                    const m = anim.monsters[i];
                    // Chase horizontally, stay behind player
                    if (m.x < anim.playerX - 4) {
                        m.x += m.speed;
                    }
                    // Maintain vertical spread
                    const targetY = m.targetY || (centerY + (i - 1) * 2);
                    if (m.y < targetY - 0.5) m.y += 0.4;
                    else if (m.y > targetY + 0.5) m.y -= 0.4;
                }
                break;
                
            case 'devoured':
                // Monsters converge on player in stages
                let closeCount = 0;
                for (let i = 0; i < anim.monsters.length; i++) {
                    const m = anim.monsters[i];
                    const dx = anim.playerX - m.x;
                    const dy = anim.playerY - m.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    if (dist > 1.5) {
                        // Move toward player but maintain some spacing
                        m.x += (dx / dist) * m.speed * 0.8;
                        m.y += (dy / dist) * m.speed * 0.5;
                    } else {
                        closeCount++;
                    }
                }
                
                // Player is devoured when surrounded
                if (closeCount >= 2 && anim.playerX !== -1) {
                    anim.deathX = anim.playerX;
                    anim.deathY = anim.playerY;
                    anim.deathFrame = anim.frameCount;
                    anim.playerX = -1; // Player vanishes
                }
                
                // After death animation, reset
                if (anim.playerX === -1 && anim.frameCount - anim.deathFrame > 40) {
                    this.resetPaymentAnimation();
                }
                break;
                
            case 'escaped':
                // Brief celebration then reset
                if (anim.frameCount - anim.escapedFrame > 25) {
                    this.resetPaymentAnimation();
                }
                // Monsters wander off
                for (const m of anim.monsters) {
                    m.x += (Math.random() - 0.5) * 2;
                }
                break;
        }
    },
    
    resetPaymentAnimation: function() {
        // Determine outcome for this cycle (60% escape, 40% devoured)
        const outcome = Math.random() < 0.6 ? 'escape' : 'devoured';
        
        // Use sensible defaults - will be updated with actual screen size on first draw
        // Player starts on left, treasure in middle-right area
        const playerStart = 3;
        const treasurePos = 15 + Math.floor(Math.random() * 4); // 15-18 (visible on 25-wide screen)
        const centerY = 9; // Will be recalculated based on actual screen height
        
        this._paymentAnimation = {
            playerX: playerStart,
            playerY: centerY,
            treasureX: treasurePos,
            treasureY: centerY,
            monsters: [],
            phase: 'approach',
            frameCount: 0,
            outcome: outcome,
            hasTreasure: false,
            // Room bounds - will be set properly on first draw
            roomStartX: 1,
            roomEndX: 23,
            roomStartY: 5,
            roomEndY: 13
        };
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
            // GFX3: tear down the FX overlay when animation is switched off
            this._stopAmbientFX();
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
        this.resetPaymentAnimation();
        // GFX3: tear down the FX overlay when the waiting screen ends
        this._stopAmbientFX();
    },

    isAnimationEnabled: function() {
        return this._animationEnabled;
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.WaitingScreenAnimator = WaitingScreenAnimator;
}
