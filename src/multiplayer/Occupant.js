/**
 * Occupant — a player's avatar inside a real-time Room (Tavern or Multiplayer match).
 *
 * The multiplayer analogue of game/player.js, but for a shared world: many Occupants
 * live in one Room and everyone sees everyone move. Kept small and dependency-free so the
 * engine can be unit-tested in isolation and reused independently.
 */
class Occupant {
    /**
     * @param {string} id  Stable identity (socket id today; Smirk/wallet key later).
     * @param {object} opts
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     * @param {string} [opts.name]    Display name (null = anonymous).
     * @param {string} [opts.avatar]  Avatar id (cosmetic; unlock-gated by Operator Policy).
     * @param {object} [opts.appearance] Structured cosmetic appearance (base + tint/equipment).
     * @param {string} [opts.facing]  'up' | 'down' | 'left' | 'right'
     */
    constructor(id, { x = 0, y = 0, name = null, avatar = 'default', appearance = null, facing = 'down' } = {}) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.name = name;
        this.avatar = avatar;
        this.appearance = appearance;
        this.facing = facing;
        this.joinedAt = Date.now();
        this.lastMoveAt = 0;
    }

    moveTo(x, y, facing = null) {
        this.x = x;
        this.y = y;
        if (facing) this.facing = facing;
        this.lastMoveAt = Date.now();
    }

    /** Broadcast-safe state (everything here is public to the whole room). */
    getState() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            name: this.name,
            avatar: this.avatar,
            appearance: this.appearance,
            facing: this.facing
        };
    }
}

module.exports = Occupant;
