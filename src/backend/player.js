/**
 * Player class - Manages player state and actions
 */
class Player {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
        this.hasKey = false;
        this.hasTreasure = false;
    }

    // Move player to new position
    moveTo(x, y) {
        this.x = x;
        this.y = y;
    }

    // Check if player is at given coordinates
    isAt(x, y) {
        return this.x === x && this.y === y;
    }

    // Reset player state
    reset() {
        this.hasKey = false;
        this.hasTreasure = false;
    }

    // Get player state as object
    getState() {
        return {
            x: this.x,
            y: this.y,
            hasKey: this.hasKey,
            hasTreasure: this.hasTreasure
        };
    }

    // Set player state from object
    setState(state) {
        if (state.x !== undefined) this.x = state.x;
        if (state.y !== undefined) this.y = state.y;
        if (state.hasKey !== undefined) this.hasKey = state.hasKey;
        if (state.hasTreasure !== undefined) this.hasTreasure = state.hasTreasure;
    }
}

module.exports = Player;
