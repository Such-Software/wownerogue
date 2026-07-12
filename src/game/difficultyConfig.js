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
 * Block times (measured against live daemons; see chainProfile.js meanBlockTimeMs):
 * - Grin (GRIN): ~1 minute
 * - Monero (XMR): ~2 minutes
 * - Litecoin (LTC): ~2.5 minutes
 * - Wownero (WOW): ~5 minutes  (measured 5.01 min/block over 1000 blocks — an earlier "correction"
 *   to 2 min was WRONG; WOW is a SLOW chain, closer to BTC than XMR for calibration purposes)
 * - Bitcoin (BTC): ~10 minutes
 *
 * Slow chains (WOW/BTC) can't get a timer-driven house edge from a single dungeon without it
 * becoming an unplayable slog → they want MULTI-LEVEL depth. See NETWORK_TUNING below.
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

    // Normal - balanced baseline (~2 min blocks, i.e. XMR; WOW is actually ~5 min — see header)
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

// Per-network SIZE tuning so cryptoType shapes difficulty (it used to be a dead parameter).
//   sizeScale ∝ √(blockTime/ref) — PACING: a run's length as a consistent fraction of the block
//     interval, applied to EVERY preset. Reference = XMR (2-min blocks) = 1.0. Clamped [0.7, 1.6]
//     so single maps stay playable.
//
// DELIBERATELY NO monster-speed lever. The sim proved a supernaturally fast monster (a) feels like
// cheating and (b) doesn't even WORK on slow chains — WOW (5-min blocks) caps ~64% house-win even
// at a 2.2× monster on a 111×55 map, because a single dungeon clears in ~1 min << the block, so the
// timer (the fair, on-theme "race the block" edge) barely bites. The real edge lever for slow chains
// is MULTI-LEVEL DEPTH (cumulative run length across levels), which is the next build. Until then,
// slow chains (WOW/BTC) run honest-but-under-target on the timer; the monster stays at its fair
// preset speed. Operator env overrides (DUNGEON_*, MONSTER_*) still win. Kill: NETWORK_TUNING_DISABLED=true.
const NETWORK_TUNING = {
    GRIN: { sizeScale: 0.71 }, // ~1 min blocks
    XMR:  { sizeScale: 1.00 }, // ~2 min (reference)
    LTC:  { sizeScale: 1.12 }, // ~2.5 min
    WOW:  { sizeScale: 1.60 }, // ~5 min (measured) — wants multi-level, not one giant map
    BTC:  { sizeScale: 1.60 }  // ~10 min — wants multi-level
};

// Fold the per-network SIZE scale into a resolved preset (pacing; monster left at the fair preset speed).
function applyNetworkTuning(preset, cryptoType) {
    if (process.env.NETWORK_TUNING_DISABLED === 'true') return preset;
    const t = NETWORK_TUNING[String(cryptoType || '').trim().toUpperCase()];
    if (!t) return preset;
    return {
        ...preset,
        dungeon: {
            ...preset.dungeon,
            width: Math.max(20, Math.round(preset.dungeon.width * t.sizeScale)),
            height: Math.max(12, Math.round(preset.dungeon.height * t.sizeScale))
        }
    };
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
