const { defineRuleset, WIN, ECONOMY } = require('./Ruleset');
const { resolveWinCondition } = require('./winConditions');
const {
    BUILTINS,
    getRuleset,
    listRulesets,
    listMatchRulesets,
    resolveMatchRuleset,
    rulesetFromMatchOpts
} = require('./registry');

module.exports = {
    defineRuleset,
    WIN,
    ECONOMY,
    resolveWinCondition,
    BUILTINS,
    getRuleset,
    listRulesets,
    listMatchRulesets,
    resolveMatchRuleset,
    rulesetFromMatchOpts
};
