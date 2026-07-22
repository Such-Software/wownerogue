/**
 * Enhanced RPC Service with Failover Support
 * Handles blockchain RPC calls with automatic failover and monitoring
 */

const axios = require('axios');
const ChainProfile = require('../chain/chainProfile');

const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';
const KNOWN_NETWORKS = new Set(['mainnet', 'stagenet', 'testnet']);
const GENESIS_HASHES = Object.freeze({
    'XMR:mainnet': '418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3',
    'XMR:stagenet': '76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb',
    'XMR:testnet': '48ca7cd3c8de5b6a4d53d2861fbdaedca141553559f9be9520068053cda8430b',
    'WOW:mainnet': 'a3fd635dd5cb55700317783469ba749b5259f0eeac2420ab2c27eb3ff5ffdc5c'
});
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function normalizeNetwork(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return KNOWN_NETWORKS.has(normalized) ? normalized : null;
}

function expectedDaemonIdentity(cryptoType, network) {
    const normalizedCrypto = String(cryptoType || 'WOW').trim().toUpperCase();
    const normalizedNetwork = normalizeNetwork(network) || 'mainnet';
    const effectiveNetwork = normalizedNetwork;
    return {
        cryptoType: normalizedCrypto,
        network: effectiveNetwork,
        targetSeconds: Math.round(ChainProfile.meanBlockTimeMsFor(normalizedCrypto) / 1000),
        genesisHash: GENESIS_HASHES[`${normalizedCrypto}:${effectiveNetwork}`] || null
    };
}

function daemonIdentityFromInfo(info = {}, genesisHeader = {}) {
    let network = normalizeNetwork(info.nettype || info.network_type);
    if (!network) {
        if (info.stagenet === true) network = 'stagenet';
        else if (info.testnet === true) network = 'testnet';
        else if (info.mainnet === true) network = 'mainnet';
    }

    const rawTarget = info.target ?? info.block_target;
    const targetSeconds = Number(rawTarget);
    const normalizedTarget = Number.isSafeInteger(targetSeconds) && targetSeconds > 0
        ? targetSeconds
        : null;
    const genesisHash = String(genesisHeader?.hash || genesisHeader?.block_header?.hash || '')
        .trim().toLowerCase();
    const knownGenesis = HASH_PATTERN.test(genesisHash)
        ? Object.entries(GENESIS_HASHES).find(([, hash]) => hash === genesisHash)
        : null;
    // nettype/target are useful consistency signals, but only the pinned genesis hash
    // distinguishes XMR mainnet from a Monero-derived mainnet without trusting daemon labels.
    const cryptoType = knownGenesis ? knownGenesis[0].split(':')[0] : null;

    return { cryptoType, network, targetSeconds: normalizedTarget, genesisHash: genesisHash || null };
}

function verifyDaemonIdentity(info, genesisHeader, expected) {
    const actual = daemonIdentityFromInfo(info, genesisHeader);
    const height = Number(info.height ?? info.target_height);
    const status = String(info.status || '').trim().toUpperCase();
    let reason = null;
    const genesisStatus = String(genesisHeader?.status || '').trim().toUpperCase();
    if (status !== 'OK' || genesisStatus !== 'OK'
        || !Number.isSafeInteger(height) || height <= 0
        || info.offline !== false
        || info.untrusted !== false
        || info.synchronized !== true
        || genesisHeader?.untrusted !== false) {
        reason = 'daemon_not_ready';
    } else if (!expected.genesisHash
        || !actual.network || !actual.cryptoType || !actual.targetSeconds || !actual.genesisHash) {
        reason = 'identity_unavailable';
    } else if (actual.genesisHash !== expected.genesisHash
        || actual.cryptoType !== expected.cryptoType
        || actual.targetSeconds !== expected.targetSeconds) {
        reason = 'chain_mismatch';
    } else if (actual.network !== expected.network) {
        reason = 'network_mismatch';
    }
    return {
        verified: reason === null,
        expected: { ...expected },
        actual,
        reason,
        checkedAt: Date.now()
    };
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

class RPCService {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.http = options.http || axios;
        this.primaryEndpoint = options.primaryEndpoint || env.PRIMARY_RPC_ENDPOINT || 'http://127.0.0.1:34568';
        this.fallbackEndpoint = options.fallbackEndpoint || env.FALLBACK_RPC_ENDPOINT || 'http://127.0.0.1:34568';
        this.currentEndpoint = this.primaryEndpoint;
        this.failoverActive = false;
        this.lastBlockHeight = 0;
        this.healthy = false;
        this.lastSuccessAt = 0;
        this.lastFailureAt = 0;
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        this.identityRequired = options.identityRequired === undefined
            ? String(env.NODE_ENV || '').toLowerCase() === 'production'
            : options.identityRequired === true;
        this.expectedIdentity = expectedDaemonIdentity(
            options.cryptoType || env.CRYPTO_TYPE || 'WOW',
            options.network || env.MONERO_NETWORK || 'mainnet'
        );
        this.identityMaxAgeMs = Math.max(1000, Number(options.identityMaxAgeMs) || 30000);
        this.endpointIdentities = new Map();
        this.networkIdentity = {
            verified: false,
            expected: { ...this.expectedIdentity },
            actual: null,
            reason: 'not_checked',
            checkedAt: 0
        };
        
        if (CONSOLE_LOGGING) {
            console.log(`🔗 RPC Service initialized`);
            console.log(`Primary: ${endpointLabel(this.primaryEndpoint)}`);
            console.log(`Fallback: ${endpointLabel(this.fallbackEndpoint)}`);
        }
    }

    async _rawRpcCall(endpoint, method, params = {}, timeout = 10000) {
        const response = await this.http.post(`${endpoint}/json_rpc`, {
            jsonrpc: '2.0',
            id: '0',
            method,
            params
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout
        });
        const data = response && response.data;
        if (!data || data.error || !Object.prototype.hasOwnProperty.call(data, 'result')) {
            const message = data?.error?.message || `Invalid JSON-RPC response for ${method}`;
            throw new Error(message);
        }
        if (method === 'getblockcount') {
            const count = Number(data.result?.count);
            if (!Number.isSafeInteger(count) || count <= 0) {
                throw new Error('Daemon returned an invalid block height.');
            }
        }
        return data.result;
    }

    _recordIdentity(endpoint, identity) {
        this.endpointIdentities.set(endpoint, identity);
        if (endpoint === this.currentEndpoint || identity.verified) {
            this.networkIdentity = identity;
        }
        return identity;
    }

    async _verifyEndpointIdentity(endpoint, { force = false } = {}) {
        const cached = this.endpointIdentities.get(endpoint);
        if (!force && cached?.verified && (Date.now() - cached.checkedAt) <= this.identityMaxAgeMs) {
            return cached;
        }
        let identity;
        try {
            const [info, genesisHeader] = await Promise.all([
                this._rawRpcCall(endpoint, 'get_info', {}, 5000),
                this._rawRpcCall(endpoint, 'get_block_header_by_height', { height: 0 }, 5000)
            ]);
            identity = this._recordIdentity(
                endpoint,
                verifyDaemonIdentity(info, genesisHeader, this.expectedIdentity)
            );
        } catch (error) {
            this._recordIdentity(endpoint, {
                verified: false,
                expected: { ...this.expectedIdentity },
                actual: null,
                reason: 'rpc_unavailable',
                checkedAt: Date.now()
            });
            throw error;
        }
        if (!identity.verified) {
            const error = new Error('Blockchain daemon identity does not match the configured chain/network.');
            error.code = 'DAEMON_IDENTITY_MISMATCH';
            throw error;
        }
        return identity;
    }

    async _ensureCurrentIdentity() {
        if (!this.identityRequired) return null;
        const candidates = [this.currentEndpoint];
        const alternate = this.currentEndpoint === this.primaryEndpoint
            ? this.fallbackEndpoint
            : this.primaryEndpoint;
        if (alternate && alternate !== this.currentEndpoint) candidates.push(alternate);

        let lastError = null;
        for (const endpoint of candidates) {
            try {
                const identity = await this._verifyEndpointIdentity(endpoint);
                if (endpoint !== this.currentEndpoint) {
                    this.currentEndpoint = endpoint;
                    this.failoverActive = endpoint !== this.primaryEndpoint;
                }
                return identity;
            } catch (error) {
                lastError = error;
            }
        }
        this.healthy = false;
        throw lastError || new Error('Blockchain daemon identity could not be verified.');
    }

    /**
     * Make RPC call with automatic failover
     */
    async makeRPCCall(method, params = {}) {
        try {
            await this._ensureCurrentIdentity();
            const result = await this._rawRpcCall(this.currentEndpoint, method, params, 10000);

            // Reset failure counter on success
            this.consecutiveFailures = 0;
            this.healthy = true;
            this.lastSuccessAt = Date.now();
            
            return result;

        } catch (error) {
            this.consecutiveFailures++;
            this.healthy = false;
            this.lastFailureAt = Date.now();
            
            if (CONSOLE_LOGGING) {
                console.error(`❌ RPC call failed (${this.consecutiveFailures}/${this.maxFailures}):`, error.message);
            }

            // Try failover if we haven't exceeded max failures
            if (this.consecutiveFailures >= this.maxFailures && !this.failoverActive) {
                return await this.tryFailover(method, params);
            }

            throw error;
        }
    }

    /**
     * Attempt failover to backup endpoint
     */
    async tryFailover(method, params) {
        if (this.currentEndpoint === this.fallbackEndpoint) {
            throw new Error('Both primary and fallback RPC endpoints failed');
        }

        if (CONSOLE_LOGGING) {
            console.log('🔄 Attempting RPC failover to backup endpoint');
        }

        this.currentEndpoint = this.fallbackEndpoint;
        this.failoverActive = true;
        this.consecutiveFailures = 0;

        try {
            if (this.identityRequired) {
                await this._verifyEndpointIdentity(this.currentEndpoint, { force: true });
            }
            const result = await this._rawRpcCall(this.currentEndpoint, method, params, 10000);

            if (CONSOLE_LOGGING) {
                console.log('✅ Failover successful');
            }

            this.healthy = true;
            this.lastSuccessAt = Date.now();

            return result;

        } catch (error) {
            this.healthy = false;
            this.lastFailureAt = Date.now();
            if (CONSOLE_LOGGING) {
                console.error('❌ Failover also failed:', error.message);
            }
            throw new Error('Both primary and fallback RPC endpoints failed');
        }
    }

    /**
     * Get a fresh daemon block count or throw. Financial fairness callers must never substitute
     * lastBlockHeight because a stale count cannot prove that a committed future block did not
     * exist yet.
     */
    async getBlockCountStrict() {
        const result = await this.makeRPCCall('getblockcount');
        const blockCount = Number(result?.count);
        if (!Number.isSafeInteger(blockCount) || blockCount < 1) {
            throw new Error('Daemon returned an invalid block count');
        }
        if (blockCount !== this.lastBlockHeight) {
            this.lastBlockHeight = blockCount;
            if (CONSOLE_LOGGING) {
                console.log(`📊 Block height updated: ${blockCount}`);
            }
        }
        return blockCount;
    }

    /**
     * Get current block count, retaining the historical cached fallback for non-financial UI and
     * polling callers. Paid match fairness uses getBlockCountStrict() directly.
     */
    async getBlockHeight() {
        try {
            return await this.getBlockCountStrict();
        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error('❌ Failed to get block height:', error.message);
            }
            return this.lastBlockHeight; // Return last known height on failure
        }
    }

    /**
     * Get block information by height
     */
    async getBlockByHeight(height) {
        try {
            return await this.makeRPCCall('get_block', { height });
        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error(`❌ Failed to get block ${height}:`, error.message);
            }
            throw error;
        }
    }

    /**
     * Get network info
     */
    async getNetworkInfo() {
        try {
            const [blockCount, networkInfo] = await Promise.all([
                this.makeRPCCall('getblockcount'),
                this.makeRPCCall('get_info')
            ]);

            return {
                blockHeight: blockCount.count,
                difficulty: networkInfo.difficulty,
                hashRate: networkInfo.difficulty / this.expectedIdentity.targetSeconds,
                networkType: daemonIdentityFromInfo(networkInfo).network,
                status: networkInfo.status
            };
        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error('❌ Failed to get network info:', error.message);
            }
            throw error;
        }
    }

    /**
     * Health check for RPC endpoints
     */
    async healthCheck() {
        const checks = {
            primary: { endpoint: endpointLabel(this.primaryEndpoint), status: 'unknown', responseTime: 0 },
            fallback: { endpoint: endpointLabel(this.fallbackEndpoint), status: 'unknown', responseTime: 0 },
            current: endpointLabel(this.currentEndpoint),
            failoverActive: this.failoverActive,
            consecutiveFailures: this.consecutiveFailures
        };

        const probe = async (endpoint) => {
            const start = Date.now();
            try {
                const count = await this._rawRpcCall(endpoint, 'getblockcount', {}, 5000);
                if (!Number.isSafeInteger(Number(count?.count)) || Number(count.count) <= 0) {
                    throw new Error('Daemon returned an invalid block height.');
                }
                let identity = null;
                try {
                    identity = await this._verifyEndpointIdentity(endpoint, { force: true });
                } catch (error) {
                    identity = this.endpointIdentities.get(endpoint) || null;
                    if (this.identityRequired) throw error;
                }
                return {
                    endpoint: endpointLabel(endpoint),
                    status: 'healthy',
                    responseTime: Date.now() - start,
                    identityVerified: identity?.verified === true,
                    network: identity?.actual?.network || null,
                    cryptoType: identity?.actual?.cryptoType || null
                };
            } catch (_) {
                return {
                    endpoint: endpointLabel(endpoint),
                    status: 'unhealthy',
                    responseTime: Date.now() - start,
                    identityVerified: false
                };
            }
        };

        checks.primary = await probe(this.primaryEndpoint);
        if (this.fallbackEndpoint !== this.primaryEndpoint) {
            checks.fallback = await probe(this.fallbackEndpoint);
        } else {
            checks.fallback = { ...checks.primary };
        }

        checks.healthy = checks.primary.status === 'healthy' || checks.fallback.status === 'healthy';
        if (checks.healthy) {
            const selectedEndpoint = checks.primary.status === 'healthy'
                ? this.primaryEndpoint
                : this.fallbackEndpoint;
            this.currentEndpoint = selectedEndpoint;
            this.failoverActive = selectedEndpoint !== this.primaryEndpoint;
            this.networkIdentity = this.endpointIdentities.get(selectedEndpoint) || this.networkIdentity;
        }
        checks.current = endpointLabel(this.currentEndpoint);
        checks.failoverActive = this.failoverActive;
        checks.identity = this.getIdentityStatus();
        this.healthy = checks.healthy;
        if (checks.healthy) this.lastSuccessAt = Date.now();
        else this.lastFailureAt = Date.now();

        return checks;
    }

    /**
     * Get current endpoint status
     */
    getStatus() {
        return {
            currentEndpoint: endpointLabel(this.currentEndpoint),
            failoverActive: this.failoverActive,
            consecutiveFailures: this.consecutiveFailures,
            lastBlockHeight: this.lastBlockHeight,
            healthy: this.healthy,
            lastSuccessAt: this.lastSuccessAt,
            lastFailureAt: this.lastFailureAt,
            identity: this.getIdentityStatus()
        };
    }

    getIdentityStatus() {
        const identity = this.networkIdentity || {};
        const verified = identity.verified === true
            && (Date.now() - Number(identity.checkedAt || 0)) <= this.identityMaxAgeMs;
        return {
            required: this.identityRequired,
            verified,
            expected: {
                cryptoType: this.expectedIdentity.cryptoType,
                network: this.expectedIdentity.network
            },
            actual: identity.actual ? {
                cryptoType: identity.actual.cryptoType,
                network: identity.actual.network
            } : null,
            reason: identity.reason || 'not_checked',
            checkedAt: Number(identity.checkedAt || 0)
        };
    }

    // Legacy methods for backward compatibility
    async daemonCall(method, params, callback) {
        try {
            const result = await this.makeRPCCall(method, params);
            if (callback) callback(result);
            return result;
        } catch (error) {
            if (callback) callback(null);
            throw error;
        }
    }

    getBlockHeightLegacy() {
        return this.getBlockHeight();
    }
}

module.exports = RPCService;
module.exports.endpointLabel = endpointLabel;
module.exports.GENESIS_HASHES = GENESIS_HASHES;
module.exports.verifyDaemonIdentity = verifyDaemonIdentity;
