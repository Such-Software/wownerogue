const Game = require('../game/game');

// Verbose logging is limited to debug and development environments.
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

class User {
    constructor(id, address) {
        this.id = id; // socket.id
        this.address = address;
        this.currentGame = null;
        this.blockRec = 0; // Block height used for game entry timing
        this.clientId = null; // socket.client.id, a distinct value from socket.id

        this.stats = {
            gamesPlayed: 0,
            gamesWon: 0,
            gamesLost: 0,
            totalPlayTime: 0,
            highestScore: 0,
            treasuresFound: 0,
            monstersDefeated: 0
        };

        // Registration happens in the constructor so every User is reachable by socket id.
        userRegistry.set(id, this);
        if (CONSOLE_LOGGING) {
            console.log(`User created and registered: ${id}`);
        }
    }

    /**
     * Start tracking a new game for this user.
     * @param {Game} gameInstance - The game instance this user is playing
     */
    joinGame(gameInstance) {
        this.currentGame = gameInstance;
        this.stats.gamesPlayed++;
        if (CONSOLE_LOGGING) {
            console.log(`[User.joinGame] User ${this.id} joined game ${gameInstance.id}. Total games played: ${this.stats.gamesPlayed}`);
        }
    }

    /**
     * Record the end of a game and fold its results into the user statistics.
     * Does nothing when the user has no current game.
     * @param {string} result - 'won', 'lost', or 'abandoned'
     * @param {number} score - Final score
     * @param {object} gameStats - Additional game statistics
     */
    endGame(result, score = 0, gameStats = {}) {
        if (this.currentGame) {
            this.currentGame = null;

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
            
            if (CONSOLE_LOGGING) {
                console.log(`[User.endGame] User ${this.id} game ended: ${result}. Score: ${score}. Stats: ${JSON.stringify(this.stats)}`);
            }
        }
    }

    /**
     * @returns {object} A copy of the stats, so callers cannot mutate the user's own counters.
     */
    getStats() {
        return { ...this.stats };
    }

    isInGame() {
        return this.currentGame !== null;
    }
}

// Maps socket.id to User. Declared after the class body; the constructor only reads it at call time,
// which is always after this binding is initialised.
const userRegistry = new Map();

module.exports = {
    User,
    getUserBySocketId: (socketId) => userRegistry.get(socketId),
    removeUser: (socketId) => userRegistry.delete(socketId),
    getAllUsers: () => Array.from(userRegistry.values())
};
