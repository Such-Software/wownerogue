const ROT = require('./rot.js');

/**
 * Dungeon generation utilities
 */
class DungeonGenerator {
    static generate(width, height) {
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

    static isFloorTile(map, x, y) {
        return map[y] && map[y][x] === 0;
    }

    static isWallTile(map, x, y) {
        return map[y] && map[y][x] === 1;
    }
}

module.exports = DungeonGenerator;
