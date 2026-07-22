const DatabaseManager = require('../src/db/databaseManager');

describe('DatabaseManager readiness freshness', () => {
    test('requires both a connection and a recent successful query', () => {
        const db = new DatabaseManager();
        expect(db.isHealthy()).toBe(false);

        db.connected = true;
        db.lastSuccessfulQueryAt = Date.now();
        expect(db.isHealthy(1000)).toBe(true);

        db.lastSuccessfulQueryAt = Date.now() - 2000;
        expect(db.isHealthy(1000)).toBe(false);
    });
});
