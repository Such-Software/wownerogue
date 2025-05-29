const { Client } = require('pg');

// Environment-based console logging control
const CONSOLE_LOGGING = process.env.NODE_ENV === 'debug' || process.env.NODE_ENV === 'development';

const client = new Client({
   user: 'postgres',
   host: 'localhost',
   database: 'bitdungeon',
   password: 'postgres',
   port: 5432,
});
client.connect();

// Add this function to create the necessary table if it doesn't exist
function initializeDatabase() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS visitors (
            id SERIAL PRIMARY KEY,
            socketid VARCHAR(255) NOT NULL,
            ip VARCHAR(100) NOT NULL,
            time BIGINT NOT NULL
        )
    `;
    
    client.query(createTableQuery)
        .then(() => {
            if (CONSOLE_LOGGING) {
                console.log("Database initialized");
            }
        })
        .catch(err => console.error("Database initialization error:", err));
}

// Call this function when starting up
initializeDatabase();

// String for inserting new visitor
const insertVisitorText = 'INSERT INTO visitors(socketid, ip, time) VALUES($1, $2, $3)';
// Function for inserting new visitor and returning ID#
function insertVisitor(socketid, ip, cookie) {
    values = [socketid, ip, Math.floor(new Date() / 1000)];
    
    // First check if table exists to prevent errors
    client.query("SELECT to_regclass('visitors')", (err, res) => {
        if (err) {
            console.error("Database check error:", err);
            return;
        }
        
        // If table doesn't exist yet, try to initialize again
        if (res.rows[0].to_regclass === null) {
            if (CONSOLE_LOGGING) {
                console.log("Table 'visitors' doesn't exist yet, creating it now...");
            }
            initializeDatabase();
            return;
        }
        
        // Insert the visitor
        client.query(insertVisitorText, values, (err, res) => {
            if (err) {
                console.error("Database insert error:", err.stack);
            } else if (res.rows && res.rows[0]) {
                if (CONSOLE_LOGGING) {
                    console.log("Visitor inserted:", res.rows[0]);
                }
            } else {
                if (CONSOLE_LOGGING) {
                    console.log("Visitor inserted");
                }
            }
        });
    });
}


module.exports = {
    insertVisitor: insertVisitor
}
