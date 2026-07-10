/**
 * ChainProfile registry (Pillar 3 foundation) — one source for chain params across Smirk's five
 * PoW chains, and the fix for decimals silently defaulting to 12 for anything but WOW/XMR.
 */
const ChainProfile = require('../src/chain/chainProfile');
const { inferCurrencyDecimals } = require('../src/game/helpers/gameModeUtils');

describe('ChainProfile', () => {
    test('decimals are correct for every Smirk chain', () => {
        expect(ChainProfile.decimalsFor('WOW')).toBe(11);
        expect(ChainProfile.decimalsFor('XMR')).toBe(12);
        expect(ChainProfile.decimalsFor('BTC')).toBe(8);
        expect(ChainProfile.decimalsFor('LTC')).toBe(8);
        expect(ChainProfile.decimalsFor('GRIN')).toBe(9);
    });

    test('mean block time + adapter family per chain', () => {
        expect(ChainProfile.meanBlockTimeMsFor('GRIN')).toBe(60000);   // ~1 min, fast floor
        expect(ChainProfile.meanBlockTimeMsFor('BTC')).toBe(600000);   // ~10 min, slow end
        expect(ChainProfile.familyFor('WOW')).toBe('monero');
        expect(ChainProfile.familyFor('BTC')).toBe('utxo');
        expect(ChainProfile.familyFor('LTC')).toBe('utxo');
        expect(ChainProfile.familyFor('GRIN')).toBe('mimblewimble');
    });

    test('atomic divisor is a BigInt of the right scale', () => {
        expect(ChainProfile.atomicDivisor('WOW')).toBe(100000000000n); // 1e11
        expect(ChainProfile.atomicDivisor('BTC')).toBe(100000000n);    // 1e8
        expect(ChainProfile.atomicDivisor('GRIN')).toBe(1000000000n);  // 1e9
    });

    test('case-insensitive; unknown falls back safely', () => {
        expect(ChainProfile.getProfile('grin').decimals).toBe(9);
        expect(ChainProfile.isSupported('DOGE')).toBe(false);
        const fb = ChainProfile.getProfile('DOGE');
        expect(fb.decimals).toBe(12);
        expect(fb.family).toBe('monero');
    });
});

describe('inferCurrencyDecimals now delegates to ChainProfile', () => {
    test('WOW/XMR unchanged; BTC/GRIN fixed (were silently 12)', () => {
        expect(inferCurrencyDecimals('WOW')).toBe(11);
        expect(inferCurrencyDecimals('XMR')).toBe(12);
        expect(inferCurrencyDecimals('BTC')).toBe(8);
        expect(inferCurrencyDecimals('GRIN')).toBe(9);
        expect(inferCurrencyDecimals('')).toBe(12);
    });
});
