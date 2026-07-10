const ChainProfile = require('../../chain/chainProfile');

const DEFAULT_DECIMALS = 12;

const parseAtomicEnvValue = (val, fallback) => {
    if (val === undefined || val === null || val === '') return fallback;
    if (typeof val !== 'string') {
        const numVal = Number(val);
        return Number.isFinite(numVal) ? Math.trunc(numVal) : fallback;
    }
    const cleaned = val.replace(/_/g, '').trim();
    if (!cleaned) {
        return fallback;
    }
    const num = Number(cleaned);
    if (!Number.isFinite(num) || num < 0) {
        return fallback;
    }
    return Math.trunc(num);
};

// Delegates to the ChainProfile registry — one source for all chains (WOW 11, XMR 12, BTC/LTC 8,
// GRIN 9; unknown -> 12). Previously WOW/XMR were hardcoded and everything else silently got 12.
const inferCurrencyDecimals = (symbol) => ChainProfile.decimalsFor(symbol);

const getDecimalDivisor = (decimals = DEFAULT_DECIMALS) => {
    const normalized = Number.isFinite(decimals) ? decimals : DEFAULT_DECIMALS;
    return Math.pow(10, normalized);
};

// The product name for a given currency (Monero -> Monerogue, otherwise Wownerogue).
const gameNameFor = (cryptoType) => (String(cryptoType || '').toUpperCase() === 'XMR' ? 'Monerogue' : 'Wownerogue');

// The user-facing currency label, network-aware: Monero on a test network shows sXMR
// (stagenet) / tXMR (testnet) so it's clear the coins aren't mainnet; mainnet shows XMR.
// Wownero has no test networks, so it's always WOW.
const currencyLabelFor = (cryptoType, network) => {
    const ct = String(cryptoType || '').toUpperCase();
    const net = String(network || 'mainnet').toLowerCase();
    if (ct === 'XMR' && (net === 'stagenet' || net === 'testnet')) {
        return (net === 'testnet' ? 't' : 's') + 'XMR';
    }
    return ct;
};

// Smirk wallet only works on mainnet Monero/Wownero, so it must be off on test networks.
const isTestNetworkFor = (network) => {
    const net = String(network || 'mainnet').toLowerCase();
    return net === 'stagenet' || net === 'testnet';
};

const formatAtomic = ({ value, decimals, digits = 6 }) => {
    if (value === undefined || value === null) {
        return '0';
    }
    const divisor = getDecimalDivisor(decimals);
    const quotient = Number(value) / divisor;
    if (!Number.isFinite(quotient)) {
        return value.toString();
    }
    return quotient.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
};

const formatAtomicHuman = ({ value, decimals, digits = 3 }) => {
    if (value === undefined || value === null) {
        return '0';
    }
    const divisor = getDecimalDivisor(decimals);
    const quotient = Number(value) / divisor;
    if (!Number.isFinite(quotient)) {
        return value.toString();
    }
    return quotient.toFixed(digits);
};

module.exports = {
    DEFAULT_DECIMALS,
    parseAtomicEnvValue,
    inferCurrencyDecimals,
    getDecimalDivisor,
    formatAtomic,
    formatAtomicHuman,
    gameNameFor,
    currencyLabelFor,
    isTestNetworkFor
};
