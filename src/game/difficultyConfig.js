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
            width: 70,                     // Large dungeon (was 60)
            height: 35,                    // (was 30)
            roomWidthRange: [3, 4],        // Small rooms (was [3, 5])
            roomHeightRange: [3, 4],
            corridorLengthRange: [6, 15],  // Long corridors (was [5, 12])
            dugPercentage: 0.10            // Very tight (was 0.12)
        },
        monster: {
            startDistanceFromPlayer: 0.30, // Close to player (was 0.35)
            movesPerPlayerMove: 1.0,       // Monster matches player speed
            chaseAggressiveness: 0.97,     // Nearly always chases (was 0.95)
            visionRange: 22,               // Excellent vision (was 18)
            respawnOnDeath: false
        },
        treasure: {
            roomPositionRatio: 0.20,       // Early room (was 0.25)
            distanceFromExitRatio: 0.85    // Very far from exit (was 0.8)
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

// Per-network difficulty tuning, SOLVED by the balance sim (src/sim/calibrate.js) so cryptoType
// finally shapes difficulty instead of being a dead parameter. Two independent levers:
//   sizeScale ∝ √(blockTime/ref) — PACING: keeps a run's length a consistent fraction of the block
//     interval (GRIN sprint … BTC epic), applied to EVERY preset; the timer then contributes a
//     stable baseline. Reference network = WOW/XMR (2-min blocks) = 1.0.
//   monsterSpeed (movesPerPlayerMove) — the house EDGE lever; calibrated for the CASINO preset
//     (70% target) only, so it's applied ONLY to casino. On slow chains (BTC) the timer barely bites
//     a ~30s run, so the monster carries the edge (and caps ~64% even maxed — a real property of
//     block-timed play, not a bug).
// CAVEAT: the sim bots don't actively evade the monster, so monsterSpeed is a STARTING POINT that
// under-provisions vs skilled humans — validate/retune with live telemetry. The sizeScale half is
// bot-robust. Operator env overrides (DUNGEON_*, MONSTER_*) still win. Kill-switch: NETWORK_TUNING_DISABLED=true.
const NETWORK_TUNING = {
    WOW:  { sizeScale: 1.00, monsterSpeed: 1.08 },
    XMR:  { sizeScale: 1.00, monsterSpeed: 1.08 },
    LTC:  { sizeScale: 1.12, monsterSpeed: 1.11 },
    BTC:  { sizeScale: 1.60, monsterSpeed: 2.20 },
    GRIN: { sizeScale: 0.71, monsterSpeed: 0.94 }
};

// Fold the per-network tuning into a resolved preset (size for all presets, monster for casino).
function applyNetworkTuning(preset, cryptoType) {
    if (process.env.NETWORK_TUNING_DISABLED === 'true') return preset;
    const t = NETWORK_TUNING[String(cryptoType || '').trim().toUpperCase()];
    if (!t) return preset;
    const out = {
        ...preset,
        dungeon: {
            ...preset.dungeon,
            width: Math.max(20, Math.round(preset.dungeon.width * t.sizeScale)),
            height: Math.max(12, Math.round(preset.dungeon.height * t.sizeScale))
        }
    };
    if (preset.presetName === 'casino' && t.monsterSpeed) {
        out.monster = { ...preset.monster, movesPerPlayerMove: t.monsterSpeed };
    }
    return out;
}

/**
 * Merge difficulty config with custom overrides.
 * Precedence (low→high): preset → per-network tuning → env vars → explicit customOverrides.
 */
function getDifficultyConfig(cryptoType = 'WOW', customOverrides = {}) {
    const preset = applyNetworkTuning(getDifficultyPreset(cryptoType, customOverrides.preset), cryptoType);

    // Apply env var overrides (only when explicitly set)
    const envOverrides = {
        dungeon: {},
        monster: {},
        treasure: {}
    };

    const env = process.env;
    if (env.DUNGEON_WIDTH) envOverrides.dungeon.width = parseInt(env.DUNGEON_WIDTH);
    if (env.DUNGEON_HEIGHT) envOverrides.dungeon.height = parseInt(env.DUNGEON_HEIGHT);
    if (env.DUNGEON_DUG_PERCENTAGE) envOverrides.dungeon.dugPercentage = parseFloat(env.DUNGEON_DUG_PERCENTAGE);
    if (env.DUNGEON_ROOM_WIDTH_MIN) envOverrides.dungeon.roomWidthRange = [parseInt(env.DUNGEON_ROOM_WIDTH_MIN), parseInt(env.DUNGEON_ROOM_WIDTH_MAX || env.DUNGEON_ROOM_WIDTH_MIN)];
    if (env.DUNGEON_ROOM_HEIGHT_MIN) envOverrides.dungeon.roomHeightRange = [parseInt(env.DUNGEON_ROOM_HEIGHT_MIN), parseInt(env.DUNGEON_ROOM_HEIGHT_MAX || env.DUNGEON_ROOM_HEIGHT_MIN)];
    if (env.DUNGEON_CORRIDOR_MIN) envOverrides.dungeon.corridorLengthRange = [parseInt(env.DUNGEON_CORRIDOR_MIN), parseInt(env.DUNGEON_CORRIDOR_MAX || env.DUNGEON_CORRIDOR_MIN)];

    if (env.MONSTER_SPEED) envOverrides.monster.movesPerPlayerMove = parseFloat(env.MONSTER_SPEED);
    if (env.MONSTER_CHASE) envOverrides.monster.chaseAggressiveness = parseFloat(env.MONSTER_CHASE);
    if (env.MONSTER_VISION) envOverrides.monster.visionRange = parseInt(env.MONSTER_VISION);
    if (env.MONSTER_DISTANCE) envOverrides.monster.startDistanceFromPlayer = parseFloat(env.MONSTER_DISTANCE);

    if (env.TREASURE_ROOM_POSITION) envOverrides.treasure.roomPositionRatio = parseFloat(env.TREASURE_ROOM_POSITION);
    if (env.TREASURE_EXIT_DISTANCE) envOverrides.treasure.distanceFromExitRatio = parseFloat(env.TREASURE_EXIT_DISTANCE);

    return {
        ...preset,
        dungeon: { ...preset.dungeon, ...envOverrides.dungeon, ...customOverrides.dungeon },
        monster: { ...preset.monster, ...envOverrides.monster, ...customOverrides.monster },
        treasure: { ...preset.treasure, ...envOverrides.treasure, ...customOverrides.treasure }
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
    NETWORK_TUNING,
    applyNetworkTuning,
    getDifficultyPreset,
    getDifficultyConfig,
    getMonsterSpawnRoomIndex,
    getTreasureRoomIndex
};
