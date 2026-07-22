'use strict';

const crypto = require('crypto');

const LEGACY_PAID_FREEZE_VERSION = 'future-block-freeze-v1';
const PAID_FREEZE_VERSION = 'future-block-freeze-v2';
const PAID_SEED_VERSION = 'future-chain-block-v2';
const PAID_ECONOMIES = new Set(['credits_prestige', 'crypto_race']);

function invariant(condition, message) {
    if (!condition) throw new Error(message);
}

function canonicalQueueEntryIds(queueEntryIds) {
    const ids = (queueEntryIds || []).map(id => String(id));
    invariant(ids.length >= 2 && ids.every(id => /^\d+$/.test(id)),
        'At least two durable numeric queue entry ids are required');
    invariant(new Set(ids).size === ids.length, 'Queue entry ids must be unique');
    return ids.sort((left, right) => {
        if (left.length !== right.length) return left.length - right.length;
        return left.localeCompare(right);
    });
}

function blockHeight(value, label) {
    const height = Number(value);
    invariant(Number.isSafeInteger(height) && height >= 0, `${label} must be a safe block height`);
    return height;
}

function canonicalBlockHash(value) {
    const normalized = String(value || '').trim().toLowerCase();
    invariant(/^[0-9a-f]{64}$/.test(normalized), 'A canonical 64-hex block hash is required');
    return normalized;
}

function buildPaidEntrantFreeze({
    version = PAID_FREEZE_VERSION,
    freezeBlockHeight,
    targetBlockHeight,
    entropyDelayBlocks = null,
    economy,
    rulesetId,
    queueEntryIds
}) {
    invariant(version === PAID_FREEZE_VERSION, 'Paid entrant freeze version is unsupported');
    const frozenAt = blockHeight(freezeBlockHeight, 'Freeze block height');
    const target = blockHeight(targetBlockHeight, 'Target block height');
    const delay = target - frozenAt;
    invariant(Number.isSafeInteger(delay) && delay >= 1,
        'Paid seed block must be after the entrant freeze');
    if (entropyDelayBlocks != null) {
        invariant(blockHeight(entropyDelayBlocks, 'Paid entropy delay') === delay,
            'Paid entropy delay does not match the committed block heights');
    }
    invariant(PAID_ECONOMIES.has(String(economy)), 'Paid entrant freeze requires a paid economy');
    invariant(/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(rulesetId || '')),
        'Paid entrant freeze requires a canonical ruleset id');
    const ids = canonicalQueueEntryIds(queueEntryIds);
    const canonical = [
        'wowngeon-paid-entrant-freeze', PAID_FREEZE_VERSION, String(frozenAt), String(target),
        String(delay),
        String(economy), String(rulesetId), ids.join(',')
    ].join('|');
    const freezeCommitment = crypto.createHash('sha256').update(canonical).digest('hex');
    return Object.freeze({
        version: PAID_FREEZE_VERSION,
        freezeBlockHeight: frozenAt,
        targetBlockHeight: target,
        entropyDelayBlocks: delay,
        economy: String(economy),
        rulesetId: String(rulesetId),
        queueEntryIds: Object.freeze(ids),
        freezeCommitment
    });
}

function deriveFutureBlockMatchSeed({ blockHash, blockHeight: height, freeze }) {
    const verifiedFreeze = buildPaidEntrantFreeze(freeze || {});
    const entropyHeight = blockHeight(height, 'Entropy block height');
    invariant(entropyHeight === verifiedFreeze.targetBlockHeight,
        'Paid seed must use the exact future block committed by the entrant freeze');
    if (freeze?.freezeCommitment != null) {
        invariant(String(freeze.freezeCommitment) === verifiedFreeze.freezeCommitment,
            'Paid entrant freeze commitment does not match its durable inputs');
    }
    const hash = canonicalBlockHash(blockHash);
    const canonical = [
        'wowngeon-match', PAID_SEED_VERSION, hash, String(entropyHeight),
        verifiedFreeze.freezeCommitment, verifiedFreeze.economy, verifiedFreeze.rulesetId,
        verifiedFreeze.queueEntryIds.join(',')
    ].join('|');
    return Object.freeze({
        seed: crypto.createHash('sha256').update(canonical).digest('hex'),
        derivation: Object.freeze({
            version: PAID_SEED_VERSION,
            blockHash: hash,
            blockHeight: entropyHeight,
            freezeBlockHeight: verifiedFreeze.freezeBlockHeight,
            targetBlockHeight: verifiedFreeze.targetBlockHeight,
            entropyDelayBlocks: verifiedFreeze.entropyDelayBlocks,
            freezeCommitment: verifiedFreeze.freezeCommitment,
            economy: verifiedFreeze.economy,
            rulesetId: verifiedFreeze.rulesetId,
            queueEntryIds: verifiedFreeze.queueEntryIds
        })
    });
}

module.exports = {
    LEGACY_PAID_FREEZE_VERSION,
    PAID_FREEZE_VERSION,
    PAID_SEED_VERSION,
    buildPaidEntrantFreeze,
    canonicalBlockHash,
    canonicalQueueEntryIds,
    deriveFutureBlockMatchSeed
};
