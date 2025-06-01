/**
 * Game Mode Manager
 * Handles different game modes (FREE, PAID_SINGLE, PAID_CREDITS)
 */

class GameModeManager {
    constructor(databaseManager, moneroPayService) {
        this.db = databaseManager;
        this.moneroPayService = moneroPayService;
        this.gameMode = process.env.GAME_MODE || 'FREE';
        this.cryptoType = process.env.CRYPTO_TYPE || 'XMR';
        this.singleGamePrice = parseInt(process.env.SINGLE_GAME_PRICE) || 5000000000; // 0.005 XMR
        this.creditsPackagePrice = parseInt(process.env.CREDITS_PACKAGE_PRICE) || 50000000000; // 0.05 XMR
        
        console.log(`🎮 Game Mode Manager initialized: ${this.gameMode} mode`);
        console.log(`💰 Currency: ${this.cryptoType}`);
        console.log(`💵 Single game price: ${this.singleGamePrice} atomic units`);
        console.log(`🎫 Credits package price: ${this.creditsPackagePrice} atomic units`);
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
                    await this.db.query(`
                        UPDATE users 
                        SET credits = credits - 1,
                            total_games_played = total_games_played + 1,
                            updated_at = NOW()
                        WHERE id = $1
                    `, [user.id]);
                    
                    console.log(`🎫 Deducted 1 credit from user ${user.id}, ${user.credits - 1} remaining`);
                    return { success: true, creditsRemaining: user.credits - 1 };
                    
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
            
            // Handle payouts for PAID_SINGLE mode
            if (this.gameMode === 'PAID_SINGLE' && outcome === 'escaped' && game.payout_address) {
                let payoutAmount;
                
                if (treasureFound) {
                    payoutAmount = this.singleGamePrice * 3; // 3x for treasure
                } else {
                    payoutAmount = this.singleGamePrice * 2; // 2x for escape
                }
                
                // Create payout record
                await this.moneroPayService.createPayout(
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
                payoutCreated: this.gameMode === 'PAID_SINGLE' && outcome === 'escaped'
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
                    description = `Wowgue single game entry (${this.cryptoType})`;
                    break;
                    
                case 'credits_package':
                    amount = this.creditsPackagePrice;
                    description = `Wowgue 10 credits package (${this.cryptoType})`;
                    break;
                    
                default:
                    throw new Error('Invalid payment type');
            }
            
            return await this.moneroPayService.createPaymentRequest(
                user.id,
                socketId,
                paymentType,
                amount,
                description
            );
            
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
}

module.exports = GameModeManager;
