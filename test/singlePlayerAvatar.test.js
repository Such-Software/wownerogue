const fs = require('fs');
const path = require('path');

describe('single-player character identity wiring', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../html/index.html'), 'utf8');
  const socketHandlers = fs.readFileSync(path.join(__dirname, '../html/js/network/socketHandlers.js'), 'utf8');
  const renderEngine = fs.readFileSync(path.join(__dirname, '../html/js/display/renderEngine.js'), 'utf8');

  test('main page loads shared character renderer dependencies before the overlay bridge', () => {
    const order = [
      'js/render/atlas.js',
      'js/render/skins.js',
      'js/render/charSprites.js',
      'js/render/assetPacks.js',
      'js/render/charCustomize.js',
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
});
