const ROT = require('./rot.js');
const { seededShuffle } = require('./provablyFair');

/**
 * Monster class - Manages monster state and AI with improved pathfinding
 * 
 * AI Behavior:
 * - Uses A* pathfinding when player is visible (line of sight)
 * - Patrols toward last known player position when player not visible
 * - Falls back to wandering when no target
 * - Vision limited to configurable range (not omniscient)
 */
class Monster {
    constructor(x = 0, y = 0, options = {}) {
        this.x = x;
        this.y = y;
        
        // AI state
        this.lastKnownPlayerX = null;
        this.lastKnownPlayerY = null;
        this.visionRange = options.visionRange || 12; // tiles the monster can "see"
        this.pathCache = null;
        this.pathCacheTarget = null;
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
    
    /**
     * Check if monster has line of sight to a position
     * Uses Bresenham's line algorithm
     */
    hasLineOfSight(targetX, targetY, dungeon, isPassable) {
        const dx = Math.abs(targetX - this.x);
        const dy = Math.abs(targetY - this.y);
        const sx = this.x < targetX ? 1 : -1;
        const sy = this.y < targetY ? 1 : -1;
        let err = dx - dy;
        let x = this.x;
        let y = this.y;
        
        while (x !== targetX || y !== targetY) {
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
            
            // Check if we hit the target
            if (x === targetX && y === targetY) return true;
            
            // Check if blocked by wall
            if (!dungeon.map[y] || !isPassable(dungeon.map[y][x])) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * Calculate distance to a point
     */
    distanceTo(x, y) {
        return Math.sqrt((x - this.x) ** 2 + (y - this.y) ** 2);
    }
    
    /**
     * Find path using A* pathfinding
     * Returns array of [x, y] positions or null if no path
     */
    findPath(targetX, targetY, dungeon, isPassable) {
        // Use ROT.js A* pathfinding
        const passableCallback = (x, y) => {
            if (!dungeon.map[y]) return false;
            return isPassable(dungeon.map[y][x]);
        };
        
        const path = [];
        const astar = new ROT.Path.AStar(targetX, targetY, passableCallback, { topology: 4 });
        
        astar.compute(this.x, this.y, (x, y) => {
            path.push([x, y]);
        });
        
        // Remove the starting position from path
        if (path.length > 0 && path[0][0] === this.x && path[0][1] === this.y) {
            path.shift();
        }
        
        return path.length > 0 ? path : null;
    }

    /**
     * Improved AI to move toward player using A* pathfinding with limited vision
     */
    moveTowardPlayer(player, dungeon, rng = Math.random) {
        if (!dungeon || !dungeon.map) return;

        // Check if a tile is passable (floor, stairs, treasure)
        const isPassable = (tile) => {
            return tile === "'1" || tile === "'2" || tile === 0 || 
                   tile === '>' || tile === '$M'; // Can walk on stairs and treasure
        };

        // If no player target, wander randomly
        if (!player) {
            this._wander(dungeon, isPassable, rng);
            return;
        }
        
        const distToPlayer = this.distanceTo(player.x, player.y);
        let canSeePlayer = false;
        
        // Check if player is within vision range AND line of sight
        if (distToPlayer <= this.visionRange) {
            canSeePlayer = this.hasLineOfSight(player.x, player.y, dungeon, isPassable);
        }
        
        if (canSeePlayer) {
            // Player visible - update last known position and use A* pathfinding
            this.lastKnownPlayerX = player.x;
            this.lastKnownPlayerY = player.y;
            
            // Find path to player
            const path = this.findPath(player.x, player.y, dungeon, isPassable);
            if (path && path.length > 0) {
                // Move to next position in path
                const [nextX, nextY] = path[0];
                this.x = nextX;
                this.y = nextY;
                return;
            }
            
            // Fallback: direct move toward player
            this._moveDirectToward(player.x, player.y, dungeon, isPassable, rng);
            
        } else if (this.lastKnownPlayerX !== null) {
            // Player not visible but we have last known position - patrol toward it
            const distToLastKnown = this.distanceTo(this.lastKnownPlayerX, this.lastKnownPlayerY);
            
            if (distToLastKnown < 1) {
                // Reached last known position, clear it and wander
                this.lastKnownPlayerX = null;
                this.lastKnownPlayerY = null;
                this._wander(dungeon, isPassable, rng);
            } else {
                // Path toward last known position
                const path = this.findPath(this.lastKnownPlayerX, this.lastKnownPlayerY, dungeon, isPassable);
                if (path && path.length > 0) {
                    const [nextX, nextY] = path[0];
                    this.x = nextX;
                    this.y = nextY;
                } else {
                    // Can't reach last known position, clear and wander
                    this.lastKnownPlayerX = null;
                    this.lastKnownPlayerY = null;
                    this._wander(dungeon, isPassable, rng);
                }
            }
        } else {
            // No player info - wander randomly
            this._wander(dungeon, isPassable, rng);
        }
    }
    
    /**
     * Simple direct movement toward a target (fallback)
     */
    _moveDirectToward(targetX, targetY, dungeon, isPassable, rng = Math.random) {
        const dx = Math.sign(targetX - this.x);
        const dy = Math.sign(targetY - this.y);
        
        // Try both directions, prioritize the one with more distance to cover
        const xDist = Math.abs(targetX - this.x);
        const yDist = Math.abs(targetY - this.y);
        
        if (xDist >= yDist && dx !== 0) {
            // Try horizontal first
            const newX = this.x + dx;
            if (dungeon.map[this.y] && isPassable(dungeon.map[this.y][newX])) {
                this.x = newX;
                return;
            }
        }
        
        if (dy !== 0) {
            const newY = this.y + dy;
            if (dungeon.map[newY] && isPassable(dungeon.map[newY][this.x])) {
                this.y = newY;
                return;
            }
        }
        
        // Try horizontal if we haven't yet
        if (xDist < yDist && dx !== 0) {
            const newX = this.x + dx;
            if (dungeon.map[this.y] && isPassable(dungeon.map[this.y][newX])) {
                this.x = newX;
                return;
            }
        }
        
        // Blocked in preferred directions, try diagonals (A* backup)
        this._wander(dungeon, isPassable, rng);
    }
    
    /**
     * Random wandering behavior
     */
    _wander(dungeon, isPassable, rng = Math.random) {
        const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
        // Deterministic shuffle from the per-game seeded RNG (provably fair).
        const shuffledDirs = seededShuffle(rng, dirs.slice());
        
        for (const [dx, dy] of shuffledDirs) {
            const nx = this.x + dx;
            const ny = this.y + dy;
            if (dungeon.map[ny] && isPassable(dungeon.map[ny][nx])) {
                this.x = nx;
                this.y = ny;
                return;
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
