const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');
const { renderPrivacy, renderResponsiblePlay, renderTerms } = require('../src/views/legalPages');

function disclosure(overrides = {}) {
    const manager = {
        cryptoType: 'WOW', currencyLabel: 'WOW', network: 'mainnet', isTestNetwork: false,
        gameName: '<script>bad</script>', paymentsEnabled: true, freePlayEnabled: true,
        directModeEnabled: true, creditsModeEnabled: true, payoutsEnabled: false,
        isPayoutEnabledForMode: () => false
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
});
