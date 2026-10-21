const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const appRequire = require('./helpers/appRequire');
const { selectPublicPaidModeDescriptors } = require('../src/config/operatedProductProfiles');
const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');
const { renderTerms } = require('../src/views/legalPages');
const GameModeManager = require('../src/game/gameModeManager');
const MatchQueue = require('../src/network/matchQueue');

const root = path.join(__dirname, '..');
const template = appRequire('dotenv').parse(fs.readFileSync(path.join(root, 'src/.env.mainnet.example')));

function closedEnv() {
    return {
        ...template,
        PAYMENTS_ENABLED: 'false',
        GAME_MODE: 'FREE',
        PAYMENT_MODES: '',
        CREDITS_ENABLED: 'false',
        EARLY_ENTRY_CREDITS_MODE: 'false',
        FINANCIAL_EVENT_SINK_URL: '',
        FINANCIAL_EVENT_SINK_TOKEN: '',
        DB_PASSWORD: crypto.randomBytes(32).toString('hex'),
        ADMIN_API_KEY: crypto.randomBytes(32).toString('hex'),
        WALLET_RPC_PASSWORD: crypto.randomBytes(32).toString('hex')
    };
}

function preflight(env) {
    return spawnSync(process.execPath, [path.join(root, 'src/scripts/preflight.js')], {
        cwd: root, env, encoding: 'utf8', timeout: 10000
    });
}

describe('official WOW payments pause', () => {
    test('the exact closed contract passes real production preflight without exposing secrets', () => {
        const env = closedEnv();
        const result = preflight(env);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('paid modes: none');
        expect(result.stdout).toContain('free play: enabled');
        expect(result.stdout).toContain('payout dispatch: disabled');
        for (const key of ['DB_PASSWORD', 'ADMIN_API_KEY', 'WALLET_RPC_PASSWORD']) {
            expect((result.stdout + result.stderr).includes(env[key])).toBe(false);
        }
    });

    test.each([
        ['PAYMENTS_ENABLED', undefined],
        ['PAYMENTS_ENABLED', 'disabled'],
        ['GAME_MODE', undefined],
        ['GAME_MODE', 'PAID_CREDITS'],
        ['PAYMENT_MODES', undefined],
        ['PAYMENT_MODES', 'credits'],
        ['DIRECT_PAYMENT_ENABLED', 'true'],
        ['CREDITS_ENABLED', 'true'],
        ['PAYOUTS_ENABLED', 'true'],
        ['DIRECT_PAYOUTS_ENABLED', 'true'],
        ['CREDITS_PAYOUTS_ENABLED', 'true'],
        ['CREDITS_PAYOUT_ENABLED', 'true'],
        ['EARLY_ENTRY_CREDITS_MODE', 'true'],
        ['EARLY_ENTRY_CREDITS_MODE', undefined],
        ['MATCH_CRYPTO_RACE_ENABLED', 'true'],
        ['MATCH_PAYOUTS_ENABLED', 'true'],
        ['HOSTED_BY', 'https://other.invalid'],
        ['MONERO_NETWORK', 'stagenet'],
        ['FREE_PLAY_ENABLED', 'false'],
        ['TAVERN_ENABLED', 'false'],
        ['MATCH_ENABLED', 'false'],
        ['FINANCIAL_EVENT_SINK_URL', 'https://ledger.invalid/events'],
        ['FINANCIAL_EVENT_SINK_TOKEN', () => crypto.randomBytes(32).toString('hex')]
    ])('refuses a drifted closed contract at %s', (key, candidate) => {
        const env = closedEnv();
        const value = typeof candidate === 'function' ? candidate() : candidate;
        if (value === undefined) delete env[key];
        else env[key] = value;
        const result = preflight(env);
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(key);
        for (const secretKey of ['DB_PASSWORD', 'ADMIN_API_KEY', 'WALLET_RPC_PASSWORD']) {
            expect((result.stdout + result.stderr).includes(env[secretKey])).toBe(false);
        }
        if (key === 'FINANCIAL_EVENT_SINK_TOKEN') {
            expect((result.stdout + result.stderr).includes(value)).toBe(false);
        }
    });

    test('public descriptors and disclosures describe only currently available free play', () => {
        const env = closedEnv();
        expect(selectPublicPaidModeDescriptors(env, {
            PAID_CREDITS: { enabled: true, cost: 1 }
        })).toEqual({});
        env.MATCH_CRYPTO_RACE_ENABLED = 'true';
        env.MATCH_PAYOUTS_ENABLED = 'true';
        const disclosure = buildCommerceDisclosure({
            cryptoType: 'WOW', network: 'mainnet', freePlayEnabled: true,
            paymentsEnabled: true, directModeEnabled: true, creditsModeEnabled: true,
            payoutsEnabled: true
        }, env);
        expect(disclosure.operatedProduct.availabilityNotice).toMatch(/free play/i);
        expect(disclosure.operatedProduct.commerceSummary).toMatch(/unavailable/i);
        expect(renderTerms(disclosure)).toContain('Current availability');
        expect(disclosure.service.paidCreditsEnabled).toBe(false);
        expect(disclosure.service.directPaidEntryEnabled).toBe(false);
        expect(disclosure.service.cryptoMatchPayoutsEnabled).toBe(false);
    });

    test('a stale credits flag cannot advertise or admit a prestige queue', async () => {
        const keys = ['OPERATED_PRODUCT_PROFILE', 'PAYMENTS_ENABLED', 'MATCH_ENABLED',
            'MATCH_CRYPTO_RACE_ENABLED', 'MATCH_PAYOUTS_ENABLED', 'CREDITS_PER_GAME',
            'CREDITS_PER_PACKAGE', 'SINGLE_GAME_PRICE', 'CREDITS_PACKAGE_PRICE',
            'CREDITS_PAYOUT_ENABLED', 'CREDITS_PAYOUTS_ENABLED', 'GAME_MODE'];
        const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            Object.assign(process.env, {
                OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige',
                PAYMENTS_ENABLED: 'false', MATCH_ENABLED: 'true',
                MATCH_CRYPTO_RACE_ENABLED: 'false', MATCH_PAYOUTS_ENABLED: 'false'
            });
            const manager = new GameModeManager(null, null, { CONSOLE_LOGGING: false });
            manager.paymentsEnabled = true;
            manager.directModeEnabled = true;
            manager.creditsModeEnabled = true;
            expect(manager._getMatchEconomies()).toEqual({ free: true });
            expect(manager.getGameModeInfo()).toMatchObject({
                mode: 'FREE', paymentsEnabled: false, creditsModeEnabled: false,
                creditPackages: [], cosmeticProducts: [],
                modes: { match: { economies: { free: true } } }
            });
            expect(manager.getPublicPreferredPaymentMode({ preferred_payment_mode: 'credits' })).toBe('free');
            expect(manager.getEffectiveModeForUser({ credits: 100 })).toMatchObject({
                mode: 'FREE', canUseCredits: false, canUseDirect: false
            });
            expect(manager.isPaymentIntakeEnabled('credits_package')).toBe(false);
            manager.getOrCreateUser = jest.fn().mockResolvedValue({ id: 1, credits: 100 });
            const options = await manager.getPaymentOptionsForUser('s');
            expect(options.options.length).toBeGreaterThan(0);
            expect(options.options.every(option => option.mode === 'FREE')).toBe(true);
            expect(await manager.processGameStart('s', 'game')).toMatchObject({
                success: true, effectiveMode: 'FREE'
            });
            const db = { query: jest.fn(), withTransaction: jest.fn() };
            const queue = new MatchQueue({ db, gameModeManager: manager });
            queue.initialized = true;
            expect(queue.isEconomyAvailable('free')).toBe(true);
            const result = await queue.join({ userId: 1, socketId: 's', sessionToken: 't', economy: 'credits_prestige' });
            expect(result).toMatchObject({ success: false, reason: 'economy_disabled' });
            expect(db.query).not.toHaveBeenCalled();
            expect(db.withTransaction).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            for (const key of keys) {
                if (original[key] === undefined) delete process.env[key];
                else process.env[key] = original[key];
            }
        }
    });
});
