const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadRenderModes(runtime, preloadedThree = null) {
  const window = {
    console,
    WOWNGEON_RUNTIME: runtime,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    RK: {
      TileRenderer: function TileRenderer() {},
      THREE: preloadedThree,
    },
  };
  window.window = window;

  const source = fs.readFileSync(
    path.join(__dirname, '../html/js/render/renderModes.js'),
    'utf8',
  );
  vm.runInNewContext(source, { window, console });
  return window.RK;
}

function fakeElement(tagName) {
  const classes = new Set();
  const element = {
    tagName,
    children: [],
    className: '',
    textContent: '',
    title: '',
    attributes: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
  Object.defineProperty(element, 'innerHTML', {
    set() { element.children = []; },
  });
  return element;
}

function loadPickerWithRuntimeDisabled() {
  const picker = fakeElement('div');
  const head = fakeElement('head');
  const document = {
    head,
    createElement: fakeElement,
    getElementById(id) {
      if (id === 'renderPicker') return picker;
      if (id === 'rp-style') return head.children.find(child => child.id === 'rp-style') || null;
      return null;
    },
    addEventListener() {},
  };
  const window = {
    console,
    document,
    WOWNGEON_RUNTIME: { rendererCdnEnabled: false },
    localStorage: { getItem: () => null, setItem: () => {} },
    RK: { TileRenderer: function TileRenderer() {} },
  };
  window.window = window;
  const context = { window, document, console };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/render/renderModes.js'), 'utf8'),
    context,
  );
  window.RK.entitlements.premium = true;
  window.RK.SPGame = { mode: () => 'tiles', setMode: () => true };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/ui/spRenderPicker.js'), 'utf8'),
    context,
  );
  window.RK.rebuildRenderPicker();
  return { picker, RK: window.RK };
}

describe('optional renderer CDN policy', () => {
  test('external renderer loading defaults closed', () => {
    const RK = loadRenderModes(undefined);

    expect(RK.externalRenderersEnabled()).toBe(false);
    expect(RK.isModeRuntimeAvailable('3d')).toBe(false);
    expect(RK.modeAvailability('3d')).toMatchObject({
      usable: false,
      runtimeAvailable: false,
      reason: 'runtime_unavailable',
    });
    expect(RK.canUseMode('3d')).toBe(false);

    const callback = jest.fn();
    RK.ensureThree(callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  test('a locally preloaded renderer remains usable with CDN loading disabled', () => {
    const localThree = {
      THREE: { REVISION: 'local-test' },
      GLTFLoader: function GLTFLoader() {},
    };
    const RK = loadRenderModes({ rendererCdnEnabled: false }, localThree);
    RK.entitlements.premium = true;

    expect(RK.canUseMode('3d')).toBe(true);

    const callback = jest.fn();
    RK.ensureThree(callback);
    expect(callback).toHaveBeenCalledWith(true);
  });

  test('homepage picker labels policy-disabled 3D as unavailable, not purchasable', () => {
    const { picker } = loadPickerWithRuntimeDisabled();
    const modeButtons = picker.children[0].children;
    const threeButton = modeButtons.find(button => button.textContent.startsWith('3D'));

    expect(threeButton.textContent).toContain('⛔');
    expect(threeButton.textContent).not.toContain('🔒');
    expect(threeButton.title).toMatch(/unavailable on this server/i);
    expect(threeButton.title).not.toMatch(/unlock with credits/i);
    expect(threeButton.attributes['aria-disabled']).toBe('true');
  });

  test('server CSP trusts jsDelivr only when the renderer CDN flag is enabled', () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, '../src/index.js'),
      'utf8',
    );

    expect(serverSource).toContain('RENDERER_CDN_ENABLED');
    expect(serverSource).toMatch(/if \(rendererCdnEnabled\) \{[\s\S]*scriptSources\.push\('https:\/\/cdn\.jsdelivr\.net'\)/);
    expect(serverSource).not.toContain("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
  });

  test('browser pages use the pinned same-origin jQuery 3.7.1 asset', () => {
    const asset = fs.readFileSync(path.join(__dirname, '../html/js/lib/jquery-3.7.1.min.js'));
    const homepage = fs.readFileSync(path.join(__dirname, '../html/index.html'), 'utf8');
    const debugPage = fs.readFileSync(path.join(__dirname, '../html/debug.html'), 'utf8');

    expect(asset.toString('utf8', 0, 100)).toContain('jQuery v3.7.1');
    expect(crypto.createHash('sha256').update(asset).digest('hex'))
      .toBe('3289f31657004339ed678f16c4e626987e57303f2107577ed4973f6c9e105260');
    expect(homepage).toContain('js/lib/jquery-3.7.1.min.js');
    expect(debugPage).toContain('js/lib/jquery-3.7.1.min.js');
    expect(homepage + debugPage).not.toContain('jquery-3.4.1');
  });
});
