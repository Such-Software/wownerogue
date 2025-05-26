const Game = require('./game'); // Add this import at the top

// Global users registry
const userRegistry = new Map();

function User(socketid, ip) {
    this.id = null;
    this.socketid = socketid;
    this.ip = ip;
    this.nick = null;
    this.receiveAddy = "";
    this.payoutAddy = "";
    this.blockRec = null;
    this.map = null;
    this.player = false;
    this.won = false;
    this.game = null; // Reference to current game
    this.paymentAmount = 0;
    this.paymentVerified = false;
    
    // Auto-register in the registry
    userRegistry.set(socketid, this);
    console.log(`User registered with socket ID: ${socketid}`);
}

// Add lookup function
function getUserBySocketId(socketId) {
    const user = userRegistry.get(socketId);
    console.log(`Looking up user ${socketId}: ${user ? "FOUND" : "NOT FOUND"}`);
    return user;
}

// Add function to remove user
function removeUser(socketId) {
    const removed = userRegistry.delete(socketId);
    console.log(`User ${socketId} removed: ${removed ? "YES" : "NO"}`);
    return removed;
}

// Get all users as array
function getAllUsers() {
    return Array.from(userRegistry.values());
}

// Add this method to your User function/class
User.prototype.startGame = function(width, height, gameConfig = {}) {
    console.log(`Creating new game for user ${this.socketid} with dimensions ${width}x${height}`);
    
    // Default game configuration - can be customized per user/game
    const defaultConfig = {
        playerType: "@",          // Options: "@", "@2"
        treasureType: "$W",       // Options: "$W" (Wownero), "$M" (Monero), "$B" (Bitcoin), "$" (Regular)
        monsterType: "~",         // Options: "~", "~2"
        primaryFloor: "'1",       // Main floor tile (99% of floors)
        secondaryFloor: "'2",     // Alt floor tile (1% of floors)
        floorVariation: 0.01,     // Percentage of secondary floor tiles (0.01 = 1%)
        torchEnabled: true,       // Enable/disable torch placement
        torchDensity: 0.15,       // Percentage of wall tiles that get torches (0.15 = 15%)
        torchTile: "torch"        // Torch tile identifier
    };
    
    const config = { ...defaultConfig, ...gameConfig };
    
    try {
        this.game = new Game(this.socketid, width, height, config);
        return this.game;
    } catch (err) {
        console.error("Error creating game:", err);
        return null;
    }
};

// Rest of your existing code...

module.exports = {
    User: User,
    getUserBySocketId: getUserBySocketId,
    removeUser: removeUser,
    getAllUsers: getAllUsers
};
