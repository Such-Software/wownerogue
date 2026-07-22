/**
 * Match economy admission policy.
 *
 * Crypto matches are materially different from free/prestige matches: consuming a ticket
 * promises one on-chain winner payout. Keep every admission caller on the same fail-closed
 * contract so the queue, scheduler, and payout snapshot cannot disagree.
 */

const { resolveMatchRuleset } = require('../game/rulesets');

const CRYPTO_WIN_CONDITIONS = new Set(['first-to-exit', 'last-alive', 'high-score']);
const PG_BIGINT_MAX = 9223372036854775807n;

function isExplicitTrue(value) {
    return String(value ?? '').trim().toLowerCase() === 'true';
}

function parsePositiveAtomic(value) {
    const raw = String(value ?? '').trim().replace(/_/g, '');
    if (!/^\d+$/.test(raw)) return null;
    try {
        const parsed = BigInt(raw);
        return parsed > 0n && parsed <= PG_BIGINT_MAX ? parsed : null;
    } catch (_) {
        return null;
    }
}

function parseHouseFeeBasisPoints(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent < 0 || percent >= 100) return null;
    return Math.round(percent * 100);
}

function playerContract(ruleset, requestedMaxPlayers) {
    const ruleMin = Number.isInteger(ruleset?.players?.min) ? ruleset.players.min : 2;
    const ruleMax = Number.isInteger(ruleset?.players?.max) ? ruleset.players.max : 4;
    const hasConfiguredMax = requestedMaxPlayers !== null
        && requestedMaxPlayers !== undefined
        && String(requestedMaxPlayers).trim() !== '';
    const rawConfiguredMax = String(requestedMaxPlayers ?? '').trim();
    const configured = /^\d+$/.test(rawConfiguredMax) ? Number(rawConfiguredMax) : NaN;
    const configuredIsValidInteger = Number.isSafeInteger(configured);
    const requestedMax = configuredIsValidInteger ? configured : ruleMax;
    // Match persistence and transport require at least two entrants even when a ruleset (such
    // as score attack) is also valid as a standalone one-player challenge.
    const minPlayers = Math.max(2, ruleMin);
    const maxPlayers = Math.max(2, Math.min(32, ruleMax, requestedMax));
    return {
        minPlayers,
        maxPlayers,
        valid: (!hasConfiguredMax || configuredIsValidInteger)
            && minPlayers <= maxPlayers
            && requestedMax >= minPlayers
            && requestedMax <= 32
    };
}

function cryptoRulesetSupported(ruleset) {
    return !!ruleset
        && ruleset.mode !== 'solo'
        && ruleset.mode !== 'coop'
        && CRYPTO_WIN_CONDITIONS.has(ruleset.winCondition?.type)
        && Number(ruleset.players?.max) >= 2;
}

function matchPayoutAdmissionPolicy({
    env = process.env,
    gameModeManager = null,
    ruleset = null,
    requestedMaxPlayers = null
} = {}) {
    const resolvedRuleset = ruleset || resolveMatchRuleset(env.MATCH_RULESET_ID || 'race');
    const players = playerContract(
        resolvedRuleset,
        requestedMaxPlayers ?? env.MATCH_MAX_PLAYERS ?? resolvedRuleset.players.max
    );
    const payoutCap = parsePositiveAtomic(env.MATCH_PAYOUT_MAX);
    const entryFee = parsePositiveAtomic(env.MATCH_ENTRY_FEE_ATOMIC);
    const houseFeeBasisPoints = parseHouseFeeBasisPoints(env.MATCH_HOUSE_FEE_PERCENT);
    const masterPayoutsEnabled = gameModeManager
        ? gameModeManager.payoutsEnabled === true
        : isExplicitTrue(env.PAYOUTS_ENABLED);
    const paidProductAvailable = gameModeManager
        ? !!(gameModeManager.directModeEnabled || gameModeManager.creditsModeEnabled)
        : isExplicitTrue(env.PAYMENTS_ENABLED);

    const checks = [
        [isExplicitTrue(env.MATCH_ENABLED), 'match_disabled'],
        [isExplicitTrue(env.MATCH_CRYPTO_RACE_ENABLED), 'crypto_match_disabled'],
        [isExplicitTrue(env.MATCH_PAYOUTS_ENABLED), 'match_payouts_disabled'],
        [masterPayoutsEnabled, 'payout_master_disabled'],
        [paidProductAvailable, 'paid_products_disabled'],
        [cryptoRulesetSupported(resolvedRuleset), 'unsupported_crypto_ruleset'],
        [players.valid, 'invalid_player_contract'],
        [payoutCap !== null, 'invalid_payout_cap'],
        [entryFee !== null, 'invalid_entry_fee'],
        [houseFeeBasisPoints !== null, 'invalid_house_fee']
    ];
    const failed = checks.find(([ok]) => !ok);

    return Object.freeze({
        enabled: !failed,
        reason: failed ? failed[1] : null,
        ruleset: resolvedRuleset,
        minPlayers: players.minPlayers,
        maxPlayers: players.maxPlayers,
        payoutCap,
        entryFee,
        houseFeeBasisPoints
    });
}

module.exports = {
    PG_BIGINT_MAX,
    cryptoRulesetSupported,
    isExplicitTrue,
    matchPayoutAdmissionPolicy,
    parseHouseFeeBasisPoints,
    parsePositiveAtomic,
    playerContract
};
