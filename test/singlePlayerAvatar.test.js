const fs = require('fs');
const path = require('path');

describe('single-player character identity wiring', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../html/index.html'), 'utf8');
  const socketHandlers = fs.readFileSync(path.join(__dirname, '../html/js/network/socketHandlers.js'), 'utf8');
  const renderEngine = fs.readFileSync(path.join(__dirname, '../html/js/display/renderEngine.js'), 'utf8');
  const screenManager = fs.readFileSync(path.join(__dirname, '../html/js/display/screenManager.js'), 'utf8');
  const avatarVisuals = fs.readFileSync(path.join(__dirname, '../html/js/render/avatarVisuals.js'), 'utf8');
  const singlePlayerAvatar = fs.readFileSync(path.join(__dirname, '../html/js/core/singlePlayerAvatar.js'), 'utf8');

  test('main page loads the avatar visual resolver before the overlay bridge', () => {
    const order = [
      'js/render/atlas.js',
      'js/render/skins.js',
      'js/render/charSprites.js',
      'js/render/assetPacks.js',
      'js/render/renderModes.js',
      'js/render/charCustomize.js',
      'js/render/avatarVisuals.js',
      'js/core/singlePlayerAvatar.js'
    ].map(src => indexHtml.indexOf(src));

    expect(order.every(pos => pos > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(indexHtml).toContain('id="characterButton"');
  });

  test('socket identity updates are forwarded to the single-player avatar bridge', () => {
    expect(socketHandlers).toContain("socket.on('identity_update', this.onIdentityUpdate)");
    expect(socketHandlers).toContain("socket.emit('identity:get')");
    expect(socketHandlers).toContain('SinglePlayerAvatar.applyIdentity(data)');
  });

  test('dungeon renderer suppresses the legacy player tile only when overlay is ready', () => {
    expect(renderEngine).toContain('SinglePlayerAvatar.canDrawPlayer');
    expect(renderEngine).toContain('if (!avatarOverlayReady)');
    expect(renderEngine).toContain('SinglePlayerAvatar.drawPlayer');
  });

  test('welcome legend draws the player as the original hero tile (uniform grid, no overlay)', () => {
    // The splash draws every icon — including the player — as a grid tile so the four rows align
    // and the player is the original hero tile, not a staggered avatar overlay.
    expect(screenManager).toContain('role: "player"');
    expect(screenManager).toContain('SinglePlayerAvatar.clearOverlay'); // overlay still cleared
    expect(screenManager).not.toContain('SinglePlayerAvatar.drawLegendIcon'); // ...but not used to draw it
    expect(screenManager).toContain('"@2"'); // the original player/hero tile
  });

  test('welcome legend uses compact one-row avatar metrics', () => {
    expect(singlePlayerAvatar).toContain("context: 'legend'");
    expect(singlePlayerAvatar).toContain('scale: 0.78');
    expect(avatarVisuals).toContain("visual.context === 'legend'");
  });

  test('dungeon renderer falls back to @ tile when overlay draw fails', () => {
    expect(renderEngine).toContain('var drew = window.SinglePlayerAvatar.drawPlayer');
    expect(renderEngine).toContain('if (!drew)');
    expect(renderEngine).toContain('display.draw(centerX, centerY, playerTile');
  });

  test('customizer does not auto-switch avatar identity on render mode change', () => {
    const charCustomize = fs.readFileSync(path.join(__dirname, '../html/js/render/charCustomize.js'), 'utf8');
    const buildAvatarGridMatch = charCustomize.match(/function buildAvatarGrid\(\)[\s\S]*?grid\.innerHTML/);
    expect(buildAvatarGridMatch).toBeTruthy();
    expect(buildAvatarGridMatch[0]).not.toContain('ensureVisibleAvatar()');
  });

  test('equipment option tiles register for async redraw', () => {
    const charCustomize = fs.readFileSync(path.join(__dirname, '../html/js/render/charCustomize.js'), 'utf8');
    expect(charCustomize).toContain('optionTileCanvas(slot, item, draft, equipRedrawers)');
    expect(charCustomize).not.toContain('optionTileCanvas(slot, item, draft, null)');
  });
});
