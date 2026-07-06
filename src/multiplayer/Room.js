const { v4: uuidv4 } = require('uuid');
const Occupant = require('./Occupant');
const { TAVERN_LAYOUT, FLOOR_CHARS } = require('./tavernMap');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

/**
 * Room — a shared, real-time, multi-occupant world. Shared engine for both new modes:
 *
 *   • Tavern      (type 'tavern'): a peaceful room — walk around, chat, spectate.
 *   • Multiplayer (type 'match'):  the same engine with a dungeon, monsters, hazards and
 *                                  combat added (later milestones).
 *
 * Design invariants (kept transport-agnostic so the engine is testable and reusable):
 *   • No Socket.IO / DB / Wownerogue coupling here — game-state logic only. A manager layer
 *     owns transport (Socket.IO rooms, broadcasts) and the server-tick timer.
 *   • Server-authoritative movement: the client requests a step; the Room decides.
 *   • Serialisable: snapshot()/fullState() are broadcast-safe (no engine internals).
 */
class Room {
    /**
     * @param {object} opts
     * @param {string}   [opts.id]              Room id (defaults to a uuid).
     * @param {string}   [opts.type]            'tavern' | 'match' (informational for now).
     * @param {string[]} [opts.layout]          Map rows (defaults to the tavern).
     * @param {boolean}  [opts.solidOccupants]  If true, occupants block each other's tiles
     *                                           (matches). Tavern leaves this false so players
     *                                           can't grief by blocking doorways.
     * @param {number}   [opts.maxOccupants]
     */
    constructor({ id = null, type = 'tavern', layout = TAVERN_LAYOUT, solidOccupants = false, maxOccupants = 50, roomData = null, roomUrl = null } = {}) {
        this.id = id || uuidv4();
        this.type = type;
        this.solidOccupants = solidOccupants;
        this.maxOccupants = maxOccupants;
        this.createdAt = Date.now();
        this.tickCount = 0;
        this.roomUrl = roomUrl; // client-relative URL of the designed room (if any)

        // A designed room (imported .tmx) supplies dims + a walkability grid; otherwise build
        // the walkable map from the ASCII layout.
        if (roomData) this._buildFromRoomData(roomData);
        else this._buildMap(layout);
        this.occupants = new Map(); // id -> Occupant
    }

    _buildFromRoomData(rd) {
        this.roomData = rd;
        this.layout = null;
        this.rows = rd.rows;
        this.cols = rd.cols;
        this.walkable = rd.walkable;
        // Spawn on the walkable cells nearest the room centre, so players start together.
        const cx = this.cols / 2, cy = this.rows / 2, cells = [];
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                if (this.walkable[y] && this.walkable[y][x] === true) {
                    cells.push({ x, y, d: (x - cx) * (x - cx) + (y - cy) * (y - cy) });
                }
            }
        }
        cells.sort((a, b) => a.d - b.d);
        this.spawns = cells.slice(0, 24).map(c => ({ x: c.x, y: c.y }));
        if (this.spawns.length === 0) this.spawns = [{ x: 1, y: 1 }];
    }

    _buildMap(layout) {
        this.layout = layout;
        this.rows = layout.length;
        this.cols = layout.reduce((m, r) => Math.max(m, r.length), 0);
        this.spawns = [];
        this.walkable = []; // walkable[y][x] === true means floor
        for (let y = 0; y < this.rows; y++) {
            const row = [];
            for (let x = 0; x < this.cols; x++) {
                const ch = layout[y][x] || '#'; // treat short rows as walled
                row.push(FLOOR_CHARS.has(ch));
                if (ch === '@') this.spawns.push({ x, y });
            }
            this.walkable.push(row);
        }
        if (this.spawns.length === 0) {
            // Fall back to the first walkable tile.
            for (let y = 0; y < this.rows && this.spawns.length === 0; y++) {
                for (let x = 0; x < this.cols; x++) {
                    if (this.walkable[y][x]) { this.spawns.push({ x, y }); break; }
                }
            }
        }
    }

    isWalkable(x, y) {
        if (y < 0 || y >= this.rows || x < 0 || x >= this.cols) return false;
        return this.walkable[y][x] === true;
    }

    isOccupied(x, y, exceptId = null) {
        for (const occ of this.occupants.values()) {
            if (occ.id !== exceptId && occ.x === x && occ.y === y) return true;
        }
        return false;
    }

    _pickSpawn() {
        // Prefer an unoccupied spawn tile so joiners don't stack; else any spawn.
        for (const s of this.spawns) {
            if (!this.isOccupied(s.x, s.y)) return s;
        }
        return this.spawns[0] || { x: 0, y: 0 };
    }

    /**
     * @returns {Occupant|null} the occupant, or null if the room is full.
     */
    addOccupant(id, { name = null, avatar = 'default', appearance = null } = {}) {
        if (this.occupants.has(id)) return this.occupants.get(id);
        if (this.occupants.size >= this.maxOccupants) return null;
        const spawn = this._pickSpawn();
        const occ = new Occupant(id, { x: spawn.x, y: spawn.y, name, avatar, appearance });
        this.occupants.set(id, occ);
        if (CONSOLE_LOGGING) {
            console.log(`[Room ${String(this.id).slice(0, 8)}] +occupant ${String(id).slice(0, 6)} at (${spawn.x},${spawn.y})`);
        }
        return occ;
    }

    removeOccupant(id) {
        return this.occupants.delete(id);
    }

    getOccupant(id) {
        return this.occupants.get(id) || null;
    }

    static facingFor(dx, dy) {
        if (dx === -1) return 'left';
        if (dx === 1) return 'right';
        if (dy === -1) return 'up';
        if (dy === 1) return 'down';
        return null;
    }

    /**
     * Attempt a one-tile cardinal move for an occupant. Server-authoritative: the client
     * only requests a direction; here we validate bounds, walls and (optionally) other
     * occupants, and mutate state only if the step is legal.
     * @returns {{moved:boolean, reason?:string, occupant?:object}}
     */
    moveOccupant(id, dx, dy) {
        const occ = this.occupants.get(id);
        if (!occ) return { moved: false, reason: 'not_in_room' };

        dx = Math.sign(dx || 0);
        dy = Math.sign(dy || 0);
        if (Math.abs(dx) + Math.abs(dy) !== 1) return { moved: false, reason: 'invalid_step' };

        const nx = occ.x + dx;
        const ny = occ.y + dy;
        const facing = Room.facingFor(dx, dy);

        // Turn to face the attempted direction even when blocked (feels responsive).
        if (!this.isWalkable(nx, ny)) {
            if (facing) occ.facing = facing;
            return { moved: false, reason: 'blocked', occupant: occ.getState() };
        }
        if (this.solidOccupants && this.isOccupied(nx, ny, id)) {
            if (facing) occ.facing = facing;
            return { moved: false, reason: 'occupied', occupant: occ.getState() };
        }

        occ.moveTo(nx, ny, facing);
        return { moved: true, occupant: occ.getState() };
    }

    /**
     * Advance the world one server tick. For a Tavern this is currently a heartbeat
     * (no autonomous entities yet). Multiplayer match rooms will drive monster movement,
     * environmental hazards and combat resolution here. Returns events for the manager
     * to broadcast. The hook is included from the start so those systems have a home.
     * @returns {{tick:number, events:Array}}
     */
    tick() {
        this.tickCount++;
        return { tick: this.tickCount, events: [] };
    }

    /** Occupants-only snapshot — broadcast every tick/update. */
    snapshot() {
        return {
            roomId: this.id,
            type: this.type,
            tick: this.tickCount,
            occupants: Array.from(this.occupants.values()).map(o => o.getState())
        };
    }

    /** Full state including the static map — sent once when an occupant joins. */
    fullState() {
        return {
            ...this.snapshot(),
            cols: this.cols,
            rows: this.rows,
            layout: this.layout,
            solidOccupants: this.solidOccupants,
            roomUrl: this.roomUrl || null
        };
    }

    get size() {
        return this.occupants.size;
    }
}

module.exports = Room;
