const { v4: uuidv4 } = require('uuid');
const ROT = require('./rot.js');
const Player = require('./player.js');
const Monster = require('./monster.js');
const DungeonGenerator = require('./dungeon.js');
const LightingAndFov = require('./lightingAndFov.js');

class Game {
  /**
   * Create a new game instance
   * @param {string} socketId - Socket ID of the player
   * @param {User} user - User object for statistics tracking
   * @param {object} gameOptions - Optional game configuration overrides
   */
  constructor(socketId, user, gameOptions = {}) {
    this.user = user;
    this.id = uuidv4();
    this.socketId = socketId;
    this.players = {};
    this.monsters = {};
    this.dungeon = null;

    // Get default configuration from DungeonGenerator
    const dungeonConfig = DungeonGenerator.getConfig();
    
    // Determine dimensions - use provided options or defaults
    const width = gameOptions.width || dungeonConfig.DEFAULT_WIDTH;
    const height = gameOptions.height || dungeonConfig.DEFAULT_HEIGHT;
    
    // Merge game configuration
    this.gameConfig = {
      width: width,
      height: height,
      // Dungeon generation options (can be overridden by gameOptions)
      floorVariation: gameOptions.floorVariation !== undefined ? gameOptions.floorVariation : dungeonConfig.FLOOR_VARIATION,
      torchEnabled: gameOptions.torchEnabled !== undefined ? gameOptions.torchEnabled : dungeonConfig.TORCH_ENABLED,
      torchDensity: gameOptions.torchDensity !== undefined ? gameOptions.torchDensity : dungeonConfig.TORCH_DENSITY,
      primaryFloor: gameOptions.primaryFloor || dungeonConfig.PRIMARY_FLOOR,
      secondaryFloor: gameOptions.secondaryFloor || dungeonConfig.SECONDARY_FLOOR,
      torchTile: gameOptions.torchTile || dungeonConfig.TORCH_TILE,
      // Other game options
      ...gameOptions
    };

    console.log(`[Game Constructor] Creating game for user ${user.id} (socket: ${socketId})`);
    console.log(`[Game Constructor] Dimensions: ${width}x${height}`);
    console.log(`[Game Constructor] Game config:`, JSON.stringify(this.gameConfig, null, 2));

    this.initializeGame();
  }

  /**
   * Static factory method to create a game with standard dimensions
   */
  static createStandardGame(socketId, user, options = {}) {
    return new Game(socketId, user, options);
  }

  /**
   * Static factory method to create a legacy-sized game
   */
  static createLegacyGame(socketId, user, options = {}) {
    const dungeonConfig = DungeonGenerator.getConfig();
    const legacyOptions = {
      width: dungeonConfig.LEGACY_WIDTH,
      height: dungeonConfig.LEGACY_HEIGHT,
      ...options
    };
    return new Game(socketId, user, legacyOptions);
  }

  initializeGame() {
    console.log(`[Game.initializeGame] Initializing game with config:`, JSON.stringify(this.gameConfig, null, 2));
    if (typeof this.gameConfig.width === 'undefined' || typeof this.gameConfig.height === 'undefined') {
      console.error("[Game.initializeGame] CRITICAL: Width or Height is undefined in gameConfig!", this.gameConfig);
      throw new Error(`Invalid game dimensions: width=${this.gameConfig.width}, height=${this.gameConfig.height}`);
    }

    // Set game dimensions from config
    this.width = this.gameConfig.width;
    this.height = this.gameConfig.height;
    
    // Initialize game state
    this.gameState = 'waiting';
    this.startBlock = null;
    this.player = new Player();
    this.monster = new Monster();
    this.fee = 0;

    // Generate dungeon with the provided dimensions and config
    this.dungeon = DungeonGenerator.generate(this.gameConfig.width, this.gameConfig.height, this.gameConfig);
    
    // Place player at entrance
    if (this.dungeon.entrance) {
      this.player.moveTo(this.dungeon.entrance[0], this.dungeon.entrance[1]);
    }
    
    // Place monster far from entrance
    if (this.dungeon.rooms && this.dungeon.rooms.length > 2) {
      const monsterRoom = this.dungeon.rooms[Math.floor(this.dungeon.rooms.length * 0.7)];
      const center = monsterRoom.getCenter();
      this.monster.moveTo(center[0], center[1]);
    }

    // Initialize lighting and FOV
    this.lightingAndFov = new LightingAndFov(this.dungeon.map, this.dungeon.torches);
    this._fovInstance = LightingAndFov.initializeFOV(this.dungeon.map, this.gameConfig);
    const fovRadius = this.gameConfig.fovRadius || 10; 
    this.visibleTiles = LightingAndFov.updateFOV(this._fovInstance, this.player, this.dungeon.map, fovRadius);
    
    // Set game state to active
    this.gameState = 'active';
  }
  
  updateFOV() {
    this.visibleTiles = LightingAndFov.updateFOV(this._fovInstance, this.player, this.dungeon.map, 10);
  }
  
  movePlayer(dx, dy) {
    const newX = this.player.x + dx;
    const newY = this.player.y + dy;
    
    console.log(`Move: (${this.player.x},${this.player.y}) -> (${newX},${newY})`);
    
    // Check if the move is valid (not into a wall and within map bounds)
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
        this.gameState = 'won';
        return { status: 'moved', event: 'escaped', player: this.player.getState(), visibleTiles: this.visibleTiles };
      }
      if (this.dungeon.treasure && this.player.isAt(this.dungeon.treasure[0], this.dungeon.treasure[1]) && !this.player.hasTreasure) {
        this.player.hasTreasure = true;
        console.log(`🏆 TREASURE PICKUP: Player ${this.socketId} collected treasure at (${this.dungeon.treasure[0]}, ${this.dungeon.treasure[1]})`);
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
  
  getState() {
    const state = {
      gameState: this.gameState,
      player: this.player.getState(),
      monster: this.monster ? this.monster.getState() : null,
      visibleTiles: { ...this.visibleTiles },
      lighting: this.calculateLighting(),
      entrance: this.dungeon ? this.dungeon.entrance : null,
      exit: this.dungeon ? this.dungeon.exit : null,
      treasure: this.dungeon ? this.dungeon.treasure : null,
    };

    console.log("🎮 getState() sending entities - Monster:", state.monster, "Entrance:", state.entrance, "Exit:", state.exit, "Treasure:", state.treasure);
    if (state.treasure === null) {
      console.log("✅ TREASURE NULL: Confirmed treasure is null in getState() - treasure was picked up!");
    }

    return state;
  }
  
  calculateLighting() {
    return LightingAndFov.calculateLighting(
      this.player, 
      this.dungeon?.torches || [], 
      this.visibleTiles, 
      10
    );
  }

  /**
   * End this game and update user statistics
   * @param {string} result - 'won', 'lost', or 'abandoned'
   * @param {object} gameStats - Additional statistics
   */
  endGame(result, gameStats = {}) {
    if (this.user) {
      const score = gameStats.score || 0;
      this.user.endGame(result, score, gameStats);
    }
    this.gameState = 'ended';
  }
}

module.exports = Game;