/**
 * Provably-fair verification page (server-rendered HTML).
 * Extracted from index.js. Interpolated values are HTML-escaped (defense in depth — the
 * game-record block only renders for a seed that matched a real game, but escape anyway).
 */

function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderVerifyPage(gameId, gameRecord, gameName) {
    const name = gameName || 'Wownerogue';
    const recordBlock = gameRecord ? `
  <div class="box">
    <h3>Game Record</h3>
    <p><strong>Game ID:</strong> ${esc(gameId)}</p>
    <p><strong>Status:</strong> ${esc(gameRecord.status)}</p>
    <p><strong>Treasure Found:</strong> ${gameRecord.treasure_found ? 'Yes' : 'No'}</p>
    <p><strong>Moves:</strong> ${esc(gameRecord.moves_made || 'N/A')}</p>
    <p><strong>Duration:</strong> ${gameRecord.duration_seconds ? esc(gameRecord.duration_seconds) + 's' : 'N/A'}</p>
    <p><strong>Created:</strong> ${esc(gameRecord.created_at)}</p>
  </div>
  ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <title>${esc(name)} - Game Verification</title>
  <style>
    body { background: #0a0a0a; color: #0f0; font-family: monospace; padding: 20px; max-width: 800px; margin: 0 auto; }
    h1 { color: #0ff; }
    .box { background: #001a00; border: 1px solid #0f0; padding: 15px; margin: 10px 0; border-radius: 5px; }
    input, button { font-family: monospace; padding: 8px; margin: 5px 0; }
    input { background: #001a00; color: #0f0; border: 1px solid #0f0; width: 100%; box-sizing: border-box; }
    button { background: #0a5c0a; color: #ff0; border: 2px solid #0f0; cursor: pointer; }
    button:hover { background: #0f0; color: #000; }
    .success { color: #4ade80; }
    .error { color: #f00; }
    #result { margin-top: 15px; padding: 10px; }
    code { background: #002200; padding: 2px 6px; border-radius: 3px; }
    .info { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🔐 ${esc(name)} Provably Fair Verification</h1>

  <div class="box">
    <h3>How it works:</h3>
    <ol>
      <li>Before game start, you received a <strong>commitment hash</strong> (SHA-256)</li>
      <li>After the game, you received the <strong>seed</strong></li>
      <li>This page verifies: <code>SHA256(seed) === commitment</code></li>
      <li>The seed deterministically generated your dungeon layout</li>
    </ol>
  </div>

  <div class="box">
    <h3>Verify Game</h3>
    <label>Game Seed (revealed after game):</label>
    <input type="text" id="seed" placeholder="64 character hex string">

    <label>Commitment Hash (shown before game):</label>
    <input type="text" id="commitment" placeholder="64 character hex string">

    <button onclick="verify()">🔍 Verify</button>

    <div id="result"></div>
  </div>
  ${recordBlock}
  <div class="box info">
    <p>For technical verification, you can also use the API:</p>
    <code>GET /api/verify?seed=YOUR_SEED&commitment=YOUR_COMMITMENT</code>
  </div>

  <script>
    async function verify() {
      const seed = document.getElementById('seed').value.trim();
      const commitment = document.getElementById('commitment').value.trim();
      const result = document.getElementById('result');

      if (!seed || !commitment) {
        result.innerHTML = '<p class="error">Please enter both seed and commitment.</p>';
        return;
      }

      try {
        const response = await fetch('/api/verify?seed=' + encodeURIComponent(seed) + '&commitment=' + encodeURIComponent(commitment));
        const data = await response.json();

        if (data.valid) {
          result.innerHTML = '<p class="success">✅ ' + data.message + '</p>' +
            '<p>Computed hash: <code>' + data.computedHash + '</code></p>';
        } else {
          result.innerHTML = '<p class="error">❌ ' + data.message + '</p>' +
            '<p>Expected: <code>' + data.expectedCommitment + '</code></p>' +
            '<p>Got: <code>' + data.computedHash + '</code></p>';
        }
      } catch (err) {
        result.innerHTML = '<p class="error">Error: ' + err.message + '</p>';
      }
    }
  </script>
</body>
</html>
  `;
}

module.exports = { renderVerifyPage };
