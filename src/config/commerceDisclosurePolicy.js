/**
 * Public commerce disclosures and paid-action acknowledgement validation.
 *
 * This is a product safety control, not a jurisdiction or identity check. The server derives
 * the words shown to players from the active runtime switches, and independently refuses paid
 * actions unless the browser echoes the current policy version and every required acknowledgement.
 */

const DEFAULT_POLICY_VERSION = '2026-07-21';
const DEFAULT_MINIMUM_AGE = 18;
const ALLOWED_CONTACT_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const ACKNOWLEDGEMENT_KEYS = new Set([
    'policyVersion',
    'ageEligible',
    'termsRead',
    'riskAccepted',
    'testnetUnderstood'
]);

function isTrue(value) {
    return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function minimumAge(env = process.env) {
    const value = Number(env.MINIMUM_AGE);
    return Number.isInteger(value) && value >= 18 && value <= 120
        ? value
        : DEFAULT_MINIMUM_AGE;
}

function safeContactUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        return ALLOWED_CONTACT_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
    } catch (_) {
        return null;
    }
}

function paidAcknowledgementRequired(env, gameModeManager) {
    // Payment intake can be paused while already-purchased prestige credits remain spendable in
    // PvP. Keep the public browser policy enabled for that value-bearing action too; free actions
    // bypass the acknowledgement explicitly at their individual server handlers.
    let matchEconomies = null;
    try {
        matchEconomies = gameModeManager?._getMatchEconomies?.() || null;
    } catch (_) {
        // Public disclosure generation must remain available during partial startup. The
        // conservative fallback below still treats an enabled paid product as value-bearing.
        matchEconomies = null;
    }
    const matchCanConsumePaidEntitlement = matchEconomies
        ? Boolean(matchEconomies.credits_prestige || matchEconomies.crypto_race)
        : Boolean(
            gameModeManager?.creditsModeEnabled
            || gameModeManager?.directModeEnabled
            || gameModeManager?.freePlayEnabled
        );
    const paidMatchEconomyAvailable = isTrue(env.MATCH_ENABLED)
        && matchCanConsumePaidEntitlement;
    const paidSoloEntitlementAvailable = Boolean(
        gameModeManager?.creditsModeEnabled || gameModeManager?.directModeEnabled
    );
    const productionPaid = String(env.NODE_ENV || '').toLowerCase() === 'production'
        && Boolean(
            gameModeManager?.paymentsEnabled
            || paidSoloEntitlementAvailable
            || paidMatchEconomyAvailable
        );
    return productionPaid || isTrue(env.PAID_ACKNOWLEDGEMENT_REQUIRED);
}

function buildCommerceDisclosure(gameModeManager, env = process.env) {
    const cryptoType = String(gameModeManager?.cryptoType || env.CRYPTO_TYPE || 'WOW').toUpperCase();
    const network = String(gameModeManager?.network || env.MONERO_NETWORK || 'mainnet').toLowerCase();
    const isTestNetwork = Boolean(gameModeManager?.isTestNetwork)
        || (cryptoType === 'XMR' && network !== 'mainnet');
    const paymentsEnabled = Boolean(gameModeManager?.paymentsEnabled);
    const directEnabled = paymentsEnabled && Boolean(gameModeManager?.directModeEnabled);
    const creditsEnabled = paymentsEnabled && Boolean(gameModeManager?.creditsModeEnabled);
    // A stale subordinate payout flag for a disabled product must not be advertised as an active
    // reward. Runtime startup policy uses the same mode-enabled distinction.
    const directPayouts = directEnabled
        && Boolean(gameModeManager?.isPayoutEnabledForMode?.('PAID_SINGLE'));
    const creditsPayouts = creditsEnabled
        && Boolean(gameModeManager?.isPayoutEnabledForMode?.('PAID_CREDITS'));
    const cryptoMatchPayouts = isTrue(env.MATCH_ENABLED)
        && isTrue(env.MATCH_CRYPTO_RACE_ENABLED)
        && isTrue(env.MATCH_PAYOUTS_ENABLED)
        && Boolean(gameModeManager?.payoutsEnabled);
    const anyPayouts = directPayouts || creditsPayouts || cryptoMatchPayouts;
    const currencyLabel = String(gameModeManager?.currencyLabel || (isTestNetwork ? `s${cryptoType}` : cryptoType));
    const operatorContactUrl = safeContactUrl(env.OPERATOR_CONTACT_URL);

    return Object.freeze({
        policyVersion: String(env.LEGAL_POLICY_VERSION || DEFAULT_POLICY_VERSION).trim(),
        termsEffectiveDate: String(env.TERMS_EFFECTIVE_DATE || '').trim() || null,
        minimumAge: minimumAge(env),
        paidAcknowledgementRequired: paidAcknowledgementRequired(env, gameModeManager),
        operator: Object.freeze({
            name: String(env.OPERATOR_NAME || '').trim() || 'Site operator (identity not configured)',
            contactUrl: operatorContactUrl,
            contactLabel: String(env.OPERATOR_CONTACT_LABEL || '').trim()
                || (operatorContactUrl ? operatorContactUrl.replace(/^mailto:/, '') : 'Operator contact is not configured')
        }),
        service: Object.freeze({
            gameName: String(gameModeManager?.gameName || 'Wowngeon'),
            cryptoType,
            currencyLabel,
            network,
            isTestNetwork,
            freePlayEnabled: Boolean(gameModeManager?.freePlayEnabled),
            paymentsEnabled,
            directPaidEntryEnabled: directEnabled,
            paidCreditsEnabled: creditsEnabled,
            soloPayoutsEnabled: directPayouts || creditsPayouts,
            cryptoMatchPayoutsEnabled: cryptoMatchPayouts,
            anyPayoutsEnabled: anyPayouts,
            paidPrestigeOnly: (directEnabled || creditsEnabled) && !anyPayouts
        }),
        notices: Object.freeze({
            jurisdiction: String(env.RESTRICTED_LOCATIONS_NOTICE || '').trim() || null,
            legalReview: 'These product disclosures are not a legal opinion, licence, or representation that the service is lawful in every location.',
            identityControl: 'The acknowledgement records a player statement; it does not verify age, identity, or location.'
        }),
        links: Object.freeze({
            terms: '/terms',
            privacy: '/privacy',
            responsiblePlay: '/responsible-play'
        })
    });
}

function validatePaidAcknowledgement(raw, disclosure, options = {}) {
    const required = options.required === true || disclosure?.paidAcknowledgementRequired === true;
    if (!required) return { ok: true, code: 'NOT_REQUIRED', acknowledgement: null };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, code: 'PAID_ACK_REQUIRED', message: 'Review and acknowledge the paid-play disclosures before continuing.' };
    }
    const prototype = Object.getPrototypeOf(raw);
    const keys = Object.keys(raw);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.length !== ACKNOWLEDGEMENT_KEYS.size
        || keys.some(key => !ACKNOWLEDGEMENT_KEYS.has(key))) {
        return { ok: false, code: 'PAID_ACK_MALFORMED', message: 'The paid-play acknowledgement payload is invalid. Reload the disclosures and try again.' };
    }
    if (typeof raw.policyVersion !== 'string' || raw.policyVersion.length < 1 || raw.policyVersion.length > 64) {
        return { ok: false, code: 'PAID_ACK_MALFORMED', message: 'The paid-play acknowledgement payload is invalid. Reload the disclosures and try again.' };
    }
    if (String(raw.policyVersion || '') !== String(disclosure.policyVersion || '')) {
        return { ok: false, code: 'PAID_ACK_VERSION', message: 'The paid-play disclosures changed. Review the current version before continuing.' };
    }
    if (typeof raw.ageEligible !== 'boolean'
        || typeof raw.termsRead !== 'boolean'
        || typeof raw.riskAccepted !== 'boolean'
        || typeof raw.testnetUnderstood !== 'boolean') {
        return { ok: false, code: 'PAID_ACK_MALFORMED', message: 'The paid-play acknowledgement payload is invalid. Reload the disclosures and try again.' };
    }
    if (raw.ageEligible !== true || raw.termsRead !== true || raw.riskAccepted !== true) {
        return { ok: false, code: 'PAID_ACK_INCOMPLETE', message: 'Every paid-play acknowledgement is required before continuing.' };
    }
    if (disclosure.service?.isTestNetwork && raw.testnetUnderstood !== true) {
        return { ok: false, code: 'PAID_ACK_TESTNET', message: 'Confirm that this test network uses valueless test coins and never send mainnet funds.' };
    }
    if (!disclosure.service?.isTestNetwork && raw.testnetUnderstood !== false) {
        return { ok: false, code: 'PAID_ACK_MALFORMED', message: 'The paid-play acknowledgement payload is invalid. Reload the disclosures and try again.' };
    }
    const acknowledgement = {
        policyVersion: disclosure.policyVersion,
        ageEligible: true,
        termsRead: true,
        riskAccepted: true,
        testnetUnderstood: disclosure.service?.isTestNetwork === true
    };
    return { ok: true, code: 'ACKNOWLEDGED', acknowledgement: Object.freeze(acknowledgement) };
}

module.exports = {
    DEFAULT_POLICY_VERSION,
    buildCommerceDisclosure,
    minimumAge,
    paidAcknowledgementRequired,
    safeContactUrl,
    validatePaidAcknowledgement
};
