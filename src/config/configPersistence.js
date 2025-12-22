/**
 * Configuration Persistence
 * 
 * Provides a mechanism to persist and reload payment configuration changes
 * without requiring a full server restart. Configuration is stored in the
 * database and merged with environment variables on load.
 * 
 * Priority order (highest to lowest):
 * 1. Database overrides (hot-reloadable)
 * 2. Environment variables (.env)
 * 3. Default values
 */

const { normalizeError } = require('../utils/errors');

// Allowed configuration keys that can be persisted
const ALLOWED_KEYS = new Set([
    // Direct mode
    'DIRECT_GAME_PRICE',
    'DIRECT_PAYOUT_ESCAPE',
    'DIRECT_PAYOUT_TREASURE',
    'DIRECT_PAYOUTS_ENABLED',
    
    // Credits mode
    'CREDITS_PER_GAME',
    'CREDITS_PACKAGES',
    'CREDITS_PAYOUT_BASE',
    'CREDITS_PAYOUT_ESCAPE',
    'CREDITS_PAYOUT_TREASURE',
    'CREDITS_PAYOUTS_ENABLED',
    
    // Limits
    'MAX_GAMES_PER_HOUR',
    'MAX_PAYOUTS_PER_DAY',
    'GAME_COOLDOWN_SECONDS',
    'PAYOUT_MIN_AMOUNT',
    'PAYOUT_MAX_PER_GAME',
    
    // Difficulty
    'DIFFICULTY_PRESET'
]);

class ConfigPersistence {
    constructor({ db, debugManager }) {
        this.db = db;
        this.debugManager = debugManager;
        this._cache = new Map();
        this._initialized = false;
        this._listeners = new Set();
    }

    /**
     * Initialize the persistence layer, creating table if needed
     */
    async initialize() {
        if (this._initialized) return;
        
        try {
            // Create config table if it doesn't exist
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS config_overrides (
                    key VARCHAR(100) PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    updated_by VARCHAR(100) DEFAULT 'system'
                )
            `);
            
            // Load existing overrides into cache
            await this._loadFromDatabase();
            
            this._initialized = true;
            
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`[ConfigPersistence] Initialized with ${this._cache.size} overrides`);
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to initialize config persistence');
            console.error('[ConfigPersistence] Initialization error:', normalized.message);
            // Don't throw - system should work without persistence
        }
    }

    /**
     * Load all overrides from database into cache
     */
    async _loadFromDatabase() {
        try {
            const result = await this.db.query('SELECT key, value FROM config_overrides');
            this._cache.clear();
            for (const row of result.rows) {
                if (ALLOWED_KEYS.has(row.key)) {
                    this._cache.set(row.key, row.value);
                }
            }
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to load config from database');
            console.error('[ConfigPersistence] Load error:', normalized.message);
        }
    }

    /**
     * Get a configuration value with priority: DB override > env > default
     * @param {string} key - Configuration key
     * @param {*} defaultValue - Default value if not found
     * @returns {string|null} Configuration value
     */
    get(key, defaultValue = null) {
        // Check database override first
        if (this._cache.has(key)) {
            return this._cache.get(key);
        }
        
        // Fall back to environment variable
        if (process.env[key] !== undefined) {
            return process.env[key];
        }
        
        return defaultValue;
    }

    /**
     * Get a numeric configuration value
     * @param {string} key - Configuration key
     * @param {number} defaultValue - Default value
     * @returns {number} Parsed numeric value
     */
    getNumber(key, defaultValue = 0) {
        const value = this.get(key);
        if (value === null) return defaultValue;
        const parsed = parseFloat(value);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    /**
     * Get a boolean configuration value
     * @param {string} key - Configuration key
     * @param {boolean} defaultValue - Default value
     * @returns {boolean} Parsed boolean value
     */
    getBoolean(key, defaultValue = false) {
        const value = this.get(key);
        if (value === null) return defaultValue;
        return value === 'true' || value === '1';
    }

    /**
     * Get a JSON configuration value
     * @param {string} key - Configuration key
     * @param {*} defaultValue - Default value
     * @returns {*} Parsed JSON value
     */
    getJSON(key, defaultValue = null) {
        const value = this.get(key);
        if (value === null) return defaultValue;
        try {
            return JSON.parse(value);
        } catch {
            return defaultValue;
        }
    }

    /**
     * Set a configuration override (persisted to database)
     * @param {string} key - Configuration key
     * @param {*} value - Value to set
     * @param {string} updatedBy - Who made the change
     * @returns {boolean} Success
     */
    async set(key, value, updatedBy = 'admin') {
        if (!ALLOWED_KEYS.has(key)) {
            console.warn(`[ConfigPersistence] Attempted to set non-allowed key: ${key}`);
            return false;
        }

        try {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
            
            await this.db.query(`
                INSERT INTO config_overrides (key, value, updated_at, updated_by)
                VALUES ($1, $2, NOW(), $3)
                ON CONFLICT (key) DO UPDATE SET
                    value = EXCLUDED.value,
                    updated_at = NOW(),
                    updated_by = EXCLUDED.updated_by
            `, [key, stringValue, updatedBy]);

            // Update cache
            this._cache.set(key, stringValue);

            // Notify listeners
            this._notifyListeners(key, stringValue);

            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`[ConfigPersistence] Set ${key} = ${stringValue.substring(0, 50)}... by ${updatedBy}`);
            }

            return true;
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to set config value');
            console.error('[ConfigPersistence] Set error:', normalized.message);
            return false;
        }
    }

    /**
     * Remove a configuration override (reverts to env/default)
     * @param {string} key - Configuration key
     * @returns {boolean} Success
     */
    async remove(key) {
        try {
            await this.db.query('DELETE FROM config_overrides WHERE key = $1', [key]);
            this._cache.delete(key);
            this._notifyListeners(key, null);
            
            if (this.debugManager?.CONSOLE_LOGGING) {
                console.log(`[ConfigPersistence] Removed override for ${key}`);
            }
            
            return true;
        } catch (error) {
            const normalized = normalizeError(error, 'Failed to remove config value');
            console.error('[ConfigPersistence] Remove error:', normalized.message);
            return false;
        }
    }

    /**
     * Get all current overrides
     * @returns {Object} Key-value pairs of all overrides
     */
    getAllOverrides() {
        return Object.fromEntries(this._cache);
    }

    /**
     * Reload configuration from database
     * Call this to pick up external changes
     */
    async reload() {
        await this._loadFromDatabase();
        
        if (this.debugManager?.CONSOLE_LOGGING) {
            console.log(`[ConfigPersistence] Reloaded ${this._cache.size} overrides`);
        }
    }

    /**
     * Register a listener for configuration changes
     * @param {Function} callback - (key, value) => void
     * @returns {Function} Unsubscribe function
     */
    onConfigChange(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    /**
     * Notify all listeners of a configuration change
     */
    _notifyListeners(key, value) {
        for (const listener of this._listeners) {
            try {
                listener(key, value);
            } catch (e) {
                console.error('[ConfigPersistence] Listener error:', e);
            }
        }
    }

    /**
     * Get configuration snapshot for display/API
     * @returns {Object} Current effective configuration
     */
    getSnapshot() {
        const snapshot = {};
        for (const key of ALLOWED_KEYS) {
            snapshot[key] = {
                value: this.get(key),
                source: this._cache.has(key) ? 'database' : (process.env[key] ? 'environment' : 'default'),
                hasOverride: this._cache.has(key)
            };
        }
        return snapshot;
    }
}

module.exports = ConfigPersistence;
