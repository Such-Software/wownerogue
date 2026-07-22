const STORAGE_KEY = 'wowngeon_paid_ack';

function policy(version, isTestNetwork = false) {
    return {
        policyVersion: version,
        paidAcknowledgementRequired: true,
        minimumAge: 18,
        service: {
            isTestNetwork,
            currencyLabel: isTestNetwork ? 'sXMR' : 'WOW',
            cryptoType: isTestNetwork ? 'XMR' : 'WOW'
        },
        links: { terms: '/terms', privacy: '/privacy', responsiblePlay: '/responsible-play' }
    };
}

function response(value) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(value) });
}

describe('browser commerce acknowledgement cache', () => {
    let values;

    beforeEach(() => {
        jest.resetModules();
        values = new Map();
        global.sessionStorage = {
            getItem: jest.fn(key => values.has(key) ? values.get(key) : null),
            setItem: jest.fn((key, value) => values.set(key, value)),
            removeItem: jest.fn(key => values.delete(key))
        };
        global.fetch = jest.fn();
        delete global.CommerceConsent;
    });

    afterEach(() => {
        delete global.fetch;
        delete global.sessionStorage;
        delete global.CommerceConsent;
    });

    test('accepts only the five-field canonical cache and clears extra data', async () => {
        global.fetch.mockReturnValueOnce(response(policy('browser-v1')));
        const consent = require('../html/js/legal/commerceConsent');
        await consent.loadPolicy();
        values.set(STORAGE_KEY, JSON.stringify({
            policyVersion: 'browser-v1',
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: false,
            acknowledgedAt: 'must-not-be-stored'
        }));

        expect(consent.acknowledgement()).toBeNull();
        expect(values.has(STORAGE_KEY)).toBe(false);
    });

    test('server version rejection clears acceptance and refetches current policy', async () => {
        global.fetch
            .mockReturnValueOnce(response(policy('browser-v1')))
            .mockReturnValueOnce(response(policy('browser-v2')));
        const consent = require('../html/js/legal/commerceConsent');
        await consent.loadPolicy();
        values.set(STORAGE_KEY, JSON.stringify({
            policyVersion: 'browser-v1',
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: false
        }));
        expect(consent.acknowledgement()).toEqual(expect.objectContaining({ policyVersion: 'browser-v1' }));

        const refreshed = await consent.reject({ code: 'PAID_ACK_VERSION', policyVersion: 'browser-v2' });

        expect(refreshed.policyVersion).toBe('browser-v2');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(consent.acknowledgement()).toBeNull();
        expect(values.has(STORAGE_KEY)).toBe(false);
    });

    test('disconnect-facing clear removes both memory and session copies', async () => {
        global.fetch.mockReturnValueOnce(response(policy('browser-v1')));
        const consent = require('../html/js/legal/commerceConsent');
        await consent.loadPolicy();
        values.set(STORAGE_KEY, JSON.stringify({
            policyVersion: 'browser-v1',
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: false
        }));
        expect(consent.acknowledgement()).not.toBeNull();

        consent.clear();

        expect(consent.acknowledgement()).toBeNull();
        expect(values.has(STORAGE_KEY)).toBe(false);
    });
});
