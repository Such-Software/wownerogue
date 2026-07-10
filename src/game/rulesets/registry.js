const { defineRuleset, WIN, ECONOMY } = require('./Ruleset');

/**
 * Built-in rulesets. `race` reproduces the current match behavior exactly (so nothing changes for
 * existing matches). `last-alive` and `score-attack` are the new PvP / score modes the match engine
 * now supports as data. `solo-classic` describes the live single-player escape for catalog/parity —
 * the single-player engine isn't refactored to consume it yet, so it's a descriptor, not wired.
 */
const BUILTINS = {
    'solo-classic': defineRuleset({
        id: 'solo-classic', label: 'Classic Escape', mode: 'solo',
        players: { min: 1, max: 1 },
        winCondition: { type: WIN.FIRST_TO_EXIT },
        economy: { model: ECONOMY.FREE }
    }),
    'race': defineRuleset({
        id: 'race', label: 'Escape Race', mode: 'race',
        world: { difficultyPreset: 'race' }, // matches DEFAULT_MATCH_PRESET (falls through difficultyConfig, preserved)
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.FIRST_TO_EXIT },
        economy: { model: ECONOMY.CRYPTO_RACE }
    }),
    'last-alive': defineRuleset({
        id: 'last-alive', label: 'Last Alive', mode: 'pvp',
        world: { difficultyPreset: 'normal' },
        entities: { monster: true, pvpCombat: true }, // step onto a rival to strike them down
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.LAST_ALIVE }
    }),
    'score-attack': defineRuleset({
        id: 'score-attack', label: 'Score Attack', mode: 'race',
        players: { min: 1, max: 8 },
        winCondition: { type: WIN.HIGH_SCORE }
    }),
    'coop-escape': defineRuleset({
        id: 'coop-escape', label: 'Co-op Escape', mode: 'coop',
        entities: { pvpCombat: false },
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.ALL_ESCAPE }
    })
};

function getRuleset(id, overrides = null) {
    const base = BUILTINS[id] || BUILTINS.race;
    if (!overrides) return base;
    return defineRuleset({ ...base, ...overrides, id: base.id, label: base.label });
}

function listRulesets() {
    return Object.values(BUILTINS).map(r => ({
        id: r.id, label: r.label, mode: r.mode,
        players: r.players, winCondition: r.winCondition.type, pvpCombat: r.entities.pvpCombat
    }));
}

/**
 * Map the legacy MatchRoom option bag ({economy, variant, difficultyPreset, maxPlayers}) to a
 * ruleset that preserves the current race behavior — win condition stays first-to-exit regardless
 * of `variant` (which was a stored-but-unused label), so wiring the engine to rulesets changes
 * nothing until a caller explicitly asks for a different ruleset by id.
 */
function rulesetFromMatchOpts(opts = {}) {
    return defineRuleset({
        id: 'race',
        label: 'Escape Race',
        mode: 'race',
        world: { difficultyPreset: opts.difficultyPreset || 'race' },
        players: { min: 2, max: opts.maxPlayers || 8 },
        winCondition: { type: WIN.FIRST_TO_EXIT },
        economy: { model: opts.economy || ECONOMY.FREE }
    });
}

module.exports = { BUILTINS, getRuleset, listRulesets, rulesetFromMatchOpts };
