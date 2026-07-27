require('dotenv').config({ path: '../.env' });
const { Client } = require('pg');

const DB_CONFIG = {
    user: process.env.DB_USER || 'wownerogue',
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'wownerogue'
};

// Admin config to create user/db
const ADMIN_CONFIG = {
    user: process.env.DB_ADMIN_USER || 'postgres',
    password: process.env.DB_ADMIN_PASSWORD || 'postgres', // Try default
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    database: 'postgres'
};

async function setup() {
    console.log('🔧 Starting database setup...');
    
    // Try to connect as admin
    const client = new Client(ADMIN_CONFIG);
    
    try {
        await client.connect();
        console.log('✅ Connected as admin');
    } catch (err) {
        console.log('⚠️ Could not connect as admin (postgres/postgres). Trying with current user...');
        // Fallback: try connecting with current user to 'postgres' db
        client.end();
        const fallbackClient = new Client({
            ...ADMIN_CONFIG,
            user: process.env.USER || 'postgres',
            password: '', // often passwordless for local socket
        });
        try {
            await fallbackClient.connect();
            console.log('✅ Connected as ' + (process.env.USER || 'postgres'));
            // Swap client
            Object.assign(client, fallbackClient);
        } catch (e) {
            console.error('❌ Could not connect to postgres instance. Please ensure PostgreSQL is running and you have rights to create databases.');
            console.error('Error:', err.message);
            process.exit(1);
        }
    }

    try {
        // 1. Create User if not exists
        const userRes = await client.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [DB_CONFIG.user]);
        if (userRes.rowCount === 0) {
            console.log(`👤 Creating user ${DB_CONFIG.user}...`);
            await client.query(`CREATE USER "${DB_CONFIG.user}" WITH PASSWORD '${DB_CONFIG.password}' CREATEDB`);
        } else {
            console.log(`👤 User ${DB_CONFIG.user} already exists`);
        }

        // 2. Create Database if not exists
        const dbRes = await client.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [DB_CONFIG.database]);
        if (dbRes.rowCount === 0) {
            console.log(`📦 Creating database ${DB_CONFIG.database}...`);
            await client.query(`CREATE DATABASE "${DB_CONFIG.database}" OWNER "${DB_CONFIG.user}"`);
        } else {
            console.log(`📦 Database ${DB_CONFIG.database} already exists`);
        }

        console.log('✅ Setup complete!');
    } catch (err) {
        console.error('❌ Setup failed:', err.message);
    } finally {
        await client.end();
    }
}

async function drop() {
    console.log('🔥 Dropping database...');
    const client = new Client(ADMIN_CONFIG);
    try {
        await client.connect();
        // Terminate connections first
        await client.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1
        `, [DB_CONFIG.database]);
        
        await client.query(`DROP DATABASE IF EXISTS "${DB_CONFIG.database}"`);
        console.log(`✅ Database ${DB_CONFIG.database} dropped`);
    } catch (err) {
        console.error('❌ Drop failed:', err.message);
    } finally {
        await client.end();
    }
}

const action = process.argv[2];
if (action === 'drop') {
    drop();
} else {
    setup();
}
