/**
 * Game Mode Manager
 * Handles different game modes (FREE, PAID_SINGLE, PAID_CREDITS)
 */

const {
    DEFAULT_DECIMALS,
    parseAtomicEnvValue,
    inferCurrencyDecimals: inferCurrencyDecimalsForSymbol,
    formatAtomic,
    formatAtomicHuman,
    getDecimalDivisor
} = require('./helpers/gameModeUtils');
const { ValidationError, normalizeError } = require('../utils/errors');

const DEFAULT_SINGLE_GAME_PRICE = 5000000000;   // 0.005 XMR or 0.05 WOW depending on currency decimals
const DEFAULT_CREDITS_PACKAGE_PRICE = 50000000000;

class GameModeManager {
    constructor(databaseManager, walletRPCService, debugManager, paymentConfigManager = null) {
        this.db = databaseManager;
        this.walletService = walletRPCService; // Changed from moneroPayService
        this.debugManager = debugManager;
        this.paymentConfigManager = paymentConfigManager || null;

        this.cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
        
        // Network configuration (mainnet/stagenet/testnet) - only applies to Monero
        // Wownero only has mainnet, so this is ignored for WOW
        this.network = (process.env.MONERO_NETWORK || 'mainnet').toLowerCase();
        this.isTestNetwork = this.network === 'stagenet' || this.network === 'testnet';
        
        this.singleGamePrice = DEFAULT_SINGLE_GAME_PRICE;
        this.creditsPackagePrice = DEFAULT_CREDITS_PACKAGE_PRICE;
        this.creditsPayoutEnabled = false;
        this.creditsPayoutBaseValue = DEFAULT_SINGLE_GAME_PRICE;
        this.directPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
        this.creditPayoutMultipliers = { escape: 2, escapeWithTreasure: 3 };
        this.creditsPerGameCost = 1;
        this.preferCreditsFirst = true;
        this.paymentsEnabled = false;
        this.directModeEnabled = false;
        this.creditsModeEnabled = false;
        this.configSnapshot = null;

        this.applyLegacyEnvConfig();

        if (this.paymentConfigManager) {
            const config = this.paymentConfigManager.getConfig();
            this.applyConfigSnapshot(config, { emitLog: false });
            this.setLegacyGameMode(this.paymentConfigManager.getLegacyGameMode());

            if (this.paymentConfigManager.eventBus && typeof this.paymentConfigManager.eventBus.on === 'function') {
                this.paymentConfigManager.eventBus.on('paymentConfig:update', (updatedConfig) => {
                    this.applyConfigSnapshot(updatedConfig, { emitLog: true, context: 'updated' });
                    this.setLegacyGameMode(this.paymentConfigManager.getLegacyGameMode());
                });
            }
        }

        this.logConfiguration('initialized');
    }

    inferCurrencyDecimals(symbol) {
        return inferCurrencyDecimalsForSymbol(symbol);
    }

    applyLegacyEnvConfig() {
        this.setLegacyGameMode(process.env.GAME_MODE || 'FREE');
        this.cryptoType = process.env.CRYPTO_TYPE || this.cryptoType;
        this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
        // Support both DIRECT_GAME_PRICE and legacy SINGLE_GAME_PRICE
        this.singleGamePrice = parseAtomicEnvValue(process.env.DIRECT_GAME_PRICE || process.env.SINGLE_GAME_PRICE, this.singleGamePrice);
        this.creditsPackagePrice = parseAtomicEnvValue(process.env.CREDITS_PACKAGE_PRICE, this.creditsPackagePrice);
        this.creditsPerGameCost = parseAtomicEnvValue(process.env.CREDITS_PER_GAME, 1) || 1;
        this.creditsPayoutEnabled = /^true$/i.test(process.env.CREDITS_PAYOUTS_ENABLED || process.env.CREDITS_PAYOUT_ENABLED || 'false');
        this.creditsPayoutBaseValue = parseAtomicEnvValue(process.env.CREDITS_PAYOUT_BASE, this.singleGamePrice);
        process.env.CREDITS_PER_GAME = String(this.creditsPerGameCost);

        const directEscape = Number(process.env.DIRECT_PAYOUT_ESCAPE);
        if (Number.isFinite(directEscape) && directEscape > 0) {
            this.directPayoutMultipliers.escape = directEscape;
        }
        const directTreasure = Number(process.env.DIRECT_PAYOUT_TREASURE);
        if (Number.isFinite(directTreasure) && directTreasure > 0) {
            this.directPayoutMultipliers.escapeWithTreasure = directTreasure;
        }
        const creditsEscape = Number(process.env.CREDITS_PAYOUT_ESCAPE);
        if (Number.isFinite(creditsEscape) && creditsEscape > 0) {
            this.creditPayoutMultipliers.escape = creditsEscape;
        }
        const creditsTreasure = Number(process.env.CREDITS_PAYOUT_TREASURE);
        if (Number.isFinite(creditsTreasure) && creditsTreasure > 0) {
            this.creditPayoutMultipliers.escapeWithTreasure = creditsTreasure;
        }

        if (process.env.PREFER_CREDITS_FIRST) {
            this.preferCreditsFirst = /^true$/i.test(process.env.PREFER_CREDITS_FIRST);
        }

        this.paymentsEnabled = this.gameMode !== 'FREE';
        this.directModeEnabled = this.gameMode === 'PAID_SINGLE';
        this.creditsModeEnabled = this.gameMode === 'PAID_CREDITS';
    }

    applyConfigSnapshot(config, options = {}) {
        if (!config || typeof config !== 'object') {
            return;
        }

        this.configSnapshot = config;
        this.paymentsEnabled = !!config.paymentsEnabled;

        if (config.currency) {
            if (config.currency.symbol) {
                this.cryptoType = config.currency.symbol;
            }
            if (config.currency.decimals !== undefined) {
                this.currencyDecimals = Number(config.currency.decimals);
            } else {
                this.currencyDecimals = this.inferCurrencyDecimals(this.cryptoType);
            }
        }

        if (config.modes && config.modes.direct) {
            const { price, enabled } = config.modes.direct;
            if (price !== undefined && price !== null) {
                this.singleGamePrice = Number(price);
            }
            this.directModeEnabled = !!enabled;
        }

        if (config.modes && config.modes.credits) {
            const creditsMode = config.modes.credits;
            if (creditsMode.packages && creditsMode.packages.length > 0) {
                const primaryPackage = creditsMode.packages[0];
                if (primaryPackage.price !== undefined && primaryPackage.price !== null) {
                    this.creditsPackagePrice = Number(primaryPackage.price);
                }
                if (primaryPackage.credits) {
                    process.env.CREDITS_PER_PACKAGE = String(primaryPackage.credits);
                }
            }
            if (creditsMode.creditsPerGame !== undefined) {
                this.creditsPerGameCost = Number(creditsMode.creditsPerGame) || 1;
            }
            this.creditsModeEnabled = !!creditsMode.enabled;
        }

        if (config.payouts && config.payouts.rules) {
            const directRule = config.payouts.rules.direct || {};
            const creditsRule = config.payouts.rules.credits || {};

            if (directRule.multipliers) {
                if (directRule.multipliers.escape !== undefined) {
                    this.directPayoutMultipliers.escape = Number(directRule.multipliers.escape);
                }
                if (directRule.multipliers.escapeWithTreasure !== undefined) {
                    this.directPayoutMultipliers.escapeWithTreasure = Number(directRule.multipliers.escapeWithTreasure);
                }
            }

            if (creditsRule.multipliers) {
                if (creditsRule.multipliers.escape !== undefined) {
                    this.creditPayoutMultipliers.escape = Number(creditsRule.multipliers.escape);
                }
                if (creditsRule.multipliers.escapeWithTreasure !== undefined) {
                    this.creditPayoutMultipliers.escapeWithTreasure = Number(creditsRule.multipliers.escapeWithTreasure);
                }
            }

            if (creditsRule.baseValue !== undefined) {
                this.creditsPayoutBaseValue = Number(creditsRule.baseValue);
            }

            if (creditsRule.enabled !== undefined) {
                this.creditsPayoutEnabled = !!creditsRule.enabled;
            }
        }

        if (config.preferences) {
            if (config.preferences.preferCreditsFirst !== undefined) {
                this.preferCreditsFirst = !!config.preferences.preferCreditsFirst;
            }
        }

        process.env.SINGLE_GAME_PRICE = String(this.singleGamePrice);
        process.env.CREDITS_PACKAGE_PRICE = String(this.creditsPackagePrice);
        process.env.CREDITS_PER_GAME = String(this.creditsPerGameCost);
        process.env.CREDITS_PAYOUT_ENABLED = this.creditsPayoutEnabled ? 'true' : 'false';
        process.env.CREDITS_PAYOUTS_ENABLED = process.env.CREDITS_PAYOUT_ENABLED;

        if (options.emitLog) {
            this.logConfiguration(options.context || 'updated');
        }
    }

    setLegacyGameMode(mode) {
        this.gameMode = (mode || 'FREE').toUpperCase();
        process.env.GAME_MODE = this.gameMode;
    }

    formatAtomic(value) {
        return formatAtomic({
            value,
            decimals: Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS
        });
    }

    getDecimalDivisor() {
        return getDecimalDivisor(Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS);
    }

    formatAtomicHuman(value, digits = 3) {
        return formatAtomicHuman({
            value,
            decimals: Number.isFinite(this.currencyDecimals) ? this.currencyDecimals : DEFAULT_DECIMALS,
            digits
        });
    }

    getPrimaryCreditPackage() {
        const packages = this.configSnapshot?.modes?.credits?.packages;
        if (Array.isArray(packages) && packages.length > 0) {
            return packages[0];
        }
        return {
            id: 'default',
            credits: 10,
            price: this.creditsPackagePrice,
            bonus: 0
        };
    }

    calculatePayout(mode, { treasureFound = false } = {}) {
        const normalizedMode = (mode || this.gameMode || 'FREE').toUpperCase();
        const usingCredits = normalizedMode === 'PAID_CREDITS';
        const base = usingCredits ? (this.creditsPayoutBaseValue || this.singleGamePrice) : this.singleGamePrice;
        const multipliers = usingCredits ? this.creditPayoutMultipliers : this.directPayoutMultipliers;
        const multiplier = treasureFound
            ? (multipliers.escapeWithTreasure ?? multipliers.escape ?? 0)
            : (multipliers.escape ?? 0);

        const amount = Math.round(base * multiplier);
        
        console.log(`🧮 calculatePayout: mode=${normalizedMode}, usingCredits=${usingCredits}, treasureFound=${treasureFound}`);
        console.log(`   base=${base}, multipliers=${JSON.stringify(multipliers)}, chosen multiplier=${multiplier}`);
        console.log(`   final amount=${amount} (base * multiplier = ${base} * ${multiplier})`);
        
        return { amount, multiplier, base };
    }

    /**
     * Process a confirmed credits package payment - add credits to user
     * @param {string} socketId - Socket ID of the user
     * @param {number} paymentId - Payment record ID
     * @param {object} packageInfo - Package info (credits, bonus, etc.)
     * @returns {object} Result with success, creditsAdded, newBalance
     */
    async processCreditsPackageConfirmation(socketId, paymentId, packageInfo = null) {
        try {
            const user = await this.getOrCreateUser(socketId);
            
            // Determine credits to add from package or fallback
            let creditsToAdd = 10; // Default fallback
            if (packageInfo && packageInfo.credits) {
                creditsToAdd = Number(packageInfo.credits) + (Number(packageInfo.bonus) || 0);
            } else {
                // Try to get from payment record description
                const paymentResult = await this.db.query(`
                    SELECT description FROM payments WHERE id = $1
                `, [paymentId]);
                if (paymentResult.rows.length > 0) {
                    const desc = paymentResult.rows[0].description || '';
                    const match = desc.match(/(\d+)\s*credits?/i);
                    if (match) {
                        creditsToAdd = parseInt(match[1], 10) || 10;
                    }
                }
            }

            // Update user credits
            const updateResult = await this.db.query(`
                UPDATE users 
                SET credits = credits + $1,
                    total_credits_purchased = COALESCE(total_credits_purchased, 0) + $1,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING credits
            `, [creditsToAdd, user.id]);

            const newBalance = updateResult.rows[0]?.credits ?? (user.credits + creditsToAdd);

            // Mark payment as processed
            await this.db.query(`
                UPDATE payments 
                SET status = 'confirmed',
                    credits_purchased = $1,
                    confirmed_at = NOW()
                WHERE id = $2
            `, [creditsToAdd, paymentId]);

            // Record credit transaction
            await this.db.query(`
                INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
                VALUES ($1, $2, 'package_purchase', $3, 'purchase')
            `, [user.id, creditsToAdd, newBalance]);

            console.log(`💰 Credits package confirmed: +${creditsToAdd} credits for user ${user.id}, new balance: ${newBalance}`);

            return {
                success: true,
                creditsAdded: creditsToAdd,
                newBalance: newBalance
            };
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process credits package confirmation');
            console.error('❌ Error processing credits package:', normalized.message);
            return {
                success: false,
                reason: normalized.safeMessage
            };
        }
    }

    async _findReusablePayment(userId, paymentType) {
        if (!userId) return null;
        const result = await this.db.query(`
            SELECT id, subaddress, expected_amount, payment_type, status, created_at, expires_at, description
            FROM payments
            WHERE user_id = $1
              AND payment_type = $2
              AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY created_at DESC
            LIMIT 1
        `, [userId, paymentType]);
        return result.rows[0] || null;
    }

    /**
     * Convert package info to JSON-safe format (BigInt price -> Number)
     */
    _serializePackageInfo(packageInfo) {
        if (!packageInfo) return null;
        return {
            ...packageInfo,
            price: typeof packageInfo.price === 'bigint' ? Number(packageInfo.price) : packageInfo.price
        };
    }

    _mapPaymentRowToRequest(row, paymentType, packageInfo) {
        if (!row) return null;
        const amount = Number(row.expected_amount);
        return {
            id: row.id,
            address: row.subaddress,
            amount,
            amountFormatted: this.formatAtomicHuman(amount, 4),
            currency: this.cryptoType,
            expiresAt: row.expires_at,
            paymentType,
            description: row.description,
            package: this._serializePackageInfo(packageInfo),
            reused: true
        };
    }

    logConfiguration(context = 'initialized') {
        console.log(`🎮 Game Mode Manager ${context}: ${this.gameMode} mode`);
        console.log(`💰 Currency: ${this.cryptoType} (decimals: ${this.currencyDecimals})`);
        console.log(`💵 Single game price: ${this.singleGamePrice} atomic units (~${this.formatAtomic(this.singleGamePrice)} ${this.cryptoType})`);
        console.log(`💵 Credits payout base: ${this.creditsPayoutBaseValue} atomic units (~${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        console.log(`🎫 Credits package price: ${this.creditsPackagePrice} atomic units (~${this.formatAtomic(this.creditsPackagePrice)} ${this.cryptoType})`);
        console.log(`🎯 Credits per game cost: ${this.creditsPerGameCost}`);
        console.log(`🧮 Payout multipliers - direct: ${JSON.stringify(this.directPayoutMultipliers)}, credits: ${JSON.stringify(this.creditPayoutMultipliers)}`);
        console.log(`🔁 Mode availability - direct: ${this.directModeEnabled}, credits: ${this.creditsModeEnabled}, preferCreditsFirst: ${this.preferCreditsFirst}`);
        if (this.creditsPayoutEnabled) {
            console.log(`🎁 Credits payout mode ENABLED - base value: ${this.creditsPayoutBaseValue} atomic (~${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        }
        console.log(`⚙️ Payments enabled: ${this.paymentsEnabled}`);
    }

    /**
     * Get effective game mode for a specific user, considering:
     * - Whether both modes are enabled (mixed mode)
     * - User's credit balance
     * - preferCreditsFirst setting
     * @param {object} user - User object with credits field
     * @returns {object} { mode, canUseCredits, canUseDirect, hasCredits, creditsBalance }
     */
    getEffectiveModeForUser(user) {
        const hasCredits = (user?.credits || 0) >= this.creditsPerGameCost;
        const bothModesEnabled = this.directModeEnabled && this.creditsModeEnabled;
        
        // Determine available options
        const canUseCredits = this.creditsModeEnabled && hasCredits;
        const canUseDirect = this.directModeEnabled;
        
        // Determine effective mode
        let effectiveMode;
        if (!this.paymentsEnabled) {
            effectiveMode = 'FREE';
        } else if (bothModesEnabled) {
            // Mixed mode: prefer based on config and availability
            if (this.preferCreditsFirst && hasCredits) {
                effectiveMode = 'PAID_CREDITS';
            } else if (hasCredits) {
                effectiveMode = 'PAID_CREDITS'; // Has credits, can use them
            } else {
                effectiveMode = 'PAID_SINGLE'; // No credits, must pay
            }
        } else if (this.creditsModeEnabled) {
            effectiveMode = 'PAID_CREDITS';
        } else if (this.directModeEnabled) {
            effectiveMode = 'PAID_SINGLE';
        } else {
            effectiveMode = 'FREE';
        }
        
        return {
            mode: effectiveMode,
            canUseCredits,
            canUseDirect,
            hasCredits,
            creditsBalance: user?.credits || 0,
            creditsRequired: this.creditsPerGameCost,
            bothModesEnabled,
            preferCreditsFirst: this.preferCreditsFirst,
            creditsPayoutsEnabled: this.creditsPayoutEnabled,
            directPayoutsEnabled: this.directPayoutMultipliers.escape > 0
        };
    }

    /**
     * Get available payment options for a user
     * @param {string} socketId - Socket ID
     * @returns {object} Available options for the user
     */
    async getPaymentOptionsForUser(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const effective = this.getEffectiveModeForUser(user);
            
            const options = [];
            
            if (effective.canUseCredits) {
                options.push({
                    type: 'use_credit',
                    label: `Use 1 Credit (${effective.creditsBalance} available)`,
                    mode: 'PAID_CREDITS',
                    cost: 0,
                    costDisplay: '1 credit',
                    payoutEligible: effective.creditsPayoutsEnabled,
                    recommended: effective.preferCreditsFirst
                });
            }
            
            if (effective.canUseDirect) {
                options.push({
                    type: 'pay_direct',
                    label: `Pay ${this.formatAtomicHuman(this.singleGamePrice, 2)} ${this.cryptoType}`,
                    mode: 'PAID_SINGLE',
                    cost: this.singleGamePrice,
                    costDisplay: `${this.formatAtomicHuman(this.singleGamePrice, 2)} ${this.cryptoType}`,
                    payoutEligible: effective.directPayoutsEnabled,
                    recommended: !effective.preferCreditsFirst || !effective.hasCredits
                });
            }
            
            if (this.creditsModeEnabled) {
                const pkg = this.getPrimaryCreditPackage();
                options.push({
                    type: 'buy_credits',
                    label: `Buy ${pkg.credits} Credits`,
                    mode: 'PURCHASE',
                    cost: Number(pkg.price),
                    costDisplay: `${this.formatAtomicHuman(pkg.price, 2)} ${this.cryptoType}`,
                    credits: pkg.credits + (pkg.bonus || 0),
                    payoutEligible: false,
                    recommended: false
                });
            }
            
            return {
                user: {
                    credits: effective.creditsBalance,
                    hasPayoutAddress: !!user.payout_address
                },
                effective,
                options
            };
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to get payment options');
            console.error('❌ Error getting payment options:', normalized.message);
            return {
                user: { credits: 0, hasPayoutAddress: false },
                effective: { mode: 'FREE' },
                options: []
            };
        }
    }

    /**
     * Check if user can start a game
     */
    async canUserStartGame(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const effective = this.getEffectiveModeForUser(user);
            
            // FREE mode or payments disabled
            if (effective.mode === 'FREE') {
                return { allowed: true, reason: 'Free mode' };
            }
            
            // Mixed mode: check if user can play with credits OR has confirmed payment
            if (effective.bothModesEnabled) {
                // Option 1: User has credits
                if (effective.hasCredits) {
                    return {
                        allowed: true,
                        reason: `${effective.creditsBalance} credits available`,
                        useCredits: true,
                        creditsRequired: this.creditsPerGameCost,
                        balance: effective.creditsBalance,
                        effectiveMode: 'PAID_CREDITS'
                    };
                }
                
                // Option 2: User has confirmed single_game payment
                const pendingPayment = await this.db.query(`
                    SELECT * FROM payments 
                    WHERE socket_id = $1 AND status = 'confirmed' 
                    AND payment_type = 'single_game'
                    AND NOT EXISTS (
                        SELECT 1 FROM games 
                        WHERE games.payment_id = payments.id
                    )
                    ORDER BY confirmed_at DESC 
                    LIMIT 1
                `, [socketId]);
                
                if (pendingPayment.rows.length > 0) {
                    return { 
                        allowed: true, 
                        reason: 'Payment confirmed',
                        paymentId: pendingPayment.rows[0].id,
                        effectiveMode: 'PAID_SINGLE'
                    };
                }
                
                // Neither credits nor payment available
                return { 
                    allowed: false, 
                    reason: 'Payment or credits required',
                    action: 'choose_payment',
                    options: await this.getPaymentOptionsForUser(socketId)
                };
            }
            
            // Single mode logic (backwards compatible)
            switch (effective.mode) {
                case 'PAID_CREDITS':
                    if (effective.hasCredits) {
                        return {
                            allowed: true,
                            reason: `${effective.creditsBalance} credits remaining`,
                            creditsRequired: this.creditsPerGameCost,
                            effectiveMode: 'PAID_CREDITS'
                        };
                    }
                    return { 
                        allowed: false, 
                        reason: 'Insufficient credits',
                        action: 'purchase_credits',
                        creditsRequired: this.creditsPerGameCost,
                        balance: effective.creditsBalance
                    };
                    
                case 'PAID_SINGLE':
                    const payment = await this.db.query(`
                        SELECT * FROM payments 
                        WHERE socket_id = $1 AND status = 'confirmed' 
                        AND payment_type = 'single_game'
                        AND NOT EXISTS (
                            SELECT 1 FROM games 
                            WHERE games.payment_id = payments.id
                        )
                        ORDER BY confirmed_at DESC 
                        LIMIT 1
                    `, [socketId]);
                    
                    if (payment.rows.length > 0) {
                        return { 
                            allowed: true, 
                            reason: 'Payment confirmed',
                            paymentId: payment.rows[0].id,
                            effectiveMode: 'PAID_SINGLE'
                        };
                    }
                    
                    return { 
                        allowed: false, 
                        reason: 'Payment required',
                        action: 'make_payment'
                    };
                    
                default:
                    return { allowed: false, reason: 'Invalid game mode' };
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Unable to verify game eligibility');
            console.error('❌ Error checking user game eligibility:', normalized.message);
            return { allowed: false, reason: normalized.safeMessage };
        }
    }

    /**
     * Process game start (deduct credits or link payment)
     */
    async processGameStart(socketId, gameId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const effective = this.getEffectiveModeForUser(user);
            
            // FREE mode
            if (effective.mode === 'FREE') {
                return { success: true, effectiveMode: 'FREE' };
            }
            
            // Mixed mode: determine which method to use
            if (effective.bothModesEnabled) {
                // Prefer credits if available and preferCreditsFirst is true
                if (effective.hasCredits && this.preferCreditsFirst) {
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                }
                
                // Check for confirmed direct payment
                const payment = await this.db.query(`
                    SELECT * FROM payments 
                    WHERE socket_id = $1 AND status = 'confirmed' 
                    AND payment_type = 'single_game'
                    AND NOT EXISTS (
                        SELECT 1 FROM games 
                        WHERE games.payment_id = payments.id
                    )
                    ORDER BY confirmed_at DESC 
                    LIMIT 1
                `, [socketId]);
                
                if (payment.rows.length > 0) {
                    return await this._processGameStartWithPayment(user, payment.rows[0], gameId);
                }
                
                // Fall back to credits if available
                if (effective.hasCredits) {
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                }
                
                return { success: false, reason: 'No valid payment or credits found' };
            }
            
            // Single mode logic
            switch (effective.mode) {
                case 'PAID_CREDITS':
                    return await this._processGameStartWithCredits(user, socketId, gameId);
                    
                case 'PAID_SINGLE':
                    const payment = await this.db.query(`
                        SELECT * FROM payments 
                        WHERE socket_id = $1 AND status = 'confirmed' 
                        AND payment_type = 'single_game'
                        AND NOT EXISTS (
                            SELECT 1 FROM games 
                            WHERE games.payment_id = payments.id
                        )
                        ORDER BY confirmed_at DESC 
                        LIMIT 1
                    `, [socketId]);
                    
                    if (payment.rows.length === 0) {
                        return { success: false, reason: 'No valid payment found' };
                    }
                    
                    return await this._processGameStartWithPayment(user, payment.rows[0], gameId);
                    
                default:
                    return { success: false, reason: 'Invalid game mode' };
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process game start');
            console.error('❌ Error processing game start:', normalized.message);
            return { success: false, reason: normalized.safeMessage };
        }
    }

    async _processGameStartWithCredits(user, socketId, gameId) {
        const creditsToSpend = this.creditsPerGameCost;
        const updateRes = await this.db.query(`
            UPDATE users 
            SET credits = credits - $1,
                total_games_played = total_games_played + 1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING credits
        `, [creditsToSpend, user.id]);
        const remainingCredits = updateRes.rows[0] ? updateRes.rows[0].credits : (user.credits - creditsToSpend);
        
        // Record the game mode used
        await this.db.query(`
            UPDATE games SET payment_mode = 'credits' WHERE id = $1
        `, [gameId]);
        
        // Record credit transaction
        await this.db.query(`
            INSERT INTO credit_transactions (user_id, amount, reason, balance_after, transaction_type)
            VALUES ($1, $2, 'game_entry', $3, 'spend')
        `, [user.id, -creditsToSpend, remainingCredits]);
        
        // Emit credits update
        try { this.io && this.io.to(socketId).emit('credits_update', { balance: remainingCredits }); } catch(_) {}
        console.log(`🎫 Deducted ${creditsToSpend} credit(s) from user ${user.id}, ${remainingCredits} remaining`);
        
        return { 
            success: true, 
            creditsRemaining: remainingCredits, 
            creditsSpent: creditsToSpend,
            effectiveMode: 'PAID_CREDITS'
        };
    }

    async _processGameStartWithPayment(user, payment, gameId) {
        await this.db.query(`
            UPDATE games 
            SET payment_id = $1, payment_mode = 'direct'
            WHERE id = $2
        `, [payment.id, gameId]);
        
        await this.db.query(`
            UPDATE users 
            SET total_games_played = total_games_played + 1,
                updated_at = NOW()
            WHERE id = $1
        `, [user.id]);
        
        console.log(`💳 Linked game ${gameId} to payment ${payment.id}`);
        return { 
            success: true, 
            paymentId: payment.id,
            effectiveMode: 'PAID_SINGLE'
        };
    }

    /**
     * Process game completion (handle payouts)
     */
    async processGameCompletion(gameId, outcome, treasureFound = false) {
        try {
            // Get game details
            const gameResult = await this.db.query(`
                SELECT g.*, u.payout_address, u.id as user_id
                FROM games g
                JOIN users u ON g.user_id = u.id
                WHERE g.id = $1
            `, [gameId]);
            
            if (gameResult.rows.length === 0) {
                return { success: false, reason: 'Game not found' };
            }
            
            const game = gameResult.rows[0];
            
            // Update game status
            await this.db.query(`
                UPDATE games 
                SET status = $1, 
                    outcome = $2, 
                    treasure_found = $3, 
                    completed_at = NOW()
                WHERE id = $4
            `, [outcome === 'escaped' ? 'won' : 'lost', outcome, treasureFound, gameId]);
            
            const recordedMode = (game.payment_mode || game.game_mode || this.gameMode || 'FREE').toUpperCase();
            const payoutEligibleMode = (recordedMode === 'PAID_SINGLE') || (recordedMode === 'PAID_CREDITS' && this.creditsPayoutEnabled);
            if (payoutEligibleMode && outcome === 'escaped' && game.payout_address) {
                const { amount: payoutAmount, multiplier } = this.calculatePayout(recordedMode, { treasureFound });
                if (payoutAmount > 0) {
                    await this.walletService.processPayout({
                        userId: game.user_id,
                        gameId,
                        address: game.payout_address,
                        amount: payoutAmount,
                        multiplier,
                        description: `Game ${gameId} payout`
                    });
                
                    console.log(`💸 Created payout: ${payoutAmount} atomic units for game ${gameId} (multiplier ${multiplier}x)`);
                }
            }
            
            // Update user statistics
            if (outcome === 'escaped') {
                await this.db.query(`
                    UPDATE users 
                    SET total_games_won = total_games_won + 1,
                        updated_at = NOW()
                    WHERE id = $1
                `, [game.user_id]);
            }
            
            return { 
                success: true, 
                outcome, 
                treasureFound,
                payoutCreated: payoutEligibleMode && outcome === 'escaped'
            };
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process game completion');
            console.error('❌ Error processing game completion:', normalized.message);
            return { success: false, reason: normalized.safeMessage };
        }
    }

    /**
     * Create payment request
     */
    async createPaymentRequest(socketId, paymentType, options = {}) {
        try {
            const user = await this.getOrCreateUser(socketId);
            const reuseExisting = options.reuseExisting !== false;
            const requestedPackageId = options.packageId;

            let amount;
            let description;
            let packageInfo = null;

            switch (paymentType) {
                case 'single_game': {
                    amount = this.singleGamePrice;
                    description = `Wowngeon single game entry (${this.cryptoType})`;
                    break;
                }
                case 'credits_package': {
                    // Find the requested package, or fall back to primary
                    const packages = this.configSnapshot?.modes?.credits?.packages || [];
                    let selectedPackage = null;
                    
                    if (requestedPackageId && packages.length > 0) {
                        selectedPackage = packages.find(p => p.id === requestedPackageId);
                    }
                    
                    // Fall back to first package if not found
                    if (!selectedPackage) {
                        selectedPackage = this.getPrimaryCreditPackage();
                    }
                    
                    const packagePrice = selectedPackage?.price ?? this.creditsPackagePrice;
                    amount = typeof packagePrice === 'bigint' ? Number(packagePrice) : Number(packagePrice);
                    packageInfo = selectedPackage;
                    const creditCount = selectedPackage?.credits ?? 10;
                    const bonusCredits = selectedPackage?.bonus ?? 0;
                    const bonusText = bonusCredits > 0 ? ` (+${bonusCredits} bonus)` : '';
                    description = `Wowngeon ${creditCount}${bonusText} credits package (${this.cryptoType})`;
                    break;
                }
                default:
                    throw new ValidationError(`Invalid payment type requested: ${paymentType}`, {
                        safeMessage: 'Unsupported payment type requested.'
                    });
            }

            if (reuseExisting) {
                const existingRow = await this._findReusablePayment(user.id, paymentType);
                if (existingRow) {
                    const existing = this._mapPaymentRowToRequest(existingRow, paymentType, packageInfo);
                    if (existing && !existing.description) {
                        existing.description = description;
                    }
                    return existing;
                }
            }
            
            // Create payment request using wallet RPC with correct parameters
            const paymentResult = await this.walletService.createPaymentRequest(
                amount,
                description,
                user.id,
                socketId
            );

            const expiresAt = paymentResult.expiresAt || new Date(Date.now() + 30 * 60 * 1000);

            // Store payment info in database
            const insertResult = await this.db.query(`
                INSERT INTO payments (user_id, socket_id, subaddress, expected_amount, payment_type, status, description, created_at, expires_at)
                VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW(), $7)
                RETURNING id, expires_at
            `, [user.id, socketId, paymentResult.address, amount, paymentType, description, expiresAt]);

            const insertedRow = insertResult.rows[0];
            
            return {
                id: insertedRow?.id,
                address: paymentResult.address,
                amount: amount,
                amountFormatted: this.formatAtomicHuman(amount, 4),
                currency: this.cryptoType,
                expiresAt: insertedRow?.expires_at || expiresAt,
                package: this._serializePackageInfo(packageInfo),
                paymentType,
                description,
                reused: false
            };
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to create payment request');
            console.error('❌ Error creating payment request:', normalized.message);
            throw normalized;
        }
    }

    /**
     * Get or create user record
     */
    async getOrCreateUser(socketId, ipAddress = null) {
        try {
            // Try to find existing user
            let userResult = await this.db.query(`
                SELECT * FROM users WHERE socket_id = $1
            `, [socketId]);
            
            if (userResult.rows.length > 0) {
                // Update last active
                await this.db.query(`
                    UPDATE users 
                    SET last_active = NOW()
                    WHERE id = $1
                `, [userResult.rows[0].id]);
                
                return userResult.rows[0];
            }
            
            // Create new user
            userResult = await this.db.query(`
                INSERT INTO users (socket_id, ip_address)
                VALUES ($1, $2)
                RETURNING *
            `, [socketId, ipAddress]);
            
            console.log(`👤 Created new user: ${socketId}`);
            return userResult.rows[0];
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to load user');
            console.error('❌ Error getting/creating user:', normalized.message);
            throw normalized;
        }
    }

    /**
     * Set user payout address
     */
    async setUserPayoutAddress(socketId, payoutAddress) {
        try {
            const user = await this.getOrCreateUser(socketId);
            
            await this.db.query(`
                UPDATE users 
                SET payout_address = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [payoutAddress, user.id]);
            
            console.log(`💰 Set payout address for user ${user.id}: ${payoutAddress}`);
            return true;
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to update payout address');
            console.error('❌ Error setting payout address:', normalized.message);
            return false;
        }
    }

    /**
     * Get user statistics
     */
    async getUserStats(socketId) {
        try {
            const result = await this.db.query(`
                SELECT * FROM get_user_stats($1)
            `, [socketId]);
            
            if (result.rows.length > 0) {
                return result.rows[0];
            }
            
            return {
                total_games: 0,
                games_won: 0,
                win_rate: 0,
                total_paid: 0,
                total_won: 0,
                net_profit: 0,
                credits_remaining: 0
            };
            
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to load user stats');
            console.error('❌ Error getting user stats:', normalized.message);
            return null;
        }
    }

    /**
     * Get game mode info for frontend
     */
    getGameModeInfo() {
        // Debug: Log credits payout base value being sent
        console.log(`📤 getGameModeInfo: creditsPayoutBaseValue = ${this.creditsPayoutBaseValue} (${this.formatAtomic(this.creditsPayoutBaseValue)} ${this.cryptoType})`);
        
        // Determine if we should show a testnet warning
        // Only for XMR on stagenet/testnet - WOW only has mainnet
        const showTestnetWarning = this.cryptoType === 'XMR' && this.isTestNetwork;
        const testnetWarning = showTestnetWarning 
            ? `⚠️ STAGENET MODE: This server is using ${this.network} XMR. Do NOT send real mainnet XMR! Only ${this.network} XMR will be accepted.`
            : null;
        
        // Serialize all credit packages (convert BigInt prices to Number)
        const packages = this.configSnapshot?.modes?.credits?.packages || [];
        const creditPackages = packages.map(pkg => ({
            id: pkg.id,
            credits: pkg.credits,
            price: typeof pkg.price === 'bigint' ? Number(pkg.price) : pkg.price,
            bonus: pkg.bonus || 0,
            priceFormatted: this.formatAtomicHuman(
                typeof pkg.price === 'bigint' ? Number(pkg.price) : pkg.price, 
                2
            )
        }));
        
        return {
            mode: this.gameMode,
            cryptoType: this.cryptoType,
            network: this.network,
            isTestNetwork: this.isTestNetwork,
            testnetWarning: testnetWarning,
            singleGamePrice: this.singleGamePrice,
            singleGamePriceFormatted: this.formatAtomicHuman(this.singleGamePrice, 2),
            creditsPackagePrice: this.creditsPackagePrice,
            creditsPerGame: this.creditsPerGameCost,
            creditPackages: creditPackages,
            creditsPayoutBaseValue: this.creditsPayoutBaseValue,
            paymentsEnabled: this.paymentsEnabled,
            directModeEnabled: this.directModeEnabled,
            creditsModeEnabled: this.creditsModeEnabled,
            directPayoutsEnabled: this.directPayoutMultipliers.escape > 0,
            creditsPayoutsEnabled: this.creditsPayoutEnabled,
            payoutMultipliers: {
                direct: this.directPayoutMultipliers,
                credits: this.creditPayoutMultipliers
            },
            features: {
                paymentRequired: this.paymentsEnabled,
                creditsSystem: this.creditsModeEnabled,
                payouts: this.directPayoutMultipliers.escape > 0 || this.creditPayoutMultipliers.escape > 0
            }
        };
    }

    /**
     * Complete a game (called from socket handlers when game ends)
     * @param {string} socketId - Player's socket ID
     * @param {string} gameId - Game UUID
     * @param {boolean} won - Whether the player won (escaped)
     * @param {boolean} treasureFound - Whether treasure was found
     * @returns {object} payout / completion info
     */
    async completeGame(socketId, gameId, won, treasureFound, metrics = {}) {
        // For FREE mode we just return basic info
        if (this.gameMode === 'FREE') {
            return { success: true, mode: 'FREE', payout: null, score: metrics.score ?? null };
        }

        try {
            // Update/record game completion in DB (simplified; reuse processGameCompletion if schema matches)
            // If a games table exists with at least id & user reference, mark completion.
            try {
                await this.db.query(`
                    UPDATE games SET status = $1, treasure_found = $2, moves_made = COALESCE($3, moves_made), duration_seconds = COALESCE($4, duration_seconds), completed_at = NOW()
                    WHERE dungeon_seed = $5 AND socket_id = $6
                `, [
                    won ? 'won' : 'lost',
                    treasureFound,
                    metrics.moves ?? null,
                    metrics.durationSeconds ?? null,
                    gameId,
                    socketId
                ]);
            } catch (e) {
                // Non-fatal if games table differs during early dev.
                if (process.env.NODE_ENV === 'development') {
                    console.warn('Game completion update warning:', e.message);
                }
            }

            // Handle payouts only in PAID_SINGLE mode and only on win (escaped)
            const payoutEligibleStartMode = (this.gameMode === 'PAID_SINGLE') || (this.gameMode === 'PAID_CREDITS' && this.creditsPayoutEnabled);
            if (payoutEligibleStartMode && won) {
                const { amount: payoutAmount, multiplier } = this.calculatePayout(this.gameMode, { treasureFound });

                // Look up user record for payout address
                const userResult = await this.db.query(`SELECT * FROM users WHERE socket_id = $1 LIMIT 1`, [socketId]);
                const userRow = userResult.rows[0];
                if (userRow && userRow.payout_address) {
                    try {
                        await this.walletService.processPayout({
                            userId: userRow.id,
                            gameId,
                            address: userRow.payout_address,
                            amount: payoutAmount,
                            multiplier,
                            description: `Game ${gameId} payout`
                        });
                        return {
                            success: true,
                            mode: this.gameMode,
                            payout: {
                                amount: payoutAmount,
                                multiplier,
                                treasure: treasureFound
                            },
                            score: metrics.score ?? null
                        };
                    } catch (payoutErr) {
                        const normalizedPayout = normalizeError(payoutErr, 'Failed to send payout');
                        console.error('❌ Error creating payout:', normalizedPayout.message);
                        return { success: true, mode: this.gameMode, payout: null, payoutError: normalizedPayout.safeMessage, score: metrics.score ?? null };
                    }
                }
                return { success: true, mode: this.gameMode, payout: null, reason: 'No payout address', score: metrics.score ?? null };
            }

            // Credits mode: decrement nothing here (already handled start). Optionally could award stats.
            return { success: true, mode: this.gameMode, payout: null, score: metrics.score ?? null };
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to complete game');
            console.error('❌ completeGame error:', normalized.message);
            return { success: false, error: normalized.safeMessage };
        }
    }
}

module.exports = GameModeManager;
