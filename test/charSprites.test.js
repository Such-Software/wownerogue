const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCharSprites() {
  const context = {
    console,
    window: { console }
  };
  context.window.window = context.window;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../html/js/render/charSprites.js'), 'utf8'),
    context
  );
  return context.window.RK;
}

describe('roguelike character sprites', () => {
  test('equipment stays fixed color unless an asset explicitly opts into tinting', () => {
    const RK = loadCharSprites();
    const parts = RK.charOverlayParts({
      avatar: 'char-wizard',
      tint: 'gold',
      colors: { base: 'gold', body: 'moss', head: 'teal' },
      equipment: { body: 'mail', head: 'helm', shield: 'round', weapon: 'sword' }
    });

    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: 'body', id: 'mail', tint: 'none', colorable: false }),
      expect.objectContaining({ slot: 'head', id: 'helm', tint: 'none', colorable: false }),
      expect.objectContaining({ slot: 'shield', id: 'round', tint: 'none', colorable: false }),
      expect.objectContaining({ slot: 'weapon', id: 'sword', tint: 'none', colorable: false })
    ]));
  });
});
