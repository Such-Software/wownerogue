/**
 * Ruleset — gameplay as a data object (Pillar 4).
 *
 * A Ruleset captures everything that makes one game mode different from another: the world it
 * generates, the entities in it, how many players, how someone wins, the clock, and the economy.
 * The match engine READS a ruleset instead of hardcoding rules, so new modes (PvP Last-Alive,
 * Score Attack, Co-op) are data — not new subsystems — and operators/players can later author their
 * own lobbies by supplying a ruleset object.
 *
 * defineRuleset normalizes a partial spec to a complete, frozen ruleset with safe defaults. The
 * defaults reproduce the classic single-dungeon escape so an empty spec is a sane baseline.
 */

const WIN = {
    FIRST_TO_EXIT: 'first-to-exit', // first player out the exit wins, ends immediately (classic race)
    LAST_ALIVE: 'last-alive',       // last player still alive-and-in-play wins (PvP / battle royale)
    HIGH_SCORE: 'high-score',       // highest score when the match ends (score attack)
    ALL_ESCAPE: 'all-escape'        // co-op: everyone must reach the exit
};

const ECONOMY = { FREE: 'free', CREDITS_PRESTIGE: 'credits_prestige', CRYPTO_RACE: 'crypto_race' };

const num = (v, d) => (Number.isFinite(v) ? v : d);
const clampInt = (v, lo, hi, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

function defineRuleset(spec = {}) {
    const s = spec || {};
    const world = s.world || {};
    const entities = s.entities || {};
    const players = s.players || {};
    const winCondition = s.winCondition || {};
    const timing = s.timing || {};
    const economy = s.economy || {};

    const rs = {
        id: String(s.id || 'custom'),
        label: String(s.label || s.id || 'Custom'),
        mode: s.mode || 'race', // 'solo' | 'race' | 'pvp' | 'coop' — a coarse family label
        world: Object.freeze({
            difficultyPreset: world.difficultyPreset || 'normal',
            maps: clampInt(world.maps, 1, 10, 1) // reserved for multi-level; engine uses 1 today
        }),
        entities: Object.freeze({
            monster: entities.monster !== false, // default true
            monsterCount: clampInt(entities.monsterCount, 0, 8, entities.monster === false ? 0 : 1),
            pvpCombat: !!entities.pvpCombat // stepping onto a rival kills them instead of being blocked
        }),
        players: Object.freeze({
            min: clampInt(players.min, 1, 32, 1),
            max: clampInt(players.max, 1, 32, 4)
        }),
        winCondition: Object.freeze({
            type: Object.values(WIN).includes(winCondition.type) ? winCondition.type : WIN.FIRST_TO_EXIT
        }),
        timing: Object.freeze({
            tickMs: clampInt(timing.tickMs, 50, 5000, 250),
            minDurationMs: clampInt(timing.minDurationMs, 0, 600000, 20000),
            hardCeilingMs: clampInt(timing.hardCeilingMs, 1000, 3600000, 240000),
            blockDeadline: timing.blockDeadline !== false
        }),
        economy: Object.freeze({
            model: Object.values(ECONOMY).includes(economy.model) ? economy.model : ECONOMY.FREE,
            houseFeePercent: num(economy.houseFeePercent, 0),
            payoutMultipliers: Object.freeze({
                escape: num(economy.payoutMultipliers && economy.payoutMultipliers.escape, 2),
                escapeWithTreasure: num(economy.payoutMultipliers && economy.payoutMultipliers.escapeWithTreasure, 3)
            })
        }),
        metadata: Object.freeze({ ...(s.metadata || {}) })
    };
    // normalize min<=max
    if (rs.players.min > rs.players.max) {
        rs.players = Object.freeze({ min: rs.players.max, max: rs.players.max });
    }
    return Object.freeze(rs);
}

module.exports = { defineRuleset, WIN, ECONOMY };
