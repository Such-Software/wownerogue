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
    this.width = mapWidth || 50;
    this.height = mapHeight || 30;
    this.gameState = 'waiting'; // waiting, active, won, lost
    this.startBlock = null;
    this.dungeon = null;
    this.player = { x: 0, y: 0, hasKey: false, hasTreasure: false };
    this.monster = { x: 0, y: 0 };
    this.fee = 0; // Amount player paid
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
  }
  
  movePlayer(dx, dy) {
    const newX = this.player.x + dx;
    const newY = this.player.y + dy;
    
    // Check if the move is valid (not into a wall)
    if (this.dungeon.map[newY][newX] === 0) {
      this.player.x = newX;
      this.player.y = newY;
      
      // Check if player found treasure
      if (this.dungeon.treasure && 
          newX === this.dungeon.treasure[0] && 
          newY === this.dungeon.treasure[1]) {
        this.player.hasTreasure = true;
      }
      
      // Check if player reached exit
      if (this.dungeon.exit && 
          newX === this.dungeon.exit[0] && 
          newY === this.dungeon.exit[1]) {
        this.gameState = 'won';
        return { status: 'won', hasTreasure: this.player.hasTreasure };
      }
      
      // Move monster after player moves
      this.moveMonster();
      
      // Check if monster caught player
      if (this.monster.x === this.player.x && this.monster.y === this.player.y) {
        this.gameState = 'lost';
        return { status: 'lost', reason: 'caught' };
      }
      
      return { status: 'moved' };
    }
    
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
  
  getState() {
    return {
      gameState: this.gameState,
      player: this.player,
      monster: this.monster,
      map: this.dungeon.map,
      entrance: this.dungeon.entrance,
      exit: this.dungeon.exit,
      treasure: this.dungeon.treasure,
      hasTreasure: this.player.hasTreasure
    };
  }
}

module.exports = Game;