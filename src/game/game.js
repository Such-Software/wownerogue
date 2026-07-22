const { v4: uuidv4 } = require('uuid');
const ROT = require('./rot.js');
const Player = require('./player.js');
const Monster = require('./monster.js');
const DungeonGenerator = require('./dungeon.js');
const LightingAndFov = require('./lightingAndFov.js');
const { getDifficultyConfig, getMonsterSpawnRoomIndex, getTreasureRoomIndex } = require('./difficultyConfig');
const { createGameProof, getPreGameCommitment, getPostGameReveal, createSeededRNG, seedToInt, levelSeed, seededShuffle } = require('./provablyFair');

// Environment-based console logging control
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';
// Only this module can mint the option that selects a historical generator. Public/client game
// options may contain a same-named string, but the constructor deliberately discards it. Durable
// restart restoration supplies the database-validated version through the symbol-backed factory.
const TRUSTED_GENERATOR_VERSION = Symbol('trustedGeneratorVersion');

class Game {
  /**
   * Create a new game instance
   * @param {string} socketId - Socket ID of the player
   * @param {User} user - User object for statistics tracking
   * @param {object} gameOptions - Optional game configuration overrides
   */
  constructor(socketId, user, gameOptions = {}) {
    const suppliedOptions = (gameOptions && typeof gameOptions === 'object') ? gameOptions : {};
    const fairnessProof = suppliedOptions.fairnessProof || null;
    // Internal proof material (including the secret server seed) must never ride into dungeon
    // options, snapshots, logs, or the persisted public generation context.
    const {
      fairnessProof: _privateFairnessProof,
      clientSeed: optionClientSeed,
      generatorVersion: _untrustedGeneratorVersion,
      [TRUSTED_GENERATOR_VERSION]: trustedGeneratorVersion,
      ...dungeonOptions
    } = suppliedOptions;
    this.generatorVersion = trustedGeneratorVersion || DungeonGenerator.GENERATOR_VERSION;
    if (!DungeonGenerator.SUPPORTED_GENERATOR_VERSIONS.includes(this.generatorVersion)) {
      throw new Error(`Unsupported trusted dungeon generator version: ${this.generatorVersion}`);
    }
    this.user = user;
    this.id = uuidv4();
    this.socketId = socketId;
    this.players = {};
    this.monsters = {};
    this.dungeon = null;
    this.moveCount = 0;
    this.startedAt = Date.now();
    
    // Provably fair: Generate game proof before anything else
    this.gameProof = createGameProof(
      this.id,
      fairnessProof?.clientSeed ?? optionClientSeed ?? '',
      fairnessProof
    );
    // Per-game deterministic RNG derived from the committed seed. ALL game randomness
    // (dungeon generation + monster movement) flows through this so the game is
    // reproducible from the seed for provably-fair verification.
    this.seededRNG = createSeededRNG(this.gameProof.seed);
    this.seedInt = seedToInt(this.gameProof.seed);

    // Get default configuration from DungeonGenerator
    const dungeonConfig = DungeonGenerator.getConfig();
    
    // Determine dimensions - use provided options or defaults
    const width = dungeonOptions.width || dungeonConfig.DEFAULT_WIDTH;
    const height = dungeonOptions.height || dungeonConfig.DEFAULT_HEIGHT;
    
    // Merge game configuration
    this.gameConfig = {
      width: width,
      height: height,
      // Dungeon generation options (can be overridden by gameOptions)
      floorVariation: dungeonOptions.floorVariation !== undefined ? dungeonOptions.floorVariation : dungeonConfig.FLOOR_VARIATION,
      torchEnabled: dungeonOptions.torchEnabled !== undefined ? dungeonOptions.torchEnabled : dungeonConfig.TORCH_ENABLED,
      torchDensity: dungeonOptions.torchDensity !== undefined ? dungeonOptions.torchDensity : dungeonConfig.TORCH_DENSITY,
      primaryFloor: dungeonOptions.primaryFloor || dungeonConfig.PRIMARY_FLOOR,
      secondaryFloor: dungeonOptions.secondaryFloor || dungeonConfig.SECONDARY_FLOOR,
      torchTile: dungeonOptions.torchTile || dungeonConfig.TORCH_TILE,
      // Resolve every layout-affecting preset value now. Persisting these exact values lets an
      // old game regenerate after operators change difficulty environment variables later.
      roomWidthRange: dungeonOptions.roomWidthRange || dungeonConfig.ROOM_WIDTH_RANGE,
      roomHeightRange: dungeonOptions.roomHeightRange || dungeonConfig.ROOM_HEIGHT_RANGE,
      corridorLengthRange: dungeonOptions.corridorLengthRange || dungeonConfig.CORRIDOR_LENGTH_RANGE,
      dugPercentage: dungeonOptions.dugPercentage ?? dungeonConfig.DUG_PERCENTAGE,
      roomPositionRatio: dungeonOptions.roomPositionRatio ?? dungeonConfig.difficulty?.treasure?.roomPositionRatio,
      cryptoType: dungeonOptions.cryptoType || process.env.CRYPTO_TYPE || 'WOW',
      // Other game options
      ...dungeonOptions
    };

    if (CONSOLE_LOGGING) {
      console.log(`[Game Constructor] Creating game for user ${user.id} (socket: ${socketId})`);
      console.log(`[Game Constructor] Dimensions: ${width}x${height}`);
      console.log(`[Game Constructor] Game config:`, JSON.stringify(this.gameConfig, null, 2));
    }

    this.initializeGame();

    // Bind the proof to every level in the committed run. Deeper layouts are independently
    // regenerated from their per-depth seeds now, before play, so a crash or early death still
    // leaves a complete, immutable verification manifest for the advertised descent.
    this.gameProof.generatorVersion = this.generatorVersion;
    this.gameProof.context = this.getProofContext();
    this.gameProof.layoutFingerprints = this._buildLayoutFingerprintManifest();
    // Backward-compatible level-one alias used by older verification clients/rows.
    this.gameProof.layoutFingerprint = this.gameProof.layoutFingerprints[0]?.fingerprint || null;
  }

  _buildLayoutFingerprintManifest() {
    const manifest = [];
    for (let depth = 1; depth <= this.maxDepth; depth += 1) {
      let dungeon;
      if (depth === 1) {
        dungeon = this.dungeon;
      } else {
        dungeon = DungeonGenerator.regenerateFromSeed(
          levelSeed(this.gameProof.seed, depth),
          this.gameConfig.cryptoType,
          {
            ...this.gameProof.context.generationOptions,
            generatorVersion: this.generatorVersion
          }
        );
        if (depth < this.maxDepth) dungeon.treasure = null;
      }
      manifest.push({
        depth,
        fingerprintVersion: DungeonGenerator.FINGERPRINT_VERSION,
        generatorVersion: this.generatorVersion,
        fingerprint: DungeonGenerator.layoutFingerprint(dungeon)
      });
    }
    return manifest;
  }

  getProofContext() {
    const keys = [
      'width', 'height', 'floorVariation', 'torchEnabled', 'torchDensity', 'primaryFloor',
      'secondaryFloor', 'torchTile', 'roomWidthRange', 'roomHeightRange',
      'corridorLengthRange', 'dugPercentage', 'roomPositionRatio', 'cryptoType'
    ];
    const generationOptions = {};
    for (const key of keys) generationOptions[key] = this.gameConfig[key];
    return {
      cryptoType: this.gameConfig.cryptoType || process.env.CRYPTO_TYPE || 'WOW',
      maxDepth: this.maxDepth,
      generatorVersion: this.generatorVersion,
      fingerprintVersion: DungeonGenerator.FINGERPRINT_VERSION,
      generationOptions
    };
  }

  /**
   * Static factory method to create a game with standard dimensions
   */
  static createStandardGame(socketId, user, options = {}) {
    return new Game(socketId, user, options);
  }

  /** @internal Rebuild a run using the generator version already trusted from PostgreSQL. */
  static createRestoredStandardGame(socketId, user, options = {}, generatorVersion) {
    return new Game(socketId, user, {
      ...options,
      [TRUSTED_GENERATOR_VERSION]: generatorVersion
    });
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
    const difficultyConfig = getDifficultyConfig(this.gameConfig.cryptoType || process.env.CRYPTO_TYPE || 'WOW');
    this.difficultyConfig = difficultyConfig;

    // Multi-level descent: a run spans `maxDepth` levels (a pacing knob ∝ block time, from the
    // per-network tuning). Reaching a non-final exit descends to a fresh level; only the final
    // level's exit escapes. Defaults to 1 (single level) when no tuning is present.
    this.depth = 1;
    this.maxDepth = Math.max(1, parseInt(difficultyConfig.levels, 10) || 1);

    if (CONSOLE_LOGGING) {
      console.log(`[Game.initializeGame] Using difficulty preset: ${difficultyConfig.presetName}`);
      console.log(`[Game.initializeGame] Target house win rate: ${difficultyConfig.targetHouseWinRate * 100}%`);
      console.log(`[Game.initializeGame] Levels this run: ${this.maxDepth}`);
    }

    // Initialize game state
    this.gameState = 'waiting';
    this.startBlock = null;
    this.player = new Player();
    this.monsterMoveAccumulator = 0; // For fractional monster moves
    this.fee = 0;

    // Generate the first level (also creates the monster + FOV for it).
    this._generateLevel(1);

    // Set game state to active
    this.gameState = 'active';
  }

  /**
   * Generate the dungeon for a given level and place the player + a fresh monster on it. The layout
   * is deterministic from the committed seed via a per-level seed (level 1 = master seed, so
   * single-level games are unchanged; deeper levels salt it), keeping the whole descent verifiable.
   * Treasure lives only in the vault (the final level) — intermediate levels are a race to the stairs.
   * @param {number} depth - 1-based level index
   */
  _generateLevel(depth) {
    const isFirst = depth === 1;
    const seed = levelSeed(this.gameProof.seed, depth);
    const dungeon = DungeonGenerator.generate(this.gameConfig.width, this.gameConfig.height, {
      ...this.gameConfig,
      generatorVersion: this.generatorVersion,
      rng: isFirst ? this.seededRNG : createSeededRNG(seed),
      seedInt: isFirst ? this.seedInt : seedToInt(seed)
    });

    // Only the final level holds the treasure — descend all the way for the reward.
    if (depth < this.maxDepth) {
      dungeon.treasure = null;
    }
    this.dungeon = dungeon;

    // Once the constructor has committed its all-level manifest, assert every actually played
    // descent still matches it. This turns accidental generator drift within a live process into
    // a hard failure rather than silently serving an unverifiable paid layout.
    const expected = this.gameProof.layoutFingerprints?.find(item => item.depth === depth);
    if (expected) {
      const actual = DungeonGenerator.layoutFingerprint(dungeon, expected.fingerprintVersion);
      if (actual !== expected.fingerprint) {
        throw new Error(`Generated level ${depth} does not match its committed fingerprint`);
      }
    }

    // Place player at the entrance.
    if (dungeon.entrance) {
      this.player.moveTo(dungeon.entrance[0], dungeon.entrance[1]);
    }

    // Fresh monster per level, placed by difficulty config (closer = harder).
    this.monster = new Monster(0, 0, { visionRange: this.difficultyConfig.monster.visionRange || 12 });
    this.monsterMoveAccumulator = 0;
    if (dungeon.rooms && dungeon.rooms.length > 2) {
      const idx = getMonsterSpawnRoomIndex(dungeon.rooms, this.difficultyConfig.monster.startDistanceFromPlayer);
      const center = dungeon.rooms[idx].getCenter();
      this.monster.moveTo(center[0], center[1]);
    }
    // ROT.Digger can legitimately produce <=2 rooms on the 30x15 easy profile. The old branch
    // then left the monster at its constructor default (0,0), normally a wall, producing an
    // effectively monsterless run. Also defend against a malformed room center. Choose the
    // farthest passable non-objective tile deterministically; this consumes no RNG and dungeon
    // generation/layout fingerprints remain byte-identical (monster execution is explicitly
    // outside the published layout proof).
    const primaryFloor = this.gameConfig.primaryFloor || "'1";
    const secondaryFloor = this.gameConfig.secondaryFloor || "'2";
    const monsterTilePassable = (x, y) => {
      const tile = dungeon.map?.[y]?.[x];
      return tile === primaryFloor || tile === secondaryFloor || tile === 0 || tile === '>' || tile === '$M';
    };
    const monsterSpawnValid = monsterTilePassable(this.monster.x, this.monster.y)
      && (this.monster.x !== this.player.x || this.monster.y !== this.player.y)
      && (!dungeon.exit || this.monster.x !== dungeon.exit[0] || this.monster.y !== dungeon.exit[1])
      && (!dungeon.treasure || this.monster.x !== dungeon.treasure[0] || this.monster.y !== dungeon.treasure[1]);
    if (!monsterSpawnValid) {
      let fallback = null;
      let fallbackDistance = -1;
      for (let y = 0; y < dungeon.map.length; y += 1) {
        for (let x = 0; x < dungeon.map[y].length; x += 1) {
          if (!monsterTilePassable(x, y)) continue;
          if (x === this.player.x && y === this.player.y) continue;
          if (dungeon.exit && x === dungeon.exit[0] && y === dungeon.exit[1]) continue;
          if (dungeon.treasure && x === dungeon.treasure[0] && y === dungeon.treasure[1]) continue;
          const distance = Math.abs(x - this.player.x) + Math.abs(y - this.player.y);
          if (distance > fallbackDistance) {
            fallback = [x, y];
            fallbackDistance = distance;
          }
        }
      }
      if (!fallback) throw new Error('Dungeon has no valid monster spawn tile');
      this.monster.moveTo(fallback[0], fallback[1]);
    }

    // Reset lighting + FOV for the new level (a fresh descent is unexplored).
    this.lightingAndFov = new LightingAndFov(dungeon.map, dungeon.torches);
    this._fovInstance = LightingAndFov.initializeFOV(dungeon.map, this.gameConfig);
    const fovRadius = this.gameConfig.fovRadius || 10;
    this.visibleTiles = LightingAndFov.updateFOV(this._fovInstance, this.player, dungeon.map, fovRadius);
  }

  /** Take the stairs down to the next level (regenerates the dungeon, keeps player identity/treasure). */
  _descend() {
    this.depth += 1;
    this._generateLevel(this.depth);
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
        // Not at the bottom yet → take the stairs down to a fresh level (NOT a win). The new level
        // is generated here, so the returned state (and the next getState) already reflects it.
        if (this.depth < this.maxDepth) {
          this._descend();
          return {
            status: 'moved', event: 'descend', depth: this.depth, maxDepth: this.maxDepth,
            player: this.player.getState(), visibleTiles: this.visibleTiles, moves: this.moveCount
          };
        }
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

      // Collision check after EACH sub-step (Phase 3.3). With movesPerPlayerMove > 1
      // (e.g. the casino preset's 1.5x speed) the monster takes multiple steps per turn;
      // checking only after the loop let it step onto the player's tile and back off
      // between checks, "phasing through" the player and missing the catch (a player-
      // favorable bug). Checking each sub-step closes that gap.
      if (this.monster.hasCaughtPlayer(this.player)) {
        this.gameState = 'lost';
        return {
          status: 'monster_caught',
          event: 'monster_caught',
          player: this.player.getState(),
          monster: this.monster.getState()
        };
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
      depth: this.depth,
      maxDepth: this.maxDepth,
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
    this.finalResult = result;
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
      won: this.finalResult === 'won' || this.gameState === 'won',
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
