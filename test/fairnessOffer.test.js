const FairnessOfferManager = require('../src/game/fairnessOfferManager');
const Game = require('../src/game/game');
const DungeonGenerator = require('../src/game/dungeon');
const { attachDungeonVerification } = require('../src/game/fairnessVerifier');
const {
    hashSeed,
    deriveSeed,
    createGameProof,
    getPreGameCommitment,
    getPostGameReveal,
    verifyGameProof
} = require('../src/game/provablyFair');

const SERVER_SEED = 'a'.repeat(64);
const CLIENT_SEED = '12'.repeat(32);

describe('two-phase solo fairness offers', () => {
    test('publishes a commitment before client seed and consumes it exactly once', () => {
        let now = 1000;
        const offers = new FairnessOfferManager({
            now: () => now,
            seedFactory: () => SERVER_SEED,
            idFactory: () => 'offer-1',
            ttlMs: 60000
        });

        const published = offers.ensureOffer('socket-a');
        expect(published).toEqual(expect.objectContaining({
            offerId: 'offer-1',
            commitment: hashSeed(SERVER_SEED),
            issuedAt: 1000,
            proofVersion: 2
        }));

        now = 2000; // client contribution arrives strictly after publication
        const consumed = offers.consume('socket-a', {
            offerId: published.offerId,
            clientSeed: CLIENT_SEED.toUpperCase()
        });
        expect(consumed.success).toBe(true);
        expect(consumed.proofInput.offerIssuedAt).toBeLessThan(now);
        expect(consumed.proofInput.clientSeed).toBe(CLIENT_SEED);
        expect(consumed.proofInput.commitment).toBe(published.commitment);

        expect(offers.consume('socket-a', {
            offerId: published.offerId,
            clientSeed: CLIENT_SEED
        })).toEqual(expect.objectContaining({ success: false, code: 'OFFER_REPLAYED' }));
    });

    test('cannot steal, swap, or attach a client seed without echoing the published offer', () => {
        const offers = new FairnessOfferManager({
            seedFactory: () => SERVER_SEED,
            idFactory: () => 'offer-owner'
        });
        const published = offers.ensureOffer('owner');

        expect(offers.consume('attacker', {
            offerId: published.offerId,
            clientSeed: CLIENT_SEED
        }).code).toBe('OFFER_OWNER_MISMATCH');
        expect(offers.consume('owner', { clientSeed: CLIENT_SEED }).code).toBe('OFFER_REQUIRED');

        const consumed = offers.consume('owner', {
            offerId: published.offerId,
            clientSeed: CLIENT_SEED
        });
        expect(consumed.success).toBe(true);

        expect(() => createGameProof('game', CLIENT_SEED, {
            ...consumed.proofInput,
            commitment: 'b'.repeat(64)
        })).toThrow(/commitment does not match/i);
    });

    test('legacy clients may consume the already-published current offer with an empty seed', () => {
        const offers = new FairnessOfferManager({
            seedFactory: () => SERVER_SEED,
            idFactory: () => 'legacy-offer'
        });
        offers.ensureOffer('legacy');
        const consumed = offers.consume('legacy');
        expect(consumed.success).toBe(true);
        expect(consumed.proofInput.clientSeed).toBe('');
    });
});

describe('v2 proof binds the accepted client seed to the played dungeon', () => {
    function precommit(clientSeed, offerId) {
        return {
            proofVersion: 2,
            offerId,
            offerIssuedAt: 123,
            serverSeed: SERVER_SEED,
            commitment: hashSeed(SERVER_SEED),
            clientSeed
        };
    }

    test('Game derives its RNG before layout generation and persists reproducible context', () => {
        const game = new Game('socket', { id: 1 }, { fairnessProof: precommit(CLIENT_SEED, 'offer-a') });
        expect(game.gameProof.seed).toBe(deriveSeed(SERVER_SEED, CLIENT_SEED));
        expect(game.gameProof.clientSeed).toBe(CLIENT_SEED);
        expect(game.gameProof.offerId).toBe('offer-a');

        const context = game.gameProof.context;
        const regenerated = DungeonGenerator.regenerateFromSeed(
            game.gameProof.seed,
            context.cryptoType,
            context.generationOptions
        );
        if (context.maxDepth > 1) regenerated.treasure = null;
        expect(DungeonGenerator.layoutFingerprint(regenerated)).toBe(game.gameProof.layoutFingerprint);
    });

    test('changing the client seed changes both effective seed and dungeon', () => {
        const one = new Game('one', { id: 1 }, { fairnessProof: precommit('01', 'offer-1') });
        const two = new Game('two', { id: 2 }, { fairnessProof: precommit('02', 'offer-2') });
        expect(one.gameProof.seed).not.toBe(two.gameProof.seed);
        expect(one.gameProof.layoutFingerprint).not.toBe(two.gameProof.layoutFingerprint);
    });

    test('pre-game data hides server seed, reveal links by game id, and tampering fails', () => {
        const proof = createGameProof('game-uuid', CLIENT_SEED, precommit(CLIENT_SEED, 'offer-z'));
        proof.layoutFingerprint = 'f'.repeat(64);
        const before = getPreGameCommitment(proof);
        expect(before.clientSeed).toBe(CLIENT_SEED);
        expect(before.offerId).toBe('offer-z');
        expect(before.serverSeed).toBeUndefined();
        expect(before.seed).toBeUndefined();

        const reveal = getPostGameReveal(proof);
        expect(reveal.verificationUrl).toBe('/verify/game-uuid');
        expect(verifyGameProof(reveal).valid).toBe(true);
        expect(verifyGameProof({ ...reveal, clientSeed: '03' }).valid).toBe(false);
        expect(verifyGameProof({ ...reveal, effectiveSeed: 'b'.repeat(64), seed: 'b'.repeat(64) }).valid).toBe(false);
        expect(verifyGameProof({ ...reveal, serverSeed: 'b'.repeat(64) }).valid).toBe(false);
    });

    test('post-game reveal preserves the terminal result after endGame changes runtime state', () => {
        const game = new Game('result-socket', { id: 3, endGame() {} }, {
            fairnessProof: precommit(CLIENT_SEED, 'result-offer')
        });
        game.endGame('won', { score: 10 });
        expect(game.gameState).toBe('ended');
        expect(game.getProofReveal().gameResult.won).toBe(true);
    });
});

describe('all-depth versioned verification', () => {
    let savedLevels;
    let savedCrypto;

    beforeEach(() => {
        savedLevels = process.env.DUNGEON_LEVELS;
        savedCrypto = process.env.CRYPTO_TYPE;
        process.env.DUNGEON_LEVELS = '3';
        process.env.CRYPTO_TYPE = 'WOW';
    });

    afterEach(() => {
        if (savedLevels === undefined) delete process.env.DUNGEON_LEVELS;
        else process.env.DUNGEON_LEVELS = savedLevels;
        if (savedCrypto === undefined) delete process.env.CRYPTO_TYPE;
        else process.env.CRYPTO_TYPE = savedCrypto;
    });

    test('persists and deterministically verifies every advertised depth', () => {
        const fairnessProof = {
            proofVersion: 2,
            offerId: 'all-depth-offer',
            offerIssuedAt: 123,
            serverSeed: SERVER_SEED,
            commitment: hashSeed(SERVER_SEED),
            clientSeed: CLIENT_SEED
        };
        const game = new Game('depth-socket', { id: 7 }, { fairnessProof });
        const reveal = game.getProofReveal();

        expect(game.gameProof.generatorVersion).toBe(DungeonGenerator.GENERATOR_VERSION);
        expect(game.gameProof.layoutFingerprints).toHaveLength(3);
        expect(game.gameProof.layoutFingerprints.map(item => item.depth)).toEqual([1, 2, 3]);

        const result = attachDungeonVerification(verifyGameProof(reveal), {
            effectiveSeed: reveal.effectiveSeed,
            proofContext: reveal.context,
            expectedFingerprint: reveal.layoutFingerprint,
            expectedFingerprints: reveal.layoutFingerprints,
            generatorVersion: reveal.generatorVersion
        });

        expect(result.valid).toBe(true);
        expect(result.verificationScope).toBe('all_depths');
        expect(result.verifiedDepths).toEqual([1, 2, 3]);
        expect(result.levels.every(level => level.matches)).toBe(true);
    });

    test('fails if any depth is tampered with or omitted', () => {
        const game = new Game('tamper-socket', { id: 8 }, {
            fairnessProof: {
                proofVersion: 2,
                offerId: 'tamper-offer',
                offerIssuedAt: 123,
                serverSeed: SERVER_SEED,
                commitment: hashSeed(SERVER_SEED),
                clientSeed: CLIENT_SEED
            }
        });
        const reveal = game.getProofReveal();
        const tampered = reveal.layoutFingerprints.map(item => ({ ...item }));
        tampered[1].fingerprint = '0'.repeat(64);
        const mismatch = attachDungeonVerification(verifyGameProof(reveal), {
            effectiveSeed: reveal.effectiveSeed,
            proofContext: reveal.context,
            expectedFingerprints: tampered,
            generatorVersion: reveal.generatorVersion
        });
        expect(mismatch.valid).toBe(false);
        expect(mismatch.levels[1].matches).toBe(false);

        const incomplete = attachDungeonVerification(verifyGameProof(reveal), {
            effectiveSeed: reveal.effectiveSeed,
            proofContext: reveal.context,
            expectedFingerprints: reveal.layoutFingerprints.slice(0, 2),
            generatorVersion: reveal.generatorVersion
        });
        expect(incomplete.valid).toBe(false);
        expect(incomplete.regenerationError).toBe('incomplete_layout_manifest');
    });
});

describe('browser contribution helper', () => {
    test('generates a fresh 256-bit client seed after selecting the offer', () => {
        const oldWindow = global.window;
        const oldSocket = global.socket;
        global.window = {
            crypto: { getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = i; return bytes; } }
        };
        global.socket = { emit: jest.fn() };
        jest.resetModules();
        const BrowserHandlers = require('../html/js/network/socketHandlers.js');
        BrowserHandlers._fairnessOffer = { offerId: 'browser-offer', commitment: hashSeed(SERVER_SEED) };
        const payload = BrowserHandlers.fairnessAttempt({ free: true });
        expect(payload.free).toBe(true);
        expect(payload.fairnessOfferId).toBe('browser-offer');
        expect(payload.clientSeed).toMatch(/^[0-9a-f]{64}$/);
        expect(BrowserHandlers._pendingFairnessAttempt.commitment).toBe(hashSeed(SERVER_SEED));
        global.window = oldWindow;
        global.socket = oldSocket;
    });
});
