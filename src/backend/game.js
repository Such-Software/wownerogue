const ROT = require('./rot.js');
const Player = require('./player.js');
const Monster = require('./monster.js');
const DungeonGenerator = require('./dungeon.js');

class Game {
  constructor(socketId, mapWidth, mapHeight, gameConfig = {}) {
    this.socketId = socketId;
    this.width = mapWidth || 25; // Reduced default size to match client display
    this.height = mapHeight || 19; // Reduced default size to match client display
    this.gameState = 'waiting'; // waiting, active, won, lost
    this.startBlock = null;
    this.dungeon = null;
    this.player = new Player();
    this.monster = new Monster();
    this.fee = 0; // Amount player paid
    this.visibleTiles = {}; // Will store visible tiles
    this.fov = null; // FOV calculator
    this.gameConfig = gameConfig; // Store game configuration
    this.generateDungeon();
  }
  
  generateDungeon() {
    // Pass game configuration to dungeon generator
    this.dungeon = DungeonGenerator.generate(this.width, this.height, this.gameConfig);
    
    if (this.dungeon.entrance) {
      this.player.moveTo(this.dungeon.entrance[0], this.dungeon.entrance[1]);
    }
    
    // Place monster far from entrance
    if (this.dungeon.rooms && this.dungeon.rooms.length > 2) {
      const monsterRoom = this.dungeon.rooms[Math.floor(this.dungeon.rooms.length * 0.7)];
      const center = monsterRoom.getCenter();
      this.monster.moveTo(center[0], center[1]);
    }
    
    // Initialize FOV calculator - need to check for multiple floor types now
    this.fov = new ROT.FOV.PreciseShadowcasting(
      (x, y) => {
        // Return true if the tile is transparent (can see through it)
        if (!this.dungeon.map[y] || this.dungeon.map[y][x] === undefined) return false;
        const tile = this.dungeon.map[y][x];
        // Check if it's any type of floor tile (primary or secondary)
        const primaryFloor = this.gameConfig.primaryFloor || "'1";
        const secondaryFloor = this.gameConfig.secondaryFloor || "'2";
        return tile === primaryFloor || tile === secondaryFloor;
      }
    );
    
    // Calculate initial FOV
    this.updateFOV();
    
    // Set game state to active
    this.gameState = 'active';
  }
  
  updateFOV() {
    // Reset visible tiles
    this.visibleTiles = {};
    
    // Calculate new visible tiles
    this.fov.compute(this.player.x, this.player.y, 10, (x, y, r, visibility) => { // Added r and visibility params
        if (visibility > 0) { // Only add if tile is actually visible
            if (!this.visibleTiles[y]) {
                this.visibleTiles[y] = {};
            }
            // Store the actual tile type (0 for floor, 1 for wall) from the dungeon map
            if (this.dungeon && this.dungeon.map && this.dungeon.map[y] && this.dungeon.map[y][x] !== undefined) {
                this.visibleTiles[y][x] = this.dungeon.map[y][x];
                
                // Debug log for specific problematic coordinates
                if ((x === 36 && (y === 18 || y === 16)) || (x === 35 && (y === 18 || y === 16))) {
                    console.log(`🔍 DEBUG FOV: (${x},${y}) - server map value: ${this.dungeon.map[y][x]}, sent to client: ${this.visibleTiles[y][x]}, visibility: ${visibility}`);
                }
            } else {
                // Should not happen if FOV is within map bounds, but as a fallback:
                // this.visibleTiles[y][x] = 1; // Default to wall if outside known map
            }
        }
    });
    // console.log("FOV updated. Player:", this.player.x, this.player.y, "Visible tiles count:", Object.keys(this.visibleTiles).reduce((acc, k) => acc + Object.keys(this.visibleTiles[k]).length, 0));
  }
  
  movePlayer(dx, dy) {
    const newX = this.player.x + dx;
    const newY = this.player.y + dy;
    
    // Simple debug output
    console.log(`Move: (${this.player.x},${this.player.y}) -> (${newX},${newY})`);
    
    // Check if the move is valid (not into a wall and within map bounds)
    // Updated to handle new floor tile types
    const primaryFloor = this.gameConfig.primaryFloor || "'1";
    const secondaryFloor = this.gameConfig.secondaryFloor || "'2";
    
    if (this.dungeon && 
        this.dungeon.map[newY] && 
        this.dungeon.map[newY][newX] !== undefined && 
        (this.dungeon.map[newY][newX] === primaryFloor || this.dungeon.map[newY][newX] === secondaryFloor)) {
      
      this.player.moveTo(newX, newY);
      console.log(`Player moved to ${newX},${newY} in game for socket ${this.socketId}`);
      
      // Update FOV after moving
      this.updateFOV();
      
      // Check for game events like finding treasure or exit
      if (this.dungeon.exit && this.player.isAt(this.dungeon.exit[0], this.dungeon.exit[1])) {
        // Handle win condition (e.g., escaped)
        this.gameState = 'won';
        return { status: 'moved', event: 'escaped', player: this.player.getState(), visibleTiles: this.visibleTiles };
      }
      if (this.dungeon.treasure && this.player.isAt(this.dungeon.treasure[0], this.dungeon.treasure[1]) && !this.player.hasTreasure) {
        this.player.hasTreasure = true;
        console.log(`🏆 TREASURE PICKUP: Player ${this.socketId} collected treasure at (${this.dungeon.treasure[0]}, ${this.dungeon.treasure[1]})`);
        // Remove treasure from dungeon so it won't be sent in future updates
        this.dungeon.treasure = null;
        console.log(`🗑️ TREASURE REMOVED: dungeon.treasure is now null for player ${this.socketId}`);
        console.log(`Player ${this.socketId} collected treasure! hasTreasure: ${this.player.hasTreasure}`);
        return { status: 'moved', event: 'treasure_found', player: this.player.getState(), visibleTiles: this.visibleTiles };
      }
      
      return { status: 'moved', player: this.player.getState(), visibleTiles: this.visibleTiles };
    }
    
    
    
    console.log(`Move BLOCKED: ${newX},${newY} - cell value: ${this.dungeon && this.dungeon.map[newY] ? this.dungeon.map[newY][newX] : 'undefined'}`);
    return { status: 'invalid' };
  }
  
  moveMonster() {
    this.monster.moveTowardPlayer(this.player, this.dungeon);
  }
  
  // Update the getState() method to include all entities with relative positions
  getState() {
    const state = {
      gameState: this.gameState,
      player: this.player.getState(), // Use Player's getState method
      monster: this.monster ? this.monster.getState() : null, // Use Monster's getState method
      visibleTiles: { ...this.visibleTiles }, // Send a copy of visible tiles
      lighting: this.calculateLighting(), // Add lighting data
      entrance: this.dungeon ? this.dungeon.entrance : null,
      exit: this.dungeon ? this.dungeon.exit : null,
      treasure: this.dungeon ? this.dungeon.treasure : null,
      // Don't send torch positions - client doesn't need them since lighting is calculated server-side
    };

    // Debug logging to verify entity data
    console.log("🎮 getState() sending entities - Monster:", state.monster, "Entrance:", state.entrance, "Exit:", state.exit, "Treasure:", state.treasure);
    if (state.treasure === null) {
      console.log("✅ TREASURE NULL: Confirmed treasure is null in getState() - treasure was picked up!");
    }

    return state;
  }
  
  // Calculate lighting levels for all visible tiles based on distance from torches
  calculateLighting() {
    const lightingData = {};
    
    // Get torch positions from dungeon
    const torches = this.dungeon?.torches || [];
    console.log("🔥 calculateLighting() - torch positions:", torches);
    
    // For each visible tile, calculate the lighting level
    for (const yKey in this.visibleTiles) {
      const y = parseInt(yKey);
      lightingData[y] = {};
      
      for (const xKey in this.visibleTiles[y]) {
        const x = parseInt(xKey);
        
        // Calculate minimum distance to any torch
        let minDistanceToTorch = Infinity;
        
        for (const torch of torches) {
          const distance = Math.max(Math.abs(x - torch[0]), Math.abs(y - torch[1])); // Chebyshev distance (diagonal movement)
          minDistanceToTorch = Math.min(minDistanceToTorch, distance);
        }
        
        // Convert distance to alpha value for darkness overlay
        let alpha = 0.0;
        
        if (minDistanceToTorch === 0) {
          // On a torch - no darkness
          alpha = 0.0;
        } else if (minDistanceToTorch === 1) {
          // Adjacent to torch - light darkness with flickering effect
          alpha = 0.15 + Math.random() * 0.15; // 0.15-0.3
        } else if (minDistanceToTorch === 2) {
          // Two tiles away - moderate darkness with flickering
          alpha = 0.3 + Math.random() * 0.2; // 0.3-0.5
        } else if (minDistanceToTorch === 3) {
          // Three tiles away - heavier darkness with flickering
          alpha = 0.5 + Math.random() * 0.2; // 0.5-0.7
        } else {
          // Far from torches - scale up to maximum darkness with flickering
          const maxDistance = 6; // Beyond this distance, maximum darkness
          const scaledDistance = Math.min(minDistanceToTorch, maxDistance);
          alpha = 0.7 + (scaledDistance - 3) / (maxDistance - 3) * 0.2; // 0.7-0.9
        }
        
        // Clamp alpha to reasonable bounds
        alpha = Math.max(0.0, Math.min(0.9, alpha));
        
        lightingData[y][x] = alpha;
      }
    }
    
    const lightingTileCount = Object.keys(lightingData).reduce((acc, yKey) => acc + Object.keys(lightingData[yKey]).length, 0);
    console.log("💡 calculateLighting() - generated lighting for", lightingTileCount, "tiles");
    console.log("💡 LIGHTING DATA SAMPLE:", JSON.stringify(lightingData).substring(0, 200));
    
    return lightingData;
  }

}

// Check if monster killed player
function checkMonsterKill(player, monster) {
    // Use Monster's hasCaughtPlayer method
    const monsterInstance = new Monster(monster.x, monster.y);
    return monsterInstance.hasCaughtPlayer(player);
}

module.exports = Game;
module.exports.checkMonsterKill = checkMonsterKill;