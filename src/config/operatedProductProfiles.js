'use strict';

/**
 * Opt-in contracts for the two public products operated by Such Software.
 *
 * Independent MIT deployments do not set OPERATED_PRODUCT_PROFILE and are deliberately not
 * constrained by these product decisions. Official production environments do set it, causing
 * preflight and normal startup to reject any network, identity, or economic-scope drift.
 */

const OPERATED_PRODUCT_PROFILE_IDS = Object.freeze({
    WOW_PRESTIGE: 'such-play-wow-prestige',
    XMR_STAGENET: 'such-monerogue-stagenet'
});

const SOURCE_SOFTWARE = Object.freeze({
    publisherName: 'Such Software',
    contactUrl: 'mailto:apps@such.software',
    contactLabel: 'apps@such.software',
    license: 'MIT',
    rightsNotice: 'Permission to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies is granted under the MIT License only if the copyright and permission notice is included in all copies or substantial portions.',
    warrantyNotice: 'The software is provided “AS IS”, without warranty of any kind, express or implied, to the fullest extent stated in the MIT License.',
    legalAdviceNotice: 'Documentation, examples, and product disclosures are informational only; they are not legal advice or a determination that any deployment complies with applicable law.',
    thirdPartyNotice: 'A third-party or self-hosted operator is solely responsible for its deployment, product design, legal compliance, funds, players, claims, and support. The MIT License does not make that deployment a Such Software service or authorize it to claim Such Software sponsorship or endorsement. Such Software does not operate, supervise, endorse, or accept responsibility for third-party deployments.',
    operatedBoundaryNotice: 'Such Software operates only play.wowne.ro and monerogue.app, and only within the product scopes stated for those services. It does not operate or endorse deployments made from this source by anyone else.'
});

const PROFILES = Object.freeze({
    [OPERATED_PRODUCT_PROFILE_IDS.WOW_PRESTIGE]: Object.freeze({
        id: OPERATED_PRODUCT_PROFILE_IDS.WOW_PRESTIGE,
        hostname: 'play.wowne.ro',
        publicUrl: 'https://play.wowne.ro',
        operatorName: 'Such Software',
        operatorContactUrl: SOURCE_SOFTWARE.contactUrl,
        operatorContactLabel: SOURCE_SOFTWARE.contactLabel,
        scopeNotice: 'Such Software operates play.wowne.ro only as Wownero mainnet free play and pay-for-credits leaderboard/prestige play. Credits are non-redeemable service entitlements. The service offers no prizes, winnings, cash-out, or payouts and is not offered or marketed as gambling; legal classification depends on applicable law.',
        commerceSummary: 'This purchase grants non-redeemable service credits for leaderboard/prestige play only. play.wowne.ro offers no prize, payout, or cash-out and is not marketed as gambling.',
        noRealValueNotice: null
    }),
    [OPERATED_PRODUCT_PROFILE_IDS.XMR_STAGENET]: Object.freeze({
        id: OPERATED_PRODUCT_PROFILE_IDS.XMR_STAGENET,
        hostname: 'monerogue.app',
        publicUrl: 'https://monerogue.app',
        operatorName: 'Such Software',
        operatorContactUrl: SOURCE_SOFTWARE.contactUrl,
        operatorContactLabel: SOURCE_SOFTWARE.contactLabel,
        scopeNotice: 'Such Software operates monerogue.app only with Monero stagenet test coins. Its single-player 2×/3× outcomes are test gambling mechanics; no real-money or mainnet gambling is offered.',
        commerceSummary: 'NO REAL VALUE — monerogue.app uses Monero stagenet test coins only. Single-player qualifying outcomes pay 2× or 3× in test coins; never send mainnet XMR.',
        noRealValueNotice: 'NO REAL VALUE — Monero stagenet coins are test data, not money, deposits, redeemable prizes, or a promise of value. Never send mainnet XMR to this service.'
    })
});

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function isExplicitTrue(value) {
    return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function isExplicitFalse(value) {
    return FALSE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

function selectedProfileId(env = process.env) {
    return String(env.OPERATED_PRODUCT_PROFILE || '').trim();
}

function getOperatedProductProfile(env = process.env) {
    return PROFILES[selectedProfileId(env)] || null;
}

function isExactPublicRoot(value, expected) {
    try {
        const actual = new URL(String(value || ''));
        const target = new URL(expected);
        return actual.protocol === 'https:'
            && actual.username === ''
            && actual.password === ''
            && actual.origin === target.origin
            && (actual.pathname === '' || actual.pathname === '/')
            && actual.search === ''
            && actual.hash === '';
    } catch (_) {
        return false;
    }
}

function exactMultiplier(value, expected) {
    return String(value ?? '').trim() !== '' && Number(value) === expected;
}

function hasOutOfScopeProduct(config) {
    const standaloneProducts = config?.products?.cosmetic || [];
    const creditPackages = config?.modes?.credits?.packages || [];

    // These two operated products sell only the top-level credits/bonus declared by a credit
    // package. Reject the entire extensible grants object, including unknown future keys, so a
    // new entitlement cannot silently widen the public product contract.
    return standaloneProducts.length > 0
        || creditPackages.some(product => product
            && Object.prototype.hasOwnProperty.call(product, 'grants'));
}

function validateOperatedProductProfile(env = process.env, config = {}) {
    const id = selectedProfileId(env);
    if (!id) return [];

    const profile = PROFILES[id];
    if (!profile) {
        return [`OPERATED_PRODUCT_PROFILE=${id} is unknown. Remove it for an independent MIT deployment or use a reviewed Such Software profile.`];
    }

    const errors = [];
    const requireContract = (condition, requirement) => {
        if (!condition) errors.push(`OPERATED_PRODUCT_PROFILE=${id} requires ${requirement}.`);
    };
    const cryptoType = String(env.CRYPTO_TYPE || config?.currency?.symbol || '').trim().toUpperCase();
    const network = String(env.MONERO_NETWORK || '').trim().toLowerCase();

    requireContract(isExactPublicRoot(env.HOSTED_BY, profile.publicUrl), `HOSTED_BY=${profile.publicUrl}`);
    requireContract(String(env.OPERATOR_NAME || '').trim() === profile.operatorName,
        `OPERATOR_NAME=${profile.operatorName}`);
    requireContract(String(env.OPERATOR_CONTACT_URL || '').trim() === profile.operatorContactUrl,
        `OPERATOR_CONTACT_URL=${profile.operatorContactUrl}`);
    requireContract(String(env.OPERATOR_CONTACT_LABEL || '').trim() === profile.operatorContactLabel,
        `OPERATOR_CONTACT_LABEL=${profile.operatorContactLabel}`);
    requireContract(isExplicitTrue(env.PAYMENTS_ENABLED) && config?.paymentsEnabled === true,
        'PAYMENTS_ENABLED=true');
    requireContract(isExplicitTrue(env.PAID_ACKNOWLEDGEMENT_REQUIRED),
        'PAID_ACKNOWLEDGEMENT_REQUIRED=true');
    requireContract(isExplicitTrue(env.FREE_PLAY_ENABLED), 'FREE_PLAY_ENABLED=true');
    requireContract(isExplicitTrue(env.SOLO_ENABLED), 'SOLO_ENABLED=true');
    requireContract(isExplicitTrue(env.TAVERN_ENABLED), 'TAVERN_ENABLED=true');
    requireContract(isExplicitTrue(env.MATCH_ENABLED), 'MATCH_ENABLED=true');
    requireContract(isExplicitFalse(env.MATCH_CRYPTO_RACE_ENABLED), 'MATCH_CRYPTO_RACE_ENABLED=false');
    requireContract(isExplicitFalse(env.MATCH_PAYOUTS_ENABLED), 'MATCH_PAYOUTS_ENABLED=false');
    requireContract(!hasOutOfScopeProduct(config),
        'no standalone products or bundled entitlement grants; credit packages may grant only their top-level credits and bonus');

    if (id === OPERATED_PRODUCT_PROFILE_IDS.WOW_PRESTIGE) {
        requireContract(cryptoType === 'WOW', 'CRYPTO_TYPE=WOW');
        requireContract(network === 'mainnet', 'MONERO_NETWORK=mainnet');
        requireContract(String(env.PAYMENT_MODES || '').trim().toLowerCase() === 'credits',
            'PAYMENT_MODES=credits');
        requireContract(isExplicitFalse(env.DIRECT_PAYMENT_ENABLED)
            && config?.modes?.direct?.enabled === false, 'DIRECT_PAYMENT_ENABLED=false');
        requireContract(isExplicitTrue(env.CREDITS_ENABLED)
            && config?.modes?.credits?.enabled === true, 'CREDITS_ENABLED=true');
        requireContract(isExplicitFalse(env.PAYOUTS_ENABLED)
            && config?.payouts?.enabled === false, 'PAYOUTS_ENABLED=false');
        requireContract(isExplicitFalse(env.DIRECT_PAYOUTS_ENABLED)
            && config?.payouts?.rules?.direct?.enabled === false, 'DIRECT_PAYOUTS_ENABLED=false');
        requireContract(isExplicitFalse(env.CREDITS_PAYOUTS_ENABLED)
            && config?.payouts?.rules?.credits?.enabled === false, 'CREDITS_PAYOUTS_ENABLED=false');
        requireContract(isExplicitFalse(env.ALLOW_MAINNET_PAYOUTS), 'ALLOW_MAINNET_PAYOUTS=false');
    }

    if (id === OPERATED_PRODUCT_PROFILE_IDS.XMR_STAGENET) {
        requireContract(cryptoType === 'XMR', 'CRYPTO_TYPE=XMR');
        requireContract(network === 'stagenet', 'MONERO_NETWORK=stagenet');
        requireContract(String(env.PAYMENT_MODES || '').split(',').map(value => value.trim().toLowerCase()).join(',') === 'direct,credits',
            'PAYMENT_MODES=direct,credits');
        requireContract(isExplicitTrue(env.DIRECT_PAYMENT_ENABLED)
            && config?.modes?.direct?.enabled === true, 'DIRECT_PAYMENT_ENABLED=true');
        requireContract(isExplicitTrue(env.CREDITS_ENABLED)
            && config?.modes?.credits?.enabled === true, 'CREDITS_ENABLED=true');
        requireContract(isExplicitTrue(env.PAYOUTS_ENABLED)
            && config?.payouts?.enabled === true, 'PAYOUTS_ENABLED=true');
        requireContract(isExplicitTrue(env.DIRECT_PAYOUTS_ENABLED)
            && config?.payouts?.rules?.direct?.enabled === true, 'DIRECT_PAYOUTS_ENABLED=true');
        requireContract(isExplicitTrue(env.CREDITS_PAYOUTS_ENABLED)
            && config?.payouts?.rules?.credits?.enabled === true, 'CREDITS_PAYOUTS_ENABLED=true');
        requireContract(exactMultiplier(env.DIRECT_PAYOUT_ESCAPE, 2), 'DIRECT_PAYOUT_ESCAPE=2');
        requireContract(exactMultiplier(env.DIRECT_PAYOUT_TREASURE, 3), 'DIRECT_PAYOUT_TREASURE=3');
        requireContract(exactMultiplier(env.CREDITS_PAYOUT_ESCAPE, 2), 'CREDITS_PAYOUT_ESCAPE=2');
        requireContract(exactMultiplier(env.CREDITS_PAYOUT_TREASURE, 3), 'CREDITS_PAYOUT_TREASURE=3');
        requireContract(isExplicitFalse(env.ALLOW_MAINNET_PAYOUTS), 'ALLOW_MAINNET_PAYOUTS=false');
    }

    return errors;
}

module.exports = {
    OPERATED_PRODUCT_PROFILE_IDS,
    SOURCE_SOFTWARE,
    getOperatedProductProfile,
    selectedProfileId,
    validateOperatedProductProfile
};
