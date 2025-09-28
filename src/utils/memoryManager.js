/**
 * Memory Manager Module
 * Handles cleanup of various memory structures to prevent leaks
 */

class MemoryManager {
    constructor(options = {}) {
        this.debugMode = options.debugMode || false;
        this.cleanupInterval = options.cleanupInterval || 300000; // 5 minutes default
        
        // Registry of cleanup functions
        this.cleanupFunctions = new Map();
        
        // Global cleanup interval
        this.globalCleanupInterval = setInterval(() => this.runCleanup(), this.cleanupInterval);
        
        // Track cleanup stats
        this.stats = {
            lastCleanup: null,
            totalCleanups: 0,
            itemsCleaned: 0
        };
    }

    /**
     * Register a cleanup function for a specific component
     * @param {string} name - Name of the component
     * @param {Function} cleanupFn - Function that performs cleanup and returns number of items cleaned
     * @param {number} interval - How often to run this cleanup (in ms), defaults to global interval
     */
    registerCleanup(name, cleanupFn, interval = null) {
        this.cleanupFunctions.set(name, {
            fn: cleanupFn,
            interval: interval || this.cleanupInterval,
            lastRun: 0,
            runCount: 0,
            itemsCleaned: 0
        });
        
        if (this.debugMode) {
            console.log(`📝 MemoryManager: Registered cleanup function '${name}'`);
        }
    }

    /**
     * Unregister a cleanup function
     * @param {string} name 
     */
    unregisterCleanup(name) {
        this.cleanupFunctions.delete(name);
        
        if (this.debugMode) {
            console.log(`❌ MemoryManager: Unregistered cleanup function '${name}'`);
        }
    }

    /**
     * Run cleanup for all registered functions
     */
    async runCleanup() {
        const now = Date.now();
        let totalCleaned = 0;
        
        for (const [name, cleanupData] of this.cleanupFunctions.entries()) {
            try {
                // Check if it's time to run this cleanup
                if (now - cleanupData.lastRun >= cleanupData.interval) {
                    const cleaned = await cleanupData.fn();
                    
                    cleanupData.lastRun = now;
                    cleanupData.runCount++;
                    cleanupData.itemsCleaned += cleaned || 0;
                    totalCleaned += cleaned || 0;
                    
                    if (this.debugMode && cleaned > 0) {
                        console.log(`🧹 MemoryManager: '${name}' cleaned ${cleaned} items`);
                    }
                }
            } catch (error) {
                console.error(`MemoryManager cleanup error for '${name}':`, error);
            }
        }
        
        this.stats.lastCleanup = now;
        this.stats.totalCleanups++;
        this.stats.itemsCleaned += totalCleaned;
        
        if (this.debugMode && totalCleaned > 0) {
            console.log(`🧹 MemoryManager: Total cleanup completed, ${totalCleaned} items cleaned`);
        }
    }

    /**
     * Run cleanup for a specific function immediately
     * @param {string} name 
     */
    async runSpecificCleanup(name) {
        const cleanupData = this.cleanupFunctions.get(name);
        if (!cleanupData) {
            throw new Error(`No cleanup function registered with name '${name}'`);
        }

        try {
            const cleaned = await cleanupData.fn();
            cleanupData.lastRun = Date.now();
            cleanupData.runCount++;
            cleanupData.itemsCleaned += cleaned || 0;
            
            if (this.debugMode) {
                console.log(`🧹 MemoryManager: Manual cleanup '${name}' cleaned ${cleaned} items`);
            }
            
            return cleaned;
        } catch (error) {
            console.error(`MemoryManager manual cleanup error for '${name}':`, error);
            throw error;
        }
    }

    /**
     * Get statistics about cleanup operations
     */
    getStats() {
        const cleanupStats = {};
        for (const [name, data] of this.cleanupFunctions.entries()) {
            cleanupStats[name] = {
                runCount: data.runCount,
                itemsCleaned: data.itemsCleaned,
                lastRun: data.lastRun,
                interval: data.interval
            };
        }

        return {
            global: this.stats,
            cleanupFunctions: cleanupStats,
            registeredCount: this.cleanupFunctions.size
        };
    }

    /**
     * Force cleanup of all functions immediately
     */
    async forceCleanup() {
        if (this.debugMode) {
            console.log('🧹 MemoryManager: Force cleanup initiated');
        }

        let totalCleaned = 0;
        for (const [name, cleanupData] of this.cleanupFunctions.entries()) {
            try {
                const cleaned = await cleanupData.fn();
                cleanupData.lastRun = Date.now();
                cleanupData.runCount++;
                cleanupData.itemsCleaned += cleaned || 0;
                totalCleaned += cleaned || 0;
            } catch (error) {
                console.error(`MemoryManager force cleanup error for '${name}':`, error);
            }
        }

        this.stats.lastCleanup = Date.now();
        this.stats.totalCleanups++;
        this.stats.itemsCleaned += totalCleaned;

        if (this.debugMode) {
            console.log(`🧹 MemoryManager: Force cleanup completed, ${totalCleaned} items cleaned`);
        }

        return totalCleaned;
    }

    /**
     * Shutdown the memory manager
     */
    shutdown() {
        if (this.globalCleanupInterval) {
            clearInterval(this.globalCleanupInterval);
            this.globalCleanupInterval = null;
        }
        
        if (this.debugMode) {
            console.log('🧹 MemoryManager: Shutdown completed');
        }
    }

    /**
     * Helper method to create a Map cleanup function
     * @param {Map} map - The Map to clean
     * @param {Function} isExpired - Function that takes (key, value) and returns true if item should be cleaned
     * @returns {Function} Cleanup function
     */
    static createMapCleanup(map, isExpired) {
        return () => {
            let cleaned = 0;
            const toDelete = [];
            
            for (const [key, value] of map.entries()) {
                if (isExpired(key, value)) {
                    toDelete.push(key);
                }
            }
            
            for (const key of toDelete) {
                if (map.delete(key)) {
                    cleaned++;
                }
            }
            
            return cleaned;
        };
    }

    /**
     * Helper method to create a Set cleanup function
     * @param {Set} set - The Set to clean
     * @param {Function} isExpired - Function that takes (value) and returns true if item should be cleaned
     * @returns {Function} Cleanup function
     */
    static createSetCleanup(set, isExpired) {
        return () => {
            let cleaned = 0;
            const toDelete = [];
            
            for (const value of set.values()) {
                if (isExpired(value)) {
                    toDelete.push(value);
                }
            }
            
            for (const value of toDelete) {
                if (set.delete(value)) {
                    cleaned++;
                }
            }
            
            return cleaned;
        };
    }

    /**
     * Helper method to create a cleanup function for objects with timestamp properties
     * @param {Map|Object} container - Container with items that have timestamps
     * @param {number} maxAge - Maximum age in milliseconds
     * @param {string} timestampProperty - Name of the timestamp property (default: 'timestamp')
     * @returns {Function} Cleanup function
     */
    static createTimestampCleanup(container, maxAge, timestampProperty = 'timestamp') {
        return () => {
            const now = Date.now();
            let cleaned = 0;

            if (container instanceof Map) {
                const toDelete = [];
                for (const [key, value] of container.entries()) {
                    if (value && typeof value[timestampProperty] === 'number' && 
                        now - value[timestampProperty] > maxAge) {
                        toDelete.push(key);
                    }
                }
                for (const key of toDelete) {
                    if (container.delete(key)) {
                        cleaned++;
                    }
                }
            } else {
                // Handle regular objects
                const keys = Object.keys(container);
                for (const key of keys) {
                    const value = container[key];
                    if (value && typeof value[timestampProperty] === 'number' && 
                        now - value[timestampProperty] > maxAge) {
                        delete container[key];
                        cleaned++;
                    }
                }
            }

            return cleaned;
        };
    }
}

module.exports = MemoryManager;