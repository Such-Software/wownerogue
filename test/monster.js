const ROT = require('./rot.js');

/**
 * Monster class - Manages monster state and AI
 */
class Monster {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }

    // Move monster to new position
    moveTo(x, y) {
        this.x = x;
        this.y = y;
    }

    // Check if monster is at given coordinates
    isAt(x, y) {
        return this.x === x && this.y === y;
    }

    // Simple AI to move toward player
    moveTowardPlayer(player, dungeon) {
        if (!player || !dungeon || !dungeon.map) return;

        const dx = Math.sign(player.x - this.x);
        const dy = Math.sign(player.y - this.y);
        
        // Try horizontal move first
        if (dx !== 0) {
            const newX = this.x + dx;
            if (dungeon.map[this.y] && dungeon.map[this.y][newX] === 0) {
                this.x = newX;
                return;
            }
        }
        
        // Try vertical move
        if (dy !== 0) {
            const newY = this.y + dy;
            if (dungeon.map[newY] && dungeon.map[newY][this.x] === 0) {
                this.y = newY;
                return;
            }
        }
        
        // Try random direction if direct path is blocked
        const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
        const shuffledDirs = ROT.RNG.shuffle(dirs.slice());
        
        for (const [dx, dy] of shuffledDirs) {
            const nx = this.x + dx;
            const ny = this.y + dy;
            if (dungeon.map[ny] && dungeon.map[ny][nx] === 0) {
                this.x = nx;
                this.y = ny;
                break;
            }
        }
    }

    // Check if monster has caught the player
    hasCaughtPlayer(player) {
        if (!player) return false;

        // Check for direct overlap - monster on same tile as player
        return this.x === player.x && this.y === player.y;
    }

    // Get monster state as object
    getState() {
        return {
            x: this.x,
            y: this.y
        };
    }

    // Set monster state from object
    setState(state) {
        if (state.x !== undefined) this.x = state.x;
        if (state.y !== undefined) this.y = state.y;
    }
}

module.exports = Monster;
