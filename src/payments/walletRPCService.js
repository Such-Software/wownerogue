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
     * Send a batch payout to multiple destinations in a single transfer_split call.
     * More efficient than individual transfers — uses fewer outputs and pays less in fees.
     * @param {Array<{amount: number|bigint, address: string}>} destinations
     * @returns {Object} - { tx_hash_list, tx_key_list, fee_list, totalFee }
     */
    async processBatchPayout(destinations) {
        if (!destinations || destinations.length === 0) {
            throw new AppError('No destinations provided for batch payout', {
                safeMessage: 'Batch payout requires at least one destination.'
            });
        }

        // Validate all addresses before attempting transfer
        for (const dest of destinations) {
            if (!dest.address || typeof dest.address !== 'string') {
                throw new AppError('Invalid address in batch payout', {
                    safeMessage: 'One or more payout addresses are invalid.'
                });
            }
            const validation = await this.validateAddress(dest.address);
            if (!validation.valid) {
                throw new AppError(`Invalid payout address in batch: ${dest.address.substring(0, 10)}...`, {
                    safeMessage: 'One or more payout addresses failed validation.'
                });
            }
        }

        const transferParams = {
            destinations: destinations.map(d => ({
                amount: this.normalizeAtomicAmount(d.amount),
                address: d.address
            })),
            account_index: this.accountIndex,
            priority: 1,
            get_tx_key: true
        };

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`🚀 Initiating batch payout (${destinations.length} destinations)`, {
                totalAmount: destinations.reduce((sum, d) => sum + Number(d.amount), 0),
                destinations: destinations.map(d => d.address.substring(0, 10) + '...')
            });
        }

        const response = await this.rpcCall('transfer_split', transferParams);

        const result = {
            tx_hash_list: response.result.tx_hash_list || [],
            tx_key_list: response.result.tx_key_list || [],
            fee_list: response.result.fee_list || [],
            totalFee: (response.result.fee_list || []).reduce((a, b) => a + b, 0)
        };

        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`💸 Batch payout sent (${result.tx_hash_list.length} tx)`, {
                txHashes: result.tx_hash_list,
                totalFee: result.totalFee,
                destinations: destinations.length
            });
        }

        return result;
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

    /**
     * Get wallet balance for admin monitoring
     * @returns {Object} - { balance: bigint, unlocked_balance: bigint } in atomic units
     */
    async getBalance() {
        try {
            const response = await this.rpcCall('get_balance', {
                account_index: this.accountIndex
            });

            return {
                balance: response.result?.balance || 0,
                unlocked_balance: response.result?.unlocked_balance || 0
            };
        } catch (error) {
            console.error('❌ Failed to get wallet balance:', error.message);
            return {
                balance: 0,
                unlocked_balance: 0,
                error: error.message
            };
        }
    }

    /**
     * Get the wallet's own primary address (account_index 0, address_index 0).
     * Used by output-splitting script and internal operations.
     * @returns {Object} - { address: string, address_index: number }
     */
    async getOwnAddress() {
        const response = await this.rpcCall('get_address', {
            account_index: this.accountIndex,
            address_index: [0]
        });
        return {
            address: response.result.address,
            address_index: 0
        };
    }

    /**
     * Validate a payout address using wallet RPC
     * @param {string} address - The address to validate
     * @returns {Object} - { valid: boolean, integrated: boolean, subaddress: boolean }
     */
    async validateAddress(address) {
        try {
            if (!address || typeof address !== 'string') {
                return { valid: false, error: 'Address is empty or not a string' };
            }

            const response = await this.rpcCall('validate_address', {
                address: address.trim(),
                any_net_type: false // Strict - must match wallet's network
            });

            return {
                valid: response.result?.valid === true,
                integrated: response.result?.integrated === true,
                subaddress: response.result?.subaddress === true,
                nettype: response.result?.nettype
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
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

            // Validate address with wallet RPC before attempting transfer
            const validation = await this.validateAddress(address);
            if (!validation.valid) {
                throw new AppError(`Invalid payout address: ${validation.error || 'validation failed'}`, {
                    safeMessage: 'The payout address is invalid or not recognized by the wallet.'
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

            // Use transfer_split for better output handling — automatically splits
            // across multiple outputs if needed, more resilient than plain transfer
            const response = await this.rpcCall('transfer_split', transferParams);

            // transfer_split returns arrays: tx_hash_list, tx_key_list, fee_list
            const txHash = response.result.tx_hash_list?.[0];
            const txKey = response.result.tx_key_list?.[0];
            const fee = response.result.fee_list?.reduce((a, b) => a + b, 0) || 0;

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('💸 Payout sent successfully', {
                    to: address.substring(0, 10) + '...',
                    amount: normalizedAmount,
                    txHash,
                    fee,
                    txCount: response.result.tx_hash_list?.length || 1
                });
            }

            return {
                success: true,
                txHash,
                txKey,
                fee,
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

    /**
     * Check if a transaction exists in the blockchain or mempool
     * Used by retry service to avoid double-spending
     * @param {string} txHash - The transaction hash to check
     * @returns {Object} - { exists: boolean, confirmed: boolean, in_mempool: boolean }
     */
    async checkTransactionStatus(txHash) {
        try {
            if (!txHash || typeof txHash !== 'string') {
                return { exists: false, confirmed: false, in_mempool: false };
            }

            // Use get_transfer_by_txid to check if transaction exists
            const response = await this.rpcCall('get_transfer_by_txid', {
                txid: txHash,
                account_index: this.accountIndex
            });

            if (response.result?.transfer) {
                const transfer = response.result.transfer;
                return {
                    exists: true,
                    confirmed: transfer.confirmations > 0,
                    in_mempool: transfer.confirmations === 0,
                    confirmations: transfer.confirmations || 0,
                    amount: transfer.amount,
                    fee: transfer.fee
                };
            }

            return { exists: false, confirmed: false, in_mempool: false };
        } catch (error) {
            // If the RPC fails with "Transaction not found" style error, tx doesn't exist
            if (error.message?.includes('not found') || error.details?.message?.includes('not found')) {
                return { exists: false, confirmed: false, in_mempool: false };
            }
            // For other errors, we can't be sure, so throw
            throw error;
        }
    }

    cleanupUserPayments(userId) {
        const addressesToRemove = [];
        for (const [address, userInfo] of this.addressToUser.entries()) {
            if (userInfo.userId === userId || userInfo.socketId === userId) {
                addressesToRemove.push(address);
            }
        }
        for (const address of addressesToRemove) {
            this.stopPaymentMonitoring(address);
            this.addressToUser.delete(address);
            this.addressToSocket.delete(address);
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