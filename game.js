const ROT = require('./rot.js');

// Define the missing generateDungeon function
function generateDungeon(width, height) {
  // Create dungeon using ROT.js Map.Digger
  const digger = new ROT.Map.Digger(width, height, {
    roomWidth: [3, 9],
    roomHeight: [3, 7],
    corridorLength: [2, 6],
    dugPercentage: 0.2
  });
  
  // Initialize the empty map with walls (1)
  const map = Array(height).fill().map(() => Array(width).fill(1));
  
  // Fill in floors (0) using digger's callback
  digger.create((x, y, value) => {
    // value: 0 = floor, 1 = wall
    map[y][x] = value;
  });
  
  // Get rooms that were created
  const rooms = digger.getRooms();
  
  // Place entrance in the first room
  const entranceRoom = rooms[0];
  const entranceCenter = entranceRoom.getCenter();
  const entrance = [entranceCenter[0], entranceCenter[1]];
  
  // Place exit in the last room
  const exitRoom = rooms[rooms.length - 1];
  const exitCenter = exitRoom.getCenter();
  const exit = [exitCenter[0], exitCenter[1]];
  
  // Place treasure in a middle room (not first or last)
  let treasureRoom;
  if (rooms.length > 2) {
    treasureRoom = rooms[Math.floor(rooms.length / 2)];
  } else {
    // Fallback if we have fewer than 3 rooms
    treasureRoom = rooms[0];
  }
  const treasureCenter = treasureRoom.getCenter();
  // Place treasure slightly off center to make it more interesting
  const treasure = [
    treasureCenter[0] + Math.floor(Math.random() * 3) - 1,
    treasureCenter[1] + Math.floor(Math.random() * 3) - 1
  ];
  
  // Ensure the treasure is on a floor tile
  if (map[treasure[1]][treasure[0]] !== 0) {
    treasure[0] = treasureCenter[0];
    treasure[1] = treasureCenter[1];
  }
  
  return {
    map: map,
    rooms: rooms, 
    entrance: entrance,
    exit: exit,
    treasure: treasure
  };
}

class Game {
  constructor(socketId, mapWidth, mapHeight) {
    this.socketId = socketId;
    this.width = mapWidth || 25; // Reduced default size to match client display
    this.height = mapHeight || 19; // Reduced default size to match client display
    this.gameState = 'waiting'; // waiting, active, won, lost
    this.startBlock = null;
    this.dungeon = null;
    this.player = { x: 0, y: 0, hasKey: false, hasTreasure: false };
    this.monster = { x: 0, y: 0 };
    this.fee = 0; // Amount player paid
    this.visibleTiles = {}; // Will store visible tiles
    this.fov = null; // FOV calculator
    this.generateDungeon();
  }
  
  generateDungeon() {
    const dungeon = generateDungeon(this.width, this.height);
    this.dungeon = dungeon;
    
    if (dungeon.entrance) {
      this.player.x = dungeon.entrance[0];
      this.player.y = dungeon.entrance[1];
    }
    
    // Place monster far from entrance
    if (dungeon.rooms && dungeon.rooms.length > 2) {
      const monsterRoom = dungeon.rooms[Math.floor(dungeon.rooms.length * 0.7)];
      const center = monsterRoom.getCenter();
      this.monster.x = center[0];
      this.monster.y = center[1];
    }
    
    // Initialize FOV calculator
    this.fov = new ROT.FOV.PreciseShadowcasting(
      (x, y) => {
        // Return true if the tile is transparent (can see through it)
        return this.dungeon.map[y] && this.dungeon.map[y][x] === 0;
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
    
    // Check if the move is valid (not into a wall and within map bounds)
    if (this.dungeon && 
        this.dungeon.map[newY] && 
        this.dungeon.map[newY][newX] !== undefined && 
        this.dungeon.map[newY][newX] === 0) { // 0 is floor
      
      this.player.x = newX;
      this.player.y = newY;
      console.log(`Player moved to ${newX},${newY} in game for socket ${this.socketId}`);
      
      // Update FOV after moving
      this.updateFOV();
      
      // Check for game events like finding treasure or exit
      if (this.dungeon.exit && newX === this.dungeon.exit[0] && newY === this.dungeon.exit[1]) {
        // Handle win condition (e.g., escaped)
        this.gameState = 'won'; // Or some other state
        return { status: 'moved', event: 'escaped', player: this.player, visibleTiles: this.visibleTiles };
      }
      if (this.dungeon.treasure && newX === this.dungeon.treasure[0] && newY === this.dungeon.treasure[1] && !this.player.hasTreasure) {
        this.player.hasTreasure = true;
        // Remove treasure from dungeon so it won't be sent in future updates
        this.dungeon.treasure = null;
        console.log(`Player ${this.socketId} collected treasure! hasTreasure: ${this.player.hasTreasure}`);
        return { status: 'moved', event: 'treasure_found', player: this.player, visibleTiles: this.visibleTiles };
      }
      
      return { status: 'moved', player: this.player, visibleTiles: this.visibleTiles };
    }
    
    console.log(`Player move to ${newX},${newY} for socket ${this.socketId} is invalid (wall or out of bounds).`);
    return { status: 'invalid' };
  }
  
  moveMonster() {
    // Simple monster AI to move toward player
    const dx = Math.sign(this.player.x - this.monster.x);
    const dy = Math.sign(this.player.y - this.monster.y);
    
    // Try horizontal move
    if (dx !== 0) {
      if (this.dungeon.map[this.monster.y][this.monster.x + dx] === 0) {
        this.monster.x += dx;
        return;
      }
    }
    
    // Try vertical move
    if (dy !== 0) {
      if (this.dungeon.map[this.monster.y + dy][this.monster.x] === 0) {
        this.monster.y += dy;
        return;
      }
    }
    
    // Try random direction if direct path is blocked
    const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
    const shuffledDirs = ROT.RNG.shuffle(dirs.slice());
    
    for (const [dx, dy] of shuffledDirs) {
      const nx = this.monster.x + dx;
      const ny = this.monster.y + dy;
      if (this.dungeon.map[ny] && this.dungeon.map[ny][nx] === 0) {
        this.monster.x = nx;
        this.monster.y = ny;
        break;
      }
    }
  }
  
  // Update the getState() method to include all entities with relative positions
  getState() {
    // Calculate relative position of all entities from player's perspective
    // const playerX = this.player.x; // Not needed if sending absolute visibleTiles
    // const playerY = this.player.y; // Not needed if sending absolute visibleTiles
    
    // The client-side Game.js expects absolute coordinates for visibleTiles.
    // So, no conversion to relative coordinates is needed here for visibleTiles.
    // Just ensure this.visibleTiles is correctly populated by updateFOV.

    const state = {
      gameState: this.gameState,
      player: { ...this.player }, // Send a copy of player object
      monster: this.monster ? { ...this.monster } : null, // Send a copy if monster exists
      visibleTiles: { ...this.visibleTiles }, // Send a copy of visible tiles
      entrance: this.dungeon ? this.dungeon.entrance : null,
      exit: this.dungeon ? this.dungeon.exit : null,
      treasure: this.dungeon ? this.dungeon.treasure : null,
    };

    // Debug logging to verify entity data
    console.log("🎮 getState() sending entities - Monster:", state.monster, "Entrance:", state.entrance, "Exit:", state.exit, "Treasure:", state.treasure);

    return state;
  }
}

// Check if monster killed player
function checkMonsterKill(player, monster) {
    // Check for direct overlap - monster on same tile as player
    if (monster.x === player.x && monster.y === player.y) {
        return true; // Monster killed player
    }
    
    // Check for adjacent tiles (optional - if you want 1-tile proximity kills)
    const dx = Math.abs(monster.x - player.x);
    const dy = Math.abs(monster.y - player.y);
    
    // If monster is adjacent (one tile away in any direction)
    if ((dx <= 1 && dy === 0) || (dx === 0 && dy <= 1)) {
        return true; // Monster killed player
    }
    
    return false; // Player is safe
}

module.exports = Game;
module.exports.checkMonsterKill = checkMonsterKill;