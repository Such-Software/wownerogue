/**
 * Debug Manager Module
 * Handles debug functionality and simulated block height logic for development
 * Keeps debug/development code separate from production logic
 */

const rpc = require('../rpc/rpccalls.js');
const packageConfig = require('../package.json');

class DebugManager {
    constructor(broadcastManager) {
        this.broadcastManager = broadcastManager;
        
        // Environment-based configuration
        const nodeEnv = process.env.NODE_ENV || 'production';
        this.IS_PRODUCTION = nodeEnv === 'production';
        this.IS_DEBUG = nodeEnv === 'debug';
        this.IS_DEVELOPMENT = nodeEnv === 'development';
        
    // Debug mode is enabled in development or debug environments
    this.DEBUG_MODE = this.IS_DEBUG || this.IS_DEVELOPMENT;
        
    // Configuration precedence:
    // 1. Explicit env overrides
    // 2. Package.json config
    const config = this.IS_PRODUCTION ? packageConfig.config.production : packageConfig.config.debug;
    this.CONSOLE_LOGGING = process.env.CONSOLE_LOGGING ? process.env.CONSOLE_LOGGING === 'true' : (config.console_logging || this.DEBUG_MODE);
    this.DEBUG_HOTKEYS = process.env.DEBUG_HOTKEYS ? process.env.DEBUG_HOTKEYS === 'true' : (config.debug_hotkeys || this.DEBUG_MODE);
    // Simulation can be force-disabled by BLOCK_SOURCE=daemon or GAME_MODE paid modes
    const forceSimFlag = process.env.FORCE_SIMULATED_BLOCKS === 'true';
    const blockSource = (process.env.BLOCK_SOURCE || '').toLowerCase(); // 'daemon' | 'simulated'
    let simulatedDefault = config.simulated_blocks || this.DEBUG_MODE;
    if (blockSource === 'daemon') simulatedDefault = false;
    // In paid modes always use real daemon unless explicitly forced (for test)
    const paidMode = ['PAID_SINGLE','PAID_CREDITS'].includes(process.env.GAME_MODE);
    if (paidMode && !forceSimFlag) simulatedDefault = false;
    this.SIMULATED_BLOCKS = process.env.SIMULATED_BLOCKS ? process.env.SIMULATED_BLOCKS === 'true' : simulatedDefault;
        
        this.debugBlockHeight = 1;
        this.debugInterval = null;
        this.statusInterval = null;
        this.lastProductionBlockHeight = 0;
        
        // Log configuration on startup
        this.logConfig();
    }

    // ====== CONFIGURATION LOGGING ======

    /**
     * Log current configuration settings
     */
    logConfig() {
        if (this.CONSOLE_LOGGING) {
            console.log("🔧 DEBUG MANAGER CONFIGURATION:");
            console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'production'}`);
            console.log(`  DEBUG_MODE: ${this.DEBUG_MODE}`);
            console.log(`  CONSOLE_LOGGING: ${this.CONSOLE_LOGGING}`);
            console.log(`  DEBUG_HOTKEYS: ${this.DEBUG_HOTKEYS}`);
            console.log(`  SIMULATED_BLOCKS: ${this.SIMULATED_BLOCKS}`);
            if (process.env.GAME_MODE && ['PAID_SINGLE','PAID_CREDITS'].includes(process.env.GAME_MODE)) {
                console.log(`  GAME_MODE: ${process.env.GAME_MODE} (simulation ${this.SIMULATED_BLOCKS ? 'ENABLED' : 'DISABLED'})`);
            }
        }
    }

    // ====== INITIALIZATION ======

    /**
     * Initialize debug mode or production mode
     */
    initialize() {
        if (this.SIMULATED_BLOCKS) {
            this.initializeDebugMode();
        } else {
            this.initializeProductionMode();
        }
    }

    /**
     * Initialize debug mode with simulated blocks
     */
    initializeDebugMode() {
        if (this.CONSOLE_LOGGING) {
            console.log("🐛 DEBUG MODE ENABLED - Simulating blocks every 30 seconds");
        }
        
    // Initial debug block broadcast
    this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
        
        // Debug block height simulator - advances every 30 seconds
        this.debugInterval = setInterval(() => {
            this.debugBlockHeight++;
            if (this.CONSOLE_LOGGING) {
                console.log(`🐛 DEBUG: New simulated block: ${this.debugBlockHeight}`);
            }
            this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
            
            // Notify listeners about new block
            this.onNewBlock(this.debugBlockHeight);
            
        }, 30000); // Every 30 seconds
        
        // Regular status broadcasting - sends current block height every 5 seconds
        // This ensures all clients stay up-to-date even if they miss a block change
        this.statusInterval = setInterval(() => {
            this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
        }, 5000); // Every 5 seconds
    }

    /**
     * Initialize production mode with real blockchain calls
     */
    initializeProductionMode() {
        if (this.CONSOLE_LOGGING) {
            console.log("🚀 PRODUCTION MODE ENABLED - Using real blockchain RPC calls");
        }
        
        // Initialize RPC service if available
        const RpcService = require('../rpc/rpcService');
        this.rpcService = new RpcService();
        
        // Real blockchain monitoring with new RPC service
        const poll = async () => {
            try {
                const currentHeight = await this.rpcService.getBlockHeight();
                
                if (!currentHeight) {
                    if (this.CONSOLE_LOGGING) {
                        console.log("❌ Failed to get block count from daemon");
                    }
                    return;
                }
                
                // Always broadcast current height to keep clients updated
                this.broadcastManager.broadcastBlockHeight(currentHeight);
                
                // If new block found
                if (currentHeight > this.lastProductionBlockHeight) {
                    if (this.CONSOLE_LOGGING) {
                        console.log(`⛏️ New block found: ${currentHeight}`);
                    }
                    
                    // Notify listeners about new block
                    this.onNewBlock(currentHeight);
                    
                    this.lastProductionBlockHeight = currentHeight;
                }
            } catch (error) {
                if (this.CONSOLE_LOGGING) {
                    console.error("❌ RPC Error:", error.message);
                }
                
                // Fallback to legacy RPC if new service fails
                rpc.daemonCall("get_block_count", "", (result) => {
                    if (result && result.result && result.result.count) {
                        const currentHeight = result.result.count;
                        this.broadcastManager.broadcastBlockHeight(currentHeight);
                        
                        if (currentHeight > this.lastProductionBlockHeight) {
                            this.onNewBlock(currentHeight);
                            this.lastProductionBlockHeight = currentHeight;
                        }
                    }
                });
            }
        };
        // immediate first poll so UI shows real height quickly
        poll();
        this.debugInterval = setInterval(poll, 2000); // Every 2 seconds
    }

    // ====== BLOCK HEIGHT MANAGEMENT ======

    /**
     * Get the current block height (debug or production)
     * @returns {number} Current block height
     */
    getCurrentBlockHeight() {
        if (this.SIMULATED_BLOCKS) return this.debugBlockHeight;
        return this.lastProductionBlockHeight;
    }

    /**
     * Set debug block height (debug mode only)
     * @param {number} height - New block height
     */
    setDebugBlockHeight(height) {
        if (this.DEBUG_MODE) {
            this.debugBlockHeight = height;
            if (this.CONSOLE_LOGGING) {
                console.log(`🐛 DEBUG: Block height set to: ${height}`);
            }
            this.broadcastManager.broadcastBlockHeight(height);
        } else if (this.CONSOLE_LOGGING) {
            console.warn("Cannot set debug block height in production mode");
        }
    }

    /**
     * Advance debug block height by one (debug mode only)
     */
    advanceDebugBlock() {
        if (this.DEBUG_MODE) {
            this.debugBlockHeight++;
            if (this.CONSOLE_LOGGING) {
                console.log(`🐛 DEBUG: Manually advanced block to: ${this.debugBlockHeight}`);
            }
            this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
            this.onNewBlock(this.debugBlockHeight);
        } else if (this.CONSOLE_LOGGING) {
            console.warn("Cannot advance debug block in production mode");
        }
    }

    // ====== EVENT HANDLING ======

    /**
     * Called when a new block is detected (debug or production)
     * Override this method or set callbacks to handle new blocks
     * @param {number} blockHeight - The new block height
     */
    onNewBlock(blockHeight) {
        // This method can be overridden or have callbacks registered
        if (this.CONSOLE_LOGGING) {
            console.log(`📦 New block detected: ${blockHeight}`);
        }
        
        // Call registered callbacks
        if (this.newBlockCallbacks) {
            this.newBlockCallbacks.forEach(callback => {
                try {
                    callback(blockHeight);
                } catch (error) {
                    if (this.CONSOLE_LOGGING) {
                        console.error("Error in new block callback:", error);
                    }
                }
            });
        }
    }

    /**
     * Register a callback for when new blocks are detected
     * @param {function} callback - Function to call with new block height
     */
    onNewBlockCallback(callback) {
        if (!this.newBlockCallbacks) {
            this.newBlockCallbacks = [];
        }
        this.newBlockCallbacks.push(callback);
    }

    // ====== DEBUG UTILITIES ======

    /**
     * Get debug status information
     * @returns {object} Debug status object
     */
    getDebugStatus() {
        return {
            debugMode: this.DEBUG_MODE,
            currentBlockHeight: this.getCurrentBlockHeight(),
            isRunning: !!this.debugInterval,
            lastProductionBlock: this.lastProductionBlockHeight,
            debugBlock: this.debugBlockHeight
        };
    }

    /**
     * Log debug socket event
     * @param {string} socketId - Socket ID
     * @param {string} eventName - Event name
     * @param {object} data - Event data
     */
    debugSocket(socketId, eventName, data) {
        if (this.CONSOLE_LOGGING) {
            const shortSocketId = socketId.substring(0, 8);
            console.log(`🔌 SOCKET DEBUG: Sending ${eventName} to ${shortSocketId}...`);
            
            // Limit payload logging to prevent console spam
            const dataStr = JSON.stringify(data);
            const shortDataStr = dataStr.length > 300 ? dataStr.substring(0, 300) + "..." : dataStr;
            console.log(`📦 PAYLOAD: ${shortDataStr}`);
        }
    }

    // ====== CLEANUP ======

    /**
     * Stop all debug intervals and clean up
     */
    cleanup() {
        if (this.debugInterval) {
            clearInterval(this.debugInterval);
            this.debugInterval = null;
        }
        
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
        
        if (this.CONSOLE_LOGGING) {
            console.log("🧹 Debug manager cleaned up");
        }
    }

    /**
     * Toggle debug mode (restart required)
     * @param {boolean} enabled - Whether to enable debug mode
     */
    setDebugMode(enabled) {
        if (this.CONSOLE_LOGGING) {
            console.log(`🔄 Switching debug mode to: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        }
        this.cleanup();
        this.DEBUG_MODE = enabled;
        this.initialize();
    }
}

module.exports = DebugManager;
