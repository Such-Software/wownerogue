const MatchPayoutService = require('../src/network/matchPayoutService');
const MatchRoom = require('../src/multiplayer/MatchRoom');

describe('MatchPayoutService', () => {
    const enabledEnv = (overrides = {}) => ({
        MATCH_ENABLED: 'true',
        MATCH_CRYPTO_RACE_ENABLED: 'true',
        MATCH_PAYOUTS_ENABLED: 'true',
        MATCH_PAYOUT_MAX: '100000000000000000',
        MATCH_ENTRY_FEE_ATOMIC: '10000',
        MATCH_HOUSE_FEE_PERCENT: '5',
        PAYOUTS_ENABLED: 'true',
        PAYMENTS_ENABLED: 'true',
        MATCH_RULESET_ID: 'race',
        MATCH_MAX_PLAYERS: '4',
        CRYPTO_TYPE: 'XMR',
        MONERO_NETWORK: 'stagenet',
        ...overrides
    });

    function makeDb({ address = 'WALLET_ADDRESS', accepted = true, amount = '19000', cap = '1000000', existing = null } = {}) {
        const captured = [];
        return {
            captured,
            async query(sql) {
                if (sql.includes('SELECT m.id')) return { rows: [] };
                return { rows: [], rowCount: 0 };
            },
            async withTransaction(fn) {
                const client = {
                    async query(sql, params) {
                        captured.push({ sql, params });
                        if (sql.includes('FROM match_queue_entries') && sql.includes('FOR UPDATE')) {
                            const ids = params[0];
                            return {
                                rows: ids.map((id, index) => ({
                                    id,
                                    user_id: index + 1,
                                    race_entry_lot_id: 100 + index,
                                    escrow_amount: '1',
                                    escrow_value_atomic: '10000'
                                })),
                                rowCount: ids.length
                            };
                        }
                        if (sql.includes('FROM matches') && sql.includes('FOR UPDATE')) {
                            return { rows: [{
                                id: params[0], economy: 'crypto_race', status: 'finished', winner_user_id: 1,
                                payout_liability_amount_atomic: amount,
                                payout_liability_cap_atomic: cap,
                                payout_liability_accepted_at: accepted ? new Date().toISOString() : null
                            }], rowCount: 1 };
                        }
                        if (sql.includes('FROM payouts') && sql.includes('LIMIT 1')) {
                            return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
                        }
                        if (sql.includes('FROM users') && sql.includes('payout_address')) {
                            return { rows: [{ id: 1, payout_address: address }], rowCount: 1 };
                        }
                        return { rows: [{ id: 99 }], rowCount: 1 };
                    }
                };
                return fn(client);
            }
        };
    }

    function manager(overrides = {}) {
        return {
            payoutsEnabled: true,
            directModeEnabled: true,
            creditsModeEnabled: false,
            _scheduleBatchPayout: jest.fn(),
            ...overrides
        };
    }

    function makeRoom() {
        const room = new MatchRoom({
            economy: 'crypto_race',
            entrants: { a: { userId: 1 }, b: { userId: 2 } },
            seed: '0'.repeat(64)
        });
        room.start();
        room.playerStates.get('a').escaped = true;
        room.winnerId = 'a';
        room.status = 'finished';
        room.finalize();
        return room;
    }

    test('collectEntryTickets atomically locks exact pot and accepted payout terms', async () => {
        const db = makeDb();
        const service = new MatchPayoutService({ db, env: enabledEnv(), gameModeManager: manager() });
        const room = makeRoom();

        await service.collectEntryTickets(room, [
            { userId: 1, socketId: 'a', queueEntryId: 11 },
            { userId: 2, socketId: 'b', queueEntryId: 12 }
        ]);

        const updateMatch = db.captured.find(q => q.sql.includes('payout_liability_accepted_at = NOW()'));
        expect(updateMatch).toBeTruthy();
        expect(updateMatch.params.slice(0, 6)).toEqual([
            '10000', '20000', '1000', 5, '19000', '100000000000000000'
        ]);
        expect(JSON.parse(updateMatch.params[6])).toEqual(expect.objectContaining({
            playerCount: 2,
            payoutAmountAtomic: '19000',
            rulesetId: 'race'
        }));
        expect(room.potAtomic).toBe('20000');
    });

    test('accepted ON -> OFF liability still creates a pending payout', async () => {
        const db = makeDb();
        const gmm = manager({ payoutsEnabled: false });
        const service = new MatchPayoutService({
            db,
            env: enabledEnv({ MATCH_PAYOUTS_ENABLED: 'false', PAYOUTS_ENABLED: 'false' }),
            gameModeManager: gmm
        });

        const result = await service.payoutWinner(makeRoom());

        const insert = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(result).toEqual(expect.objectContaining({ created: true, amount: '19000' }));
        expect(insert.params[3]).toBe('19000');
        expect(insert.params[5]).toBe('match_winner');
        // Global off pauses dispatch, but does not suppress recording the obligation.
        expect(gmm._scheduleBatchPayout).toHaveBeenCalledTimes(1);
    });

    test('OFF -> ON never creates a retroactive match liability', async () => {
        const db = makeDb({ accepted: false });
        const service = new MatchPayoutService({ db, env: enabledEnv(), gameModeManager: manager() });

        const result = await service.payoutWinner(makeRoom());

        expect(result).toEqual({ created: false, reason: 'liability_not_accepted' });
        expect(db.captured.some(q => q.sql.includes('INSERT INTO payouts'))).toBe(false);
    });

    test('needs_review payout identity blocks a replacement row', async () => {
        const db = makeDb({ existing: { id: 77, status: 'needs_review' } });
        const service = new MatchPayoutService({ db, env: enabledEnv(), gameModeManager: manager() });

        const result = await service.payoutWinner(makeRoom());

        expect(result).toEqual({ created: false, reason: 'payout_exists', payoutId: 77 });
        expect(db.captured.some(q => q.sql.includes('INSERT INTO payouts'))).toBe(false);
    });

    test('winner with no address records a claimable needs_review liability', async () => {
        const db = makeDb({ address: null });
        const service = new MatchPayoutService({ db, env: enabledEnv(), gameModeManager: manager() });

        await service.payoutWinner(makeRoom());

        const insert = db.captured.find(q => q.sql.includes('INSERT INTO payouts'));
        expect(insert.params[2]).toBe('PENDING_NO_ADDRESS');
        expect(insert.params[5]).toBe('match_winner_no_address');
        expect(insert.params[6]).toBe('needs_review');
    });
});
