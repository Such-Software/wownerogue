const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const appRequire = require('./helpers/appRequire');
const dotenv = appRequire('dotenv');

const ROOT = path.join(__dirname, '..');

function parseExample(name) {
    const contents = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8');
    return Object.fromEntries(contents.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        return match ? [[match[1], match[2]]] : [];
    }));
}

function preflightExample(name) {
    const contents = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8');
    const env = {
        ...dotenv.parse(contents),
        DB_PASSWORD: '6f4d9b8270e1c35aa96d2408b75f13ce59a0472d7e86c914',
        ADMIN_API_KEY: 'b12f078ce49d6a3510ef7b29d8435ca6982e04f17bd6593c',
        WALLET_RPC_PASSWORD: '8ce2b970a64d1f35e0897c42db6513fa724eb960d18c53a7'
    };
    return spawnSync(process.execPath, [path.join(ROOT, 'src', 'scripts', 'preflight.js')], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 10000
    });
}

describe('operated product environment templates', () => {
    test('play.wowne.ro is exactly credits-only Wownero prestige with every payout path off', () => {
        const env = parseExample('.env.mainnet.example');

        expect(env).toEqual(expect.objectContaining({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
            HOSTED_BY: 'https://play.wowne.ro',
            OPERATOR_NAME: 'Such Software',
            OPERATOR_CONTACT_URL: 'mailto:apps@such.software',
            OPERATOR_CONTACT_LABEL: 'apps@such.software',
            LEGAL_POLICY_VERSION: '2026-07-22-v1',
            TERMS_EFFECTIVE_DATE: '2026-07-22',
            MINIMUM_AGE: '18',
            PAID_ACKNOWLEDGEMENT_REQUIRED: 'true',
            CRYPTO_TYPE: 'WOW',
            MONERO_NETWORK: 'mainnet',
            FREE_PLAY_ENABLED: 'true',
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
        }));
    });

    test('monerogue.app is exactly direct-only stagenet 2x/3x solo testing', () => {
        const env = parseExample('.env.stagenet.example');

        expect(env).toEqual(expect.objectContaining({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet',
            HOSTED_BY: 'https://monerogue.app',
            OPERATOR_NAME: 'Such Software',
            OPERATOR_CONTACT_URL: 'mailto:apps@such.software',
            OPERATOR_CONTACT_LABEL: 'apps@such.software',
            LEGAL_POLICY_VERSION: '2026-07-23-v2',
            TERMS_EFFECTIVE_DATE: '2026-07-23',
            MINIMUM_AGE: '18',
            PAID_ACKNOWLEDGEMENT_REQUIRED: 'true',
            CRYPTO_TYPE: 'XMR',
            MONERO_NETWORK: 'stagenet',
            FREE_PLAY_ENABLED: 'true',
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
        }));
        expect(BigInt(env.PAYOUT_MAX_PER_GAME)).toBeGreaterThanOrEqual(
            3n * BigInt(env.DIRECT_GAME_PRICE)
        );
        expect(env.COSMETIC_PRODUCTS).toBeUndefined();
    });

    test('the generic MIT self-hosting template does not opt into a Such Software profile', () => {
        const env = parseExample('.env.example');
        expect(env.OPERATED_PRODUCT_PROFILE).toBeUndefined();
    });

    test.each([
        ['.env.mainnet.example', 'paid modes: credits'],
        ['.env.stagenet.example', 'paid modes: direct']
    ])('%s passes the real production preflight after only secret substitution', (name, summary) => {
        const result = preflightExample(name);
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
        expect(result.stdout).toContain('Production configuration preflight passed');
        expect(result.stdout).toContain(summary);
    });
});
