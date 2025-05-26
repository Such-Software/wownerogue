const ROT = require('./rot.js');

/**
 * Dungeon generation utilities
 */
class DungeonGenerator {
    static generate(width, height, options = {}) {
        // Default options for dungeon generation
        const defaultOptions = {
            floorVariation: 0.01,      // 1% secondary floor tiles
            torchEnabled: true,         // Enable torch placement
            torchDensity: 0.05,        // Default: 5% of wall tiles get torches (comment updated)
            primaryFloor: "'1",        // Primary floor tile
            secondaryFloor: "'2",      // Secondary floor tile
            torchTile: "torch"         // Torch tile type
        };
        
        const config = { ...defaultOptions, ...options };
        
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
            treasureCenter[0] + Math.floor(Math.random() * 3) - 1,
            treasureCenter[1] + Math.floor(Math.random() * 3) - 1
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
        const height = basicMap.length;
        const width = basicMap[0].length;
        const enhancedMap = Array(height).fill().map(() => Array(width).fill(null));
        let placedTorchesCount = 0; // Counter for torches placed in this function
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const cell = basicMap[y][x];
                
                if (cell === 0) {
                    // Floor tile - randomly choose primary or secondary
                    if (Math.random() < config.floorVariation) {
                        enhancedMap[y][x] = config.secondaryFloor;
                    } else {
                        enhancedMap[y][x] = config.primaryFloor;
                    }
                } else if (cell === 1) {
                    // Wall tile - maybe add a torch
                    if (config.torchEnabled && this.shouldPlaceTorch(basicMap, x, y, config.torchDensity)) {
                        enhancedMap[y][x] = config.torchTile;
                        placedTorchesCount++; // Increment if a torch is placed
                    } else {
                        enhancedMap[y][x] = '#'; // Regular wall
                    }
                }
            }
        }
        console.log(`[DungeonGenerator.enhanceMapWithVariations] Placed ${placedTorchesCount} torches during map enhancement.`);
        return enhancedMap;
    }
    
    // Determine if a torch should be placed on this wall tile
    static shouldPlaceTorch(map, x, y, torchDensity) {
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
        
        return adjacentToFloor && Math.random() < torchDensity;
    }
    
    // Get positions of all torches for client-side rendering
    static getTorchPositions(enhancedMap, config) {
        const torches = [];
        const height = enhancedMap.length;
        const width = enhancedMap[0].length;
        console.log(`[DungeonGenerator.getTorchPositions] Searching for torch tile '${config.torchTile}' in a ${width}x${height} map.`);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (enhancedMap[y][x] === config.torchTile) {
                    torches.push([x, y]);
                }
            }
        }
        console.log(`[DungeonGenerator.getTorchPositions] Found ${torches.length} torches. Positions: ${JSON.stringify(torches)}`);
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
