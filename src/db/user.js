const Game = require('../game/game'); // Ensure Game is required

// User class definition
class User {
    constructor(id, address) {
        this.id = id; // This is the socket.id
        this.address = address;
        this.currentGame = null; // Reference to current game instance
        this.blockRec = 0; // Block record for game entry timing
        this.clientId = null; // To store socket.client.id if different
        
        // User statistics
        this.stats = {
            gamesPlayed: 0,
            gamesWon: 0,
            gamesLost: 0,
            totalPlayTime: 0,
            highestScore: 0,
            treasuresFound: 0,
            monstersDefeated: 0
        };
        
        // Add user to the registry upon creation
        userRegistry.set(id, this);
        console.log(`User created and registered: ${id}`);
    }

    /**
     * Start tracking a new game for this user.
     * @param {Game} gameInstance - The game instance this user is playing
     */
    joinGame(gameInstance) {
        this.currentGame = gameInstance;
        this.stats.gamesPlayed++;
        console.log(`[User.joinGame] User ${this.id} joined game ${gameInstance.id}. Total games played: ${this.stats.gamesPlayed}`);
    }

    /**
     * Game ended - update user statistics
     * @param {string} result - 'won', 'lost', or 'abandoned'
     * @param {number} score - Final score
     * @param {object} gameStats - Additional game statistics
     */
    endGame(result, score = 0, gameStats = {}) {
        if (this.currentGame) {
            this.currentGame = null;
            
            // Update statistics
            if (result === 'won') {
                this.stats.gamesWon++;
            } else if (result === 'lost') {
                this.stats.gamesLost++;
            }
            
            if (score > this.stats.highestScore) {
                this.stats.highestScore = score;
            }
            
            if (gameStats.treasuresFound) {
                this.stats.treasuresFound += gameStats.treasuresFound;
            }
            
            if (gameStats.monstersDefeated) {
                this.stats.monstersDefeated += gameStats.monstersDefeated;
            }
            
            console.log(`[User.endGame] User ${this.id} game ended: ${result}. Score: ${score}. Stats: ${JSON.stringify(this.stats)}`);
        }
    }

    /**
     * Get user statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Get user's current game status
     */
    isInGame() {
        return this.currentGame !== null;
    }

    // ... other User methods ...
}

// User registry (maps socketId to User objects)
const userRegistry = new Map();

// ... (rest of the file, e.g., getUserBySocketId, removeUser, module.exports)
// Ensure these functions and module.exports are correctly placed relative to the class definition.
// For example:
module.exports = {
    User,
    getUserBySocketId: (socketId) => userRegistry.get(socketId),
    removeUser: (socketId) => userRegistry.delete(socketId),
    getAllUsers: () => Array.from(userRegistry.values()) // If you need to iterate over users
};
