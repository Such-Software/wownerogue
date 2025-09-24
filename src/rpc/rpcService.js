/**
 * Enhanced RPC Service with Failover Support
 * Handles blockchain RPC calls with automatic failover and monitoring
 */

const axios = require('axios');

const CONSOLE_LOGGING = true; // Temporarily enable for debugging

class RPCService {
    constructor() {
        this.primaryEndpoint = process.env.PRIMARY_RPC_ENDPOINT || 'http://jw-nodes:18081';
        this.fallbackEndpoint = process.env.FALLBACK_RPC_ENDPOINT || 'http://jw-nodes:18081';
        this.currentEndpoint = this.primaryEndpoint;
        this.failoverActive = false;
        this.lastBlockHeight = 0;
        this.consecutiveFailures = 0;
        this.maxFailures = 3;
        
        if (CONSOLE_LOGGING) {
            console.log(`🔗 RPC Service initialized`);
            console.log(`Primary: ${this.primaryEndpoint}`);
            console.log(`Fallback: ${this.fallbackEndpoint}`);
        }
    }

    /**
     * Make RPC call with automatic failover
     */
    async makeRPCCall(method, params = {}) {
        const request = {
            jsonrpc: '2.0',
            id: '0',
            method: method,
            params: params
        };

        try {
            const response = await axios.post(`${this.currentEndpoint}/json_rpc`, request, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            if (response.data.error) {
                throw new Error(`RPC Error: ${response.data.error.message}`);
            }

            // Reset failure counter on success
            this.consecutiveFailures = 0;
            
            // Switch back to primary if we were using fallback
            if (this.failoverActive && this.currentEndpoint !== this.primaryEndpoint) {
                if (CONSOLE_LOGGING) {
                    console.log('🔄 Switching back to primary RPC endpoint');
                }
                this.currentEndpoint = this.primaryEndpoint;
                this.failoverActive = false;
            }

            return response.data.result;

        } catch (error) {
            this.consecutiveFailures++;
            
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
            const request = {
                jsonrpc: '2.0',
                id: '0',
                method: method,
                params: params
            };

            const response = await axios.post(`${this.currentEndpoint}/json_rpc`, request, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            if (response.data.error) {
                throw new Error(`RPC Error: ${response.data.error.message}`);
            }

            if (CONSOLE_LOGGING) {
                console.log('✅ Failover successful');
            }

            return response.data.result;

        } catch (error) {
            if (CONSOLE_LOGGING) {
                console.error('❌ Failover also failed:', error.message);
            }
            throw new Error('Both primary and fallback RPC endpoints failed');
        }
    }

    /**
     * Get current block height
     */
    async getBlockHeight() {
        try {
            const result = await this.makeRPCCall('getblockcount');
            const blockHeight = result.count;
            
            if (blockHeight !== this.lastBlockHeight) {
                this.lastBlockHeight = blockHeight;
                if (CONSOLE_LOGGING) {
                    console.log(`📊 Block height updated: ${blockHeight}`);
                }
            }
            
            return blockHeight;
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
                hashRate: networkInfo.difficulty / 120, // Approximate hash rate
                networkType: networkInfo.mainnet ? 'mainnet' : 'testnet',
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
            primary: { endpoint: this.primaryEndpoint, status: 'unknown', responseTime: 0 },
            fallback: { endpoint: this.fallbackEndpoint, status: 'unknown', responseTime: 0 },
            current: this.currentEndpoint,
            failoverActive: this.failoverActive,
            consecutiveFailures: this.consecutiveFailures
        };

        // Test primary endpoint
        try {
            const start = Date.now();
            await axios.post(`${this.primaryEndpoint}/json_rpc`, {
                jsonrpc: '2.0',
                id: '0',
                method: 'getblockcount'
            }, { timeout: 5000 });
            checks.primary.status = 'healthy';
            checks.primary.responseTime = Date.now() - start;
        } catch (error) {
            checks.primary.status = 'unhealthy';
            checks.primary.error = error.message;
        }

        // Test fallback endpoint (if different)
        if (this.fallbackEndpoint !== this.primaryEndpoint) {
            try {
                const start = Date.now();
                await axios.post(`${this.fallbackEndpoint}/json_rpc`, {
                    jsonrpc: '2.0',
                    id: '0',
                    method: 'getblockcount'
                }, { timeout: 5000 });
                checks.fallback.status = 'healthy';
                checks.fallback.responseTime = Date.now() - start;
            } catch (error) {
                checks.fallback.status = 'unhealthy';
                checks.fallback.error = error.message;
            }
        } else {
            checks.fallback = checks.primary; // Same endpoint
        }

        return checks;
    }

    /**
     * Get current endpoint status
     */
    getStatus() {
        return {
            currentEndpoint: this.currentEndpoint,
            failoverActive: this.failoverActive,
            consecutiveFailures: this.consecutiveFailures,
            lastBlockHeight: this.lastBlockHeight
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
