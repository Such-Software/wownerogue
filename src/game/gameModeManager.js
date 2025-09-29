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
        this.singleGamePrice = parseAtomicEnvValue(process.env.SINGLE_GAME_PRICE, this.singleGamePrice);
        this.creditsPackagePrice = parseAtomicEnvValue(process.env.CREDITS_PACKAGE_PRICE, this.creditsPackagePrice);
        this.creditsPerGameCost = parseAtomicEnvValue(process.env.CREDITS_PER_GAME, 1) || 1;
        this.creditsPayoutEnabled = /^true$/i.test(process.env.CREDITS_PAYOUT_ENABLED || 'false');
        this.creditsPayoutBaseValue = this.singleGamePrice;
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
        return { amount, multiplier, base };
    }

    logConfiguration(context = 'initialized') {
        console.log(`🎮 Game Mode Manager ${context}: ${this.gameMode} mode`);
        console.log(`💰 Currency: ${this.cryptoType} (decimals: ${this.currencyDecimals})`);
        console.log(`💵 Single game price: ${this.singleGamePrice} atomic units (~${this.formatAtomic(this.singleGamePrice)} ${this.cryptoType})`);
        console.log(`🎫 Credits package price: ${this.creditsPackagePrice} atomic units (~${this.formatAtomic(this.creditsPackagePrice)} ${this.cryptoType})`);
        console.log(`🎯 Credits per game cost: ${this.creditsPerGameCost}`);
        console.log(`🧮 Payout multipliers - direct: ${JSON.stringify(this.directPayoutMultipliers)}, credits: ${JSON.stringify(this.creditPayoutMultipliers)}`);
        console.log(`🔁 Mode availability - direct: ${this.directModeEnabled}, credits: ${this.creditsModeEnabled}, preferCreditsFirst: ${this.preferCreditsFirst}`);
        if (this.creditsPayoutEnabled) {
            console.log('🎁 Credits payout mode ENABLED (will pay rewards in PAID_CREDITS).');
        }
        console.log(`⚙️ Payments enabled: ${this.paymentsEnabled}`);
    }

    /**
     * Check if user can start a game
     */
    async canUserStartGame(socketId) {
        try {
            const user = await this.getOrCreateUser(socketId);
            
            switch (this.gameMode) {
                case 'FREE':
                    return { allowed: true, reason: 'Free mode' };
                    
                case 'PAID_CREDITS':
                    if (user.credits >= this.creditsPerGameCost) {
                        return {
                            allowed: true,
                            reason: `${user.credits} credits remaining`,
                            creditsRequired: this.creditsPerGameCost
                        };
                    }
                    return { 
                        allowed: false, 
                        reason: 'Insufficient credits',
                        action: 'purchase_credits',
                        creditsRequired: this.creditsPerGameCost,
                        balance: user.credits
                    };
                    
                case 'PAID_SINGLE':
                    // Check for pending payment
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
                            paymentId: pendingPayment.rows[0].id
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
            
            switch (this.gameMode) {
                case 'FREE':
                    // No processing needed for free mode
                    return { success: true };
                    
                case 'PAID_CREDITS':
                    // Deduct required credits for this mode
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
                    // Emit credits update asynchronously if an io ref was injected later (pattern: attach externally)
                    try { this.io && this.io.to(socketId).emit('credits_update', { balance: remainingCredits }); } catch(_) {}
                    console.log(`🎫 Deducted ${creditsToSpend} credit(s) from user ${user.id}, ${remainingCredits} remaining`);
                    return { success: true, creditsRemaining: remainingCredits, creditsSpent: creditsToSpend };
                    
                case 'PAID_SINGLE':
                    // Link game to payment
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
                    
                    await this.db.query(`
                        UPDATE games 
                        SET payment_id = $1
                        WHERE id = $2
                    `, [payment.rows[0].id, gameId]);
                    
                    await this.db.query(`
                        UPDATE users 
                        SET total_games_played = total_games_played + 1,
                            updated_at = NOW()
                        WHERE id = $1
                    `, [user.id]);
                    
                    console.log(`💳 Linked game ${gameId} to payment ${payment.rows[0].id}`);
                    return { success: true, paymentId: payment.rows[0].id };
                    
                default:
                    return { success: false, reason: 'Invalid game mode' };
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to process game start');
            console.error('❌ Error processing game start:', normalized.message);
            return { success: false, reason: normalized.safeMessage };
        }
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
                    await this.walletService.processPayout(
                        game.user_id,
                        gameId,
                        game.payout_address,
                        payoutAmount
                    );
                
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
    async createPaymentRequest(socketId, paymentType) {
        try {
            const user = await this.getOrCreateUser(socketId);
            
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
                    const primaryPackage = this.getPrimaryCreditPackage();
                    const packagePrice = primaryPackage?.price ?? this.creditsPackagePrice;
                    amount = Number(packagePrice);
                    packageInfo = primaryPackage;
                    const creditCount = primaryPackage?.credits ?? 10;
                    description = `Wowngeon ${creditCount} credits package (${this.cryptoType})`;
                    break;
                }
                default:
                    throw new ValidationError(`Invalid payment type requested: ${paymentType}`, {
                        safeMessage: 'Unsupported payment type requested.'
                    });
            }
            
            // Create payment request using wallet RPC with correct parameters
            const paymentResult = await this.walletService.createPaymentRequest(
                amount,
                description,
                user.id,
                socketId
            );

            // Store payment info in database
            await this.db.query(`
                INSERT INTO payments (user_id, socket_id, subaddress, expected_amount, payment_type, status, created_at)
                VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
            `, [user.id, socketId, paymentResult.address, amount, paymentType]);
            
            return {
                id: paymentResult.id,
                address: paymentResult.address,
                amount: amount,
                amountFormatted: this.formatAtomicHuman(amount, 4),
                currency: this.cryptoType,
                expiresAt: paymentResult.expiresAt,
                package: packageInfo
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
        return {
            mode: this.gameMode,
            cryptoType: this.cryptoType,
            singleGamePrice: this.singleGamePrice,
            creditsPackagePrice: this.creditsPackagePrice,
            creditsPerGame: this.creditsPerGameCost,
            paymentsEnabled: this.paymentsEnabled,
            directModeEnabled: this.directModeEnabled,
            creditsModeEnabled: this.creditsModeEnabled,
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
    async completeGame(socketId, gameId, won, treasureFound) {
        // For FREE mode we just return basic info
        if (this.gameMode === 'FREE') {
            return { success: true, mode: 'FREE', payout: null };
        }

        try {
            // Update/record game completion in DB (simplified; reuse processGameCompletion if schema matches)
            // If a games table exists with at least id & user reference, mark completion.
            try {
                await this.db.query(`
                    UPDATE games SET status = $1, treasure_found = $2, completed_at = NOW()
                    WHERE id = $3
                `, [won ? 'won' : 'lost', treasureFound, gameId]);
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
                        await this.walletService.processPayout(
                            userRow.id,
                            gameId,
                            userRow.payout_address,
                            payoutAmount
                        );
                        return {
                            success: true,
                            mode: this.gameMode,
                            payout: {
                                amount: payoutAmount,
                                multiplier,
                                treasure: treasureFound
                            }
                        };
                    } catch (payoutErr) {
                        const normalizedPayout = normalizeError(payoutErr, 'Failed to send payout');
                        console.error('❌ Error creating payout:', normalizedPayout.message);
                        return { success: true, mode: this.gameMode, payout: null, payoutError: normalizedPayout.safeMessage };
                    }
                }
                return { success: true, mode: this.gameMode, payout: null, reason: 'No payout address' };
            }

            // Credits mode: decrement nothing here (already handled start). Optionally could award stats.
            return { success: true, mode: this.gameMode, payout: null };
        } catch (err) {
            const normalized = normalizeError(err, 'Failed to complete game');
            console.error('❌ completeGame error:', normalized.message);
            return { success: false, error: normalized.safeMessage };
        }
    }
}

module.exports = GameModeManager;
