/**
 * Difficulty Configuration
 * 
 * Configures dungeon difficulty based on crypto block timing.
 * The goal is to make the game challenging enough that the house wins
 * the majority of games (target: 60-70% house win rate).
 * 
 * Key factors affecting difficulty:
 * 1. Dungeon size (larger = more moves needed = harder)
 * 2. Monster starting position (closer to player = harder)
 * 3. Monster move frequency (how often monster moves per player move)
 * 4. Monster AI aggressiveness
 * 5. Treasure placement (farther from exit = riskier)
 * 6. Number of monsters (future enhancement)
 * 
 * Block times:
 * - Wownero (WOW): ~2 minutes (120 seconds)
 * - Monero (XMR): ~2 minutes (120 seconds)
 * - Bitcoin (for reference): ~10 minutes
 * 
 * Note: Previously docs said WOW was 5 min but it's actually 2 min like XMR.
 * We keep the config flexible for future adjustments.
 */

const DIFFICULTY_PRESETS = {
    // Easy - for testing, high player win rate
    easy: {
        dungeon: {
            width: 30,
            height: 15,
            roomWidthRange: [4, 8],
            roomHeightRange: [3, 6],
            corridorLengthRange: [2, 5],
            dugPercentage: 0.25 // More open space = easier navigation
        },
        monster: {
            startDistanceFromPlayer: 0.9, // 90% of max distance (far from player)
            movesPerPlayerMove: 0.5,      // Monster moves every other player move
            chaseAggressiveness: 0.6,     // 60% chance to chase, 40% random
            visionRange: 6,               // Short vision - easy to evade
            respawnOnDeath: false
        },
        treasure: {
            roomPositionRatio: 0.5,       // Middle room
            distanceFromExitRatio: 0.3    // Close to exit
        },
        targetHouseWinRate: 0.3           // 30% house wins (player-friendly)
    },

    // Normal - balanced for Wownero (2 min blocks)
    normal: {
        dungeon: {
            width: 45,
            height: 22,
            roomWidthRange: [3, 7],
            roomHeightRange: [3, 6],
            corridorLengthRange: [3, 7],
            dugPercentage: 0.2
        },
        monster: {
            startDistanceFromPlayer: 0.6, // 60% of max distance
            movesPerPlayerMove: 1.0,      // Monster moves every player move
            chaseAggressiveness: 0.8,     // 80% chase, 20% random
            visionRange: 10,              // Medium vision
            respawnOnDeath: false
        },
        treasure: {
            roomPositionRatio: 0.4,       // Early-middle room
            distanceFromExitRatio: 0.5    // Moderate distance from exit
        },
        targetHouseWinRate: 0.55          // 55% house wins
    },

    // Hard - challenging, house advantage
    hard: {
        dungeon: {
            width: 55,
            height: 28,
            roomWidthRange: [3, 6],
            roomHeightRange: [3, 5],
            corridorLengthRange: [4, 10],
            dugPercentage: 0.15           // Tighter corridors
        },
        monster: {
            startDistanceFromPlayer: 0.4, // Closer to player
            movesPerPlayerMove: 1.0,
            chaseAggressiveness: 0.9,     // Very aggressive
            visionRange: 14,              // Good vision
            respawnOnDeath: false
        },
        treasure: {
            roomPositionRatio: 0.3,       // Earlier room (farther from exit)
            distanceFromExitRatio: 0.7    // Farther from exit
        },
        targetHouseWinRate: 0.65          // 65% house wins
    },

    // Casino - high house edge for real money
    casino: {
        dungeon: {
            width: 60,
            height: 30,
            roomWidthRange: [3, 5],
            roomHeightRange: [3, 4],
            corridorLengthRange: [5, 12],
            dugPercentage: 0.12           // Very tight
        },
        monster: {
            startDistanceFromPlayer: 0.35, // Close to player
            movesPerPlayerMove: 1.0,
            chaseAggressiveness: 0.95,     // Nearly always chases
            visionRange: 18,               // Excellent vision
            respawnOnDeath: false
        },
        treasure: {
            roomPositionRatio: 0.25,       // Early room
            distanceFromExitRatio: 0.8     // Very far from exit
        },
        targetHouseWinRate: 0.70           // 70% house wins
    }
};

/**
 * Get difficulty preset based on crypto type and environment
 */
function getDifficultyPreset(cryptoType = 'WOW', overridePreset = null) {
    // Allow explicit override via environment
    const envPreset = process.env.DIFFICULTY_PRESET || overridePreset;
    
    if (envPreset && DIFFICULTY_PRESETS[envPreset]) {
        return { ...DIFFICULTY_PRESETS[envPreset], presetName: envPreset };
    }
    
    // Default based on payment mode and crypto
    const gameMode = process.env.GAME_MODE || 'FREE';
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';
    
    if (gameMode === 'FREE' && !paymentsEnabled) {
        // Free mode = easier for fun
        return { ...DIFFICULTY_PRESETS.normal, presetName: 'normal' };
    }
    
    // Paid modes = casino difficulty
    return { ...DIFFICULTY_PRESETS.casino, presetName: 'casino' };
}

/**
 * Merge difficulty config with custom overrides
 */
function getDifficultyConfig(cryptoType = 'WOW', customOverrides = {}) {
    const preset = getDifficultyPreset(cryptoType, customOverrides.preset);
    
    return {
        ...preset,
        dungeon: { ...preset.dungeon, ...customOverrides.dungeon },
        monster: { ...preset.monster, ...customOverrides.monster },
        treasure: { ...preset.treasure, ...customOverrides.treasure }
    };
}

/**
 * Calculate optimal monster starting room based on difficulty config
 * @param {Array} rooms - Array of dungeon rooms
 * @param {number} startDistanceRatio - 0.0 (same room as player) to 1.0 (farthest room)
 * @returns {number} Room index for monster spawn
 */
function getMonsterSpawnRoomIndex(rooms, startDistanceRatio = 0.6) {
    if (!rooms || rooms.length < 2) return 0;
    
    // Player spawns in room 0 (entrance)
    // startDistanceRatio of 1.0 = last room, 0.0 = first room
    const targetIndex = Math.floor((rooms.length - 1) * startDistanceRatio);
    
    // Don't spawn in first room (player's room) or last room (exit)
    return Math.max(1, Math.min(targetIndex, rooms.length - 2));
}

/**
 * Calculate treasure room based on difficulty config
 * @param {Array} rooms - Array of dungeon rooms  
 * @param {number} positionRatio - 0.0 (first room) to 1.0 (last room)
 * @returns {number} Room index for treasure
 */
function getTreasureRoomIndex(rooms, positionRatio = 0.5) {
    if (!rooms || rooms.length < 3) return Math.floor(rooms.length / 2);
    
    // Avoid first room (entrance) and last room (exit)
    const usableRooms = rooms.length - 2;
    const targetIndex = 1 + Math.floor(usableRooms * positionRatio);
    
    return Math.max(1, Math.min(targetIndex, rooms.length - 2));
}

module.exports = {
    DIFFICULTY_PRESETS,
    getDifficultyPreset,
    getDifficultyConfig,
    getMonsterSpawnRoomIndex,
    getTreasureRoomIndex
};
