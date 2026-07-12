/**
 * Credits unification, step ②: a direct/single_game entry is recorded as "buy 1 credit and
 * spend it" — the balance nets to zero but total_credits_purchased advances, so direct play
 * unlocks the same tier/threshold cosmetics as buying credits.
 */

const GameModeManager = require('../src/game/gameModeManager');

const mockPaymentConfig = () => ({
    getConfig: () => ({
        paymentsEnabled: true,
        currency: { symbol: 'WOW', decimals: 11 },
        modes: {
            direct: { enabled: true, price: 100000000000n },
            credits: { enabled: false, creditsPerGame: 1, packages: [] }
        },
        payouts: { rules: { direct: { enabled: false, multipliers: { escape: 2, escapeWithTreasure: 3 }, minPayout: 0n, maxPayout: 0n } } },
        preferences: { preferCreditsFirst: true },
        earlyEntry: { enabled: false }
    }),
    getLegacyGameMode: () => 'PAID_SINGLE',
    eventBus: { on: () => {} }
});

function makeGmm(userRow) {
    const client = { query: jest.fn().mockResolvedValue({ rows: [userRow] }) };
    const db = {
        query: jest.fn().mockResolvedValue({ rows: [] }), // user_pack_entitlements lookup
        withTransaction: jest.fn().mockImplementation(async (cb) => cb(client)),
        _client: client
    };
    const gmm = new GameModeManager(db, { processPayout: jest.fn() }, { CONSOLE_LOGGING: false, getCurrentBlockHeight: () => 1 }, mockPaymentConfig());
    gmm.getOrCreateUser = jest.fn().mockResolvedValue({ id: 7 });
    return { gmm, db, client };
}

describe('recordDirectEntryPurchase', () => {
    test('advances total_credits_purchased and unlocks threshold-1 packs', async () => {
        const { gmm, client } = makeGmm({ total_credits_purchased: 1, credits: 0, premium_level: null });
        const rec = await gmm.recordDirectEntryPurchase('sock');
        expect(rec).toBeTruthy();
        expect(rec.totalCreditsPurchased).toBe(1);
        expect(rec.balance).toBe(0); // net zero — bought and spent

        const insert = client.query.mock.calls.find(c => /INSERT INTO credit_transactions/i.test(c[0]));
        expect(insert).toBeTruthy();
        expect(insert[0]).toMatch(/'direct_entry'/); // audits the purchase leg
        expect(insert[0]).toMatch(/'game_entry'/);   // audits the spend leg

        // A direct entry = 1 credit, which unlocks the first tilepack (roguelike-interior, threshold
        // 1) but not skins (5) / Iso (10) / 3D (50).
        expect(rec.entitlements.packs['roguelike-interior']).toBe(true);
        expect(rec.entitlements.packs['generated-skins']).toBe(false);
        expect(rec.entitlements.packs['iso-dungeon']).toBe(false);
        expect(rec.entitlements.premium).toBe(true);
        // ...but a direct buyer is still NOT a premium tier.
        expect(rec.entitlements.level).toBe('free');
    });

    test('returns null when the session has no user', async () => {
        const { gmm } = makeGmm({});
        gmm.getOrCreateUser = jest.fn().mockResolvedValue(null);
        expect(await gmm.recordDirectEntryPurchase('sock')).toBe(null);
    });
});
