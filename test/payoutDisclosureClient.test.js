const fs = require('fs');
const path = require('path');

describe('browser payout disclosures', () => {
    test('renders server-computed outcomes and never recreates multiplier amounts', () => {
        const paymentUi = fs.readFileSync(
            path.join(__dirname, '../html/js/ui/paymentUI.js'),
            'utf8'
        );
        const help = fs.readFileSync(
            path.join(__dirname, '../html/js/ui/helpModal.js'),
            'utf8'
        );

        expect(paymentUi).toContain('this.config?.payoutOutcomes?.[mode]');
        expect(paymentUi).toContain('configured cap applied');
        expect(paymentUi).not.toMatch(/parseFloat\([^\n]+\)\s*\*\s*[^\n]*multiplier/i);
        expect(help).not.toMatch(/Escape pays[\s\S]{0,80}×/);
    });
});
