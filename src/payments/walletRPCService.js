const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { ExternalServiceError, AppError } = require('../utils/errors');

class WalletRPCService {
    constructor(debugManager) {
        this.debugManager = debugManager;
        this.walletEndpoint = process.env.PRIMARY_WALLET_ENDPOINT || 'http://127.0.0.1:34570';
        this.accountIndex = 0;
        this.paymentWatchers = new Map();
        this.addressToUser = new Map();
        this.addressToSocket = new Map();
        this.isHealthy = false;
    }

    async initialize() {
        try {
            // Test wallet connection
            const response = await this.rpcCall('get_version');
            this.isHealthy = true;
            
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('✅ Wallet RPC service initialized:', {
                    version: response.result?.version || 'unknown',
                    endpoint: this.walletEndpoint
                });
            }
            
            // Get wallet height to ensure it's synced
            const heightResponse = await this.rpcCall('get_height');
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('📊 Wallet height:', heightResponse.result?.height || 0);
            }
            
            return true;
        } catch (error) {
            this.isHealthy = false;
            console.error('❌ Wallet RPC connection failed:', error.message);
            console.error('   Make sure wownero-wallet-rpc is running on', this.walletEndpoint);
            return false;
        }
    }

    async rpcCall(method, params = {}) {
        try {
            const response = await axios.post(`${this.walletEndpoint}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: method,
                params: params
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            if (response.data.error) {
                throw new ExternalServiceError(`Wallet RPC responded with error for method ${method}`, {
                    safeMessage: 'Wallet RPC call failed.',
                    details: response.data.error,
                    cause: response.data.error
                });
            }

            return response.data;
        } catch (error) {
            const wrapped = error instanceof ExternalServiceError
                ? error
                : new ExternalServiceError(`Wallet RPC call failed (${method})`, {
                    safeMessage: 'Wallet RPC call failed.',
                    cause: error
                });

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.error(`❌ Wallet RPC call failed (${method}):`, wrapped.message);
            }
            throw wrapped;
        }
    }

    async createPaymentRequest(amount, description, userId, socketId) {
        try {
            // Create a new subaddress for this payment
            const response = await this.rpcCall('create_address', {
                account_index: this.accountIndex,
                label: `game_${userId}_${Date.now()}`
            });

            const address = response.result.address;
            const addressIndex = response.result.address_index;

            // Store mapping for payment monitoring
            const paymentInfo = {
                userId: userId,
                socketId: socketId,
                amount: amount,
                description: description,
                addressIndex: addressIndex,
                accountIndex: this.accountIndex,
                createdAt: new Date(),
                status: 'pending',
                detected: false,
                confirmed: false
            };

            this.addressToUser.set(address, paymentInfo);
            this.addressToSocket.set(address, socketId);

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`💳 Payment address created:`, {
                    user: userId,
                    address: address.substring(0, 10) + '...',
                    amount: amount,
                    index: addressIndex
                });
            }

            return {
                success: true,
                id: uuidv4(), // Generate payment ID
                address: address,
                amount: amount,
                description: description,
                addressIndex: addressIndex,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
            };
        } catch (error) {
            const wrapped = error instanceof AppError ? error : new ExternalServiceError('Failed to create payment address', {
                safeMessage: 'Unable to create a payment address at this time.',
                cause: error
            });
            console.error('❌ Failed to create payment address:', wrapped.message);
            throw wrapped;
        }
    }

    async checkPaymentStatus(address) {
        try {
            const userInfo = this.addressToUser.get(address);
            if (!userInfo) {
                return { 
                    complete: false, 
                    in_mempool: false,
                    confirmed: false,
                    amount: 0,
                    confirmations: 0
                };
            }

            // Get incoming transfers for this specific subaddress
            const response = await this.rpcCall('get_transfers', {
                in: true,
                pending: true,
                failed: false,
                pool: true,
                account_index: userInfo.accountIndex,
                subaddr_indices: [userInfo.addressIndex]
            });

            let totalReceived = 0;
            let inMempool = false;
            let confirmed = false;
            let confirmations = 0;
            let txHash = null;

            // Check pending (mempool) transactions
            if (response.result?.pool && response.result.pool.length > 0) {
                for (const tx of response.result.pool) {
                    totalReceived += tx.amount;
                    inMempool = true;
                    txHash = tx.txid;
                    
                    // Mark as detected if this is first time seeing it
                    if (!userInfo.detected) {
                        userInfo.detected = true;
                        if (this.debugManager?.CONSOLE_LOGGING) {
                            console.log(`🎯 Payment detected (mempool):`, {
                                address: address.substring(0, 10) + '...',
                                amount: tx.amount,
                                txid: txHash
                            });
                        }
                    }
                }
            }

            // Check confirmed transactions
            if (response.result?.in && response.result.in.length > 0) {
                for (const tx of response.result.in) {
                    totalReceived += tx.amount;
                    confirmed = true;
                    txHash = tx.txid;
                    
                    // Calculate confirmations
                    if (tx.height > 0) {
                        const heightResp = await this.rpcCall('get_height');
                        confirmations = Math.max(confirmations, heightResp.result.height - tx.height);
                    }
                    
                    if (!userInfo.confirmed) {
                        userInfo.confirmed = true;
                        if (this.debugManager?.CONSOLE_LOGGING) {
                            console.log(`✅ Payment included in block (confirmed):`, {
                                address: address.substring(0, 10) + '...',
                                confirmations: confirmations,
                                txid: txHash
                            });
                        }
                    }
                }
            }

            const paymentComplete = totalReceived >= userInfo.amount;

            return {
                complete: paymentComplete,
                in_mempool: inMempool,
                confirmed: confirmed,
                amount: totalReceived,
                confirmations: confirmations,
                required: userInfo.amount,
                txHash: txHash
            };
        } catch (error) {
            console.error('❌ Failed to check payment status:', error);
            return { 
                complete: false, 
                in_mempool: false,
                confirmed: false,
                amount: 0,
                confirmations: 0
            };
        }
    }

    startPaymentMonitoring(address, callback, interval = 2000) {
        if (this.paymentWatchers.has(address)) {
            return; // Already monitoring
        }

        const watcher = setInterval(async () => {
            const status = await this.checkPaymentStatus(address);
            
            if (status.in_mempool || status.confirmed) {
                callback(status);
                
                // Stop monitoring if payment is confirmed
                if (status.confirmed && status.complete) {
                    this.stopPaymentMonitoring(address);
                }
            }
        }, interval);

    this.paymentWatchers.set(address, watcher);
    // Allow process to exit if this is the only remaining handle (useful for tests)
    if (watcher.unref) watcher.unref();

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`👁️ Started monitoring payments for:`, address.substring(0, 10) + '...');
        }
    }

    stopPaymentMonitoring(address) {
        const watcher = this.paymentWatchers.get(address);
        if (watcher) {
            clearInterval(watcher);
            this.paymentWatchers.delete(address);
            
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`🛑 Stopped monitoring:`, address.substring(0, 10) + '...');
            }
        }
    }

    /**
     * Placeholder for future batch payout aggregation.
     * Currently returns early to avoid runtime errors where it's scheduled.
     */
    async processBatchPayouts() {
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log('⚙️ processBatchPayouts stub invoked (no payouts processed).');
        }
        return { processed: 0 };
    }

    normalizeAtomicAmount(value) {
        if (value === undefined || value === null) {
            throw new AppError('Payout amount was not provided', {
                safeMessage: 'Invalid payout amount supplied.'
            });
        }

        if (typeof value === 'bigint') {
            if (value <= 0n) {
                throw new AppError('Payout amount must be greater than zero', {
                    safeMessage: 'Invalid payout amount supplied.'
                });
            }
            if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                return value.toString();
            }
            return Number(value);
        }

        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) {
            throw new AppError('Payout amount must be a positive number', {
                safeMessage: 'Invalid payout amount supplied.'
            });
        }

        const truncated = Math.trunc(num);
        if (truncated <= 0) {
            throw new AppError('Payout amount rounded below minimum atomic unit', {
                safeMessage: 'Invalid payout amount supplied.'
            });
        }

        return truncated;
    }

    async processPayout({
        address,
        amount,
        userId = null,
        gameId = null,
        description = null,
        multiplier = null,
        subaddressIndex = null
    } = {}) {
        try {
            if (!address || typeof address !== 'string') {
                throw new AppError('Payout address was not provided or invalid', {
                    safeMessage: 'Invalid payout address supplied.'
                });
            }

            const normalizedAmount = this.normalizeAtomicAmount(amount);

            const transferParams = {
                destinations: [{
                    amount: normalizedAmount,
                    address
                }],
                account_index: this.accountIndex,
                priority: 1,
                get_tx_key: true
            };

            if (Number.isInteger(subaddressIndex) && subaddressIndex >= 0) {
                transferParams.subaddr_indices = [subaddressIndex];
            }

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('🚀 Initiating payout transfer', {
                    to: address.substring(0, 10) + '...',
                    amount: normalizedAmount,
                    userId,
                    gameId,
                    multiplier,
                    description
                });
            }

            const response = await this.rpcCall('transfer', transferParams);

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('💸 Payout sent successfully', {
                    to: address.substring(0, 10) + '...',
                    amount: normalizedAmount,
                    txHash: response.result.tx_hash,
                    fee: response.result.fee
                });
            }

            return {
                success: true,
                txHash: response.result.tx_hash,
                txKey: response.result.tx_key,
                fee: response.result.fee,
                userId,
                gameId,
                amount: normalizedAmount
            };
        } catch (error) {
            const wrapped = error instanceof AppError ? error : new ExternalServiceError('Failed to process payout', {
                safeMessage: 'Unable to send payout at this time.',
                cause: error
            });

            const meta = { userId, gameId, address: address?.substring?.(0, 10) + '...', amount };
            console.error('❌ Failed to process payout:', wrapped.message, meta);
            throw wrapped;
        }
    }

    cleanupUserPayments(userId) {
        for (const [address, userInfo] of this.addressToUser.entries()) {
            if (userInfo.userId === userId || userInfo.socketId === userId) {
                this.stopPaymentMonitoring(address);
            }
        }
    }

    // Get service health status
    getHealthStatus() {
        return {
            healthy: this.isHealthy,
            endpoint: this.walletEndpoint,
            activeMonitors: this.paymentWatchers.size,
            pendingPayments: this.addressToUser.size
        };
    }
}

module.exports = WalletRPCService;