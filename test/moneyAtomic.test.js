/**
 * Money / atomic-unit arithmetic tests (Phase 1.1).
 *
 * These specifically exercise the large-amount cases where the old float path
 * (`base * multiplier`, `sum + Number(x)`) silently loses precision above 2^53.
 */

const money = require('../src/money/atomic');

describe('money.toBig / toSafe', () => {
  test('parses string, number and bigint', () => {
    expect(money.toBig('100000000000')).toBe(100000000000n);
    expect(money.toBig(5)).toBe(5n);
    expect(money.toBig(7n)).toBe(7n);
  });

  test('rejects non-integer numbers and junk strings', () => {
    expect(() => money.toBig(1.5)).toThrow();
    expect(() => money.toBig('1.5')).toThrow();
    expect(() => money.toBig('abc')).toThrow();
    expect(() => money.toBig(Infinity)).toThrow();
  });

  test('toSafe narrows to number when exact, keeps string when too large', () => {
    expect(money.toSafe(200000000000n)).toBe(200000000000);
    // 10^18 atomic > MAX_SAFE_INTEGER (~9.007e15) -> must stay a string, not a lossy number
    expect(money.toSafe(1000000000000000000n)).toBe('1000000000000000000');
  });
});

describe('money.mulByDecimal (exact, no float)', () => {
  test('whole multipliers', () => {
    expect(money.mulByDecimal(100000000000n, 2)).toBe(200000000000n);
    expect(money.mulByDecimal(100000000000n, 3)).toBe(300000000000n);
  });

  test('fractional multipliers with half-up rounding', () => {
    expect(money.mulByDecimal(100000000000n, 1.5)).toBe(150000000000n);
    expect(money.mulByDecimal(50000000000n, 1.5)).toBe(75000000000n);
    expect(money.mulByDecimal(3n, 1.5)).toBe(5n);   // 4.5 -> 5 (half up)
    expect(money.mulByDecimal(1n, 2.5)).toBe(3n);   // 2.5 -> 3 (half up)
    expect(money.mulByDecimal(0n, 3)).toBe(0n);
  });

  test('large amounts stay exact where float would drift', () => {
    // 9,007,199,254,740,993 is 2^53 + 1 — not representable as a float64.
    const big = 9007199254740993n;
    expect(money.mulByDecimal(big, 3)).toBe(27021597764222979n);
    // Sanity: the naive float computation is wrong, proving why BigInt matters.
    expect(Number(big) * 3).not.toBe(27021597764222979);
  });

  test('rejects invalid multipliers', () => {
    expect(() => money.mulByDecimal(1n, -1)).toThrow();
    expect(() => money.mulByDecimal(1n, 'x')).toThrow();
  });
});

describe('money.sum / add (exact)', () => {
  test('sums large atomic amounts without precision loss', () => {
    const vals = ['9007199254740991', '9007199254740991', '9007199254740991'];
    expect(money.sum(vals)).toBe(27021597764222973n); // exact
    // The naive float reduce drifts away from the exact integer total.
    const floatSum = vals.reduce((a, b) => a + Number(b), 0);
    expect(BigInt(floatSum)).not.toBe(money.sum(vals));
  });

  test('add coerces mixed types', () => {
    expect(money.add('100', 50)).toBe(150n);
    expect(money.add(7n, '3')).toBe(10n);
  });
});

describe('money.format', () => {
  test('formats with currency decimals and trims trailing zeros', () => {
    expect(money.format(150000000000n, 11)).toBe('1.5');
    expect(money.format(100000000000n, 11)).toBe('1');
    expect(money.format(1n, 11)).toBe('0.00000000001');
    expect(money.format(0n, 11)).toBe('0');
  });
});
