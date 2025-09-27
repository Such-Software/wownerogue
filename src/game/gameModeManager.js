/**
 * Game Mode Manager
 * Handles different game modes (FREE, PAID_SINGLE, PAID_CREDITS)
 */

class GameModeManager {
    constructor(databaseManager, walletRPCService, debugManager) {
        this.db = databaseManager;
        this.walletService = walletRPCService; // Changed from moneroPayService
        this.debugManager = debugManager;
        this.gameMode = process.env.GAME_MODE || 'FREE';
        this.cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        // Flexible parsing: supports plain integers, scientific notation (e.g. 5e9), and underscores (e.g. 5_000_000_000)
        const parseAtomic = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            if (typeof val !== 'string') return Math.trunc(Number(val)) || fallback;
            const cleaned = val.replace(/_/g, '').trim();
            const num = Number(cleaned);
            if (!Number.isFinite(num) || num < 0) return fallback;
            // Ensure integer atomic units
            return Math.trunc(num);
        };

    this.singleGamePrice = parseAtomic(process.env.SINGLE_GAME_PRICE, 5000000000); // default 0.005 XMR
    this.creditsPackagePrice = parseAtomic(process.env.CREDITS_PACKAGE_PRICE, 50000000000); // default 0.05 XMR
    this.creditsPayoutEnabled = /^true$/i.test(process.env.CREDITS_PAYOUT_ENABLED || 'false');
        
        console.log(`🎮 Game Mode Manager initialized: ${this.gameMode} mode`);
        console.log(`💰 Currency: ${this.cryptoType}`);
        const toXMR = (atomic) => (atomic / 1e12).toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
        console.log(`💵 Single game price: ${this.singleGamePrice} atomic units (~${toXMR(this.singleGamePrice)} ${this.cryptoType})`);
        console.log(`🎫 Credits package price: ${this.creditsPackagePrice} atomic units (~${toXMR(this.creditsPackagePrice)} ${this.cryptoType})`);
        if (this.creditsPayoutEnabled) {
            console.log('🎁 Credits payout mode ENABLED (will pay rewards in PAID_CREDITS).');
        }
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
                    if (user.credits > 0) {
                        return { allowed: true, reason: `${user.credits} credits remaining` };
                    }
                    return { 
                        allowed: false, 
                        reason: 'No credits remaining',
                        action: 'purchase_credits'
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
            console.error('❌ Error checking user game eligibility:', error.message);
            return { allowed: false, reason: 'Database error' };
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
                    // Deduct one credit
                    const updateRes = await this.db.query(`
                        UPDATE users 
                        SET credits = credits - 1,
                            total_games_played = total_games_played + 1,
                            updated_at = NOW()
                        WHERE id = $1
                        RETURNING credits
                    `, [user.id]);
                    const remainingCredits = updateRes.rows[0] ? updateRes.rows[0].credits : (user.credits - 1);
                    // Emit credits update asynchronously if an io ref was injected later (pattern: attach externally)
                    try { this.io && this.io.to(socketId).emit('credits_update', { balance: remainingCredits }); } catch(_) {}
                    console.log(`🎫 Deducted 1 credit from user ${user.id}, ${remainingCredits} remaining`);
                    return { success: true, creditsRemaining: remainingCredits };
                    
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
            console.error('❌ Error processing game start:', error.message);
            return { success: false, reason: 'Database error' };
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
            
            // Handle payouts for PAID_SINGLE or (optionally) PAID_CREDITS mode
            const payoutEligibleMode = (this.gameMode === 'PAID_SINGLE') || (this.gameMode === 'PAID_CREDITS' && this.creditsPayoutEnabled);
            if (payoutEligibleMode && outcome === 'escaped' && game.payout_address) {
                let payoutAmount;
                const base = (this.gameMode === 'PAID_CREDITS') ? this.singleGamePrice : this.singleGamePrice; // could make distinct; reuse singleGamePrice as base
                payoutAmount = treasureFound ? base * 3 : base * 2;
                
                // Create payout record
                await this.walletService.processPayout(
                    game.user_id,
                    gameId,
                    game.payout_address,
                    payoutAmount
                );
                
                console.log(`💸 Created payout: ${payoutAmount} atomic units for game ${gameId}`);
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
            console.error('❌ Error processing game completion:', error.message);
            return { success: false, reason: 'Database error' };
        }
    }

    /**
     * Create payment request
     */
    async createPaymentRequest(socketId, paymentType) {
        try {
            const user = await this.getOrCreateUser(socketId);
            
            let amount, description;
            
            switch (paymentType) {
                case 'single_game':
                    amount = this.singleGamePrice;
                    description = `Wowngeon single game entry (${this.cryptoType})`;
                    break;
                    
                case 'credits_package':
                    amount = this.creditsPackagePrice;
                    description = `Wowngeon 10 credits package (${this.cryptoType})`;
                    break;
                    
                default:
                    throw new Error('Invalid payment type');
            }
            
            // Create payment request using wallet RPC with correct parameters
            const paymentResult = await this.walletService.createPaymentRequest(
                amount,
                description,
                user.id,
                socketId
            );

            if (!paymentResult.success) {
                throw new Error(paymentResult.error || 'Failed to create payment address');
            }

            // Store payment info in database
            await this.db.query(`
                INSERT INTO payments (user_id, socket_id, subaddress, expected_amount, payment_type, status, created_at)
                VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
            `, [user.id, socketId, paymentResult.address, amount, paymentType]);
            
            return {
                id: paymentResult.id,
                address: paymentResult.address,
                amount: amount,
                amountFormatted: (amount / 1e12).toFixed(4), // Convert from atomic units
                currency: this.cryptoType,
                expiresAt: paymentResult.expiresAt
            };
            
        } catch (error) {
            console.error('❌ Error creating payment request:', error.message);
            throw error;
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
            console.error('❌ Error getting/creating user:', error.message);
            throw error;
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
            console.error('❌ Error setting payout address:', error.message);
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
            console.error('❌ Error getting user stats:', error.message);
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
            features: {
                paymentRequired: this.gameMode !== 'FREE',
                creditsSystem: this.gameMode === 'PAID_CREDITS',
                payouts: this.gameMode === 'PAID_SINGLE'
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
                // Derive payout multiplier
                const multiplier = treasureFound ? 3 : 2;
                const payoutAmount = this.singleGamePrice * multiplier;

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
                        console.error('❌ Error creating payout:', payoutErr.message);
                        return { success: true, mode: this.gameMode, payout: null, payoutError: payoutErr.message };
                    }
                }
                return { success: true, mode: this.gameMode, payout: null, reason: 'No payout address' };
            }

            // Credits mode: decrement nothing here (already handled start). Optionally could award stats.
            return { success: true, mode: this.gameMode, payout: null };
        } catch (err) {
            console.error('❌ completeGame error:', err.message);
            return { success: false, error: err.message };
        }
    }
}

module.exports = GameModeManager;
