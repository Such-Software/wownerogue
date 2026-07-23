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
        const payoutsOn = !!(config && (config.directPayoutsEnabled || config.creditsPayoutsEnabled));
        if (payoutsOn) {
            $('#helpPayoutTitle').text('🎁 Payouts');
            $('#helpPayoutCopy').text('Set your payout address with “Manage Payout Address.” An escape pays the configured reward automatically, and escaping with the treasure earns the higher multiplier.');
            $('#helpTreasureLegend').text('Treasure - collect for the higher payout and score bonus');
        } else {
            $('#helpPayoutTitle').text('🏅 Prestige rewards');
            $('#helpPayoutCopy').text('This server does not pay crypto winnings. Paid entries and credits qualify scores for the Hall of Champions; free runs stay on the separate Pleb leaderboard.');
            $('#helpTreasureLegend').text('Treasure - collect for a score bonus');
        }
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
        
        // Fully free deployment (no payments configured).
        if (!config.paymentsEnabled) {
            $container.html(`
                <div style="padding:8px 10px; background:#0d3320; border:1px solid #4ade80; border-radius:6px;">
                    <strong style="color:#4ade80;">🆓 Free to play</strong><br>
                    <span>No payment needed — just escape the dungeon.</span>
                </div>
            `);
            return;
        }

        const directOn = config.directModeEnabled;
        const creditsOn = config.creditsModeEnabled;
        if (!directOn && !creditsOn) {
            $container.html('<p style="color:#888;">Loading…</p>');
            return;
        }

        // Unified model: everything is CREDITS. Buy one at the base price, or a bundle at a
        // discount; 1 credit = 1 run either way.
        const price = config.singleGamePriceFormatted || '1';
        const packages = config.creditPackages || [];
        const payoutsOn = !!(config.directPayoutsEnabled || config.creditsPayoutsEnabled);

        const buy = [];
        if (directOn) buy.push(`<strong>1 credit</strong> — ${price} ${currency}`);
        if (creditsOn && packages.length > 0) {
            const bundles = packages.map(pkg => {
                const bonus = pkg.bonus > 0 ? ` +${pkg.bonus}` : '';
                return `${pkg.credits}${bonus} for ${pkg.priceFormatted}`;
            }).join(' · ');
            buy.push(`<strong>Bundles</strong> — ${bundles} ${currency}`);
        }

        // Reward line is config-driven so it stays honest on prestige (no-payout) deployments.
        let reward;
        if (payoutsOn) {
            reward = '<span style="color:#4ade80;">💰 Exact escape and treasure rewards are shown before entry and locked for that run.</span>';
        } else {
            reward = `<span style="color:#fbbf24;">🏅 No crypto payout — escape for the win; top scores enter the <strong>Hall of Champions</strong>.</span>`;
        }

        const freeLine = config.freePlayEnabled
            ? `<div style="font-size:0.82em; color:#888; margin-top:6px;">Prefer a free entry? Free runs are available too (Pleb leaderboard).</div>`
            : '';

        $container.html(`
            <div style="padding:10px 12px; background:#17172a; border:1px solid #7c3aed; border-radius:6px;">
                <div style="color:#a78bfa; font-weight:700; margin-bottom:6px;">🎫 1 credit = 1 run</div>
                <div style="font-size:0.9em; margin-bottom:6px;">
                    Buy credits with ${currency}:<br>
                    ${buy.map(b => '&nbsp;&nbsp;• ' + b).join('<br>')}
                </div>
                <div style="font-size:0.82em; color:#9aa4b2; margin-bottom:6px;">
                    Spend a credit to enter — jump in immediately, or on the next block. Block timing
                    is random, so your average wait is the same either way.
                </div>
                <div style="font-size:0.85em;">${reward}</div>
                ${freeLine}
            </div>
        `);
    }
};

// Expose globally
window.HelpModal = HelpModal;

// Initialize when DOM is ready
$(document).ready(function() {
    HelpModal.init();
});
