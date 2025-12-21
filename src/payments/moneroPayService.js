/**
 * MoneroPay Integration Service
 * Handles payment requests, monitoring, and payouts
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

class MoneroPayService {
    constructor(databaseManager) {
        this.db = databaseManager;
        this.endpoint = process.env.MONEROPAY_ENDPOINT;
        this.callbackBaseUrl = process.env.MONEROPAY_CALLBACK_BASE_URL;
        this.initialized = false;
        
        if (!this.endpoint) {
            throw new Error('MONEROPAY_ENDPOINT not configured');
        }
        
        console.log(`💰 MoneroPay service initialized: ${this.endpoint}`);
    }

    /**
     * Initialize MoneroPay service
     */
    async initialize() {
        try {
            // Test connection to MoneroPay endpoint
            const response = await axios.get(`${this.endpoint}/health`, { timeout: 5000 });
            
            if (response.status === 200) {
                this.initialized = true;
                console.log('✅ MoneroPay service connection verified');
                return true;
            } else {
                console.log('❌ MoneroPay service health check failed');
                return false;
            }
        } catch (error) {
            console.log(`❌ MoneroPay service connection failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Create a payment request for a user
     */
    async createPaymentRequest(userId, socketId, paymentType, amount, description) {
        try {
            const callbackUrl = `${this.callbackBaseUrl}/${socketId}`;
            
            const response = await axios.post(`${this.endpoint}/receive`, {
                amount: parseInt(amount),
                description: description || `Wownerogue ${paymentType}`,
                callback_url: callbackUrl
            });

            const { address, amount: expectedAmount, created_at } = response.data;

            // Store payment request in database
            const paymentRecord = await this.db.query(`
                INSERT INTO payments (
                    user_id, socket_id, subaddress, expected_amount, 
                    payment_type, description, status
                ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
                RETURNING *
            `, [userId, socketId, address, expectedAmount, paymentType, description]);

            console.log(`💳 Payment request created: ${address} for ${expectedAmount} atomic units`);

            return {
                id: paymentRecord.rows[0].id,
                address,
                amount: expectedAmount,
                paymentType,
                description,
                expiresAt: paymentRecord.rows[0].expires_at
            };

        } catch (error) {
            console.error('❌ Failed to create payment request:', error.message);
            throw new Error('Failed to create payment request');
        }
    }

    /**
     * Check payment status for a subaddress
     */
    async checkPaymentStatus(subaddress) {
        try {
            const response = await axios.get(`${this.endpoint}/receive/${subaddress}`);
            const data = response.data;

            return {
                complete: data.complete,
                expectedAmount: data.amount.expected,
                coveredAmount: data.amount.covered.total,
                unlockedAmount: data.amount.covered.unlocked,
                transactions: data.transactions || []
            };

        } catch (error) {
            console.error(`❌ Failed to check payment status for ${subaddress}:`, error.message);
            return null;
        }
    }

    /**
     * Process payment callback (when payment confirmed)
     */
    async processPaymentCallback(paymentData) {
        try {
            // Find the payment record
            const paymentResult = await this.db.query(`
                SELECT * FROM payments 
                WHERE subaddress = $1 AND status = 'pending'
            `, [paymentData.address]);

            if (paymentResult.rows.length === 0) {
                console.warn('⚠️ Payment callback for unknown address:', paymentData.address);
                return false;
            }

            const paymentRecord = paymentResult.rows[0];

            // Update payment status
            await this.db.query(`
                UPDATE payments 
                SET status = 'confirmed', 
                    received_amount = $1,
                    confirmed_at = NOW(),
                    tx_hash = $2,
                    block_height = $3,
                    confirmations = $4
                WHERE id = $5
            `, [
                paymentData.amount,
                paymentData.tx_hash,
                paymentData.height,
                paymentData.confirmations,
                paymentRecord.id
            ]);

            // Handle different payment types
            if (paymentRecord.payment_type === 'credits_package') {
                // Parse credits from description or use default
                // Description format: "Wowngeon X credits package (WOW)"
                let creditsToAdd = 10; // Default fallback
                const descMatch = paymentRecord.description?.match(/(\d+)\s*credits/i);
                if (descMatch) {
                    creditsToAdd = parseInt(descMatch[1], 10) || 10;
                }
                
                await this.db.query(`
                    UPDATE users 
                    SET credits = credits + $1,
                        total_amount_paid = total_amount_paid + $2,
                        updated_at = NOW()
                    WHERE id = $3
                `, [creditsToAdd, paymentData.amount, paymentRecord.user_id]);

                console.log(`💰 Added ${creditsToAdd} credits to user ${paymentRecord.user_id}`);
            }

            console.log(`✅ Payment confirmed: ${paymentData.tx_hash} for ${paymentData.amount} atomic units`);
            return true;

        } catch (error) {
            console.error('❌ Failed to process payment callback:', error.message);
            return false;
        }
    }

    /**
     * Create a payout for game winner
     */
    async createPayout(userId, gameId, payoutAddress, amount) {
        try {
            const result = await this.db.query(`
                INSERT INTO payouts (
                    user_id, game_id, payout_address, amount, status
                ) VALUES ($1, $2, $3, $4, 'pending')
                RETURNING *
            `, [userId, gameId, payoutAddress, amount]);

            console.log(`💸 Payout created: ${amount} atomic units to ${payoutAddress}`);
            return result.rows[0];

        } catch (error) {
            console.error('❌ Failed to create payout:', error.message);
            throw error;
        }
    }

    /**
     * Process pending payouts in batches
     */
    async processPendingPayouts() {
        try {
            const maxBatchSize = parseInt(process.env.MAX_PAYOUT_BATCH_SIZE) || 50;
            
            // Get pending payouts
            const payouts = await this.db.query(`
                SELECT * FROM payouts 
                WHERE status = 'pending'
                ORDER BY created_at ASC
                LIMIT $1
            `, [maxBatchSize]);

            if (payouts.rows.length === 0) {
                return { processed: 0, message: 'No pending payouts' };
            }

            // Group payouts by address to optimize transaction fees
            const payoutGroups = this.groupPayoutsByAddress(payouts.rows);
            const batchId = uuidv4();

            // Prepare destinations for MoneroPay
            const destinations = payoutGroups.map(group => ({
                address: group.address,
                amount: group.totalAmount
            }));

            // Send batch transfer
            const transferResponse = await axios.post(`${this.endpoint}/transfer`, {
                destinations
            });

            const { tx_hash_list, fee, amount: totalAmount } = transferResponse.data;

            // Update payout records
            const payoutIds = payouts.rows.map(p => p.id);
            await this.db.query(`
                UPDATE payouts 
                SET status = 'completed',
                    batch_id = $1,
                    tx_hash = $2,
                    fee = $3,
                    processed_at = NOW()
                WHERE id = ANY($4)
            `, [batchId, tx_hash_list[0], fee, payoutIds]);

            // Update user totals
            for (const payout of payouts.rows) {
                await this.db.query(`
                    UPDATE users 
                    SET total_amount_won = total_amount_won + $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [payout.amount, payout.user_id]);
            }

            console.log(`✅ Processed ${payouts.rows.length} payouts in batch ${batchId}`);
            console.log(`💸 Total amount: ${totalAmount}, Fee: ${fee}, TX: ${tx_hash_list.join(', ')}`);

            return {
                processed: payouts.rows.length,
                batchId,
                totalAmount,
                fee,
                transactions: tx_hash_list
            };

        } catch (error) {
            console.error('❌ Failed to process payouts:', error.message);
            
            // Mark failed payouts
            await this.db.query(`
                UPDATE payouts 
                SET status = 'failed'
                WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 hour'
            `);

            throw error;
        }
    }

    /**
     * Group payouts by address to minimize transaction fees
     */
    groupPayoutsByAddress(payouts) {
        const groups = {};
        
        for (const payout of payouts) {
            if (!groups[payout.payout_address]) {
                groups[payout.payout_address] = {
                    address: payout.payout_address,
                    totalAmount: 0,
                    payouts: []
                };
            }
            
            groups[payout.payout_address].totalAmount += parseInt(payout.amount);
            groups[payout.payout_address].payouts.push(payout);
        }
        
        return Object.values(groups);
    }

    /**
     * Get wallet balance
     */
    async getBalance() {
        try {
            const response = await axios.get(`${this.endpoint}/balance`);
            return response.data;
        } catch (error) {
            console.error('❌ Failed to get wallet balance:', error.message);
            return { total: 0, unlocked: 0 };
        }
    }

    /**
     * Cleanup expired payment requests
     */
    async cleanupExpiredPayments() {
        try {
            const result = await this.db.query(`
                UPDATE payments 
                SET status = 'expired'
                WHERE status = 'pending' AND expires_at < NOW()
                RETURNING id
            `);

            if (result.rows.length > 0) {
                console.log(`🧹 Cleaned up ${result.rows.length} expired payments`);
            }

            return result.rows.length;
        } catch (error) {
            console.error('❌ Failed to cleanup expired payments:', error.message);
            return 0;
        }
    }
}

module.exports = MoneroPayService;
