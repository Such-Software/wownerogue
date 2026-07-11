const Appearance = require('../src/multiplayer/appearance');
const Entitlements = require('../src/multiplayer/entitlements');

describe('cosmetic entitlements', () => {
  test('free users cannot select premium generated skins or 3D avatars', () => {
    const entitlements = Entitlements.snapshotForUser({ credits: 0, total_credits_purchased: 0 });

    expect(Entitlements.canUsePack(entitlements, 'generated-skins')).toBe(false);
    expect(Entitlements.canUsePack(entitlements, 'kenney-3d-characters')).toBe(false);
    expect(Entitlements.normalizeAppearance({ avatar: 'monero-knight' }, entitlements).avatar).toBe('default');
    expect(Entitlements.normalizeAppearance({ avatar: 'kenney-survivor-male' }, entitlements).avatar).toBe('default');
  });

  test('graduated ladder: credit spend unlocks packs by threshold', () => {
    const entitlements = Entitlements.snapshotForUser({ credits: 7, total_credits_purchased: 10 });

    expect(entitlements.premium).toBe(true);
    expect(entitlements.level).toBe('free'); // spend unlocks packs by threshold, but isn't a premium tier
    expect(entitlements.packs['generated-skins']).toBe(true);         // threshold 1
    expect(entitlements.packs['iso-dungeon']).toBe(true);            // threshold 10 — just reached
    expect(entitlements.packs['kenney-3d-characters']).toBe(false);  // threshold 25 — not yet
    expect(Entitlements.normalizeAppearance({ avatar: 'monero-knight' }, entitlements).avatar).toBe('monero-knight');
  });

  test('explicit pack grants can unlock one pack without unlocking all packs', () => {
    const entitlements = Entitlements.snapshotForUser(
      { credits: 0, total_credits_purchased: 0 },
      [{ pack_id: 'generated-skins' }]
    );

    expect(entitlements.premium).toBe(true);
    expect(entitlements.packs['generated-skins']).toBe(true);
    expect(entitlements.packs['kenney-3d-characters']).toBe(false);
    expect(Entitlements.normalizeAppearance({ avatar: 'monero-knight' }, entitlements).avatar).toBe('monero-knight');
    expect(Entitlements.normalizeAppearance({ avatar: 'kenney-survivor-male' }, entitlements).avatar).toBe('default');
  });

  test('appearance catalog reports all premium avatar ids, including 3D models', () => {
    expect(Appearance.premiumAvatarIds()).toEqual(expect.arrayContaining([
      'monero-knight',
      'wownero-rogue',
      'cypher-operative',
      'kenney-survivor-male',
      'kenney-survivor-female'
    ]));
    expect(Appearance.avatarPack('kenney-survivor-male')).toBe('kenney-3d-characters');
  });
});
