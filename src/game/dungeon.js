const crypto = require('crypto');
const ROT = require('./rot.js');
const { getDifficultyConfig, getMonsterSpawnRoomIndex, getTreasureRoomIndex } = require('./difficultyConfig');
const { createSeededRNG, seedToInt } = require('./provablyFair');

// Environment-based console logging control
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

// ========================================
// DUNGEON CONFIGURATION SECTION
// ========================================
// These values are now overridden by difficultyConfig.js based on game mode
// Edit difficultyConfig.js presets to customize dungeon generation
const DUNGEON_CONFIGS = {
    // Default dungeon dimensions (overridden by difficulty preset)
    DEFAULT_WIDTH: 45,
    DEFAULT_HEIGHT: 22,
    
    // Legacy smaller dungeon size (for compatibility)
    LEGACY_WIDTH: 25,
    LEGACY_HEIGHT: 19,
    
    // Dungeon generation settings (overridden by difficulty preset)
    ROOM_WIDTH_RANGE: [3, 7],
    ROOM_HEIGHT_RANGE: [3, 6],
    CORRIDOR_LENGTH_RANGE: [3, 7],
    DUG_PERCENTAGE: 0.2,
    
    // Lighting and appearance
    TORCH_DENSITY: 0.1,        // 20% chance for torches on wall tiles adjacent to floors
    TORCH_ENABLED: true,       // Set to false to disable torches completely
    FLOOR_VARIATION: 0.01,     // Chance for secondary floor tiles (visual variety)
    
    // Tile symbols
    PRIMARY_FLOOR: "'1",
    SECONDARY_FLOOR: "'2", 
    WALL_TILE: "#",
    TORCH_TILE: "torch"
};

/**
 * Dungeon generation utilities
 */
class DungeonGenerator {
    // Get the configuration object with difficulty settings applied
    static getConfig(cryptoType = null) {
        const difficulty = getDifficultyConfig(cryptoType || process.env.CRYPTO_TYPE || 'WOW');
        
        return { 
            ...DUNGEON_CONFIGS,
            // Override with difficulty settings
            DEFAULT_WIDTH: difficulty.dungeon.width,
            DEFAULT_HEIGHT: difficulty.dungeon.height,
            ROOM_WIDTH_RANGE: difficulty.dungeon.roomWidthRange,
            ROOM_HEIGHT_RANGE: difficulty.dungeon.roomHeightRange,
            CORRIDOR_LENGTH_RANGE: difficulty.dungeon.corridorLengthRange,
            DUG_PERCENTAGE: difficulty.dungeon.dugPercentage,
            // Include difficulty info for game.js
            difficulty: difficulty
        };
    }
    
    /**
     * PROVABLY FAIR (Phase 0.2): Reproduce a dungeon purely from its committed seed.
     * Mirrors the standard generation path used by Game so a verifier can independently
     * regenerate the exact layout a player saw. Assumes standard generation options
     * (the difficulty preset for `cryptoType`); games started with custom dungeon
     * overrides would need those overrides passed in `gameOptions` to match.
     * @param {string} seed - The revealed game seed
     * @param {string|null} cryptoType - Currency, selects the difficulty preset
     * @param {object} gameOptions - Optional overrides matching the original game
     * @returns {object} The regenerated dungeon ({ map, rooms, entrance, exit, treasure, torches })
     */
    static regenerateFromSeed(seed, cryptoType = null, gameOptions = {}) {
        const dungeonConfig = this.getConfig(cryptoType);
        const width = gameOptions.width || dungeonConfig.DEFAULT_WIDTH;
        const height = gameOptions.height || dungeonConfig.DEFAULT_HEIGHT;
        const gameConfig = {
            width,
            height,
            floorVariation: gameOptions.floorVariation !== undefined ? gameOptions.floorVariation : dungeonConfig.FLOOR_VARIATION,
            torchEnabled: gameOptions.torchEnabled !== undefined ? gameOptions.torchEnabled : dungeonConfig.TORCH_ENABLED,
            torchDensity: gameOptions.torchDensity !== undefined ? gameOptions.torchDensity : dungeonConfig.TORCH_DENSITY,
            primaryFloor: gameOptions.primaryFloor || dungeonConfig.PRIMARY_FLOOR,
            secondaryFloor: gameOptions.secondaryFloor || dungeonConfig.SECONDARY_FLOOR,
            torchTile: gameOptions.torchTile || dungeonConfig.TORCH_TILE,
            ...gameOptions
        };
        return this.generate(width, height, {
            ...gameConfig,
            rng: createSeededRNG(seed),
            seedInt: seedToInt(seed)
        });
    }

    /**
     * Deterministic fingerprint of a dungeon's layout, used to compare a regenerated
     * dungeon against the one that was played.
     * @param {object} dungeon - A dungeon object from generate()/regenerateFromSeed()
     * @returns {string} SHA-256 hex of the layout-defining fields
     */
    static layoutFingerprint(dungeon) {
        const payload = JSON.stringify({
            map: dungeon.map,
            entrance: dungeon.entrance,
            exit: dungeon.exit,
            treasure: dungeon.treasure
        });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    static generate(width, height, options = {}) {
        const defaultOptions = {
            floorVariation: DUNGEON_CONFIGS.FLOOR_VARIATION,
            torchEnabled: DUNGEON_CONFIGS.TORCH_ENABLED,
            torchDensity: DUNGEON_CONFIGS.TORCH_DENSITY,
            primaryFloor: DUNGEON_CONFIGS.PRIMARY_FLOOR,
            secondaryFloor: DUNGEON_CONFIGS.SECONDARY_FLOOR,
            torchTile: DUNGEON_CONFIGS.TORCH_TILE
        };
        
        const config = { ...defaultOptions, ...options };
        if (CONSOLE_LOGGING) {
            console.log(`[DungeonGenerator] Generating dungeon with effective torchDensity: ${config.torchDensity}`);
        }

        // PROVABLY FAIR (Phase 0.2): when a per-game seeded RNG is supplied, all
        // randomness in generation is derived from the committed seed so the dungeon
        // is reproducible for verification. `config.rng` drives floor/torch/treasure
        // placement; `config.seedInt` deterministically seeds ROT.RNG for the Digger.
        // Generation is fully synchronous, so seeding the global ROT.RNG here is safe
        // even with concurrent games (no other game can interleave mid-generation).
        const rng = (typeof config.rng === 'function') ? config.rng : Math.random;
        if (config.seedInt != null) {
            ROT.RNG.setSeed(config.seedInt);
        }

        // Create dungeon using ROT.js Map.Digger
        const digger = new ROT.Map.Digger(width, height, {
            roomWidth: DUNGEON_CONFIGS.ROOM_WIDTH_RANGE,
            roomHeight: DUNGEON_CONFIGS.ROOM_HEIGHT_RANGE,
            corridorLength: DUNGEON_CONFIGS.CORRIDOR_LENGTH_RANGE,
            dugPercentage: DUNGEON_CONFIGS.DUG_PERCENTAGE
        });
        
        // Initialize the empty map with walls (1)
        const map = Array(height).fill().map(() => Array(width).fill(1));
        
        // Fill in floors (0) using digger's callback
        digger.create((x, y, value) => {
            // value: 0 = floor, 1 = wall
            map[y][x] = value;
        });
        
        // Create enhanced map with floor variations and torches
        const enhancedMap = this.enhanceMapWithVariations(map, config);
        
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
            treasureCenter[0] + Math.floor(rng() * 3) - 1,
            treasureCenter[1] + Math.floor(rng() * 3) - 1
        ];
        
        // Ensure the treasure is on a floor tile (check for both floor types)
        const treasureTile = enhancedMap[treasure[1]][treasure[0]];
        if (treasureTile !== config.primaryFloor && treasureTile !== config.secondaryFloor) {
            treasure[0] = treasureCenter[0];
            treasure[1] = treasureCenter[1];
        }
        
        return {
            map: enhancedMap,  // Return the enhanced map with variations
            rooms: rooms, 
            entrance: entrance,
            exit: exit,
            treasure: treasure,
            torches: this.getTorchPositions(enhancedMap, config) // Include torch positions
        };
    }
    
    // Enhanced map creation with floor variations and torch placement
    static enhanceMapWithVariations(basicMap, config) {
        const enhancedMap = basicMap.map(row => row.slice()); // Create a deep copy
        const { primaryFloor, secondaryFloor, floorVariation, torchEnabled, torchDensity, torchTile } = config;

        if (typeof primaryFloor === 'undefined' || typeof secondaryFloor === 'undefined' || typeof floorVariation === 'undefined' || typeof torchEnabled === 'undefined' || typeof torchDensity === 'undefined' || typeof torchTile === 'undefined') {
            console.error("[DungeonGenerator.enhanceMapWithVariations] Critical config missing:", config);
            // Fallback or throw error if essential configs are still missing despite defaults
            // This indicates a problem upstream if defaults didn't propagate or were explicitly undefined.
        }

        let placedTorchesCount = 0; // Counter for torches placed in this function
        const rng = (typeof config.rng === 'function') ? config.rng : Math.random;

        // Log the torchDensity being used for this map generation pass
        if (CONSOLE_LOGGING) {
            console.log(`[DungeonGenerator.enhanceMapWithVariations] Starting enhancement with torchDensity: ${config.torchDensity}`);
        }

        const height = basicMap.length; // Use basicMap's dimensions
        const width = basicMap[0].length; // Use basicMap's dimensions

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const cell = basicMap[y][x];
                
                if (cell === 0) {
                    // Floor tile - randomly choose primary or secondary
                    if (rng() < config.floorVariation) {
                        enhancedMap[y][x] = config.secondaryFloor;
                    } else {
                        enhancedMap[y][x] = config.primaryFloor;
                    }
                } else if (cell === 1) {
                    // Wall tile - maybe add a torch
                    if (config.torchEnabled && this.shouldPlaceTorch(basicMap, x, y, config.torchDensity, rng)) {
                        enhancedMap[y][x] = config.torchTile;
                        placedTorchesCount++; // Increment if a torch is placed
                    } else {
                        enhancedMap[y][x] = '#'; // Regular wall
                    }
                }
            }
        }
        if (CONSOLE_LOGGING) {
            console.log(`[DungeonGenerator.enhanceMapWithVariations] Placed ${placedTorchesCount} torches during map enhancement.`);
        }
        return enhancedMap;
    }
    
    // Determine if a torch should be placed on this wall tile
    static shouldPlaceTorch(map, x, y, torchDensity, rng = Math.random) {
        // Only place torches on walls that are adjacent to floors (for lighting logic)
        const height = map.length;
        const width = map[0].length;
        
        // Check if this wall tile is adjacent to at least one floor tile
        const adjacentToFloor = [
            [-1, 0], [1, 0], [0, -1], [0, 1] // Adjacent cells
        ].some(([dx, dy]) => {
            const nx = x + dx;
            const ny = y + dy;
            return nx >= 0 && nx < width && ny >= 0 && ny < height && map[ny][nx] === 0;
        });
        
        const randomValue = rng();
        const shouldPlace = adjacentToFloor && randomValue < torchDensity;
        
        return shouldPlace;
    }
    
    // Get positions of all torches for client-side rendering
    static getTorchPositions(enhancedMap, config) {
        const torches = [];
        const { torchTile } = config; // Ensure config is used here

        if (typeof torchTile === 'undefined') {
            console.error("[DungeonGenerator.getTorchPositions] torchTile config missing:", config);
            return torches; // Or handle error appropriately
        }

        const height = enhancedMap.length;
        const width = enhancedMap[0].length;
        if (CONSOLE_LOGGING) {
            console.log(`[DungeonGenerator.getTorchPositions] Searching for torch tile '${config.torchTile}' in a ${width}x${height} map.`);
        }
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (enhancedMap[y][x] === config.torchTile) {
                    torches.push([x, y]);
                }
            }
        }
        if (CONSOLE_LOGGING) {
            console.log(`[DungeonGenerator.getTorchPositions] Found ${torches.length} torches. Positions: ${JSON.stringify(torches)}`);
        }
        return torches;
    }

    static getRandomRoomCenter(rooms, excludeFirst = false, excludeLast = false) {
        if (!rooms || rooms.length === 0) return null;
        
        let availableRooms = [...rooms];
        if (excludeFirst && availableRooms.length > 1) {
            availableRooms = availableRooms.slice(1);
        }
        if (excludeLast && availableRooms.length > 1) {
            availableRooms = availableRooms.slice(0, -1);
        }
        
        const randomRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];
        return randomRoom.getCenter();
    }
}

module.exports = DungeonGenerator;
