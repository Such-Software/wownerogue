/**
 * Premium-subscription -> cosmetic-tier data source (decaveat: entitlements now HAS a source).
 */
const SubscriptionService = require('../src/services/subscriptionService');
const IdentityService = require('../src/network/identityService');
const { loadNostrTools } = require('../src/utils/nostrLoader');

const tools = loadNostrTools();
const sk = tools.generateSecretKey();
const pubHex = tools.getPublicKey(sk);
const npub = tools.nip19.npubEncode(pubHex);

describe('SubscriptionService', () => {
    test('no source configured -> null (inert, unchanged behavior)', async () => {
        const svc = new SubscriptionService({ env: {} });
        expect(svc.enabled).toBe(false);
        expect(await svc.tierForNpub(pubHex)).toBeNull();
    });

    test('PREMIUM_NPUBS allowlist grants the tier — hex and npub1 both match the stored pubkey', async () => {
        const byHex = new SubscriptionService({ env: { PREMIUM_NPUBS: pubHex } });
        expect(await byHex.tierForNpub(pubHex)).toBe('premium'); // default tier

        const byNpub = new SubscriptionService({ env: { PREMIUM_NPUBS: `${npub}:operator` } });
        expect(await byNpub.tierForNpub(pubHex)).toBe('operator'); // decoded npub1 matches the hex pubkey
        expect(await byNpub.tierForNpub('cc'.repeat(32))).toBeNull(); // someone else
    });

    test('HTTP source is queried when configured and caches the result', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ active: true, tier: 'premium' }) });
        const svc = new SubscriptionService({ env: { SMIRK_PREMIUM_STATUS_URL: 'https://api.example/premium' }, fetchImpl, now: () => 1000 });
        expect(await svc.tierForNpub(pubHex)).toBe('premium');
        expect(await svc.tierForNpub(pubHex)).toBe('premium'); // cached
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('HTTP inactive subscription -> null', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ active: false }) });
        const svc = new SubscriptionService({ env: { SMIRK_PREMIUM_STATUS_URL: 'https://api.example/premium' }, fetchImpl });
        expect(await svc.tierForNpub(pubHex)).toBeNull();
    });
});

describe('IdentityService wires the subscription tier into entitlements', () => {
    test('an allowlisted npub unlocks premium cosmetics with no purchase', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) }; // no pack grants
        const identity = new IdentityService({
            db,
            catalogService: { getCatalog: async () => undefined }, // -> DEFAULT_CATALOG
            subscriptionService: new SubscriptionService({ env: { PREMIUM_NPUBS: pubHex } })
        });
        const ent = await identity.entitlementsForUser({ id: 7, smirk_public_key: pubHex, total_credits_purchased: 0 });
        expect(ent.level).toBe('premium');
        expect(ent.tier).toBe(2);
        expect(ent.packs['generated-skins']).toBe(true); // tier-1 pack unlocked by the sub
    });

    test('a non-premium user is unchanged (tier 0)', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        const identity = new IdentityService({
            db,
            catalogService: { getCatalog: async () => undefined },
            subscriptionService: new SubscriptionService({ env: {} })
        });
        const ent = await identity.entitlementsForUser({ id: 8, smirk_public_key: 'dd'.repeat(32), total_credits_purchased: 0 });
        expect(ent.tier).toBe(0);
        expect(ent.packs['generated-skins']).toBe(false);
    });
});
