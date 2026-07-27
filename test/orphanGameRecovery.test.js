const SessionManager = require('../src/network/sessionManager');

function makeDb(initialGames, initialCredits = 0) {
    const games = new Map(initialGames.map(game => [game.id, { ...game }]));
    const users = new Map([[7, initialCredits]]);
    const refundReasons = new Set();

    const query = jest.fn(async (sql, params = []) => {
        if (/SELECT g\.id[\s\S]*FROM games g[\s\S]*g\.status = 'active'/i.test(sql)) {
            return {
                rows: Array.from(games.values())
                    .filter(game => game.status === 'active')
                    .map(game => ({ id: game.id }))
            };
        }
        if (/FROM games g[\s\S]*g\.id = \$1[\s\S]*FOR UPDATE/i.test(sql)) {
            const game = games.get(params[0]);
            return { rows: game ? [{ ...game }] : [] };
        }
        if (/SELECT 1 FROM credit_transactions/i.test(sql)) {
            return { rows: refundReasons.has(params[1]) ? [{}] : [] };
        }
        if (/UPDATE users SET credits = credits \+/i.test(sql)) {
            const next = (users.get(params[1]) || 0) + Number(params[0]);
            users.set(params[1], next);
            return { rows: [{ credits: next }], rowCount: 1 };
        }
        if (/INSERT INTO credit_transactions/i.test(sql)) {
            refundReasons.add(params[2]);
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE games SET status = \$1/i.test(sql)) {
            const game = games.get(params[1]);
            if (game) game.status = params[0];
            return { rows: [], rowCount: game ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
    });

    return {
        query,
        withTransaction: jest.fn(async callback => callback({ query })),
        credits: userId => users.get(userId),
        game: id => games.get(id),
        refundReasons
    };
}

function manager(db, currentConfiguredCost = 99) {
    return new SessionManager({
        db,
        debugManager: { CONSOLE_LOGGING: false },
        gameModeManager: { creditsPerGameCost: currentConfiguredCost }
    });
}

describe('orphan game recovery debit evidence', () => {
    test('does not mint a refund for a pre-created active row when entry charging never committed', async () => {
        const db = makeDb([{
            id: 1,
            user_id: 7,
            game_mode: 'PAID_CREDITS',
            payment_id: null,
            status: 'active',
            entry_consumed_at: null,
            entry_credits_spent: 5
        }], 10);

        const result = await manager(db).recoverOrphanedGames();

        expect(result).toEqual({
            ok: true,
            scanned: 1,
            finalized: 1,
            refunded: 0,
            creditsRefunded: 0,
            unresolved: []
        });
        expect(db.credits(7)).toBe(10);
        expect(db.game(1).status).toBe('expired');
        expect(db.refundReasons.size).toBe(0);
    });

    test('restores the immutable debit snapshot, not the current configured entry cost', async () => {
        const db = makeDb([{
            id: 2,
            user_id: 7,
            game_mode: 'PAID_CREDITS',
            payment_id: null,
            status: 'active',
            entry_consumed_at: new Date('2026-01-01T00:00:00Z'),
            entry_credits_spent: 3
        }], 4);
        const recovery = manager(db, 99);

        const first = await recovery.recoverOrphanedGames();
        const second = await recovery.recoverOrphanedGames();

        expect(first).toEqual({
            ok: true,
            scanned: 1,
            finalized: 1,
            refunded: 1,
            creditsRefunded: 3,
            unresolved: []
        });
        expect(second).toEqual({
            ok: true,
            scanned: 0,
            finalized: 0,
            refunded: 0,
            creditsRefunded: 0,
            unresolved: []
        });
        expect(db.credits(7)).toBe(7);
        expect(db.game(2).status).toBe('refunded');
        expect(db.refundReasons).toEqual(new Set(['orphan_game_refunded:2']));
    });

    test('does not silently convert a linked direct payment into credits', async () => {
        const db = makeDb([{
            id: 3,
            user_id: 7,
            game_mode: 'PAID_SINGLE',
            payment_id: 77,
            status: 'active',
            entry_consumed_at: new Date('2026-01-01T00:00:00Z'),
            entry_credits_spent: null
        }], 1);

        const result = await manager(db).recoverOrphanedGames();

        expect(result.refunded).toBe(0);
        expect(db.credits(7)).toBe(1);
        expect(db.game(3).status).toBe('expired');
    });

    test('fails closed with explicit scan semantics when the orphan query fails', async () => {
        const db = {
            query: jest.fn().mockRejectedValue(new Error('database unavailable')),
            withTransaction: jest.fn()
        };

        await expect(manager(db).recoverOrphanedGames()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                ok: false,
                scope: 'orphaned_solo_games',
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }
        });
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('finishes other rows but rejects startup while any orphan remains unresolved', async () => {
        const db = makeDb([{
            id: 4,
            user_id: 7,
            game_mode: 'PAID_CREDITS',
            status: 'active',
            entry_consumed_at: new Date('2026-01-01T00:00:00Z'),
            entry_credits_spent: 2
        }, {
            id: 5,
            user_id: 7,
            game_mode: 'FREE',
            status: 'active',
            entry_consumed_at: null,
            entry_credits_spent: null
        }], 0);
        const baseTransaction = db.withTransaction;
        let attempts = 0;
        db.withTransaction = jest.fn(async callback => {
            attempts += 1;
            if (attempts === 1) throw new Error('refund transaction failed');
            return baseTransaction(callback);
        });

        await expect(manager(db).recoverOrphanedGames()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                scope: 'orphaned_solo_games',
                scanFailed: false,
                scanned: 2,
                resolved: 1,
                unresolved: [{ type: 'game', id: '4' }]
            }
        });
        expect(db.game(4).status).toBe('active');
        expect(db.game(5).status).toBe('expired');
    });
});
