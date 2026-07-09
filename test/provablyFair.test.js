/**
 * Provably-fair determinism tests (Phase 0.2).
 *
 * The committed seed must deterministically generate the dungeon and drive monster
 * behaviour, so that:
 *  - the same seed always reproduces the exact same dungeon (verifiability), and
 *  - the server cannot craft a different/unfair dungeon after seeing the seed.
 */

const DungeonGenerator = require('../src/game/dungeon');
const Monster = require('../src/game/monster');
const { createSeededRNG, hashSeed, verifyGame, deriveSeed } = require('../src/game/provablyFair');

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

describe('Provably fair: deterministic dungeon generation', () => {
  test('same seed regenerates an identical dungeon layout', () => {
    const d1 = DungeonGenerator.regenerateFromSeed(SEED_A, 'WOW');
    const d2 = DungeonGenerator.regenerateFromSeed(SEED_A, 'WOW');

    expect(DungeonGenerator.layoutFingerprint(d1))
      .toBe(DungeonGenerator.layoutFingerprint(d2));
    expect(d1.entrance).toEqual(d2.entrance);
    expect(d1.exit).toEqual(d2.exit);
    expect(d1.treasure).toEqual(d2.treasure);
    expect(d1.map).toEqual(d2.map);
  });

  test('regeneration is stable even when interleaved with another seed (no global RNG bleed)', () => {
    const a1 = DungeonGenerator.layoutFingerprint(DungeonGenerator.regenerateFromSeed(SEED_A, 'WOW'));
    // Generate a different seed's dungeon in between — must not affect SEED_A's output.
    DungeonGenerator.regenerateFromSeed(SEED_B, 'WOW');
    const a2 = DungeonGenerator.layoutFingerprint(DungeonGenerator.regenerateFromSeed(SEED_A, 'WOW'));
    expect(a1).toBe(a2);
  });

  test('different seeds produce different layouts', () => {
    const fpA = DungeonGenerator.layoutFingerprint(DungeonGenerator.regenerateFromSeed(SEED_A, 'WOW'));
    const fpB = DungeonGenerator.layoutFingerprint(DungeonGenerator.regenerateFromSeed(SEED_B, 'WOW'));
    expect(fpA).not.toBe(fpB);
  });

  test('verifyGame confirms the seed/commitment relationship', () => {
    const commitment = hashSeed(SEED_A);
    expect(verifyGame(SEED_A, commitment).valid).toBe(true);
    expect(verifyGame(SEED_B, commitment).valid).toBe(false);
  });
});

describe('Provably fair: seed derivation (server + client seed)', () => {
  test('deriveSeed is HMAC-SHA256(key=serverSeed, msg=clientSeed) hex', () => {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', SEED_A).update('my-client-seed').digest('hex');
    expect(deriveSeed(SEED_A, 'my-client-seed')).toBe(expected);
    // 64-char hex output
    expect(deriveSeed(SEED_A, 'my-client-seed')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('clientSeed defaults to empty string (non-breaking) and is deterministic', () => {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', SEED_A).update('').digest('hex');
    expect(deriveSeed(SEED_A)).toBe(expected);
    expect(deriveSeed(SEED_A)).toBe(deriveSeed(SEED_A, ''));
  });

  test('different client seeds yield different derived seeds (client perturbs outcome)', () => {
    expect(deriveSeed(SEED_A, 'x')).not.toBe(deriveSeed(SEED_A, 'y'));
    // and a different server seed changes the result too
    expect(deriveSeed(SEED_A, 'x')).not.toBe(deriveSeed(SEED_B, 'x'));
  });

  test('a verifier can reproduce the dungeon from serverSeed + clientSeed', () => {
    const serverSeed = SEED_A;
    const clientSeed = 'player-chosen';
    // Commitment is over the serverSeed only (locked before clientSeed is known).
    const commitment = hashSeed(serverSeed);
    expect(verifyGame(serverSeed, commitment).valid).toBe(true);
    // The effective seed drives generation; the verifier re-derives it and regenerates.
    const effective = deriveSeed(serverSeed, clientSeed);
    const fp1 = DungeonGenerator.layoutFingerprint(DungeonGenerator.regenerateFromSeed(effective, 'WOW'));
    const fp2 = DungeonGenerator.layoutFingerprint(
      DungeonGenerator.regenerateFromSeed(deriveSeed(serverSeed, clientSeed), 'WOW')
    );
    expect(fp1).toBe(fp2);
  });
});

describe('Provably fair: seeded RNG is bounded to [0, 1)', () => {
  test('every value stays within [0, 1) across many draws and seeds', () => {
    for (let s = 0; s < 8; s++) {
      const rng = createSeededRNG((s.toString(16)).repeat(64).slice(0, 64));
      for (let i = 0; i < 500; i++) {
        const v = rng();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});

describe('Dungeon reachability (Phase 3.2)', () => {
  test('generated dungeons always have a reachable exit (many seeds)', () => {
    const cfg = { primaryFloor: "'1", secondaryFloor: "'2" };
    for (let i = 0; i < 25; i++) {
      const seed = (i.toString(16).padStart(2, '0')).repeat(32);
      const d = DungeonGenerator.regenerateFromSeed(seed, 'WOW');
      expect(DungeonGenerator.isReachable(d.map, d.entrance, d.exit, cfg)).toBe(true);
    }
  });

  test('isReachable returns false when the target is walled off', () => {
    const cfg = { primaryFloor: "'1", secondaryFloor: "'2" };
    // 3x3 all-floor map, but wall off the target corner.
    const map = [
      ["'1", "'1", "'1"],
      ["'1", "'1", '#'],
      ["'1", '#',  "'1"]  // (2,2) is isolated by walls at (2,1) and (1,2)
    ];
    expect(DungeonGenerator.isReachable(map, [0, 0], [2, 2], cfg)).toBe(false);
    expect(DungeonGenerator.isReachable(map, [0, 0], [1, 0], cfg)).toBe(true);
  });
});

describe('Provably fair: deterministic monster movement', () => {
  // A small open room so the monster always has somewhere to wander.
  function buildDungeon() {
    const map = Array.from({ length: 7 }, () => Array(7).fill("'1"));
    for (let i = 0; i < 7; i++) { map[0][i] = '#'; map[6][i] = '#'; map[i][0] = '#'; map[i][6] = '#'; }
    return { map };
  }

  test('wandering is reproducible from the same seeded RNG sequence', () => {
    const dungeon = buildDungeon();
    const run = () => {
      const rng = createSeededRNG(SEED_A);
      const m = new Monster(3, 3, { visionRange: 5 });
      const path = [];
      for (let i = 0; i < 20; i++) {
        m.moveTowardPlayer(null, dungeon, rng); // no player => wander using rng
        path.push([m.x, m.y]);
      }
      return path;
    };
    expect(run()).toEqual(run());
  });

  test('different seeds yield different wander paths', () => {
    const dungeon = buildDungeon();
    const walk = (seed) => {
      const rng = createSeededRNG(seed);
      const m = new Monster(3, 3, { visionRange: 5 });
      const path = [];
      for (let i = 0; i < 20; i++) {
        m.moveTowardPlayer(null, dungeon, rng);
        path.push([m.x, m.y]);
      }
      return JSON.stringify(path);
    };
    expect(walk(SEED_A)).not.toBe(walk(SEED_B));
  });
});
