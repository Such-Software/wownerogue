/**
 * Startup configuration validation.
 *
 * Development remains forgiving so a contributor can boot individual subsystems. Production is
 * deliberately fail-closed: an ambiguous money or block-source setting must never silently fall
 * back to a dangerous default.
 */

const { isSupported, familyFor } = require('../chain/chainProfile');
const { resolveMatchRuleset } = require('../game/rulesets');
const money = require('../money/atomic');
const {
    PG_BIGINT_MAX,
    cryptoRulesetSupported,
    parseHouseFeeBasisPoints,
    parsePositiveAtomic,
    playerContract
} = require('../network/matchEconomyPolicy');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const BOOLEAN_VALUES = new Set(['true', 'false', '1', '0', 'yes', 'no', 'y', 'n', 'on', 'off']);
const PLACEHOLDER_SECRET = /(change[_-]?me|replace[_-]?with|your[_-]|example|password|secret)/i;

const BOOLEAN_ENV_KEYS = [
    'PAYMENTS_ENABLED', 'PAYOUTS_ENABLED', 'DIRECT_PAYMENT_ENABLED',
    'DIRECT_PAYOUTS_ENABLED', 'CREDITS_ENABLED', 'CREDITS_PAYOUTS_ENABLED',
    'CREDITS_PAYOUT_ENABLED', 'FREE_PLAY_ENABLED', 'DIRECT_REQUIRES_ADDRESS',
    'DIRECT_ALLOW_GUEST_PLAY', 'CREDITS_REQUIRES_ADDRESS', 'ALLOW_MIXED_MODE',
    'PREFER_CREDITS_FIRST', 'EARLY_ENTRY_ENABLED', 'EARLY_ENTRY_FREE_MODE',
    'EARLY_ENTRY_CREDITS_MODE', 'ALLOW_MAINNET_PAYOUTS', 'TRUST_PROXY',
    'SMIRK_ENABLED', 'TAVERN_ENABLED', 'MATCH_ENABLED', 'MATCH_CRYPTO_RACE_ENABLED',
    'MATCH_PAYOUTS_ENABLED',
    'SIMULATED_BLOCKS', 'FORCE_SIMULATED_BLOCKS', 'DEBUG_HOTKEYS',
    'PAID_ACKNOWLEDGEMENT_REQUIRED'
];

const ATOMIC_ENV_KEYS = [
    'DIRECT_GAME_PRICE', 'SINGLE_GAME_PRICE', 'CREDITS_PACKAGE_PRICE',
    'CREDITS_PAYOUT_BASE', 'PAYOUT_MIN_AMOUNT', 'PAYOUT_MAX_PER_GAME',
    'CREDITS_PAYOUT_MIN', 'CREDITS_PAYOUT_MAX', 'MAX_CREDIT_PURCHASE_PER_DAY',
    'BALANCE_WARN', 'BALANCE_CRITICAL', 'LOW_BALANCE_THRESHOLD', 'MATCH_ENTRY_FEE_ATOMIC',
    'MATCH_PAYOUT_MAX'
];

const POSITIVE_ATOMIC_ENV_KEYS = new Set([
    'DIRECT_GAME_PRICE', 'SINGLE_GAME_PRICE', 'CREDITS_PACKAGE_PRICE',
    'CREDITS_PAYOUT_BASE', 'PAYOUT_MAX_PER_GAME', 'CREDITS_PAYOUT_MAX',
    'MAX_CREDIT_PURCHASE_PER_DAY', 'MATCH_ENTRY_FEE_ATOMIC', 'MATCH_PAYOUT_MAX'
]);

function isTrue(value) {
    return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function canonicalInteger(value) {
    return String(value ?? '').trim().replace(/_/g, '');
}

function raceTicketGrant(product) {
    const grants = product?.grants;
    if (!grants || typeof grants !== 'object') return null;
    const hasEntries = Object.prototype.hasOwnProperty.call(grants, 'race_entries')
        || Object.prototype.hasOwnProperty.call(grants, 'raceEntries');
    if (!hasEntries) return null;
    return {
        productId: String(product.id || '(unnamed)'),
        entries: grants.race_entries ?? grants.raceEntries,
        valueAtomic: grants.race_entry_value_atomic ?? grants.raceEntryValueAtomic,
        price: product.price
    };
}

function isLoopbackHost(hostname) {
    const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

class EnvironmentValidator {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.env = options.env || process.env;
    }

    _endpointIssue(name, value) {
        if (!value) return `${name} is not set.`;
        try {
            const endpoint = new URL(value);
            if (!['http:', 'https:'].includes(endpoint.protocol)) {
                return `${name} must use http:// or https://.`;
            }
            return null;
        } catch (_) {
            return `${name} must be a valid URL.`;
        }
    }

    _pushEndpointTransportWarning(warnings, name, value) {
        if (!value) return;
        try {
            const endpoint = new URL(value);
            if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname)) {
                warnings.push(`${name} uses plaintext HTTP on a non-loopback host; use TLS or a private authenticated network.`);
            }
        } catch (_) {
            // Syntax errors are reported separately.
        }
    }

    validate(config) {
        const env = this.env;
        const warnings = [];
        const errors = [];
        const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
        const paymentsEnabled = Boolean(config?.paymentsEnabled);
        const directEnabled = paymentsEnabled && Boolean(config?.modes?.direct?.enabled);
        const creditsEnabled = paymentsEnabled && Boolean(config?.modes?.credits?.enabled);
        const payoutMasterEnabled = Boolean(config?.payouts?.enabled);
        const directPayoutsEnabled = payoutMasterEnabled && directEnabled
            && Boolean(config?.payouts?.rules?.direct?.enabled);
        const creditsPayoutsEnabled = payoutMasterEnabled && creditsEnabled
            && Boolean(config?.payouts?.rules?.credits?.enabled);
        const matchModeEnabled = isTrue(env.MATCH_ENABLED);
        const matchCryptoEnabled = matchModeEnabled && isTrue(env.MATCH_CRYPTO_RACE_ENABLED);
        const matchPayoutsEnabled = payoutMasterEnabled && matchCryptoEnabled
            && isTrue(env.MATCH_PAYOUTS_ENABLED);
        const anyPayoutsEnabled = directPayoutsEnabled || creditsPayoutsEnabled || matchPayoutsEnabled;
        // PAYOUTS_ENABLED also authorizes settlement of already-created durable rows even when
        // every admission switch is off, so payout-only recovery has the same wallet boundary.
        const walletRequired = paymentsEnabled || payoutMasterEnabled;
        const cryptoType = String(env.CRYPTO_TYPE || config?.currency?.symbol || 'WOW').trim().toUpperCase();
        const network = String(env.MONERO_NETWORK || 'mainnet').trim().toLowerCase();

        if (env.GAME_MODE && env.PAYMENT_MODES) {
            warnings.push('Both GAME_MODE and PAYMENT_MODES are set. PAYMENT_MODES takes precedence.');
        }

        if (!isSupported(cryptoType)) {
            errors.push(`CRYPTO_TYPE=${cryptoType || '(empty)'} is not a supported chain profile.`);
        } else if (walletRequired && familyFor(cryptoType) !== 'monero') {
            errors.push(`Paid production adapters are not implemented for CRYPTO_TYPE=${cryptoType}; use WOW or XMR.`);
        }

        if (cryptoType === 'WOW' && network !== 'mainnet') {
            errors.push('Wownero only supports MONERO_NETWORK=mainnet.');
        }
        if (cryptoType === 'XMR' && !['mainnet', 'stagenet', 'testnet'].includes(network)) {
            errors.push('MONERO_NETWORK must be mainnet, stagenet, or testnet for XMR.');
        }

        const walletIssue = this._endpointIssue('PRIMARY_WALLET_ENDPOINT', env.PRIMARY_WALLET_ENDPOINT);
        if (walletRequired && walletIssue) {
            (production ? errors : warnings).push(`Financial workers require a wallet but ${walletIssue}`);
        }
        if (Boolean(env.WALLET_RPC_USER) !== Boolean(env.WALLET_RPC_PASSWORD)) {
            (production ? errors : warnings).push('WALLET_RPC_USER and WALLET_RPC_PASSWORD must be set together.');
        }
        if (production && paymentsEnabled) {
            if (!isTrue(env.PAID_ACKNOWLEDGEMENT_REQUIRED)) {
                errors.push('Production payments require PAID_ACKNOWLEDGEMENT_REQUIRED=true; the server will not accept a paid action without the current acknowledgement.');
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(env.LEGAL_POLICY_VERSION || ''))) {
                errors.push('LEGAL_POLICY_VERSION must be an explicit 1-64 character version identifier for production payments.');
            }
            const effectiveDate = String(env.TERMS_EFFECTIVE_DATE || '');
            const parsedEffectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
                ? new Date(`${effectiveDate}T00:00:00Z`)
                : null;
            if (!parsedEffectiveDate || Number.isNaN(parsedEffectiveDate.getTime())
                || parsedEffectiveDate.toISOString().slice(0, 10) !== effectiveDate) {
                errors.push('TERMS_EFFECTIVE_DATE must be an explicit valid YYYY-MM-DD date for production payments.');
            }
            const configuredMinimumAge = Number(env.MINIMUM_AGE);
            if (!Number.isInteger(configuredMinimumAge) || configuredMinimumAge < 18 || configuredMinimumAge > 120) {
                errors.push('MINIMUM_AGE must be an explicit integer from 18 through 120 for production payments.');
            }
            const operatorName = String(env.OPERATOR_NAME || '').trim();
            if (operatorName.length < 2 || operatorName.length > 120 || PLACEHOLDER_SECRET.test(operatorName)) {
                errors.push('OPERATOR_NAME must identify the responsible operator without placeholder text for production payments.');
            }
            try {
                const contact = new URL(String(env.OPERATOR_CONTACT_URL || ''));
                if (!['https:', 'mailto:'].includes(contact.protocol)) {
                    errors.push('OPERATOR_CONTACT_URL must use https:// or mailto: for production payments.');
                }
                if (PLACEHOLDER_SECRET.test(String(env.OPERATOR_CONTACT_URL || ''))) {
                    errors.push('OPERATOR_CONTACT_URL must not contain placeholder text for production payments.');
                }
            } catch (_) {
                errors.push('OPERATOR_CONTACT_URL must be an explicit valid https:// or mailto: URL for production payments.');
            }
        }
        if (production && walletRequired) {
            if (!env.WALLET_RPC_USER || !env.WALLET_RPC_PASSWORD) {
                errors.push('Production financial workers require WALLET_RPC_USER and WALLET_RPC_PASSWORD for wallet-rpc Digest authentication.');
            } else if (String(env.WALLET_RPC_PASSWORD).length < 24
                || PLACEHOLDER_SECRET.test(String(env.WALLET_RPC_PASSWORD))) {
                errors.push('WALLET_RPC_PASSWORD must be a strong non-placeholder secret of at least 24 characters in production.');
            }
            if (env.PRIMARY_WALLET_ENDPOINT) {
                try {
                    const walletEndpoint = new URL(env.PRIMARY_WALLET_ENDPOINT);
                    if (walletEndpoint.protocol === 'http:' && !isLoopbackHost(walletEndpoint.hostname)) {
                        errors.push('Production wallet-rpc over plaintext HTTP must bind to a loopback address.');
                    }
                } catch (_) {
                    // Endpoint syntax is reported by _endpointIssue above.
                }
            }
        }
        if (env.HOSTED_BY) {
            try {
                const hostedBy = new URL(env.HOSTED_BY);
                if (!['http:', 'https:'].includes(hostedBy.protocol)) {
                    (production ? errors : warnings).push('HOSTED_BY must use http:// or https://.');
                }
                if (production && hostedBy.protocol !== 'https:') {
                    errors.push('HOSTED_BY must use https:// in production.');
                }
            } catch (_) {
                (production ? errors : warnings).push('HOSTED_BY must be a valid public URL.');
            }
        }
        const daemonIssue = this._endpointIssue('PRIMARY_RPC_ENDPOINT', env.PRIMARY_RPC_ENDPOINT);
        if (production && daemonIssue) {
            errors.push(`Production block timing requires a daemon RPC: ${daemonIssue}`);
        } else if (paymentsEnabled && daemonIssue) {
            warnings.push(`Payments are enabled but ${daemonIssue}`);
        }
        this._pushEndpointTransportWarning(warnings, 'PRIMARY_WALLET_ENDPOINT', env.PRIMARY_WALLET_ENDPOINT);
        this._pushEndpointTransportWarning(warnings, 'PRIMARY_RPC_ENDPOINT', env.PRIMARY_RPC_ENDPOINT);

        if (config?.modes?.direct?.enabled && config.modes.direct.price <= 0n) {
            errors.push('Direct payment mode is enabled but its price is not positive.');
        }
        if (config?.modes?.credits?.enabled && !config.modes.credits.packages?.length) {
            errors.push('Credits mode is enabled but no credit packages are defined.');
        }

        if (env.CREDITS_PACKAGES) {
            try {
                const packages = JSON.parse(env.CREDITS_PACKAGES);
                if (!Array.isArray(packages)) {
                    errors.push('CREDITS_PACKAGES must be a JSON array.');
                } else if (packages.length === 0) {
                    errors.push('CREDITS_PACKAGES must not be empty when explicitly configured.');
                } else {
                    packages.forEach((pkg, index) => {
                        if (!pkg || typeof pkg !== 'object') {
                            errors.push(`CREDITS_PACKAGES[${index}] must be an object.`);
                            return;
                        }
                        if (!pkg.id) errors.push(`CREDITS_PACKAGES[${index}] is missing "id".`);
                        if (!Number.isInteger(Number(pkg.credits)) || Number(pkg.credits) <= 0) {
                            errors.push(`CREDITS_PACKAGES[${index}].credits must be a positive integer.`);
                        }
                        try {
                            if (BigInt(pkg.price) <= 0n) throw new Error('not positive');
                        } catch (_) {
                            errors.push(`CREDITS_PACKAGES[${index}].price must be a positive atomic-unit integer.`);
                        }
                    });
                }
            } catch (error) {
                errors.push(`CREDITS_PACKAGES is not valid JSON: ${error.message}`);
            }
        } else if (creditsEnabled) {
            warnings.push('Credits mode is using built-in package defaults; set CREDITS_PACKAGES explicitly for production pricing.');
        }

        if (!payoutMasterEnabled
            && (Boolean(config?.payouts?.rules?.direct?.enabled) || Boolean(config?.payouts?.rules?.credits?.enabled))) {
            warnings.push('Payout rules are enabled but PAYOUTS_ENABLED is off; the master switch suppresses all payout creation and dispatch.');
        }

        if (production) {
            for (const key of BOOLEAN_ENV_KEYS) {
                if (Object.prototype.hasOwnProperty.call(env, key)
                    && !BOOLEAN_VALUES.has(String(env[key]).trim().toLowerCase())) {
                    errors.push(`${key} must be an explicit boolean (true or false).`);
                }
            }

            for (const key of ATOMIC_ENV_KEYS) {
                if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === '') continue;
                const raw = canonicalInteger(env[key]);
                if (!/^\d+$/.test(raw)) {
                    errors.push(`${key} must be a non-negative integer in atomic units.`);
                    continue;
                }
                try {
                    if (POSITIVE_ATOMIC_ENV_KEYS.has(key) && BigInt(raw) <= 0n) {
                        errors.push(`${key} must be greater than zero.`);
                    }
                } catch (_) {
                    errors.push(`${key} must be a valid atomic-unit integer.`);
                }
            }

            if (env.GAME_MODE && !['FREE', 'PAID_SINGLE', 'PAID_CREDITS'].includes(String(env.GAME_MODE).trim().toUpperCase())) {
                errors.push('GAME_MODE must be FREE, PAID_SINGLE, or PAID_CREDITS.');
            }
            if (env.PAYMENT_MODES) {
                const configuredModes = String(env.PAYMENT_MODES).split(',')
                    .map(mode => mode.trim().toLowerCase()).filter(Boolean);
                const invalidModes = configuredModes.filter(mode => !['direct', 'credits'].includes(mode));
                if (configuredModes.length === 0 || invalidModes.length > 0) {
                    errors.push('PAYMENT_MODES must contain only direct and/or credits.');
                }
            }

            for (const key of [
                'DIRECT_PAYOUT_ESCAPE', 'DIRECT_PAYOUT_TREASURE',
                'CREDITS_PAYOUT_ESCAPE', 'CREDITS_PAYOUT_TREASURE'
            ]) {
                if (!Object.prototype.hasOwnProperty.call(env, key) || env[key] === '') continue;
                const multiplier = Number(env[key]);
                if (!Number.isFinite(multiplier) || multiplier <= 0) {
                    errors.push(`${key} must be a finite number greater than zero.`);
                }
            }
            if (Object.prototype.hasOwnProperty.call(env, 'MATCH_HOUSE_FEE_PERCENT')) {
                if (parseHouseFeeBasisPoints(env.MATCH_HOUSE_FEE_PERCENT) === null) {
                    errors.push('MATCH_HOUSE_FEE_PERCENT must be at least 0 and less than 100.');
                }
            }
            if (isTrue(env.TRUST_PROXY)) {
                const proxyHops = Number(env.TRUST_PROXY_HOPS || 1);
                if (!Number.isInteger(proxyHops) || proxyHops < 1 || proxyHops > 8) {
                    errors.push('TRUST_PROXY_HOPS must be an integer from 1 through 8.');
                }
            }

            if (matchModeEnabled) {
                for (const key of [
                    'MATCH_PAID_ENTROPY_DELAY_BLOCKS',
                    'MATCH_PAID_ENTROPY_CONFIRMATIONS'
                ]) {
                    const raw = String(env[key] ?? '').trim();
                    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
                    if (!Number.isSafeInteger(value) || value < 2 || value > 100) {
                        errors.push(`${key} must be an explicit safe integer from 2 through 100 when production match mode is enabled.`);
                    }
                }
            }

            if (matchCryptoEnabled && !Object.prototype.hasOwnProperty.call(env, 'MATCH_PAYOUTS_ENABLED')) {
                errors.push('Production crypto matches require an explicit MATCH_PAYOUTS_ENABLED=true|false setting.');
            }
            if (isTrue(env.MATCH_PAYOUTS_ENABLED) && !matchCryptoEnabled) {
                errors.push('MATCH_PAYOUTS_ENABLED=true requires MATCH_ENABLED=true and MATCH_CRYPTO_RACE_ENABLED=true.');
            }
            if (matchPayoutsEnabled) {
                if (!directEnabled && !creditsEnabled) {
                    errors.push('Crypto match payouts require at least one enabled paid product mode for race-entry tickets.');
                }
                const payoutCap = parsePositiveAtomic(env.MATCH_PAYOUT_MAX);
                if (payoutCap === null) {
                    errors.push('MATCH_PAYOUT_MAX must be an explicit positive PostgreSQL BIGINT atomic-unit cap when crypto match payouts are enabled.');
                }

                const ruleset = resolveMatchRuleset(env.MATCH_RULESET_ID || 'race');
                if (!cryptoRulesetSupported(ruleset)) {
                    errors.push(`MATCH_RULESET_ID=${ruleset.id} does not have supported single-winner crypto payout semantics.`);
                }
                const requestedMaxRaw = String(env.MATCH_MAX_PLAYERS ?? '').trim();
                const requestedMax = /^\d+$/.test(requestedMaxRaw)
                    ? Number(requestedMaxRaw)
                    : NaN;
                const contract = playerContract(ruleset, env.MATCH_MAX_PLAYERS || ruleset.players.max);
                if (!Number.isInteger(requestedMax)
                    || requestedMax < contract.minPlayers
                    || requestedMax > ruleset.players.max
                    || requestedMax > 32) {
                    errors.push(`MATCH_MAX_PLAYERS must be an integer from ${contract.minPlayers} through ${Math.min(32, ruleset.players.max)} for ruleset ${ruleset.id}.`);
                }

                const entryFee = parsePositiveAtomic(env.MATCH_ENTRY_FEE_ATOMIC);
                const feeBasisPoints = parseHouseFeeBasisPoints(env.MATCH_HOUSE_FEE_PERCENT);
                if (entryFee === null) {
                    errors.push('MATCH_ENTRY_FEE_ATOMIC must be an explicit positive PostgreSQL BIGINT atomic-unit value when crypto match payouts are enabled.');
                }
                if (feeBasisPoints === null) {
                    errors.push('MATCH_HOUSE_FEE_PERCENT must be explicitly set from 0 (inclusive) to 100 (exclusive) when crypto match payouts are enabled.');
                }

                const catalog = [
                    ...(config?.modes?.credits?.packages || []),
                    ...(config?.products?.cosmetic || [])
                ];
                const ticketProducts = catalog.map(raceTicketGrant).filter(Boolean);
                if (ticketProducts.length === 0) {
                    errors.push('Crypto match payouts require at least one configured race-entry product with explicit per-ticket atomic backing.');
                }
                for (const ticket of ticketProducts) {
                    const rawEntries = String(ticket.entries ?? '').trim();
                    let ticketEntries = null;
                    if (/^\d+$/.test(rawEntries)) {
                        try {
                            const parsed = BigInt(rawEntries);
                            if (parsed > 0n && parsed <= 2147483647n) ticketEntries = parsed;
                        } catch (_) { /* reported below */ }
                    }
                    if (ticketEntries === null) {
                        errors.push(`Race-entry product ${ticket.productId} must grant a positive integer number of tickets.`);
                        continue;
                    }
                    const ticketValue = parsePositiveAtomic(ticket.valueAtomic);
                    if (ticketValue === null) {
                        errors.push(`Race-entry product ${ticket.productId} must set grants.race_entry_value_atomic to a positive PostgreSQL BIGINT atomic-unit value.`);
                        continue;
                    }
                    if (entryFee !== null && ticketValue !== entryFee) {
                        errors.push(`Race-entry product ${ticket.productId} backing must equal MATCH_ENTRY_FEE_ATOMIC (${entryFee} atomic units per ticket).`);
                    }
                    const price = parsePositiveAtomic(ticket.price);
                    const requiredBacking = ticketValue * ticketEntries;
                    if (price === null || price < requiredBacking) {
                        errors.push(`Race-entry product ${ticket.productId} price must fund at least ${requiredBacking} atomic units of ticket backing.`);
                    }
                }

                if (entryFee !== null && payoutCap !== null && feeBasisPoints !== null
                    && Number.isInteger(requestedMax)) {
                    const pot = entryFee * BigInt(requestedMax);
                    const feeBp = BigInt(feeBasisPoints);
                    const maximumLiability = pot - ((pot * feeBp) / 10000n);
                    if (pot > PG_BIGINT_MAX) {
                        errors.push(`MATCH_ENTRY_FEE_ATOMIC * MATCH_MAX_PLAYERS exceeds PostgreSQL BIGINT (${PG_BIGINT_MAX}).`);
                    }
                    if (maximumLiability > payoutCap) {
                        errors.push(`MATCH_PAYOUT_MAX is below the configured ${requestedMax}-player winner liability (${maximumLiability} atomic units).`);
                    }
                }
            }

            if (payoutMasterEnabled) {
                const balanceCritical = parsePositiveAtomic(env.BALANCE_CRITICAL);
                const balanceWarn = parsePositiveAtomic(env.BALANCE_WARN);
                const acceptedLiabilities = [];

                if (directPayoutsEnabled || creditsPayoutsEnabled) {
                    const soloPayoutCap = parsePositiveAtomic(env.PAYOUT_MAX_PER_GAME);
                    if (soloPayoutCap === null) {
                        errors.push('PAYOUT_MAX_PER_GAME must be an explicit positive PostgreSQL BIGINT atomic-unit cap when solo payouts are enabled.');
                    } else {
                        acceptedLiabilities.push({ label: 'PAYOUT_MAX_PER_GAME', amount: soloPayoutCap });
                    }
                }
                if (matchPayoutsEnabled) {
                    const matchPayoutCap = parsePositiveAtomic(env.MATCH_PAYOUT_MAX);
                    if (matchPayoutCap !== null) {
                        acceptedLiabilities.push({ label: 'MATCH_PAYOUT_MAX', amount: matchPayoutCap });
                    }
                }

                if (balanceCritical === null) {
                    errors.push('BALANCE_CRITICAL must be an explicit positive PostgreSQL BIGINT atomic-unit reserve when payouts are enabled.');
                } else {
                    const uncovered = acceptedLiabilities
                        .filter(liability => balanceCritical < liability.amount)
                        .sort((left, right) => left.amount < right.amount ? 1 : -1);
                    if (uncovered.length > 0) {
                        const largest = uncovered[0];
                        errors.push(`BALANCE_CRITICAL must be at least ${largest.label} (${largest.amount} atomic units) so one accepted payout is always covered.`);
                    }
                }

                if (balanceWarn === null) {
                    errors.push('BALANCE_WARN must be an explicit positive PostgreSQL BIGINT atomic-unit warning threshold when payouts are enabled.');
                } else if (balanceCritical !== null && balanceWarn < balanceCritical) {
                    errors.push(`BALANCE_WARN must be greater than or equal to BALANCE_CRITICAL (${balanceCritical} atomic units).`);
                }
            }

            // Never let production advertise a multiplier outcome which settlement would cap or
            // suppress. Browser disclosures and immutable game terms must describe the same amount.
            const validateSoloOutcomes = (label, enabled, base, rule) => {
                if (!enabled) return;
                let baseAtomic;
                let minAtomic;
                let maxAtomic;
                try {
                    baseAtomic = money.toBig(base);
                    minAtomic = money.toBig(rule?.minPayout);
                    maxAtomic = money.toBig(rule?.maxPayout);
                } catch (_) {
                    errors.push(`${label} payout base/min/max must be exact atomic-unit integers.`);
                    return;
                }
                for (const [outcome, multiplier] of [
                    ['escape', rule?.multipliers?.escape],
                    ['escapeWithTreasure', rule?.multipliers?.escapeWithTreasure]
                ]) {
                    let amount;
                    try { amount = money.mulByDecimal(baseAtomic, multiplier); }
                    catch (_) {
                        errors.push(`${label} ${outcome} multiplier must be a non-negative decimal.`);
                        continue;
                    }
                    if (amount < minAtomic || amount <= 0n) {
                        errors.push(`${label} ${outcome} payout (${amount} atomic units) is below its configured minimum (${minAtomic}).`);
                    }
                    if (amount > maxAtomic) {
                        errors.push(`${label} ${outcome} payout (${amount} atomic units) exceeds its configured maximum (${maxAtomic}).`);
                    }
                }
            };
            validateSoloOutcomes(
                'Direct', directPayoutsEnabled,
                config?.modes?.direct?.price,
                config?.payouts?.rules?.direct
            );
            validateSoloOutcomes(
                'Credits', creditsPayoutsEnabled,
                config?.payouts?.rules?.credits?.baseValue,
                config?.payouts?.rules?.credits
            );

            if (!Object.prototype.hasOwnProperty.call(env, 'PAYMENTS_ENABLED') && !env.GAME_MODE) {
                errors.push('Production requires an explicit PAYMENTS_ENABLED=true|false setting.');
            }
            if (!Object.prototype.hasOwnProperty.call(env, 'PAYOUTS_ENABLED')) {
                errors.push('Production requires an explicit PAYOUTS_ENABLED=true|false setting.');
            }
            if (directEnabled && !Object.prototype.hasOwnProperty.call(env, 'DIRECT_PAYOUTS_ENABLED')) {
                errors.push('Production direct mode requires an explicit DIRECT_PAYOUTS_ENABLED=true|false setting.');
            }
            if (creditsEnabled
                && !Object.prototype.hasOwnProperty.call(env, 'CREDITS_PAYOUTS_ENABLED')
                && !Object.prototype.hasOwnProperty.call(env, 'CREDITS_PAYOUT_ENABLED')) {
                errors.push('Production credits mode requires an explicit CREDITS_PAYOUTS_ENABLED=true|false setting.');
            }

            const adminKey = String(env.ADMIN_API_KEY || '');
            if (adminKey.length < 32 || PLACEHOLDER_SECRET.test(adminKey) || new Set(adminKey).size < 8) {
                errors.push('ADMIN_API_KEY must be a strong non-placeholder secret of at least 32 characters in production.');
            }
            if (!env.DB_PASSWORD || PLACEHOLDER_SECRET.test(String(env.DB_PASSWORD))) {
                errors.push('DB_PASSWORD must be set to a non-placeholder value in production.');
            }

            const simulated = isTrue(env.SIMULATED_BLOCKS)
                || isTrue(env.FORCE_SIMULATED_BLOCKS)
                || String(env.BLOCK_SOURCE || '').toLowerCase() === 'simulated';
            if (simulated) {
                errors.push('Simulated blocks are forbidden when NODE_ENV=production.');
            }
            if (isTrue(env.DEBUG_HOTKEYS)) {
                errors.push('DEBUG_HOTKEYS must not be enabled in production.');
            }

            if (payoutMasterEnabled && network === 'mainnet' && !isTrue(env.ALLOW_MAINNET_PAYOUTS)) {
                errors.push('Mainnet payouts require the explicit safety acknowledgement ALLOW_MAINNET_PAYOUTS=true.');
            }
            if (network !== 'mainnet' && isTrue(env.SMIRK_ENABLED)) {
                warnings.push('SMIRK_ENABLED is ignored on test networks; set it false to keep operator intent clear.');
            }
            if (isTrue(env.TRUST_PROXY) === false) {
                warnings.push('TRUST_PROXY is not enabled; this is correct only when the Node process is directly exposed.');
            }
        }

        if (!paymentsEnabled) {
            this.logger.info?.('ℹ️ Payments disabled. Server will run in free mode.');
        }
        warnings.forEach(message => this.logger.warn?.(`⚠️ ${message}`));
        errors.forEach(message => this.logger.error?.(`❌ ${message}`));

        return {
            warnings,
            errors,
            production,
            money: {
                paymentsEnabled,
                payoutsEnabled: anyPayoutsEnabled,
                payoutWorkerEnabled: payoutMasterEnabled,
                walletRequired,
                directPayoutsEnabled,
                creditsPayoutsEnabled,
                matchPayoutsEnabled
            }
        };
    }

    assertValid(config) {
        const result = this.validate(config);
        if (result.errors.length > 0) {
            const error = new Error(`Invalid production configuration (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}).`);
            error.name = 'EnvironmentValidationError';
            error.code = 'INVALID_ENVIRONMENT';
            error.validation = result;
            throw error;
        }
        return result;
    }
}

module.exports = EnvironmentValidator;
