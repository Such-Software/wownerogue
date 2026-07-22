const DungeonGenerator = require('./dungeon');
const { levelSeed } = require('./provablyFair');

function parseJson(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
}

/**
 * Regenerate and compare the versioned layout manifest attached to an already-verified
 * seed relationship. Legacy rows with only `layout_fingerprint` remain level-one verifiable;
 * new rows must contain one contiguous entry for every advertised depth.
 */
function attachDungeonVerification(result, {
    effectiveSeed,
    proofContext = null,
    expectedFingerprint = null,
    expectedFingerprints = null,
    generatorVersion = null
} = {}) {
    if (!result.valid || !effectiveSeed) return result;
    try {
        const context = parseJson(proofContext) || {};
        const options = context.generationOptions && typeof context.generationOptions === 'object'
            ? context.generationOptions
            : {};
        const recordedGenerator = generatorVersion || context.generatorVersion || DungeonGenerator.GENERATOR_VERSION;
        if (recordedGenerator !== DungeonGenerator.GENERATOR_VERSION) {
            throw Object.assign(new Error('unsupported_generator_version'), { code: 'UNSUPPORTED_GENERATOR' });
        }

        const parsedManifest = parseJson(expectedFingerprints);
        const hasManifest = Array.isArray(parsedManifest) && parsedManifest.length > 0;
        const maxDepth = Math.max(1, parseInt(context.maxDepth, 10) || 1);
        let manifest;
        if (hasManifest) {
            manifest = parsedManifest.slice().sort((a, b) => Number(a.depth) - Number(b.depth));
            const depths = manifest.map(item => Number(item.depth));
            const expectedDepths = Array.from({ length: maxDepth }, (_, i) => i + 1);
            if (manifest.length !== maxDepth || depths.some((depth, i) => depth !== expectedDepths[i])) {
                throw Object.assign(new Error('incomplete_layout_manifest'), { code: 'INCOMPLETE_MANIFEST' });
            }
        } else {
            manifest = [{
                depth: 1,
                fingerprintVersion: 1,
                generatorVersion: recordedGenerator,
                fingerprint: expectedFingerprint ? String(expectedFingerprint).trim() : null
            }];
        }

        const levels = manifest.map((entry) => {
            const depth = Number(entry.depth);
            const entryGenerator = entry.generatorVersion || recordedGenerator;
            if (entryGenerator !== DungeonGenerator.GENERATOR_VERSION) {
                throw Object.assign(new Error('unsupported_generator_version'), { code: 'UNSUPPORTED_GENERATOR' });
            }
            const fingerprintVersion = Number(entry.fingerprintVersion || context.fingerprintVersion || 1);
            const dungeon = DungeonGenerator.regenerateFromSeed(
                levelSeed(effectiveSeed, depth),
                context.cryptoType || process.env.CRYPTO_TYPE || 'WOW',
                options
            );
            if (depth < maxDepth) dungeon.treasure = null;
            const fingerprint = DungeonGenerator.layoutFingerprint(dungeon, fingerprintVersion);
            const expected = entry.fingerprint ? String(entry.fingerprint).trim() : null;
            return {
                depth,
                fingerprintVersion,
                generatorVersion: entryGenerator,
                fingerprint,
                expectedFingerprint: expected,
                matches: expected ? fingerprint === expected : null,
                dungeonSize: { width: dungeon.map[0].length, height: dungeon.map.length },
                entrance: dungeon.entrance,
                exit: dungeon.exit,
                treasure: dungeon.treasure
            };
        });

        const compared = levels.filter(level => level.expectedFingerprint);
        const allMatch = compared.length > 0 ? compared.every(level => level.matches) : null;
        result.generatorVersion = recordedGenerator;
        result.layoutManifestVersion = hasManifest ? 1 : 0;
        result.verificationScope = hasManifest ? 'all_depths' : 'legacy_level_1_only';
        result.levels = levels;
        result.verifiedDepths = levels.map(level => level.depth);
        result.layoutFingerprint = levels[0]?.fingerprint || null;
        result.expectedLayoutFingerprint = levels[0]?.expectedFingerprint || null;
        result.layoutMatches = allMatch;
        result.dungeonSize = levels[0]?.dungeonSize || null;
        result.entrance = levels[0]?.entrance || null;
        result.exit = levels[0]?.exit || null;
        result.treasure = levels[0]?.treasure ?? null;
        if (allMatch === false) {
            result.valid = false;
            result.message = '❌ Seed derivation verified, but one or more regenerated depth fingerprints do not match the played run.';
        } else if (hasManifest && allMatch === true) {
            result.message = `✅ Game proof and all ${levels.length} dungeon depth fingerprints verified.`;
        }
    } catch (error) {
        result.valid = false;
        if (error?.code === 'UNSUPPORTED_GENERATOR') {
            result.message = '❌ This proof uses an unsupported dungeon generator version.';
            result.regenerationError = 'unsupported_generator_version';
        } else if (error?.code === 'INCOMPLETE_MANIFEST') {
            result.message = '❌ The persisted all-depth layout manifest is incomplete.';
            result.regenerationError = 'incomplete_layout_manifest';
        } else {
            result.message = '❌ Proof fields verified, but the persisted dungeon context could not be regenerated.';
            result.regenerationError = 'regeneration_failed';
        }
    }
    return result;
}

module.exports = { attachDungeonVerification };
