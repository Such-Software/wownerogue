const {
    buildCommerceDisclosure,
    safeContactUrl,
    validatePaidAcknowledgement
} = require('../src/config/commerceDisclosurePolicy');
const PaymentHandlers = require('../src/network/paymentHandlers');

function manager(overrides = {}) {
    return {
        cryptoType: 'XMR',
        currencyLabel: 'sXMR',
        network: 'stagenet',
        isTestNetwork: true,
        gameName: 'Monerogue',
        paymentsEnabled: true,
        freePlayEnabled: true,
        directModeEnabled: true,
        creditsModeEnabled: true,
        payoutsEnabled: true,
        isPayoutEnabledForMode: mode => mode === 'PAID_SINGLE',
        ...overrides
    };
}

function env(overrides = {}) {
    return {
        NODE_ENV: 'production',
        LEGAL_POLICY_VERSION: '2026-07-21-v1',
        TERMS_EFFECTIVE_DATE: '2026-07-21',
        MINIMUM_AGE: '21',
        PAID_ACKNOWLEDGEMENT_REQUIRED: 'true',
        OPERATOR_NAME: 'Test Operator',
        OPERATOR_CONTACT_URL: 'mailto:support@example.invalid',
        MATCH_ENABLED: 'false',
        ...overrides
    };
}

describe('commerce disclosure and paid-action policy', () => {
    test('describes active test-network payout mode without conflating it with mainnet', () => {
        const disclosure = buildCommerceDisclosure(manager(), env());

        expect(disclosure).toEqual(expect.objectContaining({
            policyVersion: '2026-07-21-v1',
            minimumAge: 21,
            paidAcknowledgementRequired: true
        }));
        expect(disclosure.service).toEqual(expect.objectContaining({
            network: 'stagenet',
            isTestNetwork: true,
            paidPrestigeOnly: false,
            soloPayoutsEnabled: true
        }));
    });

    test('publishes the immutable play.wowne.ro scope and Such Software identity', () => {
        const disclosure = buildCommerceDisclosure(manager({
            cryptoType: 'WOW',
            currencyLabel: 'WOW',
            network: 'mainnet',
            isTestNetwork: false,
            directModeEnabled: false,
            creditsModeEnabled: true,
            payoutsEnabled: false,
            isPayoutEnabledForMode: () => false
        }), env({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
            OPERATOR_NAME: 'untrusted override',
            OPERATOR_CONTACT_URL: 'mailto:untrusted@example.invalid'
        }));

        expect(disclosure.operator).toEqual({
            name: 'Such Software',
            contactUrl: 'mailto:apps@such.software',
            contactLabel: 'apps@such.software'
        });
        expect(disclosure.operatedProduct).toEqual(expect.objectContaining({
            id: 'such-play-wow-prestige',
            hostname: 'play.wowne.ro',
            noRealValueNotice: null
        }));
        expect(disclosure.operatedProduct.scopeNotice).toContain('pay-for-credits leaderboard/prestige');
        expect(disclosure.operatedProduct.scopeNotice).toContain('offers no prizes, winnings, cash-out, or payouts');
        expect(disclosure.operatedProduct.scopeNotice).toContain('not offered or marketed as gambling');
        expect(disclosure.operatedProduct.scopeNotice).toContain('legal classification depends on applicable law');
    });

    test('publishes conspicuous no-real-value monerogue.app scope and MIT operator boundary', () => {
        const disclosure = buildCommerceDisclosure(manager({
            creditsModeEnabled: false
        }), env({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet'
        }));

        expect(disclosure.operatedProduct.scopeNotice).toContain('single-player 2×/3× outcomes are test gambling mechanics');
        expect(disclosure.operatedProduct.noRealValueNotice).toContain('NO REAL VALUE');
        expect(disclosure.operatedProduct.commerceSummary).toMatch(/never send mainnet XMR/i);
        expect(disclosure.operatedProduct.commerceSummary).toContain('Purchased-credit entry');
        expect(disclosure.service.paidCreditsEnabled).toBe(false);
        expect(disclosure.service.cryptoMatchPayoutsEnabled).toBe(false);
        expect(disclosure.software).toEqual(expect.objectContaining({
            license: 'MIT',
            publisherName: 'Such Software'
        }));
        expect(disclosure.software.rightsNotice).toContain('copyright and permission notice');
        expect(disclosure.software.warrantyNotice).toContain('AS IS');
        expect(disclosure.software.legalAdviceNotice).toContain('not legal advice');
        expect(disclosure.software.thirdPartyNotice).toContain('solely responsible');
        expect(disclosure.software.thirdPartyNotice).toContain('does not make that deployment a Such Software service');
        expect(disclosure.software.thirdPartyNotice).toContain('does not operate, supervise, endorse, or accept responsibility');
    });

    test('an unprofiled deployment remains generic and is not represented as Such-operated', () => {
        const disclosure = buildCommerceDisclosure(manager(), env());
        expect(disclosure.operatedProduct).toBeNull();
        expect(disclosure.operator.name).toBe('Test Operator');
        expect(disclosure.software.operatedBoundaryNotice).toContain('operates only play.wowne.ro and monerogue.app');
    });

    test('describes paid prestige separately when every payout path is off', () => {
        const disclosure = buildCommerceDisclosure(manager({
            cryptoType: 'WOW', currencyLabel: 'WOW', network: 'mainnet', isTestNetwork: false,
            payoutsEnabled: false, isPayoutEnabledForMode: () => false
        }), env());

        expect(disclosure.service.paidPrestigeOnly).toBe(true);
        expect(disclosure.service.anyPayoutsEnabled).toBe(false);
    });

    test('does not advertise a stale solo payout flag when that paid mode is disabled', () => {
        const disclosure = buildCommerceDisclosure(manager({
            directModeEnabled: false,
            creditsModeEnabled: true,
            isPayoutEnabledForMode: mode => mode === 'PAID_SINGLE'
        }), env());

        expect(disclosure.service.directPaidEntryEnabled).toBe(false);
        expect(disclosure.service.paidCreditsEnabled).toBe(true);
        expect(disclosure.service.soloPayoutsEnabled).toBe(false);

        const activeCreditsPayout = buildCommerceDisclosure(manager({
            directModeEnabled: false,
            creditsModeEnabled: true,
            isPayoutEnabledForMode: mode => mode === 'PAID_CREDITS'
        }), env());
        expect(activeCreditsPayout.service.soloPayoutsEnabled).toBe(true);

        const noPaidModes = buildCommerceDisclosure(manager({
            directModeEnabled: false,
            creditsModeEnabled: false,
            isPayoutEnabledForMode: () => true
        }), env());
        expect(noPaidModes.service.soloPayoutsEnabled).toBe(false);
        expect(noPaidModes.service.anyPayoutsEnabled).toBe(false);
    });

    test('fails closed on missing, stale, incomplete, or testnet-unaware acknowledgement', () => {
        const disclosure = buildCommerceDisclosure(manager(), env());
        const good = {
            policyVersion: disclosure.policyVersion,
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: true
        };

        expect(validatePaidAcknowledgement(null, disclosure).ok).toBe(false);
        expect(validatePaidAcknowledgement({ ...good, policyVersion: 'old' }, disclosure).code).toBe('PAID_ACK_VERSION');
        expect(validatePaidAcknowledgement({ ...good, riskAccepted: false }, disclosure).code).toBe('PAID_ACK_INCOMPLETE');
        expect(validatePaidAcknowledgement({ ...good, testnetUnderstood: false }, disclosure).code).toBe('PAID_ACK_TESTNET');
        expect(validatePaidAcknowledgement({ ...good, extra: true }, disclosure).code).toBe('PAID_ACK_MALFORMED');
        expect(validatePaidAcknowledgement({
            policyVersion: disclosure.policyVersion,
            ageEligible: true,
            termsRead: true,
            riskAccepted: true
        }, disclosure).code).toBe('PAID_ACK_MALFORMED');
        expect(validatePaidAcknowledgement(good, disclosure)).toEqual({
            ok: true,
            code: 'ACKNOWLEDGED',
            acknowledgement: Object.freeze(good)
        });
    });

    test('mainnet acknowledgement is canonical and carries an explicit false testnet flag', () => {
        const disclosure = buildCommerceDisclosure(manager({
            cryptoType: 'WOW',
            currencyLabel: 'WOW',
            network: 'mainnet',
            isTestNetwork: false
        }), env());
        const good = {
            policyVersion: disclosure.policyVersion,
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: false
        };

        expect(validatePaidAcknowledgement(good, disclosure)).toEqual({
            ok: true,
            code: 'ACKNOWLEDGED',
            acknowledgement: Object.freeze(good)
        });
        expect(validatePaidAcknowledgement({ ...good, testnetUnderstood: true }, disclosure).code)
            .toBe('PAID_ACK_MALFORMED');
    });

    test('keeps acknowledgement UI enabled for paid match entitlements while invoice intake is off', () => {
        const disclosure = buildCommerceDisclosure(manager({
            paymentsEnabled: false,
            directModeEnabled: false,
            creditsModeEnabled: false,
            freePlayEnabled: true,
            _getMatchEconomies: () => ({ free: true, credits_prestige: true })
        }), env({ PAID_ACKNOWLEDGEMENT_REQUIRED: 'false', MATCH_ENABLED: 'true' }));

        expect(disclosure.service.paymentsEnabled).toBe(false);
        expect(disclosure.paidAcknowledgementRequired).toBe(true);
    });

    test('allows no acknowledgement only where the policy is actually disabled', () => {
        const disclosure = buildCommerceDisclosure(manager({
            paymentsEnabled: false,
            directModeEnabled: false,
            creditsModeEnabled: false,
            freePlayEnabled: false
        }), {
            NODE_ENV: 'test', PAID_ACKNOWLEDGEMENT_REQUIRED: 'false'
        });
        expect(validatePaidAcknowledgement(null, disclosure)).toEqual({
            ok: true, code: 'NOT_REQUIRED', acknowledgement: null
        });
    });

    test('contact URLs reject executable and unrelated schemes', () => {
        expect(safeContactUrl('javascript:alert(1)')).toBeNull();
        expect(safeContactUrl('data:text/html,boom')).toBeNull();
        expect(safeContactUrl('mailto:support@example.invalid')).toBe('mailto:support@example.invalid');
        expect(safeContactUrl('https://example.invalid/support')).toBe('https://example.invalid/support');
    });

    test('payment handler refuses an invoice before wallet or database work when acknowledgement is absent', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        const previousVersion = process.env.LEGAL_POLICY_VERSION;
        process.env.NODE_ENV = 'production';
        process.env.LEGAL_POLICY_VERSION = 'server-enforcement-v1';
        const emit = jest.fn();
        const createPaymentRequest = jest.fn();
        const handler = new PaymentHandlers({
            io: { to: () => ({ emit }) },
            gameModeManager: {
                ...manager({ isTestNetwork: false, network: 'mainnet' }),
                createPaymentRequest,
                isPayoutEnabledForMode: () => false
            },
            walletService: {},
            debugManager: { CONSOLE_LOGGING: false },
            queueManager: {},
            broadcastManager: { sendStatusUpdate: jest.fn() },
            sessionManager: null
        });
        try {
            await handler.handlePaymentRequest({ id: 'socket-1' }, { type: 'single_game' });
            expect(createPaymentRequest).not.toHaveBeenCalled();
            expect(emit).toHaveBeenCalledWith('commerce_ack_required', expect.objectContaining({
                code: 'PAID_ACK_REQUIRED', policyVersion: 'server-enforcement-v1'
            }));
            expect(emit).toHaveBeenCalledWith('payment_error', expect.objectContaining({
                code: 'PAID_ACK_REQUIRED'
            }));
        } finally {
            handler.dispose();
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousNodeEnv;
            if (previousVersion === undefined) delete process.env.LEGAL_POLICY_VERSION;
            else process.env.LEGAL_POLICY_VERSION = previousVersion;
        }
    });
});
