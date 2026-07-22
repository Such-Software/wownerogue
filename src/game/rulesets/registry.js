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
        economy: { model: ECONOMY.FREE },
        metadata: { description: 'The original single-player escape dungeon.' }
    }),
    'race': defineRuleset({
        id: 'race', label: 'Escape Race', mode: 'race',
        world: { difficultyPreset: 'race' }, // matches DEFAULT_MATCH_PRESET (falls through difficultyConfig, preserved)
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.FIRST_TO_EXIT },
        economy: { model: ECONOMY.CRYPTO_RACE },
        metadata: { description: 'First player to reach the exit wins.' }
    }),
    'last-alive': defineRuleset({
        id: 'last-alive', label: 'Last Alive', mode: 'pvp',
        world: { difficultyPreset: 'normal' },
        entities: { monster: true, pvpCombat: true }, // step onto a rival to strike them down
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.LAST_ALIVE },
        metadata: { description: 'Outlast rivals or strike them down by moving into their tile.' }
    }),
    'score-attack': defineRuleset({
        id: 'score-attack', label: 'Score Attack', mode: 'race',
        players: { min: 1, max: 8 },
        winCondition: { type: WIN.HIGH_SCORE },
        metadata: { description: 'Highest score at the deadline wins; escaping does not end the match.' }
    }),
    'coop-escape': defineRuleset({
        id: 'coop-escape', label: 'Co-op Escape', mode: 'coop',
        entities: { pvpCombat: false },
        players: { min: 2, max: 8 },
        winCondition: { type: WIN.ALL_ESCAPE },
        metadata: { description: 'Work together until every surviving player escapes.' }
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
        description: r.metadata.description || '',
        players: r.players, winCondition: r.winCondition.type, pvpCombat: r.entities.pvpCombat
    }));
}

/**
 * Match-mode catalog. `solo-classic` describes the separate solo engine and must never be
 * selected for a multiplayer queue. Keeping this filter beside the registry gives the server,
 * scheduler, and clients one stable allowlist.
 */
function listMatchRulesets() {
    return listRulesets().filter(r => r.mode !== 'solo');
}

/**
 * Resolve an operator-selected multiplayer ruleset. Unknown/solo ids fail closed to the classic
 * race, preserving the historical behavior and preventing arbitrary client-authored specs.
 */
function resolveMatchRuleset(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    const candidate = BUILTINS[key];
    return candidate && candidate.mode !== 'solo' ? candidate : BUILTINS.race;
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

module.exports = {
    BUILTINS,
    getRuleset,
    listRulesets,
    listMatchRulesets,
    resolveMatchRuleset,
    rulesetFromMatchOpts
};
