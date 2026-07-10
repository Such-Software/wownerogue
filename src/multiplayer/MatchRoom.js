/**
 * MatchRoom — a server-authoritative multiplayer race room.
 *
 * Extends Room with a shared dungeon, shared monsters, treasure, and per-player
 * life/death/finish state. The engine is transport-agnostic; MatchManager owns the
 * Socket.IO rooms and the server tick timer.
 *
 * Invariants:
 *   • One shared deterministic dungeon per match (provably fair from match seed).
 *   • All player moves are queued and resolved together by MatchEngine each tick.
 *   • Player-on-player collision is enabled (solidOccupants = true).
 *   • One shared treasure exists; first player to reach it picks it up.
 *   • If the treasure carrier dies, the treasure drops at their corpse.
 *   • First player to reach the exit wins; timer expiry ranks by proximity.
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Room = require('./Room');
const Occupant = require('./Occupant');
const DungeonGenerator = require('../game/dungeon');
const Monster = require('../game/monster');
const { createGameProof, createSeededRNG, seedToInt } = require('../game/provablyFair');
const { getDifficultyConfig, getMonsterSpawnRoomIndex, getTreasureRoomIndex } = require('../game/difficultyConfig');
const { defineRuleset, getRuleset, rulesetFromMatchOpts, resolveWinCondition } = require('../game/rulesets');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

const DEFAULT_MATCH_PRESET = 'race';

class MatchRoom extends Room {
    /**
     * @param {object} opts
     * @param {string}   [opts.id]
     * @param {string}   [opts.economy]             'free' | 'credits_prestige' | 'crypto_race'
     * @param {string}   [opts.variant]              'race' | 'pvp' (default 'race')
     * @param {string}   [opts.difficultyPreset]     key passed to getDifficultyConfig
     * @param {number}   [opts.maxPlayers]           2–32
     * @param {object}   [opts.entrants]             id -> { userId, name, avatar, appearance }
     * @param {string}   [opts.seed]                 optional explicit seed (testing)
     * @param {number}   [opts.startBlockHeight]     block that triggered this race
     * @param {object}   [opts.cryptoType]           'WOW' | 'XMR'
     */
    constructor(opts = {}) {
        const id = opts.id || uuidv4();
        // Room constructor needs a layout or roomData. We'll build our own map afterwards,
        // so pass a minimal placeholder and then overwrite the map state.
        super({ id, type: 'match', layout: ['.'], solidOccupants: true, maxOccupants: opts.maxPlayers || 4 });

        // Resolve the ruleset (Pillar 4). Precedence: an explicit ruleset object, then a rulesetId
        // from the registry, else one synthesized from the legacy opts — which preserves the classic
        // race behavior exactly, so nothing changes until a caller asks for a different ruleset.
        this.ruleset = opts.ruleset ? defineRuleset(opts.ruleset)
            : (opts.rulesetId ? getRuleset(opts.rulesetId, opts.rulesetOverrides) : rulesetFromMatchOpts(opts));
        this.winCondition = resolveWinCondition(this.ruleset.winCondition.type);
        this.pvpCombat = this.ruleset.entities.pvpCombat;
        this._deathCounter = 0; // increments per death → last-alive tiebreak (died later ranks higher)

        this.economy = opts.economy || this.ruleset.economy.model;
        this.variant = opts.variant || (this.pvpCombat ? 'pvp' : 'race');
        this.difficultyPreset = opts.difficultyPreset || this.ruleset.world.difficultyPreset || DEFAULT_MATCH_PRESET;
        this.maxPlayers = Math.max(2, Math.min(32, opts.maxPlayers || this.ruleset.players.max || 4));
        this.cryptoType = opts.cryptoType || process.env.CRYPTO_TYPE || 'WOW';
        this.startBlockHeight = opts.startBlockHeight || null;
        this.createdAt = Date.now();
        this.tickCount = 0;
        this.status = 'starting'; // starting -> active -> finished | cancelled

        // Provably fair proof
        const proof = createGameProof(id);
        this.seed = opts.seed || proof.seed;
        this.seedHash = crypto.createHash("sha256").update(this.seed).digest("hex");
        this.seededRNG = createSeededRNG(this.seed);
        this.seedInt = seedToInt(this.seed);

        // Difficulty
        this.difficultyConfig = getDifficultyConfig(this.cryptoType, { preset: this.difficultyPreset });

        // Generate the shared dungeon
        this._generateDungeon();

        // Spawn players at entrance, and the shared monster when the ruleset includes one.
        this.monster = null;
        if (this.ruleset.entities.monster) this._spawnMonster();
        this._resetEntrants(opts.entrants || {});

        // Shared treasure state
        this.treasure = this.dungeon.treasure ? { x: this.dungeon.treasure[0], y: this.dungeon.treasure[1], carrierId: null } : null;

        // Movement queue for current tick: occupantId -> { dx, dy }
        this.moveQueue = new Map();

        // Timer / deadline bookkeeping (from the ruleset; defaults reproduce the classic values).
        this.minDurationMs = this.ruleset.timing.minDurationMs;  // floor before next-block expiry can fire (20s)
        this.hardCeilingMs = this.ruleset.timing.hardCeilingMs;  // absolute max (4m)
        this.startedAt = null;
        this.endedAt = null;
        this.endReason = null;

        // Economy bookkeeping (set later by MatchManager).
        this.entryFeeAtomic = opts.entryFeeAtomic || 0;
        this.potAtomic = opts.potAtomic || 0;
        this.houseFeeAtomic = opts.houseFeeAtomic || 0;
        this.houseFeePercent = opts.houseFeePercent || 0;
        this.winnerId = null;

        // Event log for this match (also persisted to match_events by manager)
        this.events = [];
    }

    _generateDungeon() {
        const cfg = this.difficultyConfig.dungeon;
        const gameConfig = {
            width: cfg.width,
            height: cfg.height,
            floorVariation: 0.01,
            torchEnabled: true,
            torchDensity: 0.1,
            primaryFloor: "'1",
            secondaryFloor: "'2",
            torchTile: 'torch',
            rng: this.seededRNG,
            seedInt: this.seedInt
        };
        this.dungeon = DungeonGenerator.generate(cfg.width, cfg.height, gameConfig);

        // Build a walkable grid for Room's movement/collision helpers.
        this.rows = cfg.height;
        this.cols = cfg.width;
        this.walkable = [];
        for (let y = 0; y < this.rows; y++) {
            const row = [];
            for (let x = 0; x < this.cols; x++) {
                const tile = this.dungeon.map[y] && this.dungeon.map[y][x];
                row.push(tile === "'1" || tile === "'2" || tile === '>' || tile === '$M');
            }
            this.walkable.push(row);
        }

        // Spawns: entrance first, then nearby walkable tiles if many players.
        const ex = this.dungeon.entrance[0];
        const ey = this.dungeon.entrance[1];
        const spawnCandidates = [{ x: ex, y: ey, d: 0 }];
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                if (this.isWalkable(x, y) && (x !== ex || y !== ey)) {
                    const d = Math.abs(x - ex) + Math.abs(y - ey);
                    spawnCandidates.push({ x, y, d });
                }
            }
        }
        spawnCandidates.sort((a, b) => a.d - b.d);
        this.spawns = spawnCandidates.slice(0, this.maxPlayers);
    }

    _spawnMonster() {
        if (this.dungeon.rooms && this.dungeon.rooms.length > 2) {
            const idx = getMonsterSpawnRoomIndex(
                this.dungeon.rooms,
                this.difficultyConfig.monster.startDistanceFromPlayer
            );
            const room = this.dungeon.rooms[idx];
            const center = room.getCenter();
            this.monster = new Monster(center[0], center[1], {
                visionRange: this.difficultyConfig.monster.visionRange || 12
            });
        } else {
            this.monster = new Monster(0, 0, {
                visionRange: this.difficultyConfig.monster.visionRange || 12
            });
        }
    }

    /**
     * Replace the inherited tavern occupants with match entrants placed at the entrance.
     * @param {object} entrants — id -> { userId, name, avatar, appearance }
     */
    _resetEntrants(entrants) {
        this.occupants.clear();
        this.playerStates = new Map(); // id -> { alive, finished, escaped, hasTreasure, placement, killedBy }

        const ids = Object.keys(entrants);
        for (let i = 0; i < ids.length && i < this.maxPlayers; i++) {
            const id = ids[i];
            const e = entrants[id] || {};
            const spawn = this.spawns[i] || this.spawns[0] || { x: 0, y: 0 };
            const occ = new Occupant(id, {
                x: spawn.x,
                y: spawn.y,
                name: e.name || null,
                avatar: e.avatar || 'default',
                appearance: e.appearance || null,
                facing: 'down'
            });
            this.occupants.set(id, occ);
            this.playerStates.set(id, {
                userId: e.userId || null,
                alive: true,
                finished: false,
                escaped: false,
                hasTreasure: false,
                placement: null,
                killedBy: null,
                score: 0,
                moves: 0
            });
        }
    }

    /** Number of players still alive and not finished. */
    get activePlayerCount() {
        let n = 0;
        for (const s of this.playerStates.values()) {
            if (s.alive && !s.finished) n++;
        }
        return n;
    }

    /** Number of players who have reached the exit. */
    get finishCount() {
        let n = 0;
        for (const s of this.playerStates.values()) {
            if (s.finished) n++;
        }
        return n;
    }

    /**
     * Queue a move for an occupant. Moves are not applied until resolveTick().
     * @param {string} id
     * @param {number} dx - -1, 0, or 1
     * @param {number} dy - -1, 0, or 1
     */
    queueMove(id, dx, dy) {
        const occ = this.occupants.get(id);
        const state = this.playerStates.get(id);
        if (!occ || !state || !state.alive || state.finished) return false;
        dx = Math.sign(dx || 0);
        dy = Math.sign(dy || 0);
        if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
        this.moveQueue.set(id, { dx, dy });
        return true;
    }

    /**
     * Resolve one server tick: apply all queued moves, resolve collisions, move the
     * monster, check deaths/treasure/exits. Returns a tick result with events.
     * @returns {{tick:number, events:Array, finished:boolean}}
     */
    resolveTick() {
        if (this.status !== 'active') {
            return { tick: this.tickCount, events: [], finished: this.status === 'finished' };
        }
        this.tickCount++;
        const events = [];

        // 1. Resolve player moves simultaneously.
        const moves = this._resolvePlayerMoves(events);

        // 2. Move the shared monster toward the nearest visible active player.
        const monsterEvents = this._moveMonster();
        events.push(...monsterEvents);

        // 3. Check win/death/treasure after all entities have moved.
        const resolutionEvents = this._checkResolution();
        events.push(...resolutionEvents);

        this.moveQueue.clear();

        if (this.status === 'finished') {
            this.endedAt = Date.now();
            events.push({ type: 'match_end', reason: this.endReason, winnerId: this.winnerId, tick: this.tickCount });
        }

        return { tick: this.tickCount, events, finished: this.status === 'finished' };
    }

    _resolvePlayerMoves(events) {
        // Build a map of intended destinations so we can detect head-on swaps and pile-ups.
        const plans = [];
        for (const [id, { dx, dy }] of this.moveQueue.entries()) {
            const occ = this.occupants.get(id);
            const state = this.playerStates.get(id);
            if (!occ || !state || !state.alive || state.finished) continue;
            const nx = occ.x + dx;
            const ny = occ.y + dy;
            const facing = Room.facingFor(dx, dy);
            plans.push({ id, from: { x: occ.x, y: occ.y }, to: { x: nx, y: ny }, facing });
        }

        // If A moves to B's tile and B moves to A's tile, both bounce.
        const swapPairs = new Set();
        for (let i = 0; i < plans.length; i++) {
            for (let j = i + 1; j < plans.length; j++) {
                const a = plans[i];
                const b = plans[j];
                if (a.to.x === b.from.x && a.to.y === b.from.y &&
                    b.to.x === a.from.x && b.to.y === a.from.y) {
                    swapPairs.add(a.id);
                    swapPairs.add(b.id);
                }
            }
        }

        // Destination counts for pile-up detection.
        const destCount = new Map();
        for (const p of plans) {
            if (swapPairs.has(p.id)) continue;
            const key = `${p.to.x},${p.to.y}`;
            destCount.set(key, (destCount.get(key) || 0) + 1);
        }

        // Apply each valid move.
        for (const p of plans) {
            const occ = this.occupants.get(p.id);
            let reason = null;

            if (swapPairs.has(p.id)) {
                reason = 'collision_swap';
            } else if (!this.isWalkable(p.to.x, p.to.y)) {
                reason = 'blocked';
            } else if (this.solidOccupants && this.isOccupied(p.to.x, p.to.y, p.id)) {
                // PvP: stepping onto a living rival strikes them down; the attacker holds position.
                if (this.pvpCombat) {
                    const victimId = this._livingOccupantIdAt(p.to.x, p.to.y, p.id);
                    if (victimId) {
                        this._killPlayer(victimId, p.id);
                        events.push({ type: 'player_death', id: victimId, killedBy: p.id, tick: this.tickCount });
                        reason = 'attack';
                    } else {
                        reason = 'occupied'; // only a corpse / non-target is here
                    }
                } else {
                    reason = 'occupied';
                }
            } else if (destCount.get(`${p.to.x},${p.to.y}`) > 1) {
                reason = 'collision_pileup';
            }

            if (reason) {
                if (p.facing) occ.facing = p.facing;
                events.push({ type: 'move_failed', id: p.id, reason, from: p.from, to: p.to, tick: this.tickCount });
                continue;
            }

            occ.moveTo(p.to.x, p.to.y, p.facing);
            const state = this.playerStates.get(p.id);
            state.moves++;
            events.push({ type: 'move', id: p.id, from: p.from, to: p.to, facing: p.facing, tick: this.tickCount });
            // If the player stepped onto the monster, they die immediately.
            if (this.monster && p.to.x === this.monster.x && p.to.y === this.monster.y) {
                this._killPlayer(p.id, 'monster');
                events.push({ type: 'player_death', id: p.id, killedBy: 'monster', tick: this.tickCount });
            }
        }

        return events;
    }

    _moveMonster() {
        if (!this.monster || this.activePlayerCount === 0) return [];

        const events = [];
        const occs = Array.from(this.occupants.values()).filter(o => {
            const s = this.playerStates.get(o.id);
            return s && s.alive && !s.finished;
        });
        if (occs.length === 0) return events;

        // If the monster is already standing on a player, kill them immediately.
        for (const occ of occs) {
            if (occ.x === this.monster.x && occ.y === this.monster.y) {
                this._killPlayer(occ.id, 'monster');
                events.push({ type: 'player_death', id: occ.id, killedBy: 'monster', tick: this.tickCount });
            }
        }
        // Remove dead players from the active set before choosing a target.
        const activeOccs = occs.filter(o => {
            const s = this.playerStates.get(o.id);
            return s && s.alive && !s.finished;
        });
        if (activeOccs.length === 0) return events;

        // Target nearest visible player.
        let target = null;
        let bestDist = Infinity;
        for (const occ of activeOccs) {
            const dist = this.monster.distanceTo(occ.x, occ.y);
            if (dist < bestDist && this.monster.hasLineOfSight(occ.x, occ.y, this.dungeon, this._monsterPassable.bind(this))) {
                bestDist = dist;
                target = occ;
            }
        }

        const movesPerTick = this.difficultyConfig.monster.movesPerPlayerMove || 1.0;
        let movesRemaining = movesPerTick;

        while (movesRemaining >= 1) {
            movesRemaining--;
            const moved = this.monster.moveTowardPlayer(
                target,
                this.dungeon,
                this.seededRNG
            );
            if (moved) {
                events.push({ type: 'monster_move', x: this.monster.x, y: this.monster.y, tick: this.tickCount });

                // Check collisions with any player on this monster tile.
                for (const occ of activeOccs) {
                    if (occ.x === this.monster.x && occ.y === this.monster.y) {
                        this._killPlayer(occ.id, 'monster');
                        events.push({ type: 'player_death', id: occ.id, killedBy: 'monster', tick: this.tickCount });
                    }
                }
            }
        }

        return events;
    }

    _monsterPassable(tile) {
        return tile === "'1" || tile === "'2" || tile === 0 || tile === '>' || tile === '$M';
    }

    // The id of a living, in-play occupant standing on (x,y), excluding `excludeId`. Used for PvP
    // strikes (a corpse or a finished/escaped player is not a valid target).
    _livingOccupantIdAt(x, y, excludeId) {
        for (const occ of this.occupants.values()) {
            if (occ.id === excludeId) continue;
            if (occ.x === x && occ.y === y) {
                const s = this.playerStates.get(occ.id);
                if (s && s.alive && !s.finished) return occ.id;
            }
        }
        return null;
    }

    _checkResolution() {
        const events = [];
        const exit = this.dungeon.exit;

        for (const occ of this.occupants.values()) {
            const state = this.playerStates.get(occ.id);
            if (!state || !state.alive || state.finished) continue;

            // Monster collision (player moved onto monster tile).
            if (this.monster && occ.x === this.monster.x && occ.y === this.monster.y) {
                this._killPlayer(occ.id, 'monster');
                events.push({ type: 'player_death', id: occ.id, killedBy: 'monster', tick: this.tickCount });
                continue;
            }

            // Treasure pickup.
            if (this.treasure && this.treasure.carrierId === null &&
                occ.x === this.treasure.x && occ.y === this.treasure.y) {
                this.treasure.carrierId = occ.id;
                state.hasTreasure = true;
                events.push({ type: 'treasure_pickup', id: occ.id, x: occ.x, y: occ.y, tick: this.tickCount });
            }

            // Exit reached. The ruleset's win condition decides what that means (race: first out
            // wins & ends; last-alive: you survived but the match continues; score: just finished).
            if (exit && occ.x === exit[0] && occ.y === exit[1]) {
                this._finishPlayer(occ.id, true);
                events.push({ type: 'player_exit', id: occ.id, hasTreasure: state.hasTreasure, tick: this.tickCount });
                this.winCondition.onExit(this, occ.id);
            }
        }

        return events;
    }

    _killPlayer(id, killedBy) {
        const state = this.playerStates.get(id);
        const occ = this.occupants.get(id);
        if (!state || !state.alive) return;
        state.alive = false;
        state.killedBy = killedBy;
        state.deathOrder = ++this._deathCounter; // later deaths rank higher in last-alive

        // Drop treasure at corpse if carrying.
        if (state.hasTreasure && this.treasure) {
            this.treasure.carrierId = null;
            this.treasure.x = occ.x;
            this.treasure.y = occ.y;
            state.hasTreasure = false;
        }

        // The ruleset decides whether this death ends the match (race: all-dead; last-alive: one left).
        this.winCondition.onDeath(this);
    }

    _finishPlayer(id, escaped) {
        const state = this.playerStates.get(id);
        if (!state || !state.alive || state.finished) return;
        state.finished = true;
        state.escaped = escaped;
        if (this.treasure && this.treasure.carrierId === id) {
            // Treasure carried out stays with the winner's record but is removed from the map.
            this.treasure = null;
        }
    }

    /**
     * Transition from 'starting' to 'active', recording the start time.
     */
    start() {
        if (this.status !== 'starting') return false;
        this.status = 'active';
        this.startedAt = Date.now();
        this.events.push({ type: 'match_start', tick: this.tickCount, seedHash: this.seedHash });
        return true;
    }

    /**
     * Force end because of a block deadline or hard ceiling. Determines winner by proximity
     * to exit among living players, or by progress if no one is alive.
     * @param {string} reason - 'block_deadline' | 'hard_ceiling' | 'abandoned'
     */
    expire(reason) {
        if (this.status === 'finished' || this.status === 'cancelled') return;
        this.status = 'finished';
        this.endReason = reason;
        this.endedAt = Date.now();

        const exit = this.dungeon.exit;
        const ranked = Array.from(this.playerStates.entries()).map(([id, state]) => {
            const occ = this.occupants.get(id);
            const dist = exit && occ ? Math.abs(occ.x - exit[0]) + Math.abs(occ.y - exit[1]) : Infinity;
            return { id, state, occ, dist };
        });

        // Living closer to exit beats dead; then treasure; then fewer moves; then deterministic.
        ranked.sort((a, b) => {
            const aliveA = a.state.alive && !a.state.finished ? 1 : 0;
            const aliveB = b.state.alive && !b.state.finished ? 1 : 0;
            if (aliveA !== aliveB) return aliveB - aliveA;
            if (a.dist !== b.dist) return a.dist - b.dist;
            const tA = a.state.hasTreasure ? 1 : 0;
            const tB = b.state.hasTreasure ? 1 : 0;
            if (tA !== tB) return tB - tA;
            if (a.state.moves !== b.state.moves) return a.state.moves - b.state.moves;
            return a.id.localeCompare(b.id);
        });

        if (ranked.length > 0 && (ranked[0].state.alive || ranked[0].state.finished)) {
            this.winnerId = ranked[0].id;
        }

        // Assign placements deterministically.
        for (let i = 0; i < ranked.length; i++) {
            ranked[i].state.placement = i + 1;
        }
    }

    /**
     * Calculate final scores and placements. Called once when the match is finished.
     * @returns {Map} playerStates with score and placement populated
     */
    finalize() {
        if (this.status !== 'finished') return this.playerStates;

        // The ruleset's win condition provides the final ordering (best-first). FIRST_TO_EXIT
        // reproduces the classic ranking (escape-winner first, then finished > alive > closer-to-
        // exit > treasure > fewer-moves); last-alive/high-score order by their own rules.
        const ranked = this.winCondition.rank(this);

        for (let i = 0; i < ranked.length; i++) {
            const r = ranked[i];
            r.state.placement = i + 1;
            r.state.score = this._calculateScore(r.state, i + 1, r.dist);
        }

        // Winner consistency across ALL end paths: the payout target (winnerId) and the
        // leaderboard's placement #1 always name the SAME player. finalize() is the single source
        // of truth — it runs after expire() in every path, reconciling any provisional winner.
        if (ranked.length > 0) this.winnerId = ranked[0].id;

        return this.playerStates;
    }

    _calculateScore(state, placement, distToExit) {
        // Base solo-style score, then MP placement bonus.
        let score = 100;
        if (state.escaped) score += 200;
        if (state.hasTreasure) score += 200;

        // Speed bonus: fewer moves is better (cap at 300).
        score += Math.max(0, 300 - Math.max(state.moves - 30, 0) * 3);

        // Proximity bonus for non-escapers (closer to exit is better).
        if (!state.escaped && Number.isFinite(distToExit)) {
            score += Math.max(0, 100 - distToExit * 2);
        }

        // Placement bonus: winner gets 300, 2nd 200, 3rd 100, others 0.
        const placementBonus = [300, 200, 100][placement - 1] || 0;
        score += placementBonus;

        return Math.max(0, Math.round(score));
    }

    /**
     * Produce a renderer-agnostic game state object that the existing render-kit adapter
     * `RK.sceneFromGameState()` can consume. This lets ASCII/Tiled/Fancy/Iso/3D modes all
     * draw the same match with no extra renderer work.
     */
    toGameState(viewerId = null) {
        const visible = [];
        const explored = [];
        const lighting = {};

        // For simplicity, the match spectator/client receives the full dungeon (no per-player
        // FOV in the MVP). Later we can add per-viewer FOV by running LightingAndFov here.
        for (let y = 0; y < this.rows; y++) {
            const row = [];
            for (let x = 0; x < this.cols; x++) {
                row.push(this.dungeon.map[y][x]);
            }
            visible.push(row);
            explored.push(row);
        }

        return {
            matchId: this.id,
            economy: this.economy,
            tick: this.tickCount,
            status: this.status,
            visibleTiles: visible,
            exploredTiles: explored,
            lighting,
            dungeonRows: this.rows,
            dungeonCols: this.cols,
            players: Array.from(this.occupants.values()).map(o => {
                const s = this.playerStates.get(o.id);
                return {
                    id: o.id,
                    x: o.x,
                    y: o.y,
                    name: o.name,
                    avatar: o.avatar,
                    appearance: o.appearance,
                    facing: o.facing,
                    alive: s ? s.alive : true,
                    finished: s ? s.finished : false,
                    escaped: s ? s.escaped : false,
                    hasTreasure: s ? s.hasTreasure : false,
                    placement: s ? s.placement : null,
                    you: o.id === viewerId
                };
            }),
            monster: this.monster ? { x: this.monster.x, y: this.monster.y } : null,
            treasure: this.treasure ? { x: this.treasure.x, y: this.treasure.y, carrierId: this.treasure.carrierId } : null,
            exit: this.dungeon.exit,
            entrance: this.dungeon.entrance,
            winnerId: this.winnerId,
            endReason: this.endReason
        };
    }

    /** Snapshot for the shared-world layer (includes occupants only). */
    snapshot() {
        return {
            ...super.snapshot(),
            economy: this.economy,
            variant: this.variant,
            tick: this.tickCount,
            status: this.status,
            treasure: this.treasure,
            monster: this.monster ? { x: this.monster.x, y: this.monster.y } : null,
            winnerId: this.winnerId,
            endReason: this.endReason
        };
    }

    /** Full state for a joining/reconnecting player. */
    fullState(viewerId = null) {
        return {
            ...this.snapshot(),
            cols: this.cols,
            rows: this.rows,
            walkable: this.walkable,
            dungeon: this.dungeon,
            seedHash: this.seedHash,
            gameState: this.toGameState(viewerId)
        };
    }
}

module.exports = MatchRoom;
