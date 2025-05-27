/**
 * Debug Manager Module
 * Handles debug functionality and simulated block height logic for development
 * Keeps debug/development code separate from production logic
 */

const rpc = require('../rpc/rpccalls.js');

class DebugManager {
    constructor(broadcastManager) {
        this.broadcastManager = broadcastManager;
        this.DEBUG_MODE = true; // Set to false to disable debug mode
        this.debugBlockHeight = 1;
        this.debugInterval = null;
        this.statusInterval = null;
        this.lastProductionBlockHeight = 0;
    }

    // ====== INITIALIZATION ======

    /**
     * Initialize debug mode or production mode
     */
    initialize() {
        if (this.DEBUG_MODE) {
            this.initializeDebugMode();
        } else {
            this.initializeProductionMode();
        }
    }

    /**
     * Initialize debug mode with simulated blocks
     */
    initializeDebugMode() {
        console.log("🐛 DEBUG MODE ENABLED - Simulating blocks every 30 seconds");
        
        // Initial debug block broadcast
        this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
        
        // Debug block height simulator - advances every 30 seconds
        this.debugInterval = setInterval(() => {
            this.debugBlockHeight++;
            console.log(`🐛 DEBUG: New simulated block: ${this.debugBlockHeight}`);
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
        console.log("🚀 PRODUCTION MODE ENABLED - Using real blockchain RPC calls");
        
        // Real blockchain monitoring
        this.debugInterval = setInterval(() => {
            rpc.daemonCall("get_block_count", "", (result) => {
                if (!result || !result.result || !result.result.count) {
                    console.log("❌ Failed to get block count from daemon");
                    return;
                }
                
                const currentHeight = result.result.count;
                rpc.lastBlock.setHeight(currentHeight);
                
                // If new block found
                if (currentHeight > this.lastProductionBlockHeight) {
                    console.log(`⛏️ New block found: ${currentHeight}`);
                    this.broadcastManager.broadcastBlockHeight(currentHeight);
                    
                    // Notify listeners about new block
                    this.onNewBlock(currentHeight);
                    
                    this.lastProductionBlockHeight = currentHeight;
                } else {
                    // Still broadcast current height for status updates
                    this.broadcastManager.broadcastBlockHeight(currentHeight);
                }
            });
        }, 5000); // Every 5 seconds
    }

    // ====== BLOCK HEIGHT MANAGEMENT ======

    /**
     * Get the current block height (debug or production)
     * @returns {number} Current block height
     */
    getCurrentBlockHeight() {
        return this.DEBUG_MODE ? this.debugBlockHeight : this.lastProductionBlockHeight;
    }

    /**
     * Set debug block height (debug mode only)
     * @param {number} height - New block height
     */
    setDebugBlockHeight(height) {
        if (this.DEBUG_MODE) {
            this.debugBlockHeight = height;
            this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
        } else {
            console.warn("Cannot set debug block height in production mode");
        }
    }

    /**
     * Advance debug block height by one (debug mode only)
     */
    advanceDebugBlock() {
        if (this.DEBUG_MODE) {
            this.debugBlockHeight++;
            console.log(`🐛 DEBUG: Manually advanced block to: ${this.debugBlockHeight}`);
            this.broadcastManager.broadcastBlockHeight(this.debugBlockHeight);
            this.onNewBlock(this.debugBlockHeight);
        } else {
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
        console.log(`📦 New block detected: ${blockHeight}`);
        
        // Call registered callbacks
        if (this.newBlockCallbacks) {
            this.newBlockCallbacks.forEach(callback => {
                try {
                    callback(blockHeight);
                } catch (error) {
                    console.error("Error in new block callback:", error);
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
        const shortSocketId = socketId.substring(0, 8);
        console.log(`🔌 SOCKET DEBUG: Sending ${eventName} to ${shortSocketId}...`);
        
        // Limit payload logging to prevent console spam
        const dataStr = JSON.stringify(data);
        const shortDataStr = dataStr.length > 300 ? dataStr.substring(0, 300) + "..." : dataStr;
        console.log(`📦 PAYLOAD: ${shortDataStr}`);
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
        
        console.log("🧹 Debug manager cleaned up");
    }

    /**
     * Toggle debug mode (restart required)
     * @param {boolean} enabled - Whether to enable debug mode
     */
    setDebugMode(enabled) {
        console.log(`🔄 Switching debug mode to: ${enabled ? 'ENABLED' : 'DISABLED'}`);
        this.cleanup();
        this.DEBUG_MODE = enabled;
        this.initialize();
    }
}

module.exports = DebugManager;
