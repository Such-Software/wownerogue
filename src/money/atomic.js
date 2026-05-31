/**
 * Money — atomic-unit arithmetic on BigInt.
 *
 * The single source of truth for money math. All monetary values in this app are integer
 * atomic units (1 WOW = 10^11, 1 XMR = 10^12). JavaScript `number` is float64 and loses
 * precision above 2^53, so sums/products of large atomic amounts must NOT be done with `+`
 * or `*` on numbers. Everything here operates on BigInt and only narrows back to `number`
 * when the value is provably exact (<= MAX_SAFE_INTEGER).
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Coerce a string | number | bigint atomic amount to BigInt.
 * Rejects non-integer numbers and non-numeric strings (money is never fractional atomic).
 * @param {string|number|bigint} v
 * @returns {bigint}
 */
function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || !Number.isInteger(v)) {
            throw new Error(`Invalid atomic amount (not an integer number): ${v}`);
        }
        return BigInt(v);
    }
    if (typeof v === 'string') {
        const s = v.trim();
        if (!/^-?\d+$/.test(s)) {
            throw new Error(`Invalid atomic amount (not an integer string): ${v}`);
        }
        return BigInt(s);
    }
    throw new Error(`Invalid atomic amount type: ${typeof v}`);
}

/**
 * Narrow a BigInt atomic amount to a JS number when it is exactly representable,
 * otherwise return its decimal string. This keeps small amounts ergonomic (and
 * backward compatible with existing number-typed call sites and tests) while never
 * silently losing precision on large amounts.
 * @param {bigint} big
 * @returns {number|string}
 */
function toSafe(big) {
    const b = toBig(big);
    return (b <= MAX_SAFE && b >= -MAX_SAFE) ? Number(b) : b.toString();
}

/** Sum a list of atomic amounts exactly. @returns {bigint} */
function sum(values) {
    return (values || []).reduce((acc, v) => acc + toBig(v), 0n);
}

/** Add two atomic amounts exactly. @returns {bigint} */
function add(a, b) {
    return toBig(a) + toBig(b);
}

/**
 * Multiply an atomic amount by a non-negative decimal multiplier (e.g. 2, 3, 1.5, 2.5)
 * using exact integer math with half-up rounding — no float multiplication.
 * @param {string|number|bigint} atomic
 * @param {number|string} multiplier
 * @returns {bigint}
 */
function mulByDecimal(atomic, multiplier) {
    const a = toBig(atomic);
    const s = String(multiplier);
    if (!/^\d+(\.\d+)?$/.test(s)) {
        throw new Error(`Invalid multiplier (expected non-negative decimal): ${multiplier}`);
    }
    const [intPart, fracPart = ''] = s.split('.');
    const places = fracPart.length;
    const scale = 10n ** BigInt(places);
    const numerator = BigInt(intPart + fracPart); // "2.5" -> 25n, scale 10n
    // Half-up rounding: add half the denominator before truncating division.
    return (a * numerator + scale / 2n) / scale;
}

/**
 * Format an atomic amount as a human-readable decimal string for the given currency
 * decimals (e.g. format(150000000000n, 11) -> "1.5"). Trims trailing fractional zeros.
 * @param {string|number|bigint} atomic
 * @param {number} decimals
 * @returns {string}
 */
function format(atomic, decimals) {
    const a = toBig(atomic);
    const neg = a < 0n;
    const abs = neg ? -a : a;
    const d = BigInt(decimals);
    const divisor = 10n ** d;
    const whole = abs / divisor;
    const frac = abs % divisor;
    let fracStr = frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '');
    return (neg ? '-' : '') + whole.toString() + (fracStr ? '.' + fracStr : '');
}

module.exports = { toBig, toSafe, sum, add, mulByDecimal, format, MAX_SAFE };
