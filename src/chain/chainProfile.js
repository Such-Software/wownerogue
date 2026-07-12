/**
 * ChainProfile registry — the 10× foundation stone for multi-chain (Pillar 3).
 *
 * A single, data-driven source for everything chain-specific that ISN'T an RPC call: money units
 * (decimals / atomic divisor), the block-timing model (mean block time — which difficulty must
 * scale to), the adapter family (which wallet/daemon adapter implements it), and the payment-URI
 * scheme. The adapters (daemon/wallet clients, address validators) plug in per family and read
 * their params from here.
 *
 * The set is exactly what the Smirk wallet supports — btc, ltc, xmr, wow, grin (see
 * smirk-monorepo packages/core/src/types.ts AssetType) — all proof-of-work / high-variance, so the
 * "a random block ends your run" mechanic is fair on every one. Adding a chain = one entry here
 * plus a family adapter, never a fork.
 */

const DEFAULT_DECIMALS = 12;

// family: 'monero' (subaddress + transfer_split), 'utxo' (BTC/LTC-style), 'mimblewimble' (Grin).
const PROFILES = Object.freeze({
    WOW:  Object.freeze({ id: 'WOW',  symbol: 'WOW',  decimals: 11, meanBlockTimeMs: 300000, family: 'monero',       uriScheme: 'wownero'  }),
    XMR:  Object.freeze({ id: 'XMR',  symbol: 'XMR',  decimals: 12, meanBlockTimeMs: 120000, family: 'monero',       uriScheme: 'monero'   }),
    BTC:  Object.freeze({ id: 'BTC',  symbol: 'BTC',  decimals: 8,  meanBlockTimeMs: 600000, family: 'utxo',         uriScheme: 'bitcoin'  }),
    LTC:  Object.freeze({ id: 'LTC',  symbol: 'LTC',  decimals: 8,  meanBlockTimeMs: 150000, family: 'utxo',         uriScheme: 'litecoin' }),
    GRIN: Object.freeze({ id: 'GRIN', symbol: 'GRIN', decimals: 9,  meanBlockTimeMs: 60000,  family: 'mimblewimble', uriScheme: 'grin'     })
});

function normalizeId(cryptoType) {
    return String(cryptoType || '').trim().toUpperCase();
}

/**
 * Resolve a chain profile. Unknown/unset falls back to a WOW-shaped default (11 decimals, ~2 min)
 * so callers never crash on a mis-set CRYPTO_TYPE. Returns a frozen profile object.
 */
function getProfile(cryptoType) {
    const id = normalizeId(cryptoType);
    if (PROFILES[id]) return PROFILES[id];
    return Object.freeze({ id: id || 'WOW', symbol: id || 'WOW', decimals: DEFAULT_DECIMALS, meanBlockTimeMs: 120000, family: 'monero', uriScheme: 'monero' });
}

function decimalsFor(cryptoType) {
    return getProfile(cryptoType).decimals;
}

function meanBlockTimeMsFor(cryptoType) {
    return getProfile(cryptoType).meanBlockTimeMs;
}

function familyFor(cryptoType) {
    return getProfile(cryptoType).family;
}

function uriSchemeFor(cryptoType) {
    return getProfile(cryptoType).uriScheme;
}

/** Atomic divisor as a BigInt (10 ** decimals) — safe for ETH-18-scale amounts (none here, but correct). */
function atomicDivisor(cryptoType) {
    return 10n ** BigInt(decimalsFor(cryptoType));
}

function isSupported(cryptoType) {
    return !!PROFILES[normalizeId(cryptoType)];
}

module.exports = {
    DEFAULT_DECIMALS,
    PROFILES,
    getProfile,
    decimalsFor,
    meanBlockTimeMsFor,
    familyFor,
    uriSchemeFor,
    atomicDivisor,
    isSupported
};
