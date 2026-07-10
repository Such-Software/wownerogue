/**
 * Load nostr-tools in a way that works in BOTH runtimes (see the same shim in utils/nip98.js):
 *   - Production (plain Node >=22): a normal require() succeeds — Node natively require()s
 *     nostr-tools' ESM-only transitive deps (@noble/*).
 *   - A CJS-only test runtime (Jest without --experimental-vm-modules) cannot parse those ESM
 *     deps, so we fall back to nostr-tools' pre-bundled self-contained IIFE build.
 * Same public API either way. Shared so chat + auth load nostr identically.
 */
function loadNostrTools() {
    try {
        return require('nostr-tools');
    } catch (_e) {
        const fs = require('fs');
        const path = require('path');
        const cjsIndex = require.resolve('nostr-tools');
        const bundlePath = path.join(path.dirname(cjsIndex), '..', 'nostr.bundle.js');
        const src = fs.readFileSync(bundlePath, 'utf8');
        // eslint-disable-next-line no-new-func
        return new Function(`${src}\nreturn NostrTools;`)();
    }
}

module.exports = { loadNostrTools };
