/**
 * Database Connection Manager
 * Handles PostgreSQL connection pool and migration management
 */

const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

class DatabaseManager {
    constructor() {
        this.pool = null;
        this.connected = false;
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
                database: process.env.DB_NAME || 'wowgue',
                user: process.env.DB_USER || 'jw',
                password: process.env.DB_PASSWORD || 'jw',
                max: 20, // Maximum number of clients in the pool
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });

            // Test connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();

            this.connected = true;
            console.log('✅ Database connected successfully');
            
            // Run migrations
            await this.runMigrations();
            
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
            const migrationsPath = path.join(__dirname, '../migrations');
            const files = await fs.readdir(migrationsPath);
            const sqlFiles = files.filter(file => file.endsWith('.sql')).sort();

            console.log(`📁 Found ${sqlFiles.length} migration files`);

            for (const file of sqlFiles) {
                const filePath = path.join(migrationsPath, file);
                const sql = await fs.readFile(filePath, 'utf8');
                
                console.log(`🔄 Running migration: ${file}`);
                await this.pool.query(sql);
                console.log(`✅ Migration completed: ${file}`);
            }

            console.log('✅ All migrations completed successfully');
        } catch (error) {
            console.error('❌ Migration failed:', error.message);
            throw error;
        }
    }

    /**
     * Execute a query
     */
    async query(text, params = []) {
        if (!this.connected) {
            throw new Error('Database not connected');
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
     * Get a client from the pool for transactions
     */
    async getClient() {
        if (!this.connected) {
            throw new Error('Database not connected');
        }
        return await this.pool.connect();
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
