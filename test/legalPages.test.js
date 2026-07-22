const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');
const { renderPrivacy, renderResponsiblePlay, renderTerms } = require('../src/views/legalPages');

function disclosure(overrides = {}, managerOverrides = {}) {
    const manager = {
        cryptoType: 'WOW', currencyLabel: 'WOW', network: 'mainnet', isTestNetwork: false,
        gameName: '<script>bad</script>', paymentsEnabled: true, freePlayEnabled: true,
        directModeEnabled: true, creditsModeEnabled: true, payoutsEnabled: false,
        isPayoutEnabledForMode: () => false,
        ...managerOverrides
    };
    return buildCommerceDisclosure(manager, {
        NODE_ENV: 'production', LEGAL_POLICY_VERSION: 'v1', TERMS_EFFECTIVE_DATE: '2026-07-21',
        MINIMUM_AGE: '18', PAID_ACKNOWLEDGEMENT_REQUIRED: 'true',
        OPERATOR_NAME: '<img src=x onerror=alert(1)>',
        OPERATOR_CONTACT_URL: 'javascript:alert(1)',
        ...overrides
    });
}

describe('production disclosure pages', () => {
    test.each([
        ['terms', renderTerms, 'Paid prestige mode'],
        ['privacy', renderPrivacy, 'random browser session token'],
        ['responsible play', renderResponsiblePlay, 'automated self-exclusion system']
    ])('%s page is mode-aware, complete, and HTML-escapes operator data', (_name, render, expected) => {
        const html = render(disclosure());
        expect(html).toContain(expected);
        expect(html).toContain('/responsible-play');
        expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<script>bad</script>');
        expect(html).not.toContain('href="javascript:');
    });

    test('terms state the exact solo and PvP leaderboard mappings', () => {
        const html = renderTerms(disclosure());
        expect(html).toContain('FREE runs use the Pleb board');
        expect(html).toContain('PAID_SINGLE and PAID_CREDITS runs use the Hall of Champions');
        expect(html).toContain('credits_prestige matches use the Prestige board');
        expect(html).toContain('crypto_race matches use the Hall of Champions');
    });

    test('generic self-hosted pages carry the MIT conditions and third-party operator disclaimer', () => {
        const html = renderTerms(disclosure());
        expect(html).toContain('Independent deployment');
        expect(html).toContain('solely responsible for its deployment');
        expect(html).toContain('does not make that deployment a Such Software service');
        expect(html).toContain('does not operate, supervise, endorse, or accept responsibility');
        expect(html).toContain('copyright and permission notice');
        expect(html).toContain('AS IS');
        expect(html).toContain('not legal advice');
        expect(html).toContain('operates only play.wowne.ro and monerogue.app');
    });

    test('play.wowne.ro pages state credits-only prestige and the no-payout product positioning', () => {
        const html = renderTerms(disclosure({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige'
        }, {
            directModeEnabled: false,
            creditsModeEnabled: true
        }));

        expect(html).toContain('Such Software');
        expect(html).toContain('apps@such.software');
        expect(html).toContain('pay-for-credits leaderboard/prestige play');
        expect(html).toContain('offers no prizes, winnings, cash-out, or payouts');
        expect(html).toContain('not offered or marketed as gambling');
        expect(html).toContain('legal classification depends on applicable law');
        expect(html).not.toContain('NO REAL VALUE');
    });

    test('monerogue.app pages conspicuously state stagenet 2x/3x test gambling has no real value', () => {
        const html = renderResponsiblePlay(disclosure({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet'
        }, {
            cryptoType: 'XMR',
            currencyLabel: 'sXMR',
            network: 'stagenet',
            isTestNetwork: true,
            payoutsEnabled: true,
            isPayoutEnabledForMode: () => true
        }));

        expect(html).toContain('single-player 2×/3× outcomes are test gambling mechanics');
        expect(html).toContain('NO REAL VALUE');
        expect(html).toContain('Never send mainnet XMR');
        expect(html).toContain('no real-money or mainnet gambling is offered');
    });
});
