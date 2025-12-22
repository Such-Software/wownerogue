/**
 * Rate Limiter Module
 * Provides rate limiting functionality for various user actions
 */

class RateLimiter {
    constructor(options = {}) {
        // Default rate limits - can be overridden via options
        this.limits = {
            'payment:create': { window: 60000, max: 3 },      // 3 payments per minute
            'game:start': { window: 60000, max: 10 },         // 10 game starts per minute
            'game:queue': { window: 30000, max: 5 },          // 5 queue attempts per 30s
            'chat:message': { window: 10000, max: 8 },        // 8 messages per 10s
            'address:set': { window: 300000, max: 3 },        // 3 address changes per 5min
            'move:player': { window: 1000, max: 50 },         // 50 moves per second (already handled separately)
            'connection:new': { window: 60000, max: 10 },     // 10 connections per minute per IP
            ...options.limits
        };
        
        // Storage for rate limit data - in production, use Redis
        this.storage = new Map(); // key: userId:action, value: { count, firstAttempt }
        this.ipStorage = new Map(); // key: ip:action, value: { count, firstAttempt }
        
        // Cleanup interval to prevent memory leaks
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // cleanup every minute
        
        this.debugMode = options.debugMode || false;
    }

    /**
     * Check if an action is rate limited for a user
     * @param {string} userId - User identifier (socket ID)
     * @param {string} action - Action type (e.g., 'payment:create')
     * @param {string} ip - Optional IP address for IP-based limits
     * @returns {Object} { allowed: boolean, retryAfter: number, remaining: number }
     */
    async checkLimit(userId, action, ip = null) {
        const limit = this.limits[action];
        if (!limit) {
            // No limit configured for this action
            return { allowed: true, remaining: Infinity, retryAfter: 0 };
        }

        const now = Date.now();
        const key = `${userId}:${action}`;
        
        // Check user-based limits
        const userResult = this._checkSingleLimit(key, limit, now);
        
        // Check IP-based limits if IP provided and it's a connection-type action
        let ipResult = { allowed: true, remaining: Infinity, retryAfter: 0 };
        if (ip && action.startsWith('connection:')) {
            const ipKey = `${ip}:${action}`;
            ipResult = this._checkSingleLimit(ipKey, limit, now, this.ipStorage);
        }

        // Return most restrictive result
        const result = {
            allowed: userResult.allowed && ipResult.allowed,
            remaining: Math.min(userResult.remaining, ipResult.remaining),
            retryAfter: Math.max(userResult.retryAfter, ipResult.retryAfter)
        };

        if (this.debugMode && !result.allowed) {
            console.log(`🚫 Rate limit exceeded for ${userId}:${action}. Remaining: ${result.remaining}, RetryAfter: ${result.retryAfter}ms`);
        }

        return result;
    }

    /**
     * Record an action attempt (increment counter)
     * @param {string} userId - User identifier
     * @param {string} action - Action type
     * @param {string} ip - Optional IP address
     */
    async recordAttempt(userId, action, ip = null) {
        const now = Date.now();
        const key = `${userId}:${action}`;
        
        // Record user attempt
        this._recordSingleAttempt(key, now);
        
        // Record IP attempt for connection actions
        if (ip && action.startsWith('connection:')) {
            const ipKey = `${ip}:${action}`;
            this._recordSingleAttempt(ipKey, now, this.ipStorage);
        }
    }

    /**
     * Get current usage stats for a user/action
     * @param {string} userId 
     * @param {string} action 
     * @returns {Object} { count: number, remaining: number, resetTime: number }
     */
    getUsageStats(userId, action) {
        const limit = this.limits[action];
        if (!limit) return { count: 0, remaining: Infinity, resetTime: 0 };

        const key = `${userId}:${action}`;
        const data = this.storage.get(key);
        
        if (!data) {
            return { count: 0, remaining: limit.max, resetTime: 0 };
        }

        const now = Date.now();
        const resetTime = data.firstAttempt + limit.window;
        
        if (now > resetTime) {
            return { count: 0, remaining: limit.max, resetTime: 0 };
        }

        return {
            count: data.count,
            remaining: Math.max(0, limit.max - data.count),
            resetTime: resetTime
        };
    }

    /**
     * Clear rate limit data for a user (useful for admin overrides)
     * @param {string} userId 
     * @param {string} action - Optional, if not provided clears all actions for user
     */
    clearLimits(userId, action = null) {
        if (action) {
            const key = `${userId}:${action}`;
            this.storage.delete(key);
        } else {
            // Clear all limits for this user
            for (const key of this.storage.keys()) {
                if (key.startsWith(`${userId}:`)) {
                    this.storage.delete(key);
                }
            }
        }
    }

    /**
     * Internal method to check a single limit
     */
    _checkSingleLimit(key, limit, now, storage = this.storage) {
        const data = storage.get(key);
        
        if (!data) {
            // First attempt
            return { allowed: true, remaining: limit.max - 1, retryAfter: 0 };
        }

        // Check if window has expired
        if (now - data.firstAttempt > limit.window) {
            // Window expired, reset
            storage.delete(key);
            return { allowed: true, remaining: limit.max - 1, retryAfter: 0 };
        }

        // Within window, check if limit exceeded
        if (data.count >= limit.max) {
            const retryAfter = (data.firstAttempt + limit.window) - now;
            return { allowed: false, remaining: 0, retryAfter: Math.max(0, retryAfter) };
        }

        return { allowed: true, remaining: limit.max - data.count - 1, retryAfter: 0 };
    }

    /**
     * Internal method to record a single attempt
     */
    _recordSingleAttempt(key, now, storage = this.storage) {
        const data = storage.get(key);
        
        if (!data) {
            storage.set(key, { count: 1, firstAttempt: now });
        } else {
            // Check if window has expired
            const limit = this._getLimitFromKey(key);
            if (limit && now - data.firstAttempt > limit.window) {
                // Reset window
                storage.set(key, { count: 1, firstAttempt: now });
            } else {
                // Increment within window
                data.count++;
            }
        }
    }

    /**
     * Get limit config from storage key
     */
    _getLimitFromKey(key) {
        const action = key.split(':').slice(1).join(':'); // Remove userId/IP prefix
        return this.limits[action];
    }

    /**
     * Cleanup expired entries to prevent memory leaks
     */
    cleanup() {
        const now = Date.now();
        let cleanedCount = 0;

        // Clean user storage
        for (const [key, data] of this.storage.entries()) {
            const limit = this._getLimitFromKey(key);
            if (limit && now - data.firstAttempt > limit.window) {
                this.storage.delete(key);
                cleanedCount++;
            }
        }

        // Clean IP storage
        for (const [key, data] of this.ipStorage.entries()) {
            const limit = this._getLimitFromKey(key);
            if (limit && now - data.firstAttempt > limit.window) {
                this.ipStorage.delete(key);
                cleanedCount++;
            }
        }

        if (this.debugMode && cleanedCount > 0) {
            console.log(`🧹 RateLimiter cleanup: removed ${cleanedCount} expired entries`);
        }
    }

    /**
     * Get current statistics about rate limiter state
     */
    getStats() {
        return {
            totalKeys: this.storage.size + this.ipStorage.size,
            userKeys: this.storage.size,
            ipKeys: this.ipStorage.size,
            limits: Object.keys(this.limits).length
        };
    }

    /**
     * Get count of tracked entries (for dashboard)
     */
    getTrackedCount() {
        return this.storage.size + this.ipStorage.size;
    }

    /**
     * Get count of currently blocked users (rough estimate)
     */
    getBlockedCount() {
        const now = Date.now();
        let blocked = 0;
        for (const [key, data] of this.storage.entries()) {
            const limit = this._getLimitFromKey(key);
            if (limit && data.count >= limit.max && (now - data.firstAttempt) < limit.window) {
                blocked++;
            }
        }
        return blocked;
    }

    /**
     * Shutdown the rate limiter (cleanup interval)
     */
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

module.exports = RateLimiter;