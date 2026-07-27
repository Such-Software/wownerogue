const crypto = require('crypto');
const DungeonGenerator = require('../src/game/dungeon');
const Game = require('../src/game/game');
const { attachDungeonVerification } = require('../src/game/fairnessVerifier');

const LEGACY_OVERLAP_SEED = '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9';
const LEGACY_OVERLAP_FINGERPRINT = '9fd69a09c5f7a233b03538142994dd932afb4f2d6cfa19baab7041d5303edb50';

function objectiveKeys(dungeon) {
    return [dungeon.entrance, dungeon.exit, dungeon.treasure].map(point => point.join(','));
}

describe('versioned playable dungeon objectives', () => {
    const saved = {};

    beforeAll(() => {
        for (const key of ['DIFFICULTY_PRESET', 'DUNGEON_LEVELS', 'GAME_MODE', 'PAYMENTS_ENABLED']) {
            saved[key] = process.env[key];
        }
        process.env.DIFFICULTY_PRESET = 'easy';
        process.env.DUNGEON_LEVELS = '1';
        process.env.GAME_MODE = 'FREE';
        process.env.PAYMENTS_ENABLED = 'false';
    });

    afterAll(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('v2 deterministically retries a known v1 entrance/exit overlap', () => {
        const v1 = DungeonGenerator.regenerateFromSeed(LEGACY_OVERLAP_SEED, 'XMR', {
            width: 30,
            height: 15,
            generatorVersion: 'dungeon-generator-v1'
        });
        const v2 = DungeonGenerator.regenerateFromSeed(LEGACY_OVERLAP_SEED, 'XMR', {
            width: 30,
            height: 15,
            generatorVersion: 'dungeon-generator-v2'
        });

        expect(v1.entrance).toEqual(v1.exit);
        expect([v1.entrance, v1.exit, v1.treasure]).toEqual([[17, 8], [17, 8], [16, 8]]);
        expect(DungeonGenerator.layoutFingerprint(v1)).toBe(LEGACY_OVERLAP_FINGERPRINT);
        expect(new Set(objectiveKeys(v1)).size).toBeLessThan(3);
        expect(new Set(objectiveKeys(v2)).size).toBe(3);
        expect(DungeonGenerator.hasDistinctReachableObjectives(v2, {
            primaryFloor: "'1",
            secondaryFloor: "'2"
        })).toBe(true);
        const repeated = DungeonGenerator.regenerateFromSeed(LEGACY_OVERLAP_SEED, 'XMR', {
            width: 30,
            height: 15,
            generatorVersion: 'dungeon-generator-v2'
        });
        expect(DungeonGenerator.layoutFingerprint(repeated)).toBe(DungeonGenerator.layoutFingerprint(v2));
    });

    test('easy-profile v2 samples always have distinct reachable objectives', () => {
        for (let i = 0; i < 100; i += 1) {
            const seed = crypto.createHash('sha256').update(`objective-sample-${i}`).digest('hex');
            const dungeon = DungeonGenerator.regenerateFromSeed(seed, 'XMR', {
                width: 30,
                height: 15,
                generatorVersion: DungeonGenerator.GENERATOR_VERSION
            });
            expect(new Set(objectiveKeys(dungeon)).size).toBe(3);
            expect(DungeonGenerator.hasDistinctReachableObjectives(dungeon, {
                primaryFloor: "'1",
                secondaryFloor: "'2"
            })).toBe(true);
        }
    });

    test('historical v1 fingerprints remain verifiable after v2 becomes current', () => {
        const legacy = DungeonGenerator.regenerateFromSeed(LEGACY_OVERLAP_SEED, 'XMR', {
            width: 30,
            height: 15,
            generatorVersion: 'dungeon-generator-v1'
        });
        expect(DungeonGenerator.layoutFingerprint(legacy)).toBe(LEGACY_OVERLAP_FINGERPRINT);
        const result = attachDungeonVerification({ valid: true }, {
            effectiveSeed: LEGACY_OVERLAP_SEED,
            proofContext: {
                cryptoType: 'XMR',
                maxDepth: 1,
                generatorVersion: 'dungeon-generator-v1',
                generationOptions: { width: 30, height: 15 }
            },
            expectedFingerprint: LEGACY_OVERLAP_FINGERPRINT,
            generatorVersion: 'dungeon-generator-v1'
        });

        expect(result.valid).toBe(true);
        expect(result.generatorVersion).toBe('dungeon-generator-v1');
        expect(result.layoutMatches).toBe(true);
    });

    test('public game options cannot select a historical generator', () => {
        const game = Game.createStandardGame('public-socket', { id: 'public-socket' }, {
            cryptoType: 'XMR',
            width: 30,
            height: 15,
            generatorVersion: 'dungeon-generator-v1'
        });

        expect(game.generatorVersion).toBe(DungeonGenerator.GENERATOR_VERSION);
        expect(game.gameConfig).not.toHaveProperty('generatorVersion');
        expect(game.gameProof.generatorVersion).toBe(DungeonGenerator.GENERATOR_VERSION);
        expect(game.gameProof.context.generatorVersion).toBe(DungeonGenerator.GENERATOR_VERSION);
    });
});
