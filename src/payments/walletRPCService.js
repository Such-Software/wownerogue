const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { ExternalServiceError, AppError } = require('../utils/errors');
const money = require('../money/atomic');
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const { DigestAuthClient } = require('./digestAuth');
const XMR_ADDRESS_PATTERN = /^(?:4|8|5|7|9|B)[1-9A-HJ-NP-Za-km-z]{90,110}$/;
const WOW_ADDRESS_PATTERN = /^(?:(?:Wo|WO|ww|WW)[0-9A-Za-z]{88,112}|W[0-9A-Za-z]{90,112})$/;
const KNOWN_NETWORKS = new Set(['mainnet', 'stagenet', 'testnet']);

function normalizeNetwork(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return KNOWN_NETWORKS.has(normalized) ? normalized : null;
}

function endpointLabel(value) {
    try {
        const endpoint = new URL(value);
        endpoint.username = '';
        endpoint.password = '';
        return endpoint.toString().replace(/\/$/, '');
    } catch (_) {
        return '[invalid endpoint]';
    }
}

function cryptoTypeFromAddress(address) {
    const value = String(address || '').trim();
    if (XMR_ADDRESS_PATTERN.test(value)) return 'XMR';
    if (WOW_ADDRESS_PATTERN.test(value)) return 'WOW';
    return null;
}

class WalletRPCService {
    constructor(debugManager, options = {}) {
        const env = options.env || process.env;
        this.debugManager = debugManager;
        this.http = options.http || axios;
        this.walletEndpoint = options.walletEndpoint || env.PRIMARY_WALLET_ENDPOINT || 'http://127.0.0.1:34570';
        this.authRequired = options.authRequired === undefined
            ? String(env.NODE_ENV || '').toLowerCase() === 'production'
            : options.authRequired === true;
        const rpcUser = options.rpcUser || env.WALLET_RPC_USER;
        const rpcPassword = options.rpcPassword || env.WALLET_RPC_PASSWORD;
        // Monero wallet-rpc uses HTTP Digest auth. Keep unauthenticated mode available for
        // development fixtures; production validation requires an intentional protected setup.
        this.walletAuth = rpcUser && rpcPassword
            ? { username: rpcUser, password: rpcPassword }
            : null;
        this.rpcHttp = this.walletAuth
            ? new DigestAuthClient(this.http, this.walletAuth)
            : this.http;
        this.authMaxAgeMs = Math.max(1000, Number(options.authMaxAgeMs) || 30000);
        this.authentication = {
            verified: false,
            reason: this.walletAuth ? 'not_checked' : 'credentials_missing',
            checkedAt: 0
        };
        this.accountIndex = 0;
        this.paymentWatchers = new Map();
        this.addressToUser = new Map();
        this.addressToSocket = new Map();
        this.isHealthy = false;
        this.lastHealthSuccessAt = 0;
        this.lastHealthFailureAt = 0;
        const configuredCrypto = String(options.cryptoType || env.CRYPTO_TYPE || 'WOW').trim().toUpperCase();
        const configuredNetwork = normalizeNetwork(options.network || env.MONERO_NETWORK) || 'mainnet';
        this.expectedIdentity = {
            cryptoType: configuredCrypto,
            network: configuredNetwork
        };
        this.identityRequired = options.identityRequired === undefined
            ? String(env.NODE_ENV || '').toLowerCase() === 'production'
            : options.identityRequired === true;
        this.identityMaxAgeMs = Math.max(1000, Number(options.identityMaxAgeMs) || 30000);
        this.networkIdentity = {
            verified: false,
            expected: { ...this.expectedIdentity },
            actual: null,
            reason: 'not_checked',
            checkedAt: 0
        };
        // The production composition root replaces this with the single payout/readiness
        // predicate. Isolated diagnostics and the explicitly guarded stagenet canary retain the
        // legacy default unless they deliberately inject a stricter boundary.
        this.transferAllowed = typeof options.transferAllowed === 'function'
            ? options.transferAllowed
            : () => true;
        const configuredConfirmations = Number(options.minConfirmations ?? 1);
        this.minConfirmations = Number.isSafeInteger(configuredConfirmations)
            && configuredConfirmations >= 1 ? configuredConfirmations : 1;
    }

    async initialize() {
        try {
            await this.ensureAuthentication({ force: true });
            // Test wallet connection
            const response = await this.rpcCall('get_version');
            if (!response?.result) throw new Error('Wallet version response is invalid.');
            
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('✅ Wallet RPC service initialized:', {
                    version: response.result?.version || 'unknown'
                });
            }
            
            // Get wallet height to ensure it's synced
            const heightResponse = await this.rpcCall('get_height');
            const height = Number(heightResponse.result?.height);
            if (!Number.isSafeInteger(height) || height <= 0) {
                throw new Error('Wallet returned an invalid height.');
            }
            const identity = await this.verifyNetworkIdentity({ force: true });
            if (this.identityRequired && !identity.verified) {
                throw this._identityError();
            }
            // Transport success alone must not revive a production wallet that failed identity
            // verification. initialize()/ensureNetworkIdentity() promote it after verification.
            this.isHealthy = (!this.identityRequired || this.isIdentityFresh())
                && (!this.authRequired || this.isAuthenticationFresh());
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log('📊 Wallet height:', height);
            }
            
            return true;
        } catch (error) {
            this.isHealthy = false;
            console.error('❌ Wallet RPC initialization failed:', error?.code || 'wallet_unavailable');
            return false;
        }
    }

    _identityError() {
        return new ExternalServiceError('Wallet identity does not match the configured chain/network.', {
            code: 'WALLET_IDENTITY_MISMATCH',
            safeMessage: 'Wallet service is unavailable due to a network configuration mismatch.'
        });
    }

    _authenticationError(reason = this.authentication.reason) {
        const notEnforced = reason === 'not_enforced';
        return new ExternalServiceError(
            notEnforced
                ? 'Wallet RPC does not enforce configured Digest authentication.'
                : 'Wallet RPC authentication could not be verified.',
            {
                statusCode: 503,
                code: notEnforced ? 'WALLET_RPC_AUTH_NOT_ENFORCED' : 'WALLET_RPC_AUTH_UNVERIFIED',
                safeMessage: 'Wallet service authentication is unavailable.'
            }
        );
    }

    async ensureAuthentication({ force = false } = {}) {
        if (!this.authRequired) return this.authentication;
        if (!this.walletAuth || typeof this.rpcHttp?.verifyEnforced !== 'function') {
            this.authentication = {
                verified: false,
                reason: 'credentials_missing',
                checkedAt: Date.now()
            };
            this.isHealthy = false;
            throw this._authenticationError();
        }
        if (!force && this.isAuthenticationFresh()) return this.authentication;

        const url = `${this.walletEndpoint}/json_rpc`;
        const body = { jsonrpc: '2.0', id: 'auth-probe', method: 'get_version', params: {} };
        const requestConfig = {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        };
        try {
            await this.rpcHttp.verifyEnforced(url, body, requestConfig);
            const authenticated = await this.rpcHttp.post(url, body, requestConfig);
            if (!authenticated?.data?.result || authenticated.data.error) {
                throw new Error('Authenticated wallet version response is invalid.');
            }
            this.authentication = {
                verified: true,
                reason: null,
                checkedAt: Date.now()
            };
            return this.authentication;
        } catch (error) {
            const reason = error?.code === 'WALLET_RPC_AUTH_NOT_ENFORCED'
                ? 'not_enforced'
                : 'unverified';
            this.authentication = {
                verified: false,
                reason,
                checkedAt: Date.now()
            };
            this.isHealthy = false;
            throw this._authenticationError(reason);
        }
    }

    isAuthenticationFresh() {
        return this.authentication.verified === true
            && (Date.now() - this.authentication.checkedAt) <= this.authMaxAgeMs;
    }

    async verifyNetworkIdentity({ force = false } = {}) {
        if (!force && this.networkIdentity.verified
            && (Date.now() - this.networkIdentity.checkedAt) <= this.identityMaxAgeMs) {
            return this.networkIdentity;
        }

        try {
            const addressResponse = await this.rpcCall('get_address', {
                account_index: this.accountIndex,
                address_index: [0]
            });
            // The primary address is used only in this stack frame. Never retain it in health
            // state or logs; it is identity evidence, not public diagnostics.
            const address = String(addressResponse.result?.address
                || addressResponse.result?.addresses?.[0]?.address || '').trim();
            const validationResponse = await this.rpcCall('validate_address', {
                address,
                any_net_type: true
            });
            const validation = validationResponse.result || {};
            const actual = {
                cryptoType: cryptoTypeFromAddress(address),
                network: normalizeNetwork(validation.nettype)
            };
            let reason = null;
            if (validation.valid !== true || !actual.cryptoType || !actual.network) {
                reason = 'identity_unavailable';
            } else if (actual.cryptoType !== this.expectedIdentity.cryptoType) {
                reason = 'chain_mismatch';
            } else if (actual.network !== this.expectedIdentity.network) {
                reason = 'network_mismatch';
            }
            this.networkIdentity = {
                verified: reason === null,
                expected: { ...this.expectedIdentity },
                actual,
                reason,
                checkedAt: Date.now()
            };
            if (this.identityRequired && reason) this.isHealthy = false;
            return this.networkIdentity;
        } catch (error) {
            this.networkIdentity = {
                verified: false,
                expected: { ...this.expectedIdentity },
                actual: null,
                reason: 'rpc_unavailable',
                checkedAt: Date.now()
            };
            throw error;
        }
    }

    async ensureNetworkIdentity({ force = false } = {}) {
        await this.ensureAuthentication({ force });
        if (!this.identityRequired) return this.networkIdentity;
        let identity;
        try {
            identity = await this.verifyNetworkIdentity({ force });
        } catch (_) {
            this.isHealthy = false;
            throw this._identityError();
        }
        if (!identity.verified) {
            this.isHealthy = false;
            throw this._identityError();
        }
        this.isHealthy = true;
        return identity;
    }

    _assertTransferAllowed() {
        if (!this.transferAllowed()) {
            throw new AppError('Wallet transfer blocked by the payout safety gate.', {
                statusCode: 503,
                code: 'PAYOUT_DISPATCH_DISABLED',
                safeMessage: 'Payout transfers are currently disabled.'
            });
        }
    }

    getIdentityStatus() {
        return {
            required: this.identityRequired,
            verified: this.isIdentityFresh(),
            expected: { ...this.expectedIdentity },
            actual: this.networkIdentity.actual ? { ...this.networkIdentity.actual } : null,
            reason: this.networkIdentity.reason || 'not_checked',
            checkedAt: Number(this.networkIdentity.checkedAt || 0)
        };
    }

    isIdentityFresh() {
        return this.networkIdentity.verified === true
            && (Date.now() - this.networkIdentity.checkedAt) <= this.identityMaxAgeMs;
    }

    async rpcCall(method, params = {}) {
        try {
            const requestConfig = {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            };

            const response = await this.rpcHttp.post(`${this.walletEndpoint}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: method,
                params: params
            }, requestConfig);

            if (response.data.error) {
                throw new ExternalServiceError(`Wallet RPC responded with error for method ${method}`, {
                    safeMessage: 'Wallet RPC call failed.',
                    details: response.data.error,
                    cause: response.data.error
                });
            }

            this.isHealthy = (!this.identityRequired || this.isIdentityFresh())
                && (!this.authRequired || this.isAuthenticationFresh());
            this.lastHealthSuccessAt = Date.now();

            return response.data;
        } catch (error) {
            this.isHealthy = false;
            this.lastHealthFailureAt = Date.now();
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
            await this.ensureNetworkIdentity();
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
            await this.ensureNetworkIdentity();
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

            // `get_transfers` supplies transaction state (pool, double-spend, timelock and
            // confirmation metadata), but it does not expose a stable identity for each owned
            // output. `incoming_transfers` supplies that output-level identity (`pubkey` and
            // `global_index`). Entitlements require both views to agree for this subaddress.
            const response = await this.rpcCall('get_transfers', {
                in: true,
                pending: true,
                failed: false,
                pool: true,
                account_index: userInfo.accountIndex,
                subaddr_indices: [userInfo.addressIndex]
            });
            const outputResponse = await this.rpcCall('incoming_transfers', {
                transfer_type: 'all',
                account_index: userInfo.accountIndex,
                subaddr_indices: [userInfo.addressIndex]
            });

            let confirmedReceived = 0n;
            let poolReceived = 0n;
            let inMempool = false;
            let confirmed = false;
            let confirmations = 0;
            const confirmedReceipts = new Map();
            const receiptAddressIndex = (tx) => {
                const raw = tx?.subaddr_index;
                if (Number.isInteger(raw) && raw >= 0) return raw;
                if (raw && Number.isInteger(raw.minor) && raw.minor >= 0) return raw.minor;
                return null;
            };
            const receiptAccountIndex = (tx) => {
                const raw = tx?.subaddr_index;
                return raw && Number.isInteger(raw.major) && raw.major >= 0 ? raw.major : null;
            };
            const receiptOutputId = (tx) => {
                const pubkey = String(tx?.pubkey || '').trim().toLowerCase();
                if (/^[0-9a-f]{64}$/.test(pubkey)) return pubkey;
                const globalIndex = tx?.global_index;
                if (typeof globalIndex === 'number' && !Number.isSafeInteger(globalIndex)) return null;
                const canonical = String(globalIndex ?? '').trim();
                if (!/^\d+$/.test(canonical)) return null;
                const parsed = BigInt(canonical);
                if (parsed > 18446744073709551615n) return null;
                return `global:${parsed.toString()}`;
            };
            const hasSafeUnlockTime = (tx) => {
                if (tx?.unlock_time == null) return false;
                const raw = tx.unlock_time;
                if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw === 0;
                if (typeof raw === 'bigint') return raw === 0n;
                const canonical = String(raw).trim();
                return /^\d+$/.test(canonical) && BigInt(canonical) === 0n;
            };
            const belongsToRequestedSubaddress = (tx) => {
                const direct = receiptAddressIndex(tx);
                if (direct !== null) return direct === userInfo.addressIndex;
                const indices = Array.isArray(tx?.subaddr_indices) ? tx.subaddr_indices : [];
                return indices.some(index => {
                    if (Number.isInteger(index)) return index === userInfo.addressIndex;
                    return index && Number.isInteger(index.minor)
                        && index.minor === userInfo.addressIndex
                        && (!Number.isInteger(index.major) || index.major === userInfo.accountIndex);
                });
            };

            // Check pending (mempool) transactions
            if (response.result?.pool && response.result.pool.length > 0) {
                for (const tx of response.result.pool) {
                    poolReceived += money.toBig(tx.amount);
                    inMempool = true;
                    
                    // Mark as detected if this is first time seeing it
                    if (!userInfo.detected) {
                        userInfo.detected = true;
                        if (this.debugManager?.CONSOLE_LOGGING) {
                            console.log(`🎯 Payment detected (mempool):`, {
                                address: address.substring(0, 10) + '...',
                                amount: money.toSafe(money.toBig(tx.amount)),
                                txid: tx.txid
                            });
                        }
                    }
                }
            }

            // Build a fail-closed transaction-state index. A chain output is never enough on its
            // own: its transaction must also appear as a safe, mined incoming transfer for the
            // exact requested subaddress.
            const confirmedTx = new Map();
            for (const tx of (response.result?.in || [])) {
                const txHash = String(tx?.txid || '').trim().toLowerCase();
                const height = Number(tx?.height);
                const accountIndex = receiptAccountIndex(tx);
                const reportedConfirmations = Number(tx?.confirmations);
                let transactionAmount = null;
                try { transactionAmount = money.toBig(tx?.amount); } catch (_) { /* rejected below */ }
                if (!TX_HASH_PATTERN.test(txHash)
                    || !belongsToRequestedSubaddress(tx)
                    || (accountIndex !== null && accountIndex !== userInfo.accountIndex)
                    || tx?.double_spend_seen !== false
                    || !hasSafeUnlockTime(tx)
                    || !Number.isSafeInteger(height) || height <= 0
                    || !Number.isSafeInteger(reportedConfirmations)
                    || reportedConfirmations < this.minConfirmations
                    || transactionAmount === null || transactionAmount <= 0n) {
                    continue;
                }
                confirmedTx.set(txHash, {
                    height,
                    confirmations: reportedConfirmations,
                    remainingAmount: transactionAmount
                });
            }

            for (const output of (outputResponse.result?.transfers || [])) {
                const txHash = String(output?.tx_hash || '').trim().toLowerCase();
                const txState = confirmedTx.get(txHash);
                const addressIndex = receiptAddressIndex(output);
                const accountIndex = receiptAccountIndex(output);
                const outputId = receiptOutputId(output);
                const blockHeight = Number(output?.block_height);
                if (!txState
                    || addressIndex !== userInfo.addressIndex
                    || (accountIndex !== null && accountIndex !== userInfo.accountIndex)
                    || !outputId
                    || !Number.isSafeInteger(blockHeight) || blockHeight <= 0
                    || blockHeight !== txState.height
                    || output?.frozen === true) {
                    continue;
                }
                const amount = money.toBig(output.amount);
                if (amount <= 0n || amount > txState.remainingAmount) continue;
                const receiptKey = `${txHash}:${outputId}`;
                // RPC responses may repeat the same output; replaying identical evidence must
                // never increase confirmed coverage.
                if (confirmedReceipts.has(receiptKey)) continue;
                confirmedReceipts.set(receiptKey, {
                    evidenceType: 'chain_output',
                    evidenceId: receiptKey,
                    providerId: 'native-monero',
                    txHash,
                    outputId,
                    addressIndex,
                    amount: amount.toString(),
                    confirmed: true
                });
                confirmedReceived += amount;
                txState.remainingAmount -= amount;
            }

            confirmed = confirmedReceipts.size > 0;
            if (confirmed) {
                // Report the least-confirmed counted receipt, never the oldest/top value.
                const depths = Array.from(confirmedReceipts.values()).map(receipt => {
                    const state = confirmedTx.get(receipt.txHash);
                    return state.confirmations;
                });
                confirmations = Math.min(...depths);
                if (!userInfo.confirmed) {
                    userInfo.confirmed = true;
                    if (this.debugManager?.CONSOLE_LOGGING) {
                        console.log(`✅ Payment included in block (confirmed):`, {
                            address: address.substring(0, 10) + '...',
                            confirmations,
                            txid: Array.from(confirmedReceipts.values())[0].txHash
                        });
                    }
                }
            }

            const requiredAmount = money.toBig(userInfo.amount);
            // Pool transfers are useful detection/UI evidence only. Entitlements are authorized
            // exclusively by confirmed receipts, so an old 1-atomic confirmed transfer plus an
            // unconfirmed pool top-up can never satisfy the invoice.
            const paymentComplete = confirmedReceived >= requiredAmount;
            const receipts = Array.from(confirmedReceipts.values())
                .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

            return {
                complete: paymentComplete,
                in_mempool: inMempool,
                confirmed: confirmed,
                amount: money.toSafe(confirmedReceived),
                observedAmount: money.toSafe(confirmedReceived + poolReceived),
                pendingAmount: money.toSafe(poolReceived),
                confirmations: confirmations,
                required: money.toSafe(requiredAmount),
                txHash: receipts[0]?.txHash || null,
                receipts
            };
        } catch (error) {
            // Axios/Digest errors retain request configuration, including Authorization. Never
            // inspect the whole object in logs; rpcCall already records a credential-free label.
            console.error('❌ Failed to check payment status:', error?.message || 'wallet RPC failure');
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
        this._assertTransferAllowed();
        if (!destinations || destinations.length === 0) {
            throw new AppError('No destinations provided for batch payout', {
                safeMessage: 'Batch payout requires at least one destination.'
            });
        }
        await this.ensureNetworkIdentity();

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
                totalAmount: money.sum(destinations.map(d => d.amount)).toString(),
                destinations: destinations.map(d => d.address.substring(0, 10) + '...')
            });
        }

        // Address validation may take several RPC round trips. Recheck at the last possible
        // point before transfer_split can broadcast.
        this._assertTransferAllowed();
        const response = await this.rpcCall('transfer_split', transferParams);

        const hashes = Array.isArray(response.result?.tx_hash_list)
            ? response.result.tx_hash_list.map(hash => String(hash || '').trim())
            : [];
        if (hashes.length === 0 || hashes.some(hash => !TX_HASH_PATTERN.test(hash))) {
            // The RPC call may already have broadcast. Never manufacture success without
            // durable chain evidence; callers move the claimed rows to manual review.
            throw new ExternalServiceError('Wallet returned no valid transaction-hash evidence', {
                safeMessage: 'The payout transfer requires manual wallet reconciliation.'
            });
        }

        const result = {
            success: true,
            tx_hash_list: hashes,
            tx_key_list: response.result.tx_key_list || [],
            fee_list: response.result.fee_list || [],
            totalFee: money.toSafe(money.sum(response.result.fee_list || []))
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

        let exact;
        try {
            exact = money.toBig(value);
        } catch (_) {
            throw new AppError('Payout amount must be a positive number', {
                safeMessage: 'Invalid payout amount supplied.'
            });
        }
        if (exact <= 0n) {
            throw new AppError('Payout amount rounded below minimum atomic unit', {
                safeMessage: 'Invalid payout amount supplied.'
            });
        }
        return money.toSafe(exact);
    }

    /**
     * Get wallet balance for admin monitoring
     * @returns {Object} - { balance: bigint, unlocked_balance: bigint } in atomic units
     */
    async getBalance() {
        try {
            await this.ensureNetworkIdentity();
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
        await this.ensureNetworkIdentity();
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
            await this.ensureNetworkIdentity();
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
            this._assertTransferAllowed();
            if (!address || typeof address !== 'string') {
                throw new AppError('Payout address was not provided or invalid', {
                    safeMessage: 'Invalid payout address supplied.'
                });
            }
            await this.ensureNetworkIdentity();

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

            this._assertTransferAllowed();
            // Use transfer_split for better output handling — automatically splits
            // across multiple outputs if needed, more resilient than plain transfer
            const response = await this.rpcCall('transfer_split', transferParams);

            // transfer_split returns arrays: tx_hash_list, tx_key_list, fee_list
            const txHashes = Array.isArray(response.result?.tx_hash_list)
                ? response.result.tx_hash_list.map(hash => String(hash || '').trim())
                : [];
            if (txHashes.length !== 1 || !TX_HASH_PATTERN.test(txHashes[0])) {
                // One payout row must map to exactly one valid hash. transfer_split may have
                // broadcast already, so this is deliberately an ambiguous failure and must not
                // be automatically retried by callers.
                throw new ExternalServiceError('Wallet returned ambiguous transaction-hash evidence', {
                    safeMessage: 'The payout transfer requires manual wallet reconciliation.'
                });
            }
            const txHash = txHashes[0];
            const txKey = response.result.tx_key_list?.length === 1
                ? response.result.tx_key_list[0]
                : null;
            const fee = money.toSafe(money.sum(response.result.fee_list || []));

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
            await this.ensureNetworkIdentity();
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
            healthy: this.isHealthy
                && (!this.identityRequired || this.isIdentityFresh())
                && (!this.authRequired || this.isAuthenticationFresh()),
            endpoint: endpointLabel(this.walletEndpoint),
            activeMonitors: this.paymentWatchers.size,
            pendingPayments: this.addressToUser.size,
            identity: this.getIdentityStatus(),
            authentication: {
                required: this.authRequired,
                verified: this.isAuthenticationFresh(),
                reason: this.authentication.reason || null,
                checkedAt: Number(this.authentication.checkedAt || 0)
            }
        };
    }
}

module.exports = WalletRPCService;
module.exports.cryptoTypeFromAddress = cryptoTypeFromAddress;
module.exports.endpointLabel = endpointLabel;
