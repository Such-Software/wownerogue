/**
 * Payment Configuration Manager
 * Loads unified payment settings from defaults, environment variables, and (future) database overrides.
 */

const { EventEmitter } = require('events');
const { inferCurrencyDecimals } = require('../game/helpers/gameModeUtils');

const DEFAULT_CONFIG = Object.freeze({
    paymentsEnabled: true,
    currency: {
        symbol: 'WOW',
        decimals: 11,
        minPayment: 1000000000n, // 0.01 WOW in atomic units
        maxPayment: 100000000000000n // 1,000 WOW in atomic units
    },
    // Early entry allows free/credits mode players to start immediately without waiting for next block
    // Risk: If next block is found before they escape, they lose (timeout)
    earlyEntry: {
        enabled: true,           // Master toggle for early entry feature
        allowInFreeMode: true,   // Allow early entry in free mode
        allowInCreditsMode: true // Allow early entry when using credits
    },
    modes: {
        direct: {
            enabled: true,
            price: 100000000000n, // 1 WOW per game
            requiresAddress: true,
            allowGuestPlay: false
        },
        credits: {
            enabled: false,
            creditsPerGame: 1,
            requiresAddress: true,
            allowMixedMode: true,
            packages: [
                { id: 'small', credits: 10, price: 500000000000n, bonus: 0 },
                { id: 'medium', credits: 25, price: 1000000000000n, bonus: 2 },
                { id: 'large', credits: 100, price: 3500000000000n, bonus: 15 }
            ]
        }
    },
    payouts: {
        enabled: true,
        requiresKYC: false,
        rules: {
            direct: {
                enabled: true,
                multipliers: {
                    escape: 2.0,
                    escapeWithTreasure: 3.0,
                    perfectRun: 5.0
                },
                minPayout: 1000000000n,
                maxPayout: 10000000000000n
            },
            credits: {
                enabled: false,
                multipliers: {
                    escape: 2.0,
                    escapeWithTreasure: 3.0,
                    perfectRun: 3.0
                },
                baseValue: 100000000000n,
                minPayout: 1000000000n,
                maxPayout: 5000000000000n
            }
        },
        processing: {
            automatic: true,
            batchingEnabled: true,
            batchInterval: 300,
            confirmations: 1,
            maxRetries: 3
        }
    },
    promotions: {
        enabled: false,
        freeCredits: {
            onSignup: 0,
            onFirstPurchase: 0,
            referralBonus: 0
        },
        discounts: {
            enabled: false,
            bulkDiscount: 0,
            happyHour: null
        }
    },
    limits: {
        maxGamesPerHour: 60,
        maxPayoutsPerDay: 100,
        maxCreditPurchasePerDay: 100000000000000n,
        cooldownBetweenGames: 5
    },
    preferences: {
        allowMixedMode: true,
        preferCreditsFirst: true
    }
});

function cloneConfig(value) {
    if (Array.isArray(value)) {
        return value.map(cloneConfig);
    }
    if (value && typeof value === 'object' && !(value instanceof EventEmitter)) {
        return Object.entries(value).reduce((acc, [key, val]) => {
            acc[key] = cloneConfig(val);
            return acc;
        }, {});
    }
    return value;
}

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}

function parseInteger(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (Number.isInteger(value)) {
        return value;
    }
    const normalized = String(value).trim().toLowerCase().replace(/_/g, '');
    if (normalized === '') {
        return fallback;
    }
    const num = Number(normalized);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.trunc(num);
}

function parseAtomicValue(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'bigint') {
        return value;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return BigInt(Math.round(value));
    }

    const normalized = String(value).trim().toLowerCase().replace(/_/g, '');
    if (normalized === '') {
        return fallback;
    }

    if (normalized.startsWith('0x')) {
        try {
            return BigInt(normalized);
        } catch (error) {
            return fallback;
        }
    }

    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
        return BigInt(Math.round(numeric));
    }

    try {
        return BigInt(normalized);
    } catch (error) {
        return fallback;
    }
}

function parseFloatValue(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'number') {
        return value;
    }
    const normalized = String(value).trim();
    const num = Number(normalized);
    return Number.isFinite(num) ? num : fallback;
}

function safeParseJson(value, fallback) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

class PaymentConfigManager {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.eventBus = options.eventBus || new EventEmitter();
        this.persistenceAdapter = options.persistenceAdapter || null;
        this.config = this.loadConfig();
        this.validateConfig();
        this.legacyOverride = process.env.GAME_MODE || null;
    }

    loadConfig() {
        const config = cloneConfig(DEFAULT_CONFIG);

        config.paymentsEnabled = parseBoolean(process.env.PAYMENTS_ENABLED, config.paymentsEnabled);

        const gameModeOverride = process.env.GAME_MODE ? process.env.GAME_MODE.toUpperCase() : null;
        if (gameModeOverride === 'FREE') {
            config.paymentsEnabled = false;
            config.modes.direct.enabled = false;
            config.modes.credits.enabled = false;
        } else if (gameModeOverride === 'PAID_SINGLE') {
            config.paymentsEnabled = true;
            config.modes.direct.enabled = true;
            config.modes.credits.enabled = false;
        } else if (gameModeOverride === 'PAID_CREDITS') {
            config.paymentsEnabled = true;
            config.modes.direct.enabled = false;
            config.modes.credits.enabled = true;
        }

        if (process.env.PAYMENT_MODES) {
            const modes = process.env.PAYMENT_MODES.split(',').map(m => m.trim().toLowerCase()).filter(Boolean);
            config.modes.direct.enabled = modes.includes('direct');
            config.modes.credits.enabled = modes.includes('credits');
            config.paymentsEnabled = config.modes.direct.enabled || config.modes.credits.enabled;
        }

        config.currency.symbol = process.env.CRYPTO_TYPE || config.currency.symbol;
        // Derive decimals from the currency (XMR=12, WOW=11) so display divisors match the
        // chain. Previously decimals stayed at the WOW default (11) even for XMR, making all
        // XMR amounts display 10x too large. An explicit CURRENCY_DECIMALS env still wins.
        config.currency.decimals = process.env.CURRENCY_DECIMALS
            ? parseInt(process.env.CURRENCY_DECIMALS, 10)
            : inferCurrencyDecimals(config.currency.symbol);
        config.currency.minPayment = parseAtomicValue(process.env.PAYOUT_MIN_AMOUNT, config.currency.minPayment);
        config.currency.maxPayment = parseAtomicValue(process.env.MAX_CREDIT_PURCHASE_PER_DAY, config.currency.maxPayment);

        const directPriceEnv = process.env.DIRECT_GAME_PRICE ?? process.env.SINGLE_GAME_PRICE;
        config.modes.direct.price = parseAtomicValue(directPriceEnv, config.modes.direct.price);
        config.modes.direct.enabled = parseBoolean(process.env.DIRECT_PAYMENT_ENABLED, config.modes.direct.enabled);
        config.modes.direct.requiresAddress = parseBoolean(process.env.DIRECT_REQUIRES_ADDRESS, config.modes.direct.requiresAddress);
        config.modes.direct.allowGuestPlay = parseBoolean(process.env.DIRECT_ALLOW_GUEST_PLAY, config.modes.direct.allowGuestPlay);

        const creditsEnabled = parseBoolean(process.env.CREDITS_ENABLED, undefined);
        if (creditsEnabled !== undefined) {
            config.modes.credits.enabled = creditsEnabled;
        }
        config.modes.credits.creditsPerGame = parseInteger(process.env.CREDITS_PER_GAME, config.modes.credits.creditsPerGame);
        config.modes.credits.requiresAddress = parseBoolean(process.env.CREDITS_REQUIRES_ADDRESS, config.modes.credits.requiresAddress);
        config.modes.credits.allowMixedMode = parseBoolean(process.env.ALLOW_MIXED_MODE, config.modes.credits.allowMixedMode);

        const packageJson = safeParseJson(process.env.CREDITS_PACKAGES, null);
        if (Array.isArray(packageJson) && packageJson.length > 0) {
            config.modes.credits.packages = packageJson.map(pkg => ({
                id: pkg.id,
                credits: parseInteger(pkg.credits, 0),
                price: parseAtomicValue(pkg.price, 0n),
                bonus: parseInteger(pkg.bonus || 0, 0)
            })).filter(pkg => pkg.id);
        } else if (process.env.CREDITS_PACKAGE_PRICE) {
            const overridePrice = parseAtomicValue(process.env.CREDITS_PACKAGE_PRICE, null);
            if (overridePrice !== null) {
                config.modes.credits.packages = config.modes.credits.packages.map((pkg, index) =>
                    index === 0 ? { ...pkg, price: overridePrice } : pkg
                );
            }
        }

        config.payouts.enabled = parseBoolean(process.env.PAYOUTS_ENABLED, config.payouts.enabled);
        config.payouts.rules.direct.enabled = parseBoolean(process.env.DIRECT_PAYOUTS_ENABLED, config.payouts.rules.direct.enabled);
        config.payouts.rules.direct.multipliers.escape = parseFloatValue(process.env.DIRECT_PAYOUT_ESCAPE, config.payouts.rules.direct.multipliers.escape);
        config.payouts.rules.direct.multipliers.escapeWithTreasure = parseFloatValue(process.env.DIRECT_PAYOUT_TREASURE, config.payouts.rules.direct.multipliers.escapeWithTreasure);
        config.payouts.rules.direct.minPayout = parseAtomicValue(process.env.PAYOUT_MIN_AMOUNT, config.payouts.rules.direct.minPayout);
        config.payouts.rules.direct.maxPayout = parseAtomicValue(process.env.PAYOUT_MAX_PER_GAME, config.payouts.rules.direct.maxPayout);

        const creditsPayoutEnabled = parseBoolean(process.env.CREDITS_PAYOUTS_ENABLED ?? process.env.CREDITS_PAYOUT_ENABLED, undefined);
        if (creditsPayoutEnabled !== undefined) {
            config.payouts.rules.credits.enabled = creditsPayoutEnabled;
        }
        config.payouts.rules.credits.multipliers.escape = parseFloatValue(process.env.CREDITS_PAYOUT_ESCAPE, config.payouts.rules.credits.multipliers.escape);
        config.payouts.rules.credits.multipliers.escapeWithTreasure = parseFloatValue(process.env.CREDITS_PAYOUT_TREASURE, config.payouts.rules.credits.multipliers.escapeWithTreasure);
        config.payouts.rules.credits.baseValue = parseAtomicValue(process.env.CREDITS_PAYOUT_BASE, config.payouts.rules.credits.baseValue);

        config.payouts.processing.batchInterval = parseInteger(process.env.PAYOUT_BATCH_INTERVAL, config.payouts.processing.batchInterval);
        config.payouts.processing.maxRetries = parseInteger(process.env.PAYOUT_MAX_RETRIES, config.payouts.processing.maxRetries);

        config.limits.maxGamesPerHour = parseInteger(process.env.MAX_GAMES_PER_HOUR, config.limits.maxGamesPerHour);
        config.limits.maxPayoutsPerDay = parseInteger(process.env.MAX_PAYOUTS_PER_DAY, config.limits.maxPayoutsPerDay);
        config.limits.maxCreditPurchasePerDay = parseAtomicValue(process.env.MAX_CREDIT_PURCHASE_PER_DAY, config.limits.maxCreditPurchasePerDay);
        config.limits.cooldownBetweenGames = parseInteger(process.env.GAME_COOLDOWN_SECONDS, config.limits.cooldownBetweenGames);

        config.preferences.allowMixedMode = config.modes.credits.allowMixedMode;
        config.preferences.preferCreditsFirst = parseBoolean(process.env.PREFER_CREDITS_FIRST, config.preferences.preferCreditsFirst);

        config.earlyEntry.enabled = parseBoolean(process.env.EARLY_ENTRY_ENABLED, config.earlyEntry.enabled);
        config.earlyEntry.allowInFreeMode = parseBoolean(process.env.EARLY_ENTRY_FREE_MODE, config.earlyEntry.allowInFreeMode);
        config.earlyEntry.allowInCreditsMode = parseBoolean(process.env.EARLY_ENTRY_CREDITS_MODE, config.earlyEntry.allowInCreditsMode);

        return config;
    }

    getConfig() {
        return cloneConfig(this.config);
    }

    getLegacyGameMode() {
        if (!this.config.paymentsEnabled) {
            return 'FREE';
        }
        if (this.legacyOverride) {
            return this.legacyOverride.toUpperCase();
        }
        const directEnabled = !!this.config.modes.direct.enabled;
        const creditsEnabled = !!this.config.modes.credits.enabled;
        if (directEnabled && !creditsEnabled) {
            return 'PAID_SINGLE';
        }
        if (!directEnabled && creditsEnabled) {
            return 'PAID_CREDITS';
        }
        if (!directEnabled && !creditsEnabled) {
            return 'FREE';
        }
        return this.config.preferences.preferCreditsFirst ? 'PAID_CREDITS' : 'PAID_SINGLE';
    }

    isModeEnabled(mode) {
        return Boolean(this.config.modes[mode]?.enabled);
    }

    validateConfig() {
        const directEnabled = this.config.modes.direct.enabled;
        const creditsEnabled = this.config.modes.credits.enabled;

        if (!this.config.paymentsEnabled && (directEnabled || creditsEnabled)) {
            this.logger.warn?.('⚠️ paymentsEnabled is false but some payment modes are enabled. Payments will remain disabled.');
        }

        if (!directEnabled && !creditsEnabled && this.config.paymentsEnabled) {
            this.logger.warn?.('⚠️ Payments enabled but no payment modes active. Falling back to FREE mode.');
        }

        this.validatePrices();
        return true;
    }

    validatePrices() {
        const { direct, credits } = this.config.modes;
        if (direct.enabled && direct.price <= 0n) {
            throw new Error('Direct game price must be a positive value');
        }
        if (credits.enabled) {
            for (const pkg of credits.packages) {
                if (!pkg.id) {
                    throw new Error('Each credit package requires an id');
                }
                if (pkg.price <= 0n) {
                    throw new Error(`Credit package ${pkg.id} has invalid price`);
                }
                if (pkg.credits <= 0) {
                    throw new Error(`Credit package ${pkg.id} has invalid credit count`);
                }
            }
        }
    }

    async updateConfig(updates) {
        const newConfig = cloneConfig(this.config);
        Object.keys(updates || {}).forEach(key => {
            newConfig[key] = updates[key];
        });

        const testManager = new PaymentConfigManager({
            logger: this.logger,
            eventBus: this.eventBus,
            persistenceAdapter: this.persistenceAdapter
        });
        testManager.config = cloneConfig(newConfig);
        testManager.validateConfig();

        this.config = newConfig;
        if (this.persistenceAdapter && typeof this.persistenceAdapter.save === 'function') {
            await this.persistenceAdapter.save(newConfig);
        }
        this.broadcastConfigUpdate();
        return this.getConfig();
    }

    refresh() {
        this.config = this.loadConfig();
        this.validateConfig();
        this.broadcastConfigUpdate();
        return this.getConfig();
    }

    broadcastConfigUpdate() {
        if (this.eventBus && typeof this.eventBus.emit === 'function') {
            this.eventBus.emit('paymentConfig:update', this.getConfig());
        }
    }

    setPersistenceAdapter(adapter) {
        this.persistenceAdapter = adapter;
    }

    setEventBus(eventBus) {
        this.eventBus = eventBus;
    }

    summarize() {
        return {
            paymentsEnabled: this.config.paymentsEnabled,
            legacyMode: this.getLegacyGameMode(),
            directEnabled: this.config.modes.direct.enabled,
            creditsEnabled: this.config.modes.credits.enabled,
            directPrice: this.config.modes.direct.price,
            creditPackages: this.config.modes.credits.packages.length
        };
    }
}

PaymentConfigManager.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = PaymentConfigManager;
