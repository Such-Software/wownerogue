const { isPayoutProcessingEnabled, isWalletRequired } = require('../src/config/runtimePolicy');

const baseConfig = () => ({
    payouts: {
        enabled: true,
        rules: {
            direct: { enabled: true },
            credits: { enabled: true }
        }
    },
    modes: {
        direct: { enabled: true },
        credits: { enabled: true }
    }
});

const baseManager = () => ({
    payoutsEnabled: true,
    directPayoutEnabled: true,
    creditsPayoutEnabled: true
});

describe('runtime payout worker policy', () => {
    test('master config switch suppresses every per-mode payout worker', () => {
        const config = baseConfig();
        config.payouts.enabled = false;

        expect(isPayoutProcessingEnabled(config, baseManager())).toBe(false);
    });

    test('manager emergency switch also suppresses workers after hot reload', () => {
        const manager = baseManager();
        manager.payoutsEnabled = false;

        expect(isPayoutProcessingEnabled(baseConfig(), manager)).toBe(false);
    });

    test('disabled modes cannot accidentally activate a worker through stale payout flags', () => {
        const config = baseConfig();
        config.modes.direct.enabled = false;
        config.modes.credits.enabled = false;

        expect(isPayoutProcessingEnabled(config, baseManager())).toBe(false);
    });

    test('one explicitly active policy is enough to process its queued payouts', () => {
        const config = baseConfig();
        config.modes.direct.enabled = false;
        const manager = baseManager();
        manager.directPayoutEnabled = false;

        expect(isPayoutProcessingEnabled(config, manager)).toBe(true);
    });

    test('accepted durable liabilities keep the generic worker alive after admission is disabled', () => {
        const config = baseConfig();
        config.modes.direct.enabled = false;
        config.modes.credits.enabled = false;
        const manager = baseManager();
        manager.directPayoutEnabled = false;
        manager.creditsPayoutEnabled = false;

        expect(isPayoutProcessingEnabled(config, manager)).toBe(false);
        expect(isPayoutProcessingEnabled(config, manager, {
            settleAcceptedLiabilities: true
        })).toBe(true);

        config.payouts.enabled = false;
        expect(isPayoutProcessingEnabled(config, manager, {
            settleAcceptedLiabilities: true
        })).toBe(false);
    });

    test('wallet remains mandatory for payout-only accepted-liability settlement', () => {
        const config = baseConfig();
        config.paymentsEnabled = false;
        config.modes.direct.enabled = false;
        config.modes.credits.enabled = false;
        const manager = baseManager();
        manager.directPayoutEnabled = false;
        manager.creditsPayoutEnabled = false;

        expect(isWalletRequired(config, manager)).toBe(false);
        expect(isWalletRequired(config, manager, {
            settleAcceptedLiabilities: true
        })).toBe(true);

        config.payouts.enabled = false;
        expect(isWalletRequired(config, manager, {
            settleAcceptedLiabilities: true
        })).toBe(false);
    });
});
