/**
 * Database Connection Manager
 * Handles PostgreSQL connection pool and migration management
 */

const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

/**
 * Query validator to detect potential SQL injection
 */
class QueryValidator {
    constructor() {
        this.dangerousKeywords = [
            'DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'REPLACE',
            'EXEC', 'EXECUTE', 'SCRIPT', '--', '/*', '*/', 'XP_', 'SP_'
        ];
    }

    isSafe(text, params) {
        // Check if using parameterized query properly
        const placeholderCount = (text.match(/\$\d+/g) || []).length;
        if (placeholderCount !== params.length) {
            console.warn('⚠️ Parameter count mismatch in query');
            return false;
        }

        // Check for dangerous patterns in the query text itself
        for (const keyword of this.dangerousKeywords) {
            // Use regex to avoid false positives (e.g., "DESCRIPTION" containing "SCRIPT")
            // Alphanumeric keywords use word boundaries; others use literal match
            let regex;
            if (/^[A-Z0-9_]+$/i.test(keyword)) {
                regex = new RegExp(`\\b${keyword}\\b`, 'i');
            } else {
                // Escape special characters for literal match
                const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escaped, 'i');
            }

            if (regex.test(text)) {
                // Allow legitimate DDL in migrations only
                const stack = new Error().stack;
                if (!stack.includes('migrations')) {
                    console.warn(`⚠️ Potentially dangerous keyword "${keyword}" in query`);
                    // Log but don't block - some keywords might be legitimate
                }
            }
        }

        return true;
    }

    validateQuery(query) {
        if (typeof query === 'string') {
            console.warn('⚠️ Raw string query detected - should use parameterized queries');
        }
    }
}

class DatabaseManager {
    constructor() {
        this.pool = null;
        this.connected = false;
        this.queryValidator = new QueryValidator();
    }

    /**
     * Initialize database connection and run migrations
     */
    async initialize() {
        const connected = await this.init();
        if (connected) {
            await this.runMigrations();
        }
    }

    /**
     * Initialize database connection
     */
    async init() {
        try {
            this.pool = new Pool({
                host: process.env.DB_HOST || 'localhost',
                port: process.env.DB_PORT || 5432,
                database: process.env.DB_NAME || 'wownerogue',
                user: process.env.DB_USER || 'wownerogue',
                password: process.env.DB_PASSWORD,
                max: 20, // Maximum number of clients in the pool
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });
            
            // Add query monitoring for security
            this.pool.on('query', (query) => {
                if (process.env.DEBUG === 'true') {
                    this.queryValidator.validateQuery(query);
                }
            });

            // Test connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();

            this.connected = true;
            console.log('✅ Database connected successfully');
            
            return true;
        } catch (error) {
            console.error('❌ Database connection failed:', error.message);
            this.connected = false;
            return false;
        }
    }

    /**
     * Run database migrations
     */
    async runMigrations() {
        try {
            // Simple migration ledger
            await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT NOW())`);

            const migrationsPath = path.join(__dirname, '../migrations');
            const files = await fs.readdir(migrationsPath);
            const sqlFiles = files.filter(file => file.endsWith('.sql')).sort();

            console.log(`📁 Found ${sqlFiles.length} migration files`);

            for (const file of sqlFiles) {
                // Skip if already applied
                const existing = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [file]);
                if (existing.rowCount > 0) {
                    console.log(`⏩ Skipping already applied migration: ${file}`);
                    continue;
                }

                const filePath = path.join(migrationsPath, file);
                const sql = await fs.readFile(filePath, 'utf8');
                console.log(`🔄 Running migration: ${file}`);
                await this.pool.query(sql);
                await this.pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
                console.log(`✅ Migration completed: ${file}`);
            }

            console.log('✅ Migration phase complete');
        } catch (error) {
            console.error('❌ Migration failed:', error.message);
            throw error;
        }
    }

    /**
     * Execute a query with security validation
     */
    async query(text, params = []) {
        if (!this.connected) {
            throw new Error('Database not connected');
        }

        // Validate query structure for security
        if (!this.queryValidator.isSafe(text, params)) {
            throw new Error('Potentially unsafe query detected');
        }

        try {
            const start = Date.now();
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;

            if (process.env.NODE_ENV === 'development') {
                console.log('📊 Query executed:', { text: text.substring(0, 100), duration, rows: result.rowCount });
            }

            return result;
        } catch (error) {
            console.error('❌ Database query error:', error.message);
            console.error('Query:', text);
            throw error;
        }
    }

    /**
     * Helper method to ensure parameterized queries
     */
    async safeQuery(template, values = {}) {
        const { text, params } = this.buildParameterizedQuery(template, values);
        return this.query(text, params);
    }

    /**
     * Build parameterized query from template
     */
    buildParameterizedQuery(template, values) {
        let paramIndex = 1;
        const params = [];
        
        const text = template.replace(/:(\w+)/g, (match, key) => {
            if (key in values) {
                params.push(values[key]);
                return `$${paramIndex++}`;
            }
            throw new Error(`Missing parameter: ${key}`);
        });
        
        return { text, params };
    }

    /**
     * Get a client from the pool for transactions
     */
    async getClient() {
        if (!this.connected) {
            throw new Error('Database not connected');
        }
        return await this.pool.connect();
    }

    /**
     * Execute a callback within a database transaction
     * Automatically handles BEGIN, COMMIT, and ROLLBACK
     * @param {Function} callback - Async function that receives the client
     * @returns {Promise<any>} - Result from the callback
     */
    async withTransaction(callback) {
        const client = await this.getClient();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Close database connection
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.connected = false;
            console.log('📴 Database connection closed');
        }
    }

    /**
     * Get connection status
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const result = await this.query('SELECT 1 as status, NOW() as timestamp');
            return {
                status: 'healthy',
                timestamp: result.rows[0].timestamp,
                connected: this.connected
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                connected: false
            };
        }
    }
}

module.exports = DatabaseManager;
