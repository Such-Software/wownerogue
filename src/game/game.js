const { v4: uuidv4 } = require('uuid');
const ROT = require('./rot.js');
const Player = require('./player.js');
const Monster = require('./monster.js');
const DungeonGenerator = require('./dungeon.js');
const LightingAndFov = require('./lightingAndFov.js');
const { getDifficultyConfig, getMonsterSpawnRoomIndex, getTreasureRoomIndex } = require('./difficultyConfig');
const { createGameProof, getPreGameCommitment, getPostGameReveal, createSeededRNG, seedToInt, seededShuffle } = require('./provablyFair');

// Environment-based console logging control
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

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
    this.moveCount = 0;
    this.startedAt = Date.now();
    
    // Provably fair: Generate game proof before anything else
    this.gameProof = createGameProof(this.id);
    // Per-game deterministic RNG derived from the committed seed. ALL game randomness
    // (dungeon generation + monster movement) flows through this so the game is
    // reproducible from the seed for provably-fair verification.
    this.seededRNG = createSeededRNG(this.gameProof.seed);
    this.seedInt = seedToInt(this.gameProof.seed);

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

    if (CONSOLE_LOGGING) {
      console.log(`[Game Constructor] Creating game for user ${user.id} (socket: ${socketId})`);
      console.log(`[Game Constructor] Dimensions: ${width}x${height}`);
      console.log(`[Game Constructor] Game config:`, JSON.stringify(this.gameConfig, null, 2));
    }

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
    if (CONSOLE_LOGGING) {
      console.log(`[Game.initializeGame] Initializing game with config:`, JSON.stringify(this.gameConfig, null, 2));
    }
    if (typeof this.gameConfig.width === 'undefined' || typeof this.gameConfig.height === 'undefined') {
      console.error("[Game.initializeGame] CRITICAL: Width or Height is undefined in gameConfig!", this.gameConfig);
      throw new Error(`Invalid game dimensions: width=${this.gameConfig.width}, height=${this.gameConfig.height}`);
    }

    // Set game dimensions from config
    this.width = this.gameConfig.width;
    this.height = this.gameConfig.height;
    
    // Get difficulty settings
    const difficultyConfig = getDifficultyConfig(process.env.CRYPTO_TYPE || 'WOW');
    this.difficultyConfig = difficultyConfig;
    
    if (CONSOLE_LOGGING) {
      console.log(`[Game.initializeGame] Using difficulty preset: ${difficultyConfig.presetName}`);
      console.log(`[Game.initializeGame] Target house win rate: ${difficultyConfig.targetHouseWinRate * 100}%`);
    }
    
    // Initialize game state
    this.gameState = 'waiting';
    this.startBlock = null;
    this.player = new Player();
    this.monster = new Monster(0, 0, { 
      visionRange: difficultyConfig.monster.visionRange || 12 
    });
    this.monsterMoveAccumulator = 0; // For fractional monster moves
    this.fee = 0;

    // Generate dungeon with the provided dimensions and config.
    // Pass the per-game seeded RNG + numeric seed so the layout is deterministic
    // and verifiable from the committed seed (provably fair).
    this.dungeon = DungeonGenerator.generate(this.gameConfig.width, this.gameConfig.height, {
      ...this.gameConfig,
      rng: this.seededRNG,
      seedInt: this.seedInt
    });
    
    // Place player at entrance
    if (this.dungeon.entrance) {
      this.player.moveTo(this.dungeon.entrance[0], this.dungeon.entrance[1]);
    }
    
    // Place monster based on difficulty config (closer = harder)
    if (this.dungeon.rooms && this.dungeon.rooms.length > 2) {
      const monsterRoomIndex = getMonsterSpawnRoomIndex(
        this.dungeon.rooms, 
        difficultyConfig.monster.startDistanceFromPlayer
      );
      const monsterRoom = this.dungeon.rooms[monsterRoomIndex];
      const center = monsterRoom.getCenter();
      this.monster.moveTo(center[0], center[1]);
      
      if (CONSOLE_LOGGING) {
        console.log(`[Game.initializeGame] Monster spawned in room ${monsterRoomIndex}/${this.dungeon.rooms.length - 1} (distance ratio: ${difficultyConfig.monster.startDistanceFromPlayer})`);
      }
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
    
    if (CONSOLE_LOGGING) {
      console.log(`Move: (${this.player.x},${this.player.y}) -> (${newX},${newY})`);
    }
    
    // Check if the move is valid (not into a wall and within map bounds)
    const primaryFloor = this.gameConfig.primaryFloor || "'1";
    const secondaryFloor = this.gameConfig.secondaryFloor || "'2";
    
    if (this.dungeon && 
        this.dungeon.map[newY] && 
        this.dungeon.map[newY][newX] !== undefined && 
        (this.dungeon.map[newY][newX] === primaryFloor || this.dungeon.map[newY][newX] === secondaryFloor)) {
      
      this.player.moveTo(newX, newY);
      this.moveCount += 1;
      if (CONSOLE_LOGGING) {
        console.log(`Player moved to ${newX},${newY} in game for socket ${this.socketId}`);
      }
      
      // Update FOV after moving
      this.updateFOV();
      
      // Check if player walked into monster (death by collision)
      if (this.monster && this.monster.x === newX && this.monster.y === newY) {
        this.gameState = 'lost';
        if (CONSOLE_LOGGING) {
          console.log(`💀 Player walked into monster at (${newX},${newY}) - GAME OVER`);
        }
        return { 
          status: 'moved', 
          event: 'monster_caught', 
          player: this.player.getState(), 
          monster: this.monster.getState(),
          visibleTiles: this.visibleTiles, 
          moves: this.moveCount 
        };
      }
      
      // Check for game events like finding treasure or exit
      if (this.dungeon.exit && this.player.isAt(this.dungeon.exit[0], this.dungeon.exit[1])) {
        this.gameState = 'won';
  return { status: 'moved', event: 'escaped', player: this.player.getState(), visibleTiles: this.visibleTiles, moves: this.moveCount };
      }
      if (this.dungeon.treasure && this.player.isAt(this.dungeon.treasure[0], this.dungeon.treasure[1]) && !this.player.hasTreasure) {
        this.player.hasTreasure = true;
        if (CONSOLE_LOGGING) {
          console.log(`🏆 TREASURE PICKUP: Player ${this.socketId} collected treasure at (${this.dungeon.treasure[0]}, ${this.dungeon.treasure[1]})`);
        }
        this.dungeon.treasure = null;
        if (CONSOLE_LOGGING) {
          console.log(`🗑️ TREASURE REMOVED: dungeon.treasure is now null for player ${this.socketId}`);
          console.log(`Player ${this.socketId} collected treasure! hasTreasure: ${this.player.hasTreasure}`);
        }
  return { status: 'moved', event: 'treasure_found', player: this.player.getState(), visibleTiles: this.visibleTiles, moves: this.moveCount };
      }
      
  return { status: 'moved', player: this.player.getState(), visibleTiles: this.visibleTiles, moves: this.moveCount };
    }
    
    if (CONSOLE_LOGGING) {
      console.log(`Move BLOCKED: ${newX},${newY} - cell value: ${this.dungeon && this.dungeon.map[newY] ? this.dungeon.map[newY][newX] : 'undefined'}`);
    }
    return { status: 'invalid' };
  }
  
  moveMonster() {
    if (!this.monster || !this.player) {
      return { status: 'idle' };
    }

    // Get monster movement rate from difficulty config
    const movesPerPlayerMove = this.difficultyConfig?.monster?.movesPerPlayerMove ?? 1.0;
    const chaseAggressiveness = this.difficultyConfig?.monster?.chaseAggressiveness ?? 0.8;
    
    // Accumulate fractional moves
    this.monsterMoveAccumulator = (this.monsterMoveAccumulator || 0) + movesPerPlayerMove;
    
    // Only move if accumulator >= 1
    while (this.monsterMoveAccumulator >= 1) {
      this.monsterMoveAccumulator -= 1;
      
      // Apply chase aggressiveness (chance to move randomly instead of chasing).
      // Use the per-game seeded RNG so monster behaviour is deterministic from the seed.
      if (this.seededRNG() < chaseAggressiveness) {
        this.monster.moveTowardPlayer(this.player, this.dungeon, this.seededRNG);
      } else {
        // Random move - still try to move, just not toward player
        this.monster.moveTowardPlayer(null, this.dungeon, this.seededRNG);
      }
    }

    if (this.monster.hasCaughtPlayer(this.player)) {
      this.gameState = 'lost';
      return {
        status: 'monster_caught',
        event: 'monster_caught',
        player: this.player.getState(),
        monster: this.monster.getState()
      };
    }

    return {
      status: 'moved',
      player: this.player.getState(),
      monster: this.monster.getState()
    };
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
      moves: this.moveCount,
      startedAt: this.startedAt
    };

    if (CONSOLE_LOGGING) {
      console.log("🎮 getState() sending entities - Monster:", state.monster, "Entrance:", state.entrance, "Exit:", state.exit, "Treasure:", state.treasure);
      if (state.treasure === null) {
        console.log("✅ TREASURE NULL: Confirmed treasure is null in getState() - treasure was picked up!");
      }
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

  /**
   * Get the provably fair commitment to show BEFORE game starts
   * This is the hash of the seed - player can verify after game
   * @returns {object} Pre-game commitment data
   */
  getProofCommitment() {
    return getPreGameCommitment(this.gameProof);
  }

  /**
   * Get the provably fair reveal data to show AFTER game ends
   * This includes the seed so player can verify
   * @returns {object} Post-game reveal data with seed
   */
  getProofReveal() {
    return getPostGameReveal(this.gameProof, {
      won: this.gameState === 'won',
      treasureFound: this.player?.hasTreasure ?? false,
      moves: this.moveCount,
      duration: Math.floor((Date.now() - this.startedAt) / 1000)
    });
  }

  /**
   * Get the game seed (only after game ends for fairness)
   * @returns {string|null} Seed if game ended, null otherwise
   */
  getSeed() {
    if (this.gameState === 'ended' || this.gameState === 'won' || this.gameState === 'lost') {
      return this.gameProof.seed;
    }
    return null; // Don't reveal seed during active game
  }
}

module.exports = Game;