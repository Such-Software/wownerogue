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

function renderVerifyPage(gameId, gameRecord, opts = {}) {
    // Back-compat: opts may be a plain gameName string (older callers).
    if (typeof opts === 'string') opts = { gameName: opts };
    const name = opts.gameName || 'Wownerogue';
    const baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
    const ogImage = opts.ogImage ? `${baseUrl}/${opts.ogImage.replace(/^\//, '')}` : '';
    const pageUrl = `${baseUrl}/verify/${esc(gameId)}`;
    const gameIdJson = JSON.stringify(String(gameId)).replace(/</g, '\\u003c');

    // Social card description reflects the actual result when we have a record.
    let ogDescription = `Committed-layout roguelike — verify the published seed generated the recorded dungeon depths.`;
    if (gameRecord) {
        const escaped = gameRecord.status === 'won';
        const bag = gameRecord.treasure_found ? ' with the treasure bag' : '';
        ogDescription = escaped
            ? `Escaped the dungeon${bag} in ${gameRecord.moves_made || '?'} moves. Verify the committed dungeon layout.`
            : `A run that didn't make it out. Verify the committed seed generated its recorded dungeon layout.`;
    }
    const ogTitle = `${name} — Dungeon Layout Verification`;
    const metaTags = `
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(ogDescription)}">
  ${pageUrl ? `<meta property="og:url" content="${esc(pageUrl)}">` : ''}
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
  <meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(ogDescription)}">
  ${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : ''}`;

    const hasV2Proof = !!(gameRecord && gameRecord.server_seed && gameRecord.proof_commitment && gameRecord.effective_seed);
    let recordedManifest = gameRecord?.layout_fingerprints || null;
    if (typeof recordedManifest === 'string') {
        try { recordedManifest = JSON.parse(recordedManifest); } catch (_) { recordedManifest = null; }
    }
    const recordedDepths = Array.isArray(recordedManifest) ? recordedManifest.length : 0;
    const recordBlock = gameRecord ? `
  <div class="box">
    <h3>Game Record</h3>
    <p><strong>Game ID:</strong> ${esc(gameId)}</p>
    <p><strong>Status:</strong> ${esc(gameRecord.status)}</p>
    <p><strong>Treasure Found:</strong> ${gameRecord.treasure_found ? 'Yes' : 'No'}</p>
    <p><strong>Moves:</strong> ${esc(gameRecord.moves_made || 'N/A')}</p>
    <p><strong>Duration:</strong> ${gameRecord.duration_seconds ? esc(gameRecord.duration_seconds) + 's' : 'N/A'}</p>
    <p><strong>Created:</strong> ${esc(gameRecord.created_at)}</p>
    ${hasV2Proof ? `
    <p><strong>Proof version:</strong> ${esc(gameRecord.proof_version || 2)}</p>
    <p><strong>Published commitment:</strong> <code>${esc(String(gameRecord.proof_commitment).trim())}</code></p>
    <p><strong>Client seed:</strong> <code>${esc(gameRecord.client_seed || '(empty)')}</code></p>
    <p><strong>Revealed server seed:</strong> <code>${esc(String(gameRecord.server_seed).trim())}</code></p>
    <p><strong>Derived effective seed:</strong> <code>${esc(String(gameRecord.effective_seed).trim())}</code></p>
    <p><strong>Generator version:</strong> <code>${esc(gameRecord.generator_version || gameRecord.proof_context?.generatorVersion || 'legacy')}</code></p>
    <p><strong>Verification scope:</strong> ${recordedDepths ? `All ${recordedDepths} dungeon depth(s)` : 'Legacy level 1 only'}</p>
    <p><strong>Played layout fingerprint:</strong> <code>${esc(String(gameRecord.layout_fingerprint || '').trim())}</code></p>
    <button onclick="verifyRecorded()">🔍 Verify recorded proof + dungeon</button>
    ` : '<p class="info">This legacy/in-progress game has no revealed v2 proof.</p>'}
  </div>
  ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(name)} - Game Verification</title>${metaTags}
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
  <h1>🔐 ${esc(name)} Committed Dungeon Verification</h1>

  <div class="box">
    <h3>How it works:</h3>
    <ol>
      <li>The server publishes <code>SHA256(serverSeed)</code> before your browser chooses a client seed.</li>
      <li>Your one-time offer and client seed are bound to the game before dungeon generation.</li>
      <li>After the game, the server seed is revealed and this page re-derives the effective seed with HMAC-SHA256.</li>
      <li>The effective seed regenerates every advertised depth and each must match its versioned recorded fingerprint.</li>
    </ol>
    <p class="info">Scope: this verifies seed commitment and recorded dungeon layouts. It does not replay player input, block timing, monster turns, the reported outcome, or payout delivery.</p>
  </div>

  <div class="box">
    <h3>Manual v2 verification</h3>
    <label>Server seed (revealed after game):</label>
    <input type="text" id="serverSeed" placeholder="64 character hex string" value="${hasV2Proof ? esc(String(gameRecord.server_seed).trim()) : ''}">

    <label>Client seed (accepted before game; empty for legacy clients):</label>
    <input type="text" id="clientSeed" placeholder="up to 64 hexadecimal characters" value="${hasV2Proof ? esc(gameRecord.client_seed || '') : ''}">

    <label>Effective dungeon seed:</label>
    <input type="text" id="effectiveSeed" placeholder="64 character hex string" value="${hasV2Proof ? esc(String(gameRecord.effective_seed).trim()) : ''}">

    <label>Commitment Hash (shown before game):</label>
    <input type="text" id="commitment" placeholder="64 character hex string" value="${hasV2Proof ? esc(String(gameRecord.proof_commitment).trim()) : ''}">

    <button onclick="verifyManual()">🔍 Verify seed relationship</button>

    <div id="result"></div>
  </div>
  ${recordBlock}
  <div class="box info">
    <p>For technical verification, you can also use the API:</p>
    <code>GET /api/verify/${esc(gameId)}</code>
  </div>

  <script>
    const gameId = ${gameIdJson};

    function clearResult() {
      const result = document.getElementById('result');
      result.textContent = '';
      return result;
    }

    function appendLine(parent, text, className) {
      const line = document.createElement('p');
      if (className) line.className = className;
      line.textContent = String(text == null ? '' : text);
      parent.appendChild(line);
    }

    function appendCodeLine(parent, label, value, suffix) {
      const line = document.createElement('p');
      line.appendChild(document.createTextNode(label));
      const code = document.createElement('code');
      code.textContent = String(value == null ? '' : value);
      line.appendChild(code);
      if (suffix) line.appendChild(document.createTextNode(suffix));
      parent.appendChild(line);
    }

    function showFailure(message) {
      const result = clearResult();
      appendLine(result, message || 'Verification failed', 'error');
    }

    function show(data) {
      const result = clearResult();
      if (data.valid) {
        appendLine(result, data.message, 'success');
        appendCodeLine(result, 'Commitment: ', data.computedCommitment);
        appendCodeLine(result, 'Effective seed: ', data.computedEffectiveSeed);
        if (Array.isArray(data.levels)) {
          const depthSummary = data.levels.map(function(level) {
            const state = level.matches === true ? 'match' : (level.matches === false ? 'mismatch' : 'unscoped');
            return String(level.depth) + ':' + state;
          }).join(', ');
          appendCodeLine(result, 'Verified depths: ', depthSummary);
        }
        if (data.layoutFingerprint) {
          appendCodeLine(result, 'Layout fingerprint: ', data.layoutFingerprint,
            data.layoutMatches === true ? ' ✅' : '');
        }
      } else {
        showFailure(data.message || data.error || 'Verification failed');
      }
    }

    async function verifyRecorded() {
      try {
        const response = await fetch('/api/verify/' + encodeURIComponent(gameId));
        show(await response.json());
      } catch (err) {
        showFailure('Error: ' + err.message);
      }
    }

    async function verifyManual() {
      const serverSeed = document.getElementById('serverSeed').value.trim();
      const clientSeed = document.getElementById('clientSeed').value.trim();
      const effectiveSeed = document.getElementById('effectiveSeed').value.trim();
      const commitment = document.getElementById('commitment').value.trim();

      if (!serverSeed || !effectiveSeed || !commitment) {
        showFailure('Please enter server seed, effective seed, and commitment.');
        return;
      }

      try {
        const query = '?serverSeed=' + encodeURIComponent(serverSeed) +
          '&clientSeed=' + encodeURIComponent(clientSeed) +
          '&effectiveSeed=' + encodeURIComponent(effectiveSeed) +
          '&commitment=' + encodeURIComponent(commitment);
        const response = await fetch('/api/verify' + query);
        show(await response.json());
      } catch (err) {
        showFailure('Error: ' + err.message);
      }
    }
  </script>
</body>
</html>
  `;
}

module.exports = { renderVerifyPage };
