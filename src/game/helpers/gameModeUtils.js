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

const inferCurrencyDecimals = (symbol) => {
    if (!symbol) return DEFAULT_DECIMALS;
    const normalized = symbol.toUpperCase();
    if (normalized === 'WOW') return 11;
    if (normalized === 'XMR') return 12;
    return DEFAULT_DECIMALS;
};

const getDecimalDivisor = (decimals = DEFAULT_DECIMALS) => {
    const normalized = Number.isFinite(decimals) ? decimals : DEFAULT_DECIMALS;
    return Math.pow(10, normalized);
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
    formatAtomicHuman
};
