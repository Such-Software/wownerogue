const MatchQueue = require('../src/network/matchQueue');
const MatchRoom = require('../src/multiplayer/MatchRoom');
const MatchScheduler = require('../src/network/matchScheduler');
const MatchManager = require('../src/network/matchManager');

describe('match queue crash/restart invariants', () => {
    const priorMatchEnabled = process.env.MATCH_ENABLED;

    beforeEach(() => {
        process.env.MATCH_ENABLED = 'true';
    });

    afterEach(() => {
        if (priorMatchEnabled === undefined) delete process.env.MATCH_ENABLED;
        else process.env.MATCH_ENABLED = priorMatchEnabled;
    });

    test('persisting a match links every exact queue row before inserting linked entrants', async () => {
        const captured = [];
        const entries = [
            { userId: 7, socketId: 's7', queueEntryId: 101 },
            { userId: 8, socketId: 's8', queueEntryId: 102 }
        ];
        const db = {
            async withTransaction(fn) {
                return fn({
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('UPDATE match_queue_entries') && sql.includes('SET match_id')) {
                            return {
                                rows: entries.map(entry => ({
                                    id: entry.queueEntryId,
                                    user_id: entry.userId
                                })),
                                rowCount: entries.length
                            };
                        }
                        return { rows: [{ id: 1 }], rowCount: 1 };
                    }
                });
            }
        };
        const room = new MatchRoom({
            economy: 'crypto_race',
            entrants: {
                s7: { userId: 7, socketId: 's7' },
                s8: { userId: 8, socketId: 's8' }
            },
            seed: 'a'.repeat(64)
        });
        const scheduler = new MatchScheduler({ matchQueue: {}, matchManager: { db } });

        await scheduler._persistMatch(room, entries, 'crypto_race');

        const link = captured.find(call => call.sql.includes('SET match_id'));
        expect(link.params).toEqual([room.id, [101, 102], 'crypto_race']);
        expect(link.sql).toContain("status = 'matched'");
        expect(link.sql).toContain('match_id IS NULL');
        const entrantInserts = captured.filter(call => call.sql.includes('INSERT INTO match_entrants'));
        expect(entrantInserts.map(call => call.params)).toEqual([
            [room.id, 7, 's7', 101],
            [room.id, 8, 's8', 102]
        ]);
        scheduler.shutdown();
    });

    test('a finished match with linked consumed tickets is never treated as stale escrow', async () => {
        let staleSql = '';
        const db = {
            query: jest.fn(async (sql) => {
                if (sql.includes('FROM matches')) return { rows: [], rowCount: 0 };
                if (sql.includes('FROM match_queue_entries') && sql.includes("status = 'matched'")) {
                    staleSql = sql;
                    return { rows: [], rowCount: 0 };
                }
                return { rows: [], rowCount: 0 };
            }),
            withTransaction: jest.fn()
        };
        const queue = new MatchQueue({ db });

        await queue.initialize();
        await queue.shutdown();

        expect(staleSql).toContain("status = 'matched' AND match_id IS NULL");
        expect(staleSql).not.toContain("status = 'consumed'");
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('a crash after drain but before match persistence refunds the unlinked hold exactly once', async () => {
        const state = {
            queueStatus: 'matched',
            matchId: null,
            lotRemaining: 0,
            userTickets: 0,
            ledgerRows: 0
        };
        const db = {
            async query(sql) {
                if (sql.includes('FROM match_queue_entries')
                    && state.queueStatus === 'matched'
                    && state.matchId === null) {
                    return {
                        rows: [{
                            id: 41,
                            user_id: 9,
                            economy: 'crypto_race',
                            escrow_amount: '1',
                            race_entry_lot_id: 71
                        }],
                        rowCount: 1
                    };
                }
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('UPDATE match_queue_entries')) {
                            expect(sql).toContain("status = 'matched' AND match_id IS NULL");
                            if (state.queueStatus !== 'matched' || state.matchId !== null) {
                                return { rows: [], rowCount: 0 };
                            }
                            state.queueStatus = 'cancelled';
                            return {
                                rows: [{ id: 41, escrow_amount: '1', race_entry_lot_id: 71 }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('UPDATE race_entry_lots')) {
                            expect(sql).toContain('refunded_at IS NULL');
                            expect(sql).toContain('remaining_entries + $1 <= original_entries');
                            state.lotRemaining += 1;
                            return { rows: [{ id: 71 }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE users')) {
                            state.userTickets += 1;
                            return { rows: [{ race_entries: state.userTickets }], rowCount: 1 };
                        }
                        if (sql.includes('INSERT INTO race_entry_transactions')) {
                            state.ledgerRows += 1;
                            return { rows: [], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 0 };
                    }
                });
            }
        };
        const queue = new MatchQueue({ db });

        await queue._recoverStaleQueueEntries();
        await queue._recoverStaleQueueEntries();

        expect(state).toEqual(expect.objectContaining({
            queueStatus: 'cancelled',
            lotRemaining: 1,
            userTickets: 1,
            ledgerRows: 1
        }));
    });

    test('an abandoned starting match restores a consumed funded ticket only once', async () => {
        const state = {
            matchStatus: 'starting',
            queueStatus: 'consumed',
            lotRemaining: 0,
            userTickets: 0,
            entrantRefunded: false,
            ledgerRows: 0
        };
        const db = {
            async query(sql) {
                if (sql.includes('FROM matches') && state.matchStatus === 'starting') {
                    return { rows: [{ id: 'match-9', economy: 'crypto_race' }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('SELECT id FROM payouts')) return { rows: [], rowCount: 0 };
                        if (sql.includes('UPDATE matches SET status')) {
                            if (state.matchStatus !== 'starting') return { rows: [], rowCount: 0 };
                            state.matchStatus = 'cancelled';
                            return { rows: [{ id: 'match-9' }], rowCount: 1 };
                        }
                        if (sql.includes('FROM match_entrants') && sql.includes('queue_entry_id')) {
                            return {
                                rows: [{ id: 91, user_id: 9, queue_entry_id: 41 }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('UPDATE match_queue_entries') && sql.includes('match_id = $2')) {
                            if (state.queueStatus !== 'consumed') return { rows: [], rowCount: 0 };
                            state.queueStatus = 'cancelled';
                            return {
                                rows: [{ id: 41, escrow_amount: '1', race_entry_lot_id: 71 }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('UPDATE race_entry_lots')) {
                            state.lotRemaining += 1;
                            return { rows: [{ id: 71 }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE users')) {
                            state.userTickets += 1;
                            return { rows: [{ race_entries: state.userTickets }], rowCount: 1 };
                        }
                        if (sql.includes('INSERT INTO race_entry_transactions')) {
                            state.ledgerRows += 1;
                            return { rows: [], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE match_entrants')) {
                            state.entrantRefunded = true;
                            return { rows: [], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 0 };
                    }
                });
            }
        };
        const queue = new MatchQueue({ db });

        await queue._recoverAbandonedMatches();
        await queue._recoverAbandonedMatches();

        expect(state).toEqual({
            matchStatus: 'cancelled',
            queueStatus: 'cancelled',
            lotRemaining: 1,
            userTickets: 1,
            entrantRefunded: true,
            ledgerRows: 1
        });
    });

    test('queue initialization stays closed when the abandoned-match scan fails', async () => {
        const db = {
            query: jest.fn(async sql => {
                if (sql.includes('FROM matches')) throw new Error('scan unavailable');
                return { rows: [], rowCount: 0 };
            }),
            withTransaction: jest.fn()
        };
        const queue = new MatchQueue({ db });

        await expect(queue.initialize()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                scope: 'abandoned_matches',
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }
        });
        expect(queue.initialized).toBe(false);
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('queue initialization rejects after processing peers when one match remains unresolved', async () => {
        let transactionCount = 0;
        const db = {
            query: jest.fn(async sql => {
                if (sql.includes('FROM matches')) {
                    return {
                        rows: [
                            { id: 'unresolved-match', economy: 'crypto_race' },
                            { id: 'resolved-match', economy: 'crypto_race' }
                        ],
                        rowCount: 2
                    };
                }
                return { rows: [], rowCount: 0 };
            }),
            withTransaction: jest.fn(async fn => {
                transactionCount += 1;
                if (transactionCount === 1) throw new Error('refund transaction failed');
                return fn({
                    query: jest.fn(async sql => {
                        if (sql.includes('SELECT id FROM payouts')) {
                            return { rows: [{ id: 91 }], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 1 };
                    })
                });
            })
        };
        const queue = new MatchQueue({ db });

        await expect(queue.initialize()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                scope: 'abandoned_matches',
                scanFailed: false,
                scanned: 2,
                resolved: 1,
                unresolved: [{ type: 'match', id: 'unresolved-match' }]
            }
        });
        expect(queue.initialized).toBe(false);
        expect(db.withTransaction).toHaveBeenCalledTimes(2);
    });

    test('paid queue admission is closed before durable recovery completes', async () => {
        const queue = new MatchQueue({ db: {} });

        expect(await queue.join({ userId: 7, economy: 'credits_prestige' })).toEqual({
            success: false,
            reason: 'financial_recovery_pending'
        });
    });

    test('a later liability-recovery failure closes paid joins, drains, and freezes dynamically', async () => {
        const queue = new MatchQueue({
            db: {},
            isFinancialRecoveryReady: () => false
        });
        queue.initialized = true;
        queue._queues.credits_prestige.push(
            { queueEntryId: 1, userId: 1, socketId: 's1' },
            { queueEntryId: 2, userId: 2, socketId: 's2' }
        );

        expect(await queue.join({ userId: 7, economy: 'credits_prestige' })).toEqual({
            success: false,
            reason: 'financial_recovery_pending'
        });
        await expect(queue.drain('credits_prestige', 2, 2)).resolves.toBeNull();
        await expect(queue.freezePaidMatch({
            economy: 'credits_prestige',
            maxPlayers: 2,
            minPlayers: 2,
            freezeBlockHeight: 10,
            targetBlockHeight: 11,
            rulesetId: 'race'
        })).resolves.toBeNull();
    });

    test('MATCH_ENABLED=false still refunds durable queued escrow during boot', async () => {
        process.env.MATCH_ENABLED = 'false';
        let userTickets = 0;
        let lotTickets = 0;
        let ledgerRows = 0;
        const db = {
            async query(sql) {
                if (sql.includes('FROM matches')) return { rows: [], rowCount: 0 };
                if (sql.includes("status = 'matched'") && sql.includes('INTERVAL')) {
                    return { rows: [], rowCount: 0 };
                }
                if (sql.includes("WHERE status = 'queued'")) {
                    return {
                        rows: [{
                            id: 55,
                            user_id: 12,
                            economy: 'crypto_race',
                            socket_id: 'old-socket',
                            session_token: 'session',
                            created_at: new Date().toISOString()
                        }],
                        rowCount: 1
                    };
                }
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                return fn({
                    async query(sql) {
                        if (sql.includes('DELETE FROM match_queue_entries')) {
                            return {
                                rows: [{ id: 55, escrow_amount: '1', race_entry_lot_id: 77 }],
                                rowCount: 1
                            };
                        }
                        if (sql.includes('UPDATE users')) {
                            userTickets += 1;
                            return { rows: [{ race_entries: userTickets }], rowCount: 1 };
                        }
                        if (sql.includes('UPDATE race_entry_lots')) {
                            lotTickets += 1;
                            return { rows: [{ id: 77 }], rowCount: 1 };
                        }
                        if (sql.includes('INSERT INTO race_entry_transactions')) {
                            ledgerRows += 1;
                            return { rows: [], rowCount: 1 };
                        }
                        return { rows: [], rowCount: 0 };
                    }
                });
            }
        };
        const queue = new MatchQueue({ db });

        await queue.initialize();
        await queue.shutdown();

        expect(queue.isEnabled()).toBe(false);
        expect(queue.length('crypto_race')).toBe(0);
        expect({ userTickets, lotTickets, ledgerRows }).toEqual({
            userTickets: 1,
            lotTickets: 1,
            ledgerRows: 1
        });
    });

    test('MATCH_ENABLED=false still reconciles an already-finished accepted liability', async () => {
        process.env.MATCH_ENABLED = 'false';
        const manager = new MatchManager({ db: {}, io: null });
        manager.matchPayoutService.reconcileFinishedLiabilities = jest.fn().mockResolvedValue({
            scanned: 1,
            created: 1,
            failed: 0
        });

        await manager.initialize();

        expect(manager.enabled).toBe(false);
        expect(manager.matchPayoutService.reconcileFinishedLiabilities).toHaveBeenCalledTimes(1);
        manager.shutdown();
    });

    test('finished accepted-liability failures keep match recovery and startup closed', async () => {
        const manager = new MatchManager({ db: {}, io: null });
        manager.matchPayoutService.reconcileFinishedLiabilities = jest.fn().mockResolvedValue({
            ok: false,
            scanned: 1,
            created: 0,
            failed: 1,
            unresolved: [{ type: 'match_liability', id: 'match-owed' }]
        });

        await expect(manager.initialize()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                scope: 'finished_match_liabilities',
                scanFailed: false,
                scanned: 1,
                resolved: 0,
                unresolved: [{ type: 'match_liability', id: 'match-owed' }]
            }
        });
        expect(manager.financialRecoveryReady).toBe(false);
        expect(manager._liabilityReconcileTimer).toBeNull();
        manager.shutdown();
    });

    test('finished-liability scan errors have explicit fail-closed startup semantics', async () => {
        const manager = new MatchManager({ db: {}, io: null });
        manager.matchPayoutService.reconcileFinishedLiabilities = jest.fn()
            .mockRejectedValue(new Error('liability scan unavailable'));

        await expect(manager.initialize()).rejects.toMatchObject({
            code: 'FINANCIAL_RECOVERY_INCOMPLETE',
            recovery: {
                scope: 'finished_match_liabilities',
                scanFailed: true,
                scanned: 0,
                resolved: 0,
                unresolved: []
            }
        });
        expect(manager.financialRecoveryReady).toBe(false);
        manager.shutdown();
    });

    test('bounded reconciliation retries a later transient failure and reopens the dynamic gate', async () => {
        const manager = new MatchManager({ db: {}, io: null });
        manager.matchPayoutService.reconcileFinishedLiabilities = jest.fn().mockResolvedValue({
            ok: true, scanned: 0, created: 0, failed: 0, unresolved: []
        });
        await manager.initialize();
        manager.matchPayoutService.reconcileFinishedLiabilities
            .mockResolvedValueOnce({
                ok: false,
                scanned: 1,
                created: 0,
                failed: 1,
                unresolved: [{ type: 'match_liability', id: 'match-retry' }]
            })
            .mockResolvedValueOnce({
                ok: true,
                scanned: 1,
                created: 1,
                failed: 0,
                unresolved: []
            });

        const failed = await manager._reconcileFinishedLiabilities({ failClosed: false });
        expect(failed.ok).toBe(false);
        expect(manager.financialRecoveryReady).toBe(false);

        const retried = await manager._reconcileFinishedLiabilities({ failClosed: false });
        expect(retried).toMatchObject({ ok: true, scanned: 1, created: 1, failed: 0 });
        expect(manager.financialRecoveryReady).toBe(true);
        manager.shutdown();
    });
});
