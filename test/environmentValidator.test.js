const EnvironmentValidator = require('../src/config/environmentValidator');

function config(overrides = {}) {
    const base = {
        paymentsEnabled: true,
        currency: { symbol: 'XMR' },
        modes: {
            direct: { enabled: true, price: 10000n },
            credits: {
                enabled: true,
                packages: [{ id: 'small', credits: 10, price: 90000000000n }]
            }
        },
        payouts: {
            enabled: false,
            rules: {
                direct: {
                    enabled: false,
                    multipliers: { escape: 2, escapeWithTreasure: 3 },
                    minPayout: 1n,
                    maxPayout: 50000n
                },
                credits: {
                    enabled: false,
                    multipliers: { escape: 2, escapeWithTreasure: 3 },
                    baseValue: 10000n,
                    minPayout: 1n,
                    maxPayout: 50000n
                }
            }
        }
    };
    return {
        ...base,
        ...overrides,
        modes: {
            ...base.modes,
            ...(overrides.modes || {})
        },
        payouts: {
            ...base.payouts,
            ...(overrides.payouts || {}),
            rules: {
                direct: {
                    ...base.payouts.rules.direct,
                    ...(overrides.payouts?.rules?.direct || {})
                },
                credits: {
                    ...base.payouts.rules.credits,
                    ...(overrides.payouts?.rules?.credits || {})
                }
            }
        }
    };
}

function productionEnv(overrides = {}) {
    return {
        NODE_ENV: 'production',
        CRYPTO_TYPE: 'XMR',
        MONERO_NETWORK: 'stagenet',
        PAYMENTS_ENABLED: 'true',
        PAYOUTS_ENABLED: 'false',
        DIRECT_PAYOUTS_ENABLED: 'false',
        CREDITS_PAYOUTS_ENABLED: 'false',
        PRIMARY_WALLET_ENDPOINT: 'http://127.0.0.1:38083',
        WALLET_RPC_USER: 'monerogue',
        WALLET_RPC_PASSWORD: 'wallet-rpc-correct-horse-2026',
        PRIMARY_RPC_ENDPOINT: 'http://127.0.0.1:38081',
        DB_PASSWORD: 'correct-horse-battery-staple-2026',
        ADMIN_API_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        OPERATOR_NAME: 'Test Operator LLC',
        OPERATOR_CONTACT_URL: 'mailto:support@operator.invalid',
        LEGAL_POLICY_VERSION: '2026-07-21-v1',
        TERMS_EFFECTIVE_DATE: '2026-07-21',
        MINIMUM_AGE: '18',
        PAID_ACKNOWLEDGEMENT_REQUIRED: 'true',
        BLOCK_SOURCE: 'daemon',
        TRUST_PROXY: 'true',
        MATCH_PAID_ENTROPY_DELAY_BLOCKS: '2',
        MATCH_PAID_ENTROPY_CONFIRMATIONS: '2',
        PAYOUT_MAX_PER_GAME: '50000',
        BALANCE_CRITICAL: '50000',
        BALANCE_WARN: '100000',
        CREDITS_PACKAGES: '[{"id":"small","credits":10,"price":"90000000000"}]',
        ...overrides
    };
}

const silentLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('EnvironmentValidator production launch gate', () => {
    beforeEach(() => jest.clearAllMocks());

    test('accepts explicit paid-credits plus free-play style config with payouts disabled', () => {
        const validator = new EnvironmentValidator({ env: productionEnv(), logger: silentLogger });
        const result = validator.assertValid(config());

        expect(result.errors).toEqual([]);
        expect(result.money).toEqual(expect.objectContaining({
            paymentsEnabled: true,
            payoutsEnabled: false
        }));
    });

    test('accepts a complete HTTPS mainnet financial-event sink without exposing its token', () => {
        const token = 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6';
        const result = new EnvironmentValidator({
            env: productionEnv({
                MONERO_NETWORK: 'mainnet',
                FINANCIAL_EVENT_SINK_URL: 'https://ledger.operator.invalid/v1/events',
                FINANCIAL_EVENT_SINK_TOKEN: token,
                FINANCIAL_EVENT_ACCOUNT_REF: 'wowngeon:receipts'
            }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(token);
    });

    test('rejects partial, insecure, weak, credential-bearing, or testnet accounting export', () => {
        const token = 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6';
        const cases = [
            [
                { FINANCIAL_EVENT_SINK_URL: 'https://ledger.operator.invalid/events' },
                'must be configured together'
            ],
            [
                {
                    FINANCIAL_EVENT_SINK_URL: 'http://ledger.operator.invalid/events',
                    FINANCIAL_EVENT_SINK_TOKEN: token,
                    MONERO_NETWORK: 'mainnet'
                },
                'must use https:// in production'
            ],
            [
                {
                    FINANCIAL_EVENT_SINK_URL: 'https://user:pass@ledger.operator.invalid/events',
                    FINANCIAL_EVENT_SINK_TOKEN: token,
                    MONERO_NETWORK: 'mainnet'
                },
                'must not embed credentials'
            ],
            [
                {
                    FINANCIAL_EVENT_SINK_URL: 'https://ledger.operator.invalid/events',
                    FINANCIAL_EVENT_SINK_TOKEN: 'change-me'
                },
                'strong non-placeholder secret'
            ],
            [
                {
                    FINANCIAL_EVENT_SINK_URL: 'https://ledger.operator.invalid/events',
                    FINANCIAL_EVENT_SINK_TOKEN: token
                },
                'must be unset on non-mainnet networks'
            ],
            [
                {
                    FINANCIAL_EVENT_SINK_URL: 'https://ledger.operator.invalid/events',
                    FINANCIAL_EVENT_SINK_TOKEN: token,
                    FINANCIAL_EVENT_ACCOUNT_REF: 'customer@example.invalid',
                    MONERO_NETWORK: 'mainnet'
                },
                'must be a non-PII identifier'
            ]
        ];

        for (const [overrides, expected] of cases) {
            const result = new EnvironmentValidator({
                env: productionEnv(overrides), logger: silentLogger
            }).validate(config());
            expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
            expect(JSON.stringify(result)).not.toContain(token);
        }
    });

    test('accepts the exact Such Software play.wowne.ro operated-product contract', () => {
        const env = productionEnv({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
            HOSTED_BY: 'https://play.wowne.ro',
            OPERATOR_NAME: 'Such Software',
            OPERATOR_CONTACT_URL: 'mailto:apps@such.software',
            OPERATOR_CONTACT_LABEL: 'apps@such.software',
            LEGAL_POLICY_VERSION: '2026-07-22-v1',
            TERMS_EFFECTIVE_DATE: '2026-07-22',
            CRYPTO_TYPE: 'WOW',
            MONERO_NETWORK: 'mainnet',
            FREE_PLAY_ENABLED: 'true',
            GAME_MODE: 'PAID_CREDITS',
            PAYMENT_MODES: 'credits',
            DIRECT_PAYMENT_ENABLED: 'false',
            CREDITS_ENABLED: 'true',
            PAYOUTS_ENABLED: 'false',
            DIRECT_PAYOUTS_ENABLED: 'false',
            CREDITS_PAYOUTS_ENABLED: 'false',
            ALLOW_MAINNET_PAYOUTS: 'false',
            SOLO_ENABLED: 'true',
            TAVERN_ENABLED: 'true',
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'false',
            MATCH_PAYOUTS_ENABLED: 'false'
        });
        const operatedConfig = config({
            currency: { symbol: 'WOW' },
            modes: {
                direct: { enabled: false, price: 10000n },
                credits: {
                    enabled: true,
                    packages: [{ id: 'small', credits: 10, price: 90000000000n }]
                }
            }
        });

        expect(new EnvironmentValidator({ env, logger: silentLogger })
            .assertValid(operatedConfig).errors).toEqual([]);

        for (const gameMode of [undefined, 'PAID_SINGLE']) {
            const driftedEnv = { ...env };
            if (gameMode === undefined) delete driftedEnv.GAME_MODE;
            else driftedEnv.GAME_MODE = gameMode;
            expect(new EnvironmentValidator({ env: driftedEnv, logger: silentLogger })
                .validate(operatedConfig).errors).toContain(
                    'OPERATED_PRODUCT_PROFILE=such-play-wow-prestige requires GAME_MODE=PAID_CREDITS.'
                );
        }

        expect(new EnvironmentValidator({ env, logger: silentLogger }).validate({
            ...operatedConfig,
            products: { cosmetic: [{ id: 'unrelated-pack', price: 1n }] }
        }).errors).toContain(
            'OPERATED_PRODUCT_PROFILE=such-play-wow-prestige requires no standalone products or bundled entitlement grants; credit packages may grant only their top-level credits and bonus.'
        );
    });

    test('accepts the exact direct-only Such Software monerogue.app stagenet 2x/3x contract', () => {
        const env = productionEnv({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet',
            HOSTED_BY: 'https://monerogue.app',
            OPERATOR_NAME: 'Such Software',
            OPERATOR_CONTACT_URL: 'mailto:apps@such.software',
            OPERATOR_CONTACT_LABEL: 'apps@such.software',
            LEGAL_POLICY_VERSION: '2026-07-23-v2',
            TERMS_EFFECTIVE_DATE: '2026-07-23',
            FREE_PLAY_ENABLED: 'true',
            GAME_MODE: 'PAID_SINGLE',
            PAYMENT_MODES: 'direct',
            DIRECT_PAYMENT_ENABLED: 'true',
            CREDITS_ENABLED: 'false',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'false',
            DIRECT_PAYOUT_ESCAPE: '2.0',
            DIRECT_PAYOUT_TREASURE: '3.0',
            ALLOW_MAINNET_PAYOUTS: 'false',
            SOLO_ENABLED: 'true',
            TAVERN_ENABLED: 'true',
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'false',
            MATCH_PAYOUTS_ENABLED: 'false'
        });
        const operatedConfig = config({
            modes: {
                direct: { enabled: true, price: 10000n },
                credits: {
                    enabled: false,
                    packages: [{ id: 'small', credits: 10, price: 90000000000n }]
                }
            },
            payouts: {
                enabled: true,
                rules: {
                    direct: { enabled: true },
                    credits: { enabled: false }
                }
            }
        });

        expect(new EnvironmentValidator({ env, logger: silentLogger })
            .assertValid(operatedConfig).errors).toEqual([]);

        const outOfScopeCatalogs = [
            {
                ...operatedConfig,
                products: { cosmetic: [{ id: 'pack', price: 20000n }] }
            },
            ...[
                { packs: ['kenney-3d-characters'] },
                { premiumLevel: 'supporter' },
                { race_entries: 2, race_entry_value_atomic: '10000' },
                { future_entitlement: true },
                { credits: 10 }
            ].map(grants => ({
                ...operatedConfig,
                modes: {
                    ...operatedConfig.modes,
                    credits: {
                        ...operatedConfig.modes.credits,
                        packages: [{ id: 'small', credits: 10, price: 90000000000n, grants }]
                    }
                }
            }))
        ];
        for (const widenedCatalog of outOfScopeCatalogs) {
            expect(new EnvironmentValidator({ env, logger: silentLogger })
                .validate(widenedCatalog).errors).toContain(
                    'OPERATED_PRODUCT_PROFILE=such-monerogue-stagenet requires no standalone products or bundled entitlement grants; credit packages may grant only their top-level credits and bonus.'
                );
        }
    });

    test('play.wowne.ro profile rejects direct entry or any payout activation', () => {
        const env = productionEnv({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
            HOSTED_BY: 'https://play.wowne.ro',
            OPERATOR_NAME: 'Such Software',
            OPERATOR_CONTACT_URL: 'mailto:apps@such.software',
            OPERATOR_CONTACT_LABEL: 'apps@such.software',
            CRYPTO_TYPE: 'WOW',
            MONERO_NETWORK: 'mainnet',
            FREE_PLAY_ENABLED: 'true',
            GAME_MODE: 'PAID_CREDITS',
            PAYMENT_MODES: 'direct,credits',
            DIRECT_PAYMENT_ENABLED: 'true',
            CREDITS_ENABLED: 'true',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'false',
            ALLOW_MAINNET_PAYOUTS: 'false',
            MATCH_CRYPTO_RACE_ENABLED: 'false',
            MATCH_PAYOUTS_ENABLED: 'false'
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config({
            currency: { symbol: 'WOW' },
            payouts: { enabled: true, rules: { direct: { enabled: true } } }
        }));

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('requires PAYMENT_MODES=credits'),
            expect.stringContaining('requires DIRECT_PAYMENT_ENABLED=false'),
            expect.stringContaining('requires PAYOUTS_ENABLED=false'),
            expect.stringContaining('requires DIRECT_PAYOUTS_ENABLED=false')
        ]));
    });

    test('operated profiles fail closed on identity, network, mode, multiplier, or payout drift', () => {
        const env = productionEnv({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet',
            HOSTED_BY: 'https://play.wowne.ro',
            OPERATOR_NAME: 'Someone Else',
            OPERATOR_CONTACT_URL: 'mailto:other@example.invalid',
            OPERATOR_CONTACT_LABEL: 'Other',
            CRYPTO_TYPE: 'XMR',
            MONERO_NETWORK: 'mainnet',
            FREE_PLAY_ENABLED: 'true',
            GAME_MODE: 'PAID_CREDITS',
            PAYMENT_MODES: 'direct,credits',
            DIRECT_PAYMENT_ENABLED: 'true',
            CREDITS_ENABLED: 'true',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUT_ESCAPE: '4',
            DIRECT_PAYOUT_TREASURE: '3',
            CREDITS_PAYOUT_ESCAPE: '2',
            CREDITS_PAYOUT_TREASURE: '3',
            ALLOW_MAINNET_PAYOUTS: 'true',
            SOLO_ENABLED: 'false',
            TAVERN_ENABLED: 'false',
            MATCH_ENABLED: 'false',
            MATCH_CRYPTO_RACE_ENABLED: 'true',
            MATCH_PAYOUTS_ENABLED: 'true'
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config({
            payouts: {
                enabled: true,
                rules: { direct: { enabled: true }, credits: { enabled: true } }
            }
        }));

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('requires HOSTED_BY=https://monerogue.app'),
            expect.stringContaining('requires OPERATOR_NAME=Such Software'),
            expect.stringContaining('requires OPERATOR_CONTACT_URL=mailto:apps@such.software'),
            expect.stringContaining('requires LEGAL_POLICY_VERSION=2026-07-23-v2'),
            expect.stringContaining('requires TERMS_EFFECTIVE_DATE=2026-07-23'),
            expect.stringContaining('requires MONERO_NETWORK=stagenet'),
            expect.stringContaining('requires GAME_MODE=PAID_SINGLE'),
            expect.stringContaining('requires PAYMENT_MODES=direct'),
            expect.stringContaining('requires CREDITS_ENABLED=false'),
            expect.stringContaining('requires CREDITS_PAYOUTS_ENABLED=false'),
            expect.stringContaining('requires DIRECT_PAYOUT_ESCAPE=2'),
            expect.stringContaining('requires SOLO_ENABLED=true'),
            expect.stringContaining('requires TAVERN_ENABLED=true'),
            expect.stringContaining('requires MATCH_ENABLED=true'),
            expect.stringContaining('requires MATCH_CRYPTO_RACE_ENABLED=false'),
            expect.stringContaining('requires MATCH_PAYOUTS_ENABLED=false'),
            expect.stringContaining('requires ALLOW_MAINNET_PAYOUTS=false')
        ]));
    });

    test('unknown operated profile is rejected while an omitted profile preserves generic MIT hosting', () => {
        expect(new EnvironmentValidator({ env: productionEnv(), logger: silentLogger })
            .validate(config()).errors).toEqual([]);

        const result = new EnvironmentValidator({
            env: productionEnv({ OPERATED_PRODUCT_PROFILE: 'third-party-claim' }),
            logger: silentLogger
        }).validate(config());
        expect(result.errors).toContain(
            'OPERATED_PRODUCT_PROFILE=third-party-claim is unknown. Remove it for an independent MIT deployment or use a reviewed Such Software profile.'
        );
    });

    test('operated identity cannot bypass its exact contract outside production', () => {
        const env = productionEnv({
            NODE_ENV: 'development',
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
            HOSTED_BY: 'http://localhost:3000',
            OPERATOR_NAME: 'Such Software'
        });

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('requires HOSTED_BY=https://play.wowne.ro'),
            expect.stringContaining('requires CRYPTO_TYPE=WOW'),
            expect.stringContaining('requires PAYMENT_MODES=credits')
        ]));
    });

    test('accepts explicitly capped stagenet crypto match payouts', () => {
        const env = productionEnv({
            PAYOUTS_ENABLED: 'true',
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'true',
            MATCH_PAYOUTS_ENABLED: 'true',
            MATCH_PAYOUT_MAX: '50000',
            MATCH_ENTRY_FEE_ATOMIC: '10000',
            MATCH_HOUSE_FEE_PERCENT: '5',
            MATCH_RULESET_ID: 'race',
            MATCH_MAX_PLAYERS: '4'
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger })
            .assertValid(config({
                payouts: { enabled: true },
                products: {
                    cosmetic: [{
                        id: 'race_2',
                        price: 20000n,
                        grants: { race_entries: 2, race_entry_value_atomic: '10000' }
                    }]
                }
            }));

        expect(result.money.matchPayoutsEnabled).toBe(true);
    });

    test.each([
        ['MATCH_PAID_ENTROPY_DELAY_BLOCKS', '1'],
        ['MATCH_PAID_ENTROPY_CONFIRMATIONS', '1'],
        ['MATCH_PAID_ENTROPY_DELAY_BLOCKS', '2.5'],
        ['MATCH_PAID_ENTROPY_CONFIRMATIONS', '9007199254740992'],
        ['MATCH_PAID_ENTROPY_DELAY_BLOCKS', '101']
    ])('rejects unsafe production paid entropy setting %s=%s', (key, value) => {
        const result = new EnvironmentValidator({
            env: productionEnv({ MATCH_ENABLED: 'true', [key]: value }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toContain(
            `${key} must be an explicit safe integer from 2 through 100 when production match mode is enabled.`
        );
    });

    test('rejects crypto co-op and a cap below the configured maximum pot liability', () => {
        const env = productionEnv({
            PAYOUTS_ENABLED: 'true',
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'true',
            MATCH_PAYOUTS_ENABLED: 'true',
            MATCH_PAYOUT_MAX: '100',
            MATCH_ENTRY_FEE_ATOMIC: '10000',
            MATCH_HOUSE_FEE_PERCENT: '5',
            MATCH_RULESET_ID: 'coop-escape',
            MATCH_MAX_PLAYERS: '4'
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger })
            .validate(config({ payouts: { enabled: true } }));

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('single-winner crypto payout semantics'),
            expect.stringContaining('below the configured 4-player winner liability')
        ]));
    });

    test('rejects mismatched or underfunded race-ticket products', () => {
        const env = productionEnv({
            PAYOUTS_ENABLED: 'true',
            MATCH_ENABLED: 'true',
            MATCH_CRYPTO_RACE_ENABLED: 'true',
            MATCH_PAYOUTS_ENABLED: 'true',
            MATCH_PAYOUT_MAX: '50000',
            MATCH_ENTRY_FEE_ATOMIC: '10000',
            MATCH_HOUSE_FEE_PERCENT: '5',
            MATCH_RULESET_ID: 'race',
            MATCH_MAX_PLAYERS: '4'
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config({
            payouts: { enabled: true },
            products: {
                cosmetic: [
                    {
                        id: 'wrong-value',
                        price: 20000n,
                        grants: { race_entries: 2, race_entry_value_atomic: '9000' }
                    },
                    {
                        id: 'underfunded',
                        price: 19999n,
                        grants: { race_entries: 2, race_entry_value_atomic: '10000' }
                    }
                ]
            }
        }));

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('wrong-value backing must equal MATCH_ENTRY_FEE_ATOMIC'),
            expect.stringContaining('underfunded price must fund at least 20000')
        ]));
    });

    test('rejects a 100% or over-precision match house fee', () => {
        for (const value of ['100', '5.555']) {
            const result = new EnvironmentValidator({
                env: productionEnv({ MATCH_HOUSE_FEE_PERCENT: value }),
                logger: silentLogger
            }).validate(config());
            expect(result.errors).toContain(
                'MATCH_HOUSE_FEE_PERCENT must be at least 0 and less than 100.'
            );
        }
    });

    test('missing production secrets and RPC endpoints are fatal', () => {
        const env = productionEnv({
            ADMIN_API_KEY: 'change-me',
            DB_PASSWORD: '',
            PRIMARY_WALLET_ENDPOINT: '',
            PRIMARY_RPC_ENDPOINT: ''
        });
        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('PRIMARY_WALLET_ENDPOINT'),
            expect.stringContaining('PRIMARY_RPC_ENDPOINT'),
            expect.stringContaining('ADMIN_API_KEY'),
            expect.stringContaining('DB_PASSWORD')
        ]));
    });

    test('wallet RPC authentication requires a complete credential pair', () => {
        const result = new EnvironmentValidator({
            env: productionEnv({ WALLET_RPC_USER: 'rpc-user', WALLET_RPC_PASSWORD: '' }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toContain('WALLET_RPC_USER and WALLET_RPC_PASSWORD must be set together.');
    });

    test('production payments reject unauthenticated or remotely exposed wallet RPC', () => {
        const missing = productionEnv({ WALLET_RPC_USER: '', WALLET_RPC_PASSWORD: '' });
        const missingResult = new EnvironmentValidator({ env: missing, logger: silentLogger }).validate(config());
        expect(missingResult.errors).toContain(
            'Production financial workers require WALLET_RPC_USER and WALLET_RPC_PASSWORD for wallet-rpc Digest authentication.'
        );

        const remote = productionEnv({ PRIMARY_WALLET_ENDPOINT: 'http://10.42.1.20:38083' });
        const remoteResult = new EnvironmentValidator({ env: remote, logger: silentLogger }).validate(config());
        expect(remoteResult.errors).toContain(
            'Production wallet-rpc over plaintext HTTP must bind to a loopback address.'
        );
    });

    test('payout-only recovery still requires an authenticated loopback wallet', () => {
        const payoutOnlyConfig = config({
            paymentsEnabled: false,
            modes: {
                direct: { enabled: false },
                credits: { enabled: false, packages: [] }
            },
            payouts: { enabled: true }
        });
        const env = productionEnv({
            PAYMENTS_ENABLED: 'false',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYMENT_ENABLED: 'false',
            CREDITS_ENABLED: 'false',
            MONERO_NETWORK: 'mainnet',
            WALLET_RPC_USER: '',
            WALLET_RPC_PASSWORD: '',
            PRIMARY_WALLET_ENDPOINT: 'http://10.42.1.20:38083'
        });

        const errors = new EnvironmentValidator({ env, logger: silentLogger })
            .validate(payoutOnlyConfig).errors;

        expect(errors).toEqual(expect.arrayContaining([
            expect.stringContaining('Production financial workers require WALLET_RPC_USER'),
            expect.stringContaining('plaintext HTTP must bind to a loopback'),
            expect.stringContaining('ALLOW_MAINNET_PAYOUTS=true')
        ]));

        env.PRIMARY_WALLET_ENDPOINT = '';
        expect(new EnvironmentValidator({ env, logger: silentLogger })
            .validate(payoutOnlyConfig).errors)
            .toEqual(expect.arrayContaining([
                expect.stringContaining('Financial workers require a wallet'),
                expect.stringContaining('PRIMARY_WALLET_ENDPOINT')
            ]));
    });

    test('payout-only recovery cannot bypass the mainnet acknowledgement', () => {
        const payoutOnlyConfig = config({
            paymentsEnabled: false,
            modes: {
                direct: { enabled: false },
                credits: { enabled: false, packages: [] }
            },
            payouts: { enabled: true }
        });
        const env = productionEnv({
            PAYMENTS_ENABLED: 'false',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYMENT_ENABLED: 'false',
            CREDITS_ENABLED: 'false',
            MONERO_NETWORK: 'mainnet'
        });

        const validator = new EnvironmentValidator({ env, logger: silentLogger });
        expect(validator.validate(payoutOnlyConfig).errors).toContain(
            'Mainnet payouts require the explicit safety acknowledgement ALLOW_MAINNET_PAYOUTS=true.'
        );
        env.ALLOW_MAINNET_PAYOUTS = 'true';
        expect(validator.validate(payoutOnlyConfig).errors).toEqual([]);
    });

    test('production requires explicit payout intent instead of dangerous defaults', () => {
        const env = productionEnv();
        delete env.PAYOUTS_ENABLED;
        delete env.DIRECT_PAYOUTS_ENABLED;
        delete env.CREDITS_PAYOUTS_ENABLED;

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('explicit PAYOUTS_ENABLED'),
            expect.stringContaining('explicit DIRECT_PAYOUTS_ENABLED'),
            expect.stringContaining('explicit CREDITS_PAYOUTS_ENABLED')
        ]));
    });

    test('production paid play requires truthful operator metadata and acknowledgement policy', () => {
        const result = new EnvironmentValidator({
            env: productionEnv({
                OPERATOR_NAME: 'CHANGE_ME',
                OPERATOR_CONTACT_URL: 'javascript:alert(1)',
                LEGAL_POLICY_VERSION: '',
                TERMS_EFFECTIVE_DATE: '2026-02-30',
                MINIMUM_AGE: '0',
                PAID_ACKNOWLEDGEMENT_REQUIRED: 'false'
            }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('PAID_ACKNOWLEDGEMENT_REQUIRED=true'),
            expect.stringContaining('LEGAL_POLICY_VERSION'),
            expect.stringContaining('TERMS_EFFECTIVE_DATE'),
            expect.stringContaining('MINIMUM_AGE'),
            expect.stringContaining('OPERATOR_NAME'),
            expect.stringContaining('OPERATOR_CONTACT_URL')
        ]));
    });

    test('rejects misspelled booleans and legacy modes instead of using defaults', () => {
        const env = productionEnv({
            GAME_MODE: 'FRE',
            PAYOUTS_ENABLED: 'flase',
            DIRECT_PAYOUTS_ENABLED: 'treu'
        });

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('GAME_MODE must be'),
            expect.stringContaining('PAYOUTS_ENABLED must be an explicit boolean'),
            expect.stringContaining('DIRECT_PAYOUTS_ENABLED must be an explicit boolean')
        ]));
    });

    test('rejects malformed atomic amounts and payout multipliers', () => {
        const env = productionEnv({
            DIRECT_GAME_PRICE: '0.01 XMR',
            PAYOUT_MAX_PER_GAME: '-1',
            DIRECT_PAYOUT_ESCAPE: 'double'
        });

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());

        expect(result.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('DIRECT_GAME_PRICE must be a non-negative integer'),
            expect.stringContaining('PAYOUT_MAX_PER_GAME must be a non-negative integer'),
            expect.stringContaining('DIRECT_PAYOUT_ESCAPE must be a finite number')
        ]));
    });

    test('rejects unknown payment modes instead of silently disabling them', () => {
        const result = new EnvironmentValidator({
            env: productionEnv({ PAYMENT_MODES: 'direct,magic' }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toContain('PAYMENT_MODES must contain only direct and/or credits.');
    });

    test('rejects an invalid trusted-proxy hop count', () => {
        const result = new EnvironmentValidator({
            env: productionEnv({ TRUST_PROXY_HOPS: 'all' }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toContain('TRUST_PROXY_HOPS must be an integer from 1 through 8.');
    });

    test('mainnet payout dispatch needs a deliberate acknowledgement', () => {
        const payoutConfig = config({
            payouts: {
                enabled: true,
                rules: { direct: { enabled: true }, credits: { enabled: true } }
            }
        });
        const env = productionEnv({
            MONERO_NETWORK: 'mainnet',
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'true'
        });
        const validator = new EnvironmentValidator({ env, logger: silentLogger });

        expect(validator.validate(payoutConfig).errors)
            .toContain('Mainnet payouts require the explicit safety acknowledgement ALLOW_MAINNET_PAYOUTS=true.');

        env.ALLOW_MAINNET_PAYOUTS = 'true';
        expect(validator.validate(payoutConfig).errors).toEqual([]);
    });

    test('stagenet 2x/3x payouts do not require the mainnet acknowledgement', () => {
        const payoutConfig = config({
            payouts: {
                enabled: true,
                rules: { direct: { enabled: true }, credits: { enabled: true } }
            }
        });
        const env = productionEnv({
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'true'
        });

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(payoutConfig);
        expect(result.errors).toEqual([]);
        expect(result.money.payoutsEnabled).toBe(true);
    });

    test('rejects direct 3x above cap and credits 2x below minimum', () => {
        const env = productionEnv({
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            CREDITS_PAYOUTS_ENABLED: 'true'
        });
        const payoutConfig = config({
            modes: { direct: { enabled: true, price: 20000n } },
            payouts: {
                enabled: true,
                rules: {
                    direct: { enabled: true, maxPayout: 50000n },
                    credits: { enabled: true, baseValue: 1000n, minPayout: 3000n }
                }
            }
        });

        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(payoutConfig);

        expect(result.errors).toEqual(expect.arrayContaining([
            'Direct escapeWithTreasure payout (60000 atomic units) exceeds its configured maximum (50000).',
            'Credits escape payout (2000 atomic units) is below its configured minimum (3000).'
        ]));
    });

    test('payout launch gate requires a reserve that covers the largest accepted liability', () => {
        const payoutConfig = config({
            payouts: {
                enabled: true,
                rules: { direct: { enabled: true }, credits: { enabled: false } }
            }
        });
        const missing = productionEnv({
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            PAYOUT_MAX_PER_GAME: '60000',
            BALANCE_CRITICAL: '',
            BALANCE_WARN: ''
        });
        expect(new EnvironmentValidator({ env: missing, logger: silentLogger })
            .validate(payoutConfig).errors).toEqual(expect.arrayContaining([
            expect.stringContaining('BALANCE_CRITICAL must be an explicit positive'),
            expect.stringContaining('BALANCE_WARN must be an explicit positive')
        ]));

        const underfunded = productionEnv({
            PAYOUTS_ENABLED: 'true',
            DIRECT_PAYOUTS_ENABLED: 'true',
            PAYOUT_MAX_PER_GAME: '60000',
            BALANCE_CRITICAL: '59999',
            BALANCE_WARN: '59998'
        });
        expect(new EnvironmentValidator({ env: underfunded, logger: silentLogger })
            .validate(payoutConfig).errors).toEqual(expect.arrayContaining([
            expect.stringContaining('BALANCE_CRITICAL must be at least PAYOUT_MAX_PER_GAME (60000'),
            expect.stringContaining('BALANCE_WARN must be greater than or equal to BALANCE_CRITICAL')
        ]));
    });

    test.each([
        ['BLOCK_SOURCE', 'simulated'],
        ['SIMULATED_BLOCKS', 'true'],
        ['FORCE_SIMULATED_BLOCKS', 'true']
    ])('rejects production simulation via %s', (key, value) => {
        const result = new EnvironmentValidator({
            env: productionEnv({ [key]: value }),
            logger: silentLogger
        }).validate(config());

        expect(result.errors).toContain('Simulated blocks are forbidden when NODE_ENV=production.');
    });

    test('assertValid throws a typed error for startup to fail closed', () => {
        const validator = new EnvironmentValidator({
            env: productionEnv({ ADMIN_API_KEY: 'weak' }),
            logger: silentLogger
        });

        expect(() => validator.assertValid(config())).toThrow(expect.objectContaining({
            name: 'EnvironmentValidationError',
            code: 'INVALID_ENVIRONMENT'
        }));
    });
});

describe('EnvironmentValidator development ergonomics', () => {
    test('missing wallet/daemon endpoints warn without hard-stopping development', () => {
        const env = { NODE_ENV: 'development', CRYPTO_TYPE: 'XMR', MONERO_NETWORK: 'stagenet' };
        const result = new EnvironmentValidator({ env, logger: silentLogger }).validate(config());

        expect(result.errors).toEqual([]);
        expect(result.warnings.some(message => message.includes('PRIMARY_WALLET_ENDPOINT'))).toBe(true);
        expect(result.warnings.some(message => message.includes('PRIMARY_RPC_ENDPOINT'))).toBe(true);
    });
});
