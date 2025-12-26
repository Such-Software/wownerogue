/**
 * Help Modal
 * Displays game instructions and payment mode information
 */
const HelpModal = {
    _config: null,
    
    init: function() {
        // Bind close buttons
        $('#helpModalClose, #helpModalCloseBtn').on('click', function() {
            HelpModal.hide();
        });
        
        // Bind help button
        $('#helpButton').on('click', function() {
            HelpModal.show();
        });
        
        // Close on overlay click
        $('#helpModal').on('click', function(e) {
            if (e.target === this) {
                HelpModal.hide();
            }
        });
        
        // Close on Escape key
        $(document).on('keydown', function(e) {
            if (e.key === 'Escape' && !$('#helpModal').hasClass('hidden')) {
                HelpModal.hide();
            }
        });
    },
    
    updateConfig: function(config) {
        this._config = config;
    },
    
    show: function() {
        this._renderPaymentModes();
        $('#helpModal').removeClass('hidden');
    },
    
    hide: function() {
        $('#helpModal').addClass('hidden');
    },
    
    _renderPaymentModes: function() {
        const $container = $('#helpModesList');
        $container.empty();
        
        const config = this._config || {};
        const currency = config.cryptoType || 'WOW';
        
        // Check if payments are disabled (free mode)
        if (!config.paymentsEnabled) {
            $container.html(`
                <div style="padding:8px; background:#0d3320; border:1px solid #4ade80; border-radius:4px; margin-bottom:8px;">
                    <strong style="color:#4ade80;">🆓 Free Mode</strong><br>
                    <span>Play for free! No payment required. Payouts may or may not be enabled.</span>
                </div>
            `);
            return;
        }
        
        // Direct payment mode
        if (config.directModeEnabled) {
            const price = config.singleGamePriceFormatted || '1';
            const multipliers = config.payoutMultipliers?.direct || {};
            const escapeMulti = multipliers.escape || 2;
            const treasureMulti = multipliers.treasure || 3;
            
            $container.append(`
                <div style="padding:8px; background:#1a1a2e; border:1px solid #3730a3; border-radius:4px; margin-bottom:8px;">
                    <strong style="color:#818cf8;">⚡ Direct Payment</strong><br>
                    <span>Pay <strong>${price} ${currency}</strong> per game.</span><br>
                    <span style="font-size:0.85em; color:#aaa;">Escape: ${escapeMulti}× payout | With treasure: ${treasureMulti}× payout</span>
                </div>
            `);
        }
        
        // Credits mode
        if (config.creditsModeEnabled) {
            const packages = config.creditPackages || [];
            const creditsPayoutEnabled = config.creditsPayoutsEnabled;
            
            let packagesInfo = '';
            if (packages.length > 0) {
                packagesInfo = packages.map(pkg => {
                    const bonus = pkg.bonus > 0 ? ` +${pkg.bonus} bonus` : '';
                    return `${pkg.credits}${bonus} credits for ${pkg.priceFormatted} ${currency}`;
                }).join(', ');
            }
            
            $container.append(`
                <div style="padding:8px; background:#1a1a2e; border:1px solid #7c3aed; border-radius:4px; margin-bottom:8px;">
                    <strong style="color:#a78bfa;">🎫 Credits Mode</strong><br>
                    <span>Buy credits in bulk and use them to play.</span><br>
                    ${packagesInfo ? `<span style="font-size:0.85em; color:#aaa;">Packages: ${packagesInfo}</span><br>` : ''}
                    ${creditsPayoutEnabled 
                        ? '<span style="font-size:0.85em; color:#4ade80;">✓ Payouts enabled for credit games</span>' 
                        : '<span style="font-size:0.85em; color:#888;">Payouts not available for credit games</span>'}
                </div>
            `);
        }
        
        // If no paid modes are shown but payments enabled
        if (!config.directModeEnabled && !config.creditsModeEnabled && config.paymentsEnabled) {
            $container.html(`
                <p style="color:#888;">Payment configuration is loading...</p>
            `);
        }
    }
};

// Expose globally
window.HelpModal = HelpModal;

// Initialize when DOM is ready
$(document).ready(function() {
    HelpModal.init();
});
