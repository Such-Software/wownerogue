const {
    selectPublicPaidModeDescriptors
} = require('../src/config/operatedProductProfiles');

const descriptors = Object.freeze({
    PAID_SINGLE: Object.freeze({ enabled: true, name: 'Paid Single Game' }),
    PAID_CREDITS: Object.freeze({ enabled: true, name: 'Credits Package' })
});

describe('operated-product public paid-mode contract', () => {
    test('play.wowne.ro publishes credits and omits direct entry', () => {
        const result = selectPublicPaidModeDescriptors({
            OPERATED_PRODUCT_PROFILE: 'such-play-wow-prestige'
        }, descriptors);

        expect(result).toEqual({ PAID_CREDITS: descriptors.PAID_CREDITS });
        expect(result).not.toHaveProperty('PAID_SINGLE');
    });

    test('monerogue.app publishes direct entry and omits purchased credits', () => {
        const result = selectPublicPaidModeDescriptors({
            OPERATED_PRODUCT_PROFILE: 'such-monerogue-stagenet'
        }, descriptors);

        expect(result).toEqual({ PAID_SINGLE: descriptors.PAID_SINGLE });
        expect(result).not.toHaveProperty('PAID_CREDITS');
    });

    test('generic MIT deployments retain both legacy API descriptors', () => {
        const result = selectPublicPaidModeDescriptors({}, descriptors);

        expect(result).toEqual(descriptors);
        expect(result).not.toBe(descriptors);
    });
});
