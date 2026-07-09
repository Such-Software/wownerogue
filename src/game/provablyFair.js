/**
 * Provably Fair Gaming System
 * 
 * This module implements cryptographic verification for fair game generation.
 * 
 * How it works:
 * 1. Server generates a random seed before game starts
 * 2. Server computes SHA-256 hash of the seed
 * 3. Hash is shown to player BEFORE game starts (commitment)
 * 4. Seed is used to deterministically generate:
 *    - Dungeon layout
 *    - Player spawn position
 *    - Monster spawn position  
 *    - Treasure position
 *    - Exit position
 * 5. After game ends, seed is revealed
 * 6. Player can verify: hash(seed) === pre-game commitment
 * 7. Player can regenerate the dungeon using the seed to verify fairness
 * 
 * This prevents the server from:
 * - Generating impossible dungeons after seeing player's payment
 * - Changing dungeon mid-game
 * - Claiming different game outcomes
 */

const crypto = require('crypto');

/**
 * Generate a cryptographically secure random seed
 * @returns {string} 64-character hex string (256 bits)
 */
function generateSeed() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a commitment hash of a seed
 * @param {string} seed - The game seed
 * @returns {string} SHA-256 hash of the seed (64-character hex)
 */
function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * Verify that a seed matches its commitment hash
 * @param {string} seed - The revealed seed
 * @param {string} commitment - The hash that was shown before the game
 * @returns {boolean} True if the seed matches the commitment
 */
function verifySeed(seed, commitment) {
    return hashSeed(seed) === commitment;
}

/**
 * Derive the effective RNG seed from a server seed and an (optional) client seed.
 * Uses HMAC-SHA256 with the server seed as key and the client seed as message so
 * that neither party can unilaterally control the outcome:
 *   - the server commits to hash(serverSeed) BEFORE seeing the client seed, and
 *   - the client seed still perturbs the final layout.
 * The commitment stays hash(serverSeed); a verifier with (serverSeed, clientSeed)
 * can reproduce this derived seed and therefore the entire dungeon.
 * @param {string} serverSeed - The secret server seed (revealed after the game)
 * @param {string} [clientSeed=''] - Optional client-supplied seed
 * @returns {string} 64-character hex string used as the effective RNG seed
 */
function deriveSeed(serverSeed, clientSeed = '') {
    return crypto.createHmac('sha256', String(serverSeed))
        .update(String(clientSeed ?? ''))
        .digest('hex');
}

/**
 * Create a seeded random number generator
 * Uses the seed to create deterministic "random" numbers
 * This allows players to recreate the exact same dungeon
 * 
 * @param {string} seed - The game seed
 * @returns {function} A function that returns deterministic random numbers [0, 1)
 */
function createSeededRNG(seed) {
    // Use seed to create a deterministic PRNG
    // We'll use a simple but effective approach: hash-based PRNG
    let state = seed;
    let counter = 0;
    
    return function() {
        // Generate next state by hashing current state + counter
        const hash = crypto.createHash('sha256')
            .update(state + counter.toString())
            .digest();
        counter++;
        
        // Convert first 4 bytes to a number in [0, 1). Divide by 2^32 (not
        // 0xFFFFFFFF) so the maximum value stays strictly below 1.
        const num = hash.readUInt32BE(0);
        return num / 0x100000000;
    };
}

/**
 * Derive a positive integer from a hex seed, suitable for seeding ROT.RNG.
 * 13 hex chars = 52 bits, which stays within Number.MAX_SAFE_INTEGER so the
 * value is represented exactly. Always returns >= 1.
 * @param {string} seed - The game seed (hex)
 * @returns {number} A positive integer derived deterministically from the seed
 */
function seedToInt(seed) {
    const hex = String(seed).replace(/[^0-9a-fA-F]/g, '').slice(0, 13) || '1';
    const n = parseInt(hex, 16);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Generate a random integer in range [min, max] using seeded RNG
 * @param {function} rng - Seeded RNG function
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {number} Random integer
 */
function seededRandomInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Shuffle an array deterministically using seeded RNG
 * @param {function} rng - Seeded RNG function
 * @param {Array} array - Array to shuffle
 * @returns {Array} New shuffled array
 */
function seededShuffle(rng, array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * Create a game proof object for a new game
 * @param {string} gameId - Unique game identifier
 * @param {string} [clientSeed=''] - Optional client-supplied seed (non-breaking)
 * @returns {object} Proof object with seeds, commitment, and creation time
 */
function createGameProof(gameId, clientSeed = '') {
    const serverSeed = generateSeed();
    const commitment = hashSeed(serverSeed);        // commits to serverSeed only
    // Effective RNG seed folds in the client seed so neither party controls it.
    const seed = deriveSeed(serverSeed, clientSeed);
    const timestamp = Date.now();

    return {
        gameId,
        serverSeed,     // Keep secret until game ends
        clientSeed,     // Client contribution (may be '')
        seed,           // Derived effective seed used to generate the dungeon
        commitment,     // Show to player before game starts
        timestamp,
        verified: false
    };
}

/**
 * Generate the verification data to send to player BEFORE game starts
 * This is the "commitment" phase - player sees hash but not seed
 * @param {object} proof - Game proof object
 * @returns {object} Safe data to send to client
 */
function getPreGameCommitment(proof) {
    return {
        gameId: proof.gameId,
        commitment: proof.commitment,
        timestamp: proof.timestamp,
        message: "This hash commits to your game's layout. After the game, you'll receive the seed to verify fairness."
    };
}

/**
 * Generate the verification data to send to player AFTER game ends
 * This is the "reveal" phase - player gets seed to verify
 * @param {object} proof - Game proof object
 * @param {object} gameResult - Game outcome data
 * @returns {object} Full verification data for client
 */
function getPostGameReveal(proof, gameResult = {}) {
    const serverSeed = proof.serverSeed ?? proof.seed;
    const clientSeed = proof.clientSeed ?? '';
    // Effective seed a verifier regenerates the dungeon from.
    const effectiveSeed = proof.seed ?? deriveSeed(serverSeed, clientSeed);
    return {
        gameId: proof.gameId,
        serverSeed,
        clientSeed,
        seed: effectiveSeed,
        commitment: proof.commitment,
        timestamp: proof.timestamp,
        gameResult: {
            won: gameResult.won ?? false,
            treasureFound: gameResult.treasureFound ?? false,
            moves: gameResult.moves ?? 0,
            duration: gameResult.duration ?? 0
        },
        verificationUrl: `/verify/${effectiveSeed}`,
        instructions: [
            "To verify this game was fair:",
            `1. Compute SHA-256 of the serverSeed and confirm it equals the commitment: ${proof.commitment}`,
            "2. Compute HMAC-SHA256(key=serverSeed, msg=clientSeed) to derive the effective seed",
            "3. The effective seed deterministically generates the dungeon layout, treasure, and monster behaviour",
            `4. Open ${`/verify/${effectiveSeed}`} to regenerate the dungeon from the effective seed and compare its layout fingerprint`
        ]
    };
}

/**
 * Verification result for a game
 * @param {string} seed - The revealed seed
 * @param {string} expectedCommitment - The pre-game commitment hash
 * @returns {object} Verification result
 */
function verifyGame(seed, expectedCommitment) {
    const computedHash = hashSeed(seed);
    const isValid = computedHash === expectedCommitment;
    
    return {
        valid: isValid,
        seed: seed,
        expectedCommitment: expectedCommitment,
        computedHash: computedHash,
        match: isValid,
        message: isValid 
            ? "✅ Game verified as fair! The seed matches the pre-game commitment."
            : "❌ Verification failed! The seed does not match the commitment."
    };
}

module.exports = {
    generateSeed,
    hashSeed,
    verifySeed,
    deriveSeed,
    createSeededRNG,
    seedToInt,
    seededRandomInt,
    seededShuffle,
    createGameProof,
    getPreGameCommitment,
    getPostGameReveal,
    verifyGame
};
