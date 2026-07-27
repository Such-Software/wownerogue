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
    // nettype/target are consistency signals only; the pinned genesis hash is what
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

/** Split a comma/whitespace separated endpoint list from configuration. */
function parseEndpointList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    return value.split(/[,\s]+/).map(part => part.trim()).filter(Boolean);
}

/** Trim trailing slashes and drop duplicates while preserving preference order. */
function normalizeEndpointList(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const endpoint = raw.trim().replace(/\/$/, '');
        if (!endpoint || seen.has(endpoint)) continue;
        seen.add(endpoint);
        out.push(endpoint);
    }
    return out.length ? out : ['http://127.0.0.1:34568'];
}

class RPCService {
    constructor(options = {}) {
        const env = options.env || process.env;
        this.http = options.http || axios;
        // Ordered preference list. `RPC_ENDPOINTS` (comma/whitespace separated) declares any number
        // of daemons and, when present, its order is the preference order. PRIMARY/FALLBACK are
        // appended when explicitly configured. The list is deduped so a configuration pointing
        // primary and fallback at the same host does not read as redundancy it does not have.
        const declaredEndpoints = options.endpoints || parseEndpointList(env.RPC_ENDPOINTS);
        const configuredPrimary = options.primaryEndpoint || env.PRIMARY_RPC_ENDPOINT || null;
        const configuredFallback = options.fallbackEndpoint || env.FALLBACK_RPC_ENDPOINT || null;
        this.endpoints = normalizeEndpointList(
            declaredEndpoints.length
                // An explicit list is authoritative: never silently graft the localhost default onto it.
                ? [...declaredEndpoints, configuredPrimary, configuredFallback].filter(Boolean)
                : [configuredPrimary || 'http://127.0.0.1:34568', configuredFallback].filter(Boolean)
        );
        this.primaryEndpoint = configuredPrimary || this.endpoints[0];
        this.fallbackEndpoint = configuredFallback || this.primaryEndpoint;
        this.currentEndpoint = this.endpoints[0];
        this.failoverActive = false;
        // How long to stay on a backup before re-testing the preferred daemon. Without this a single
        // blip pins the process to a degraded node until it restarts.
        this.preferredRetryMs = Math.max(1000, Number(options.preferredRetryMs)
            || Number(env.RPC_PREFERRED_RETRY_MS) || 60000);
        this._preferredProbedAt = 0;
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
            console.log(`Endpoints: ${this.endpoints.map(endpointLabel).join(', ')}`);
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

    /**
     * The order to try endpoints in for one logical call.
     *
     * The current node first, then every other node in declared preference order. Every
     * preferredRetryMs the preferred node takes the first slot instead, so recovery from a blip
     * happens without a restart rather than pinning the process to a backup indefinitely.
     */
    _attemptOrder() {
        const preferred = this.endpoints[0];
        const now = Date.now();
        const retryPreferred = this.currentEndpoint !== preferred
            && (now - this._preferredProbedAt) >= this.preferredRetryMs;
        if (retryPreferred) this._preferredProbedAt = now;
        const first = retryPreferred ? preferred : this.currentEndpoint;
        const order = [first];
        for (const endpoint of this.endpoints) {
            if (endpoint !== first) order.push(endpoint);
        }
        return order;
    }

    _selectEndpoint(endpoint) {
        const wasFailedOver = this.failoverActive;
        this.currentEndpoint = endpoint;
        this.failoverActive = endpoint !== this.endpoints[0];
        // The re-test clock starts at the moment of failover. Left at 0, the next call would
        // re-probe the dead preferred node and pay its timeout on every request.
        if (this.failoverActive && !wasFailedOver) this._preferredProbedAt = Date.now();
        if (!this.failoverActive) this._preferredProbedAt = 0;
    }

    /**
     * Make RPC call with automatic failover
     */
    async makeRPCCall(method, params = {}) {
        const order = this._attemptOrder();
        let lastError = null;

        for (const endpoint of order) {
            try {
                // Identity is verified per ENDPOINT (cached for identityMaxAgeMs): a backup node
                // must prove it is the same chain before it is allowed to answer, or failover
                // becomes a way to silently serve a different chain's data.
                if (this.identityRequired) await this._verifyEndpointIdentity(endpoint);
                const result = await this._rawRpcCall(endpoint, method, params, 10000);

                if (endpoint !== this.currentEndpoint && CONSOLE_LOGGING) {
                    console.log(`🔄 RPC now using ${endpointLabel(endpoint)}`);
                }
                this._selectEndpoint(endpoint);
                this.consecutiveFailures = 0;
                this.healthy = true;
                this.lastSuccessAt = Date.now();
                return result;
            } catch (error) {
                lastError = error;
                if (CONSOLE_LOGGING) {
                    console.error(`❌ RPC ${method} failed on ${endpointLabel(endpoint)}:`, error.message);
                }
            }
        }

        // Every configured node refused or was unreachable. Callers must degrade gracefully from
        // here: nothing downstream may treat a stale cached height as live chain state.
        this.consecutiveFailures++;
        this.healthy = false;
        this.lastFailureAt = Date.now();
        throw lastError
            || new Error(`No blockchain daemon answered (${this.endpoints.length} endpoint(s) tried).`);
    }

    /**
     * Alias for callers that explicitly ask for a failover attempt. makeRPCCall already walks every
     * configured endpoint within a single call, so this is that same walk.
     */
    async tryFailover(method, params) {
        return this.makeRPCCall(method, params);
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
     * Get current block count, falling back to the last known height for non-financial UI and
     * polling callers. Paid match fairness uses getBlockCountStrict() directly.
     */
    async getBlockHeight() {
        try {
            return await this.getBlockCountStrict();
        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error('❌ Failed to get block height:', error.message);
            }
            return this.lastBlockHeight;
        }
    }

    /**
     * Cosmetic chain tip (top block hash + difficulty) for the Tavern's ambient chain display.
     *
     * Deliberately non-authoritative: it never throws and never feeds fairness, payouts, or match
     * seeding. Those use getBlockCountStrict()/matchFairness, which must not accept a cached or
     * best-effort value. On any RPC failure this returns null and the UI shows nothing new.
     */
    async getChainTipInfo() {
        try {
            const info = await this.makeRPCCall('get_info');
            const hash = typeof info?.top_block_hash === 'string' ? info.top_block_hash : null;
            return {
                hash: hash && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null,
                difficulty: Number.isFinite(Number(info?.difficulty)) ? Number(info.difficulty) : null,
                txPoolSize: Number.isFinite(Number(info?.tx_pool_size)) ? Number(info.tx_pool_size) : null
            };
        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error('❌ Failed to get chain tip info:', error.message);
            }
            return null;
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

        // Probe every configured node, in preference order, and adopt the first healthy one.
        checks.endpoints = [];
        let selectedEndpoint = null;
        for (const endpoint of this.endpoints) {
            const result = await probe(endpoint);
            checks.endpoints.push(result);
            if (!selectedEndpoint && result.status === 'healthy') selectedEndpoint = endpoint;
        }

        // `primary` / `fallback` stay in the payload for readiness consumers that read those keys.
        const byEndpoint = new Map(this.endpoints.map((e, i) => [e, checks.endpoints[i]]));
        checks.primary = byEndpoint.get(this.primaryEndpoint) || checks.primary;
        checks.fallback = byEndpoint.get(this.fallbackEndpoint) || { ...checks.primary };

        checks.healthy = selectedEndpoint !== null;
        checks.healthyCount = checks.endpoints.filter(e => e.status === 'healthy').length;
        if (checks.healthy) {
            this._selectEndpoint(selectedEndpoint);
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
            endpoints: this.endpoints.map(endpointLabel),
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
