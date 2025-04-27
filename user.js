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
}

User.prototype.startGame = function(mapWidth, mapHeight) {
    const Game = require('./game');
    this.game = new Game(this.socketid, mapWidth, mapHeight);
    return this.game;
};

User.prototype.verifyPayment = function(amount) {
    this.paymentAmount = amount;
    this.paymentVerified = true;
    return true;
};

User.prototype.calculateReward = function() {
    if (!this.game || this.game.gameState !== 'won') return 0;
    
    // Base reward is 2x the entrance fee
    let reward = this.paymentAmount * 2;
    
    // Bonus for finding treasure
    if (this.game.player.hasTreasure) {
        reward = this.paymentAmount * 5;
    }
    
    return reward;
};

module.exports = {
  User: User
};
