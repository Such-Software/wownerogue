const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRenderKit() {
  const context = {
    console,
    window: {
      console,
      localStorage: {
        getItem: () => null,
        setItem: () => {}
      }
    }
  };
  context.window.window = context.window;

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/render/assetPacks.js'), 'utf8'),
    context
  );

  const RK = context.window.RK;
  RK.normalizeAppearance = input => {
    if (input && input.appearance && !input.avatar) input = input.appearance;
    if (typeof input === 'string') input = { avatar: input };
    input = input || {};
    return {
      avatar: input.avatar || 'default',
      tint: input.tint || 'none',
      equipment: input.equipment || { body: 'none', head: 'none', shield: 'none', weapon: 'none' },
      colors: input.colors
    };
  };
  RK.appearance = input => ({ label: (input && input.avatar) || 'Character' });
  RK.SKINS = {
    'monero-knight': { id: 'monero-knight', label: 'Monero Knight', pack: 'generated-skins' }
  };
  RK.isSkin = id => !!RK.SKINS[id];
  RK.CHARS = { 'char-ranger': { id: 'char-ranger', label: 'Ranger', frame: 432 } };
  RK.isChar = id => !!RK.CHARS[id];

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/render/avatarVisuals.js'), 'utf8'),
    context
  );

  RK.TileRenderer = function TileRenderer() { this.name = 'tiles'; };
  RK.IsoRenderer = function IsoRenderer() { this.name = 'iso'; };
  RK.ThreeRenderer = function ThreeRenderer() { this.name = '3d'; };
  RK.THREE = { THREE: {}, GLTFLoader: function GLTFLoader() {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/render/renderModes.js'), 'utf8'),
    context
  );
  RK.RENDER_MODE_TEST_UNLOCKS = false;

  return RK;
}

describe('render pack visual resolver', () => {
  test('resolves iso and 3D visuals through pack entitlements', () => {
    const RK = loadRenderKit();
    RK.setEntitlementSnapshot({ totalCreditsPurchased: 0, premium: false, packs: {} });

    const locked3d = RK.avatarVisuals.resolve(
      { avatar: 'kenney-survivor-male' },
      { projection: '3d' }
    );
    expect(locked3d).toMatchObject({
      projection: '3d',
      kind: 'model3d',
      pack: 'kenney-3d-characters',
      allowed: false
    });
    expect(locked3d.model.url).toContain('survivorMaleB.glb');

    RK.setEntitlementSnapshot({ totalCreditsPurchased: 1 });
    const iso = RK.avatarVisuals.resolve({ avatar: 'char-ranger' }, { projection: 'iso' });
    expect(iso).toMatchObject({ projection: 'iso', kind: 'iso', pack: 'iso-dungeon', allowed: true });
    expect(iso.character.idle).toContain('Male_0_Idle0.png');

    const compat = RK.resolveAppearance(
      { appearance: { avatar: 'kenney-survivor-female' } },
      '3d'
    );
    expect(compat.model.url).toContain('survivorFemaleA.glb');
  });

  test('renderer factory falls back when premium modes are locked', () => {
    const RK = loadRenderKit();
    RK.setEntitlementSnapshot({ totalCreditsPurchased: 0, premium: false, packs: {} });

    expect(RK.canUseMode('iso')).toBe(false);
    expect(RK.createRenderer('iso', {}, {}).name).toBe('tiles');

    RK.setEntitlementSnapshot({ totalCreditsPurchased: 1 });
    expect(RK.canUseMode('iso')).toBe(true);
    expect(RK.createRenderer('iso', {}, {}).name).toBe('iso');
  });

  test('temporary render test unlocks bypass mode gates only for render packs', () => {
    const RK = loadRenderKit();
    RK.setEntitlementSnapshot({ totalCreditsPurchased: 0, premium: false, packs: {} });

    expect(RK.canUseMode('iso')).toBe(false);
    expect(RK.canUsePack('iso-dungeon')).toBe(false);

    RK.RENDER_MODE_TEST_UNLOCKS = true;
    expect(RK.canUseMode('ascii')).toBe(true);
    expect(RK.canUseMode('fancy')).toBe(true);
    expect(RK.canUseMode('iso')).toBe(true);
    expect(RK.canUseMode('3d')).toBe(true);
    expect(RK.canUsePack('iso-dungeon')).toBe(true);
    expect(RK.canUsePack('kenney-3d-characters')).toBe(true);
    expect(RK.canUsePack('generated-skins')).toBe(false);
  });

  test('render pack code stays out of payment and account APIs', () => {
    const files = [
      '../html/js/render/assetPacks.js',
      '../html/js/render/avatarVisuals.js',
      '../html/js/render/renderModes.js',
      '../html/js/render/isoRenderer.js',
      '../html/js/render/threeRenderer.js',
      '../html/js/render/tileRenderer.js'
    ];
    const source = files.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
    [
      'PaymentUI',
      'request_payment',
      'payment_',
      'wallet',
      'subaddress',
      '/api/',
      'user_id',
      'socket.emit'
    ].forEach(forbidden => {
      expect(source).not.toContain(forbidden);
    });
  });
});
