const ProductGrants = require('../src/payments/productGrants');

describe('product grants', () => {
  test('derives credit grants from credit package fields when grants are absent', () => {
    const grants = ProductGrants.normalizeProductGrants({ id: 'small', credits: 10, bonus: 2 });

    expect(grants).toMatchObject({
      credits: 12,
      packs: [],
      premiumLevel: null
    });
  });

  test('normalizes bundled pack grants and premium tier', () => {
    const grants = ProductGrants.normalizeProductGrants({
      id: 'bundle',
      credits: 10,
      grants: {
        credits: 15,
        packs: ['generated-skins', { id: 'kenney-3d-characters' }, 'bad-pack'],
        premiumLevel: 'Supporter'
      }
    });

    expect(grants.credits).toBe(15);
    expect(grants.packs.map(p => p.id)).toEqual(['generated-skins', 'kenney-3d-characters']);
    expect(grants.premiumLevel).toBe('supporter');
  });

  test('public summaries omit internal source/expiry fields', () => {
    const summary = ProductGrants.publicGrantSummary({
      credits: 0,
      packs: [{ id: 'iso-dungeon', source: 'operator', expiresAt: '2030-01-01' }],
      premiumLevel: null
    });

    expect(summary).toEqual({
      credits: 0,
      packs: ['iso-dungeon'],
      premiumLevel: null
    });
  });
});
