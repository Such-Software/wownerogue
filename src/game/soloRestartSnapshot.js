const { isDeepStrictEqual } = require('node:util');
const Game = require('./game');
const DungeonGenerator = require('./dungeon');

const SNAPSHOT_VERSION = 1;
const MAX_RNG_COUNTER = 100000000;

function invariant(condition, message) {
    if (!condition) {
        const error = new Error(`Invalid solo restart snapshot: ${message}`);
        error.code = 'SOLO_RESTART_SNAPSHOT_INVALID';
        throw error;
    }
}

function integer(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    invariant(Number.isSafeInteger(value), `${label} must be a safe integer`);
    invariant(value >= min && value <= max, `${label} is outside the accepted range`);
    return value;
}

function nullableInteger(value, label, bounds = {}) {
    return value == null ? null : integer(value, label, bounds);
}

function finiteNumber(value, label, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
    invariant(Number.isFinite(value), `${label} must be finite`);
    invariant(value >= min && value <= max, `${label} is outside the accepted range`);
    return value;
}

function nonemptyString(value, label, maxLength = 255) {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= maxLength,
        `${label} must be a nonempty bounded string`);
    return value;
}

function jsonClone(value, label) {
    try {
        const encoded = JSON.stringify(value);
        invariant(typeof encoded === 'string', `${label} is not JSON serializable`);
        return JSON.parse(encoded);
    } catch (error) {
        if (error?.code === 'SOLO_RESTART_SNAPSHOT_INVALID') throw error;
        invariant(false, `${label} is not JSON serializable`);
    }
}

function jsonValue(value, label) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch (_) {
            invariant(false, `${label} is not valid JSON`);
        }
    }
    return value;
}

function normalizedHex(value, label) {
    const normalized = String(value || '').trim().toLowerCase();
    invariant(/^[0-9a-f]{64}$/.test(normalized), `${label} must be 64 lowercase hex characters`);
    return normalized;
}

function captureSoloRestartSnapshot(game, { paymentMonitoringActive = false } = {}) {
    invariant(game && typeof game === 'object', 'game is required');
    invariant(!game.settlementPending && !game.settlementCommitted,
        'terminal or settlement-pending games cannot be captured');
    invariant(game.gameState === 'active', 'only active games can be captured');

    const dbId = integer(Number(game.dbId), 'game.dbId', { min: 1 });
    const userId = integer(Number(game.dbUserId ?? game.userId), 'stable user id', { min: 1 });
    const gameId = nonemptyString(game.id, 'game.id', 50);
    const originalSocketId = nonemptyString(game.socketId, 'game.socketId');
    invariant(typeof game.seededRNG?.getCounter === 'function', 'seeded RNG is not snapshot-capable');

    const player = game.player?.getState?.();
    const monster = game.monster;
    invariant(player && monster, 'player and monster state are required');

    const state = {
        version: SNAPSHOT_VERSION,
        gameId,
        dbId,
        userId,
        proofTimestamp: integer(Number(game.gameProof?.timestamp), 'proof timestamp', { min: 0 }),
        gameConfig: jsonClone(game.gameConfig, 'game config'),
        difficultyConfig: jsonClone(game.difficultyConfig, 'difficulty config'),
        depth: integer(Number(game.depth), 'depth', { min: 1 }),
        maxDepth: integer(Number(game.maxDepth), 'max depth', { min: 1 }),
        player: {
            x: integer(Number(player.x), 'player.x'),
            y: integer(Number(player.y), 'player.y'),
            hasKey: player.hasKey === true,
            hasTreasure: player.hasTreasure === true
        },
        monster: {
            x: integer(Number(monster.x), 'monster.x'),
            y: integer(Number(monster.y), 'monster.y'),
            lastKnownPlayerX: nullableInteger(monster.lastKnownPlayerX, 'monster.lastKnownPlayerX'),
            lastKnownPlayerY: nullableInteger(monster.lastKnownPlayerY, 'monster.lastKnownPlayerY'),
            visionRange: finiteNumber(Number(monster.visionRange), 'monster.visionRange', { min: 1, max: 1000 })
        },
        moveCount: integer(Number(game.moveCount || 0), 'move count', { min: 0 }),
        startedAt: integer(Number(game.startedAt), 'startedAt', { min: 0 }),
        monsterMoveAccumulator: finiteNumber(Number(game.monsterMoveAccumulator || 0),
            'monster move accumulator', { min: 0, max: 1000 }),
        rngCounter: integer(Number(game.seededRNG.getCounter()), 'seeded RNG counter', {
            min: 0,
            max: MAX_RNG_COUNTER
        }),
        blockRec: nullableInteger(game.blockRec ?? game.blockHeight ?? null, 'entry block', { min: 0 }),
        startBlock: nullableInteger(game.startBlock ?? null, 'start block', { min: 0 }),
        fee: finiteNumber(Number(game.fee || 0), 'fee', { min: 0 })
    };

    invariant(state.depth <= state.maxDepth, 'depth exceeds maxDepth');

    return {
        gameId: dbId,
        userId,
        dungeonSeed: gameId,
        snapshotVersion: SNAPSHOT_VERSION,
        originalSocketId,
        paymentMonitoringActive: paymentMonitoringActive === true,
        state
    };
}

function restoreSoloRestartSnapshot(row, { db } = {}) {
    invariant(row && typeof row === 'object', 'database row is required');
    invariant(db && typeof db.query === 'function', 'database handle is required');
    invariant(row.status === 'active' && row.completed_at == null,
        'database game must still be active and nonterminal');

    const state = jsonValue(row.state, 'state');
    invariant(state && typeof state === 'object' && !Array.isArray(state), 'state must be an object');
    invariant(Number(row.snapshot_version) === SNAPSHOT_VERSION && state.version === SNAPSHOT_VERSION,
        'unsupported snapshot version');

    const dbId = integer(Number(row.game_id), 'game id', { min: 1 });
    const userId = integer(Number(row.user_id), 'user id', { min: 1 });
    const dungeonSeed = nonemptyString(String(row.dungeon_seed || ''), 'dungeon seed', 50);
    const originalSocketId = nonemptyString(String(row.original_socket_id || ''), 'original socket id');
    invariant(Number(row.joined_game_id ?? row.game_id) === dbId
        && Number(row.game_user_id ?? row.user_id) === userId
        && String(row.game_dungeon_seed ?? row.dungeon_seed) === dungeonSeed,
    'snapshot identity does not exactly join its game row');
    invariant(state.dbId === dbId && state.userId === userId && state.gameId === dungeonSeed,
        'snapshot identity does not match its database anchors');
    const snapshotCreatedAt = row.created_at instanceof Date
        ? row.created_at.getTime()
        : Date.parse(row.created_at);
    invariant(Number.isFinite(snapshotCreatedAt), 'snapshot created_at is invalid');
    const now = Date.now();
    invariant(snapshotCreatedAt <= now + 60000, 'snapshot created_at is in the future');

    const serverSeed = normalizedHex(row.server_seed, 'server seed');
    const commitment = normalizedHex(row.proof_commitment, 'proof commitment');
    const effectiveSeed = normalizedHex(row.effective_seed, 'effective seed');
    const clientSeed = String(row.client_seed ?? '').trim().toLowerCase();
    invariant(clientSeed === '' || /^[0-9a-f]{1,64}$/.test(clientSeed), 'client seed is invalid');
    let offerIssuedAt = null;
    if (row.fairness_offer_issued_at != null) {
        offerIssuedAt = row.fairness_offer_issued_at instanceof Date
            ? row.fairness_offer_issued_at.getTime()
            : Number(row.fairness_offer_issued_at);
        if (!Number.isFinite(offerIssuedAt)) offerIssuedAt = Date.parse(row.fairness_offer_issued_at);
        invariant(Number.isSafeInteger(offerIssuedAt) && offerIssuedAt >= 0,
            'fairness offer issued timestamp is invalid');
    }

    const gameConfig = jsonValue(state.gameConfig, 'game config');
    const difficultyConfig = jsonValue(state.difficultyConfig, 'difficulty config');
    invariant(gameConfig && typeof gameConfig === 'object' && !Array.isArray(gameConfig),
        'game config must be an object');
    invariant(difficultyConfig && typeof difficultyConfig === 'object' && !Array.isArray(difficultyConfig),
        'difficulty config must be an object');
    const persistedGeneratorVersion = String(row.generator_version || '').trim();
    invariant(DungeonGenerator.SUPPORTED_GENERATOR_VERSIONS.includes(persistedGeneratorVersion),
        'dungeon generator version is unsupported');
    const persistedContext = jsonValue(row.proof_context, 'proof context');
    const persistedFingerprints = jsonValue(row.layout_fingerprints, 'layout fingerprints');
    invariant(persistedContext?.generatorVersion === persistedGeneratorVersion,
        'proof context generator version does not match the game row');

    const placeholderUser = {
        id: originalSocketId,
        joinGame() {},
        endGame() {}
    };
    const game = Game.createRestoredStandardGame(originalSocketId, placeholderUser, {
        ...gameConfig,
        fairnessProof: {
            proofVersion: Number(row.proof_version) || 1,
            offerId: row.fairness_offer_id || null,
            offerIssuedAt,
            serverSeed,
            clientSeed,
            commitment
        }
    }, persistedGeneratorVersion);

    invariant(game.gameProof.seed === effectiveSeed, 'effective seed does not match the proof inputs');
    invariant(game.gameProof.commitment === commitment, 'commitment does not match the server seed');
    invariant(game.maxDepth === state.maxDepth, 'runtime maxDepth has drifted');
    invariant(isDeepStrictEqual(jsonClone(game.gameConfig, 'restored game config'), gameConfig),
        'runtime game configuration has drifted');
    invariant(isDeepStrictEqual(jsonClone(game.difficultyConfig, 'restored difficulty config'), difficultyConfig),
        'runtime difficulty configuration has drifted');

    invariant(isDeepStrictEqual(game.gameProof.context, persistedContext), 'proof context has drifted');
    invariant(isDeepStrictEqual(game.gameProof.layoutFingerprints, persistedFingerprints),
        'layout fingerprint manifest has drifted');
    invariant(game.gameProof.generatorVersion === persistedGeneratorVersion,
        'dungeon generator version has drifted');
    invariant(game.gameProof.layoutFingerprint === String(row.layout_fingerprint || '').trim(),
        'level-one layout fingerprint has drifted');

    const depth = integer(Number(state.depth), 'depth', { min: 1, max: state.maxDepth });
    if (depth !== 1) game._generateLevel(depth);
    game.depth = depth;

    const width = integer(Number(game.width), 'game width', { min: 1 });
    const height = integer(Number(game.height), 'game height', { min: 1 });
    const player = state.player || {};
    const monster = state.monster || {};
    game.player.setState({
        x: integer(Number(player.x), 'player.x', { min: 0, max: width - 1 }),
        y: integer(Number(player.y), 'player.y', { min: 0, max: height - 1 }),
        hasKey: player.hasKey === true,
        hasTreasure: player.hasTreasure === true
    });
    game.monster.moveTo(
        integer(Number(monster.x), 'monster.x', { min: 0, max: width - 1 }),
        integer(Number(monster.y), 'monster.y', { min: 0, max: height - 1 })
    );
    game.monster.lastKnownPlayerX = nullableInteger(monster.lastKnownPlayerX,
        'monster.lastKnownPlayerX', { min: 0, max: width - 1 });
    game.monster.lastKnownPlayerY = nullableInteger(monster.lastKnownPlayerY,
        'monster.lastKnownPlayerY', { min: 0, max: height - 1 });
    game.monster.visionRange = finiteNumber(Number(monster.visionRange),
        'monster.visionRange', { min: 1, max: 1000 });

    const primaryFloor = game.gameConfig.primaryFloor || "'1";
    const secondaryFloor = game.gameConfig.secondaryFloor || "'2";
    const passable = (x, y) => {
        const tile = game.dungeon?.map?.[y]?.[x];
        return tile === primaryFloor || tile === secondaryFloor
            || tile === 0 || tile === '>' || tile === '$M';
    };
    invariant(passable(game.player.x, game.player.y), 'player is not on a passable tile');
    invariant(passable(game.monster.x, game.monster.y), 'monster is not on a passable tile');
    invariant(game.player.x !== game.monster.x || game.player.y !== game.monster.y,
        'active player and monster overlap');
    const onExit = Array.isArray(game.dungeon?.exit)
        && game.player.x === game.dungeon.exit[0]
        && game.player.y === game.dungeon.exit[1];
    invariant(!onExit, 'active player is already on the exit');

    const generatedTreasure = Array.isArray(game.dungeon?.treasure)
        ? [...game.dungeon.treasure]
        : null;
    if (game.player.hasTreasure) {
        invariant(depth === state.maxDepth, 'treasure cannot be held before the final depth');
        invariant(generatedTreasure !== null, 'final-depth treasure cannot be reconstructed');
        // Picking treasure removes the live dungeon marker immediately. The player may still
        // stand on the former pickup coordinate; it is no longer an active treasure tile.
        game.dungeon.treasure = null;
    } else if (depth === state.maxDepth) {
        invariant(generatedTreasure !== null, 'uncollected final-depth treasure is missing');
        const onUncollectedTreasure = game.player.x === generatedTreasure[0]
            && game.player.y === generatedTreasure[1];
        invariant(!onUncollectedTreasure, 'active player is already on uncollected treasure');
    } else {
        invariant(generatedTreasure === null, 'treasure exists before the final depth');
    }

    game.moveCount = integer(Number(state.moveCount), 'move count', { min: 0 });
    game.startedAt = integer(Number(state.startedAt), 'startedAt', { min: 0 });
    invariant(game.startedAt <= snapshotCreatedAt + 60000 && game.startedAt <= now + 60000,
        'startedAt is later than the durable snapshot');
    game.monsterMoveAccumulator = finiteNumber(Number(state.monsterMoveAccumulator),
        'monster move accumulator', { min: 0, max: 1000 });
    const generatedRngCounter = game.seededRNG.getCounter();
    const restoredRngCounter = integer(Number(state.rngCounter), 'seeded RNG counter', {
        min: 0,
        max: MAX_RNG_COUNTER
    });
    invariant(restoredRngCounter >= generatedRngCounter,
        'seeded RNG counter predates deterministic dungeon generation');
    game.seededRNG.setCounter(restoredRngCounter);
    game.blockRec = nullableInteger(state.blockRec, 'entry block', { min: 0 });
    const durableEntryBlock = nullableInteger(
        row.start_block_height == null ? null : Number(row.start_block_height),
        'durable entry block',
        { min: 0 }
    );
    invariant(game.blockRec === durableEntryBlock,
        'entry block does not match the durable game row');
    game.blockHeight = game.blockRec;
    game.startBlock = nullableInteger(state.startBlock, 'start block', { min: 0 });
    game.fee = finiteNumber(Number(state.fee), 'fee', { min: 0 });
    game.gameState = 'active';
    game.updateFOV();

    game.id = dungeonSeed;
    game.socketId = originalSocketId;
    game.dbId = dbId;
    game.userId = userId;
    game.dbUserId = userId;
    game.db = db;
    game.gameMode = String(row.game_mode || 'FREE').toUpperCase();
    game.gameProof.gameId = dungeonSeed;
    game.gameProof.timestamp = integer(Number(state.proofTimestamp), 'proof timestamp', { min: 0 });
    invariant(game.gameProof.timestamp <= snapshotCreatedAt + 60000
        && game.gameProof.timestamp >= game.startedAt - 60000,
    'proof timestamp is outside the game/snapshot lifetime');
    game.gameProof.proofVersion = Number(row.proof_version) || 1;
    game.gameProof.offerId = row.fairness_offer_id || null;
    game.gameProof.offerIssuedAt = offerIssuedAt;
    game.gameProof.context = persistedContext;
    game.gameProof.layoutFingerprints = persistedFingerprints;
    game.gameProof.layoutFingerprint = String(row.layout_fingerprint || '').trim();
    return {
        game,
        userId,
        originalSocketId,
        paymentMonitoringActive: row.payment_monitoring_active === true,
        snapshotVersion: SNAPSHOT_VERSION
    };
}

module.exports = {
    SNAPSHOT_VERSION,
    captureSoloRestartSnapshot,
    restoreSoloRestartSnapshot
};
