/**
 * Payment UI Manager
 * Handles the game mode selection and payment modal interactions
 */
const PaymentUI = {
    config: null,
    userCredits: 0,
    hasPayoutAddress: false,
    selectedPackageId: null,
    
    init: function() {
        console.log("Initializing PaymentUI...");
        
        // Bind close button
        $('#close-payment').on('click', function() {
            $('#payment-ui').hide();
        });

        // Bind mode options (use delegation for dynamic content)
        $('#payment-ui').on('click', '.mode-option', function() {
            const mode = $(this).data('mode');
            const action = $(this).data('action');
            const packageId = $(this).data('package-id');
            PaymentUI.handleModeSelection(mode, action, packageId);
        });

        // Bind package radio buttons
        $('#payment-ui').on('change', 'input[name="credit-package"]', function() {
            PaymentUI.selectedPackageId = $(this).val();
            // Enable buy button
            $('#buy-credits-btn').prop('disabled', false);
        });

        // Bind buy credits button
        $('#payment-ui').on('click', '#buy-credits-btn', function() {
            if (PaymentUI.selectedPackageId) {
                PaymentUI.handleModeSelection('PAID_CREDITS', 'buy_credits', PaymentUI.selectedPackageId);
            }
        });

        // Bind check payment button
        $('#check-payment').on('click', function() {
            const paymentId = $(this).data('payment-id');
            if (paymentId && window.socket) {
                window.socket.emit('check_payment_status', { paymentId });
                $(this).text('Checking...');
                setTimeout(() => $('#check-payment').text('🔄 Check Payment'), 1000);
            }
        });
        
        // Bind copy button
        $('#copy-address').on('click', function() {
             const addr = $('#payment-address').val();
             if(addr) {
                 if (navigator.clipboard && navigator.clipboard.writeText) {
                     navigator.clipboard.writeText(addr).then(() => {
                         $('#copy-address').text('Copied!');
                         setTimeout(() => $('#copy-address').html('📋 Copy Address'), 2000);
                     });
                 } else {
                     const $temp = $("<input>");
                     $("body").append($temp);
                     $temp.val(addr).select();
                     document.execCommand("copy");
                     $temp.remove();
                     $('#copy-address').text('Copied!');
                     setTimeout(() => $('#copy-address').html('📋 Copy Address'), 2000);
                 }
             }
        });

        // Bind Shop Button
        $('#shopButton').on('click', function() {
            PaymentUI.show();
        });
        
        // Listen for credits updates
        if (window.socket) {
            window.socket.on('credits_update', function(data) {
                PaymentUI.updateCredits(data.balance);
            });
        }
    },

    updateConfig: function(config) {
        console.log("PaymentUI config updated:", config);
        this.config = config;
        this.render();
    },
    
    updateCredits: function(balance) {
        this.userCredits = balance || 0;
        this.render();
        $('#user-credits-display').text(this.userCredits);
    },

    formatPrice: function(atomicAmount) {
        const currency = this.config?.cryptoType || 'WOW';
        const decimals = currency === 'XMR' ? 12 : 11;
        const divisor = Math.pow(10, decimals);
        return (atomicAmount / divisor).toFixed(decimals === 12 ? 4 : 2);
    },

    escapeHtml: function(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
            return ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[ch];
        });
    },

    grantLabel: function(packId) {
        const pack = window.RK && window.RK.PACKS ? window.RK.PACKS[packId] : null;
        const labels = {
            'generated-skins': 'Premium skins',
            'iso-dungeon': 'Isometric dungeon',
            'kenney-3d-characters': '3D characters',
            'roguelike-interior': 'Roguelike interior'
        };
        return (pack && pack.label) || labels[packId] || packId;
    },

    grantSummaryHtml: function(grants, options = {}) {
        if (!grants) return '';
        const parts = [];
        if (options.includeCredits && Number(grants.credits || 0) > 0) {
            parts.push(`${Number(grants.credits)} credits`);
        }
        (grants.packs || []).forEach(packId => parts.push(this.grantLabel(packId)));
        if (grants.premiumLevel) {
            parts.push(`${grants.premiumLevel} tier`);
        }
        if (parts.length === 0) return '';
        return `<div style="font-size:0.78em;color:#fbbf24;margin-top:4px;margin-left:${options.indent || 0}px;">Includes: ${this.escapeHtml(parts.join(' • '))}</div>`;
    },

    render: function() {
        if (!this.config) return;

        // Display label (sXMR on stagenet) — distinct from cryptoType, which formatPrice
        // still uses for decimals.
        const currency = this.config.currencyLabel || this.config.cryptoType || 'WOW';
        const hasCredits = this.userCredits >= (this.config.creditsPerGame || 1);
        const creditPackages = this.config.creditPackages || [];
        const cosmeticProducts = this.config.cosmeticProducts || [];
        
        const $container = $('.game-modes');
        $container.empty();
        
        // Reset selected package
        this.selectedPackageId = null;

        // Explain the two leaderboards up front when both paid and free are available.
        if (this.config.paymentsEnabled && this.config.freePlayEnabled) {
            $container.append(
                '<div style="margin-bottom:14px;padding:10px;background:rgba(245,158,11,0.08);border:1px solid #92400e;border-radius:6px;font-size:0.85em;line-height:1.5;">' +
                    '🏅 <strong style="color:#fbbf24;">Pay</strong> (credits or single entry) to put your high scores in the <strong style="color:#fbbf24;">Hall of Champions</strong>.<br>' +
                    '🪙 <strong style="color:#8ab4f8;">Play free</strong> — high scores go to the <strong style="color:#8ab4f8;">Pleb leaderboard</strong> instead.' +
                '</div>'
            );
        }

        // === SECTION 1: Use existing credits (if available) ===
        if (hasCredits && this.config.creditsModeEnabled) {
            const creditsPayoutsEnabled = this.config.creditsPayoutsEnabled;
            const creditsMultipliers = this.config.payoutMultipliers?.credits || { escape: 2, escapeWithTreasure: 3 };
            const creditsBaseValue = this.config.creditsPayoutBaseValue || this.config.singleGamePrice;
            
            let payoutNote = '';
            if (creditsPayoutsEnabled) {
                const baseFormatted = this.formatPrice(creditsBaseValue);
                const escapeWin = (parseFloat(baseFormatted) * creditsMultipliers.escape).toFixed(2);
                const treasureWin = (parseFloat(baseFormatted) * creditsMultipliers.escapeWithTreasure).toFixed(2);
                payoutNote = `<span style="color:#4ade80;">💰 Win: ${creditsMultipliers.escape}x (${escapeWin} ${currency}) • Treasure: ${creditsMultipliers.escapeWithTreasure}x (${treasureWin} ${currency})</span><br><span style="color:#fbbf24;">🏅 High scores enter the Hall of Champions</span>`;
            } else {
                payoutNote = '<span style="color:#fbbf24;">🏅 High scores enter the Hall of Champions</span>';
            }
            
            $container.append(`
                <div class="payment-section" style="margin-bottom:15px;padding:12px;background:#0d3320;border:2px solid #4ade80;border-radius:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <strong style="color:#4ade80;font-size:1.1em;">🎮 You have ${this.userCredits} credits</strong>
                    </div>
                    <div style="font-size:0.85em;margin-bottom:10px;">
                        ${payoutNote}
                    </div>
                    <button class="mode-option recommended" data-mode="PAID_CREDITS" data-action="use_credit" 
                            style="width:100%;padding:10px;background:#166534;border:none;color:#fff;cursor:pointer;border-radius:4px;">
                        <strong>▶ PLAY NOW</strong> (use 1 credit)
                    </button>
                </div>
            `);
        }
        
        // === SECTION 2: Direct payment (pay per game) ===
        if (this.config.directModeEnabled) {
            const price = this.config.singleGamePriceFormatted || this.formatPrice(this.config.singleGamePrice);
            const multipliers = this.config.payoutMultipliers?.direct || { escape: 2, escapeWithTreasure: 3 };
            const directPayoutsEnabled = this.config.directPayoutsEnabled !== false;
            
            let payoutInfo = '';
            if (directPayoutsEnabled) {
                const escapeWin = (parseFloat(price) * multipliers.escape).toFixed(2);
                const treasureWin = (parseFloat(price) * multipliers.escapeWithTreasure).toFixed(2);
                payoutInfo = `<span style="color:#4ade80;">Win: ${multipliers.escape}x (${escapeWin} ${currency}) • Treasure: ${multipliers.escapeWithTreasure}x (${treasureWin} ${currency})</span><br><span style="color:#fbbf24;">🏅 High scores enter the Hall of Champions</span>`;
            } else {
                payoutInfo = '<span style="color:#fbbf24;">🏅 High scores enter the Hall of Champions</span>';
            }
            
            $container.append(`
                <div class="payment-section" style="margin-bottom:15px;padding:12px;background:#1a1a2e;border:1px solid #444;border-radius:6px;">
                    <div style="margin-bottom:8px;">
                        <strong style="color:#f0f0f0;">⚡ Single Game</strong>
                        <span style="float:right;color:#fbbf24;font-weight:bold;">${price} ${currency}</span>
                    </div>
                    <div style="font-size:0.85em;color:#aaa;margin-bottom:10px;">
                        ${payoutInfo}
                    </div>
                    <button class="mode-option" data-mode="PAID_SINGLE" data-action="pay_direct"
                            style="width:100%;padding:8px;background:#3730a3;border:none;color:#fff;cursor:pointer;border-radius:4px;">
                        💰 Pay ${price} ${currency} to Play
                    </button>
                </div>
            `);
        }

        // === SECTION 3: Buy credits (bulk discount) ===
        if (this.config.creditsModeEnabled && creditPackages.length > 0) {
            const singlePrice = this.config.singleGamePrice;
            const creditsPayoutsEnabled = this.config.creditsPayoutsEnabled;
            const creditsMultipliers = this.config.payoutMultipliers?.credits || { escape: 2, escapeWithTreasure: 3 };
            const creditsBaseValue = this.config.creditsPayoutBaseValue || this.config.singleGamePrice;
            
            // Build payout info for credits mode
            let creditsPayoutInfo = '';
            if (creditsPayoutsEnabled) {
                const baseFormatted = this.formatPrice(creditsBaseValue);
                const escapeWin = (parseFloat(baseFormatted) * creditsMultipliers.escape).toFixed(2);
                const treasureWin = (parseFloat(baseFormatted) * creditsMultipliers.escapeWithTreasure).toFixed(2);
                creditsPayoutInfo = `<div style="font-size:0.85em;color:#4ade80;margin-bottom:10px;">💰 Win: ${creditsMultipliers.escape}x (${escapeWin} ${currency}) • Treasure: ${creditsMultipliers.escapeWithTreasure}x (${treasureWin} ${currency})</div>`;
            } else {
                creditsPayoutInfo = `<div style="font-size:0.85em;color:#fbbf24;margin-bottom:10px;">🏅 High scores enter the Hall of Champions • bulk discount</div>`;
            }
            
            let packagesHtml = '';
            creditPackages.forEach((pkg, index) => {
                const totalCredits = pkg.credits + (pkg.bonus || 0);
                const pricePerCredit = pkg.price / totalCredits;
                const priceFormatted = pkg.priceFormatted || this.formatPrice(pkg.price);
                const perGamePrice = this.formatPrice(pricePerCredit);
                
                // Calculate discount vs direct play
                let discountBadge = '';
                if (singlePrice > 0) {
                    const directCostForSameGames = singlePrice * totalCredits;
                    const savings = ((directCostForSameGames - pkg.price) / directCostForSameGames * 100).toFixed(0);
                    if (savings > 0) {
                        discountBadge = `<span style="background:#166534;color:#4ade80;padding:2px 6px;border-radius:3px;font-size:0.75em;margin-left:8px;">Save ${savings}%</span>`;
                    }
                }
                
                const bonusText = pkg.bonus > 0 
                    ? `<span style="color:#4ade80;"> +${pkg.bonus} bonus</span>` 
                    : '';
                const grantSummary = this.grantSummaryHtml(pkg.grants, { indent: 22 });
                
                const checked = index === 0 ? 'checked' : '';
                if (index === 0) this.selectedPackageId = pkg.id;
                
                packagesHtml += `
                    <label style="display:block;padding:10px;margin:5px 0;background:#252540;border:1px solid #444;border-radius:4px;cursor:pointer;"
                           class="package-option" data-package-id="${pkg.id}">
                        <input type="radio" name="credit-package" value="${pkg.id}" ${checked} style="margin-right:10px;">
                        <strong>${pkg.credits} credits${bonusText}</strong>${discountBadge}
                        <span style="float:right;color:#fbbf24;font-weight:bold;">${priceFormatted} ${currency}</span>
                        <div style="font-size:0.8em;color:#888;margin-top:4px;margin-left:22px;">
                            ${perGamePrice} ${currency}/game for ${totalCredits} games
                        </div>
                        ${grantSummary}
                    </label>
                `;
            });
            
            $container.append(`
                <div class="payment-section" style="margin-bottom:15px;padding:12px;background:#1a1a2e;border:1px solid #444;border-radius:6px;">
                    <div style="margin-bottom:10px;">
                        <strong style="color:#f0f0f0;">🎫 Buy Credits</strong>
                        <span style="font-size:0.85em;color:#888;margin-left:10px;">Bulk discount • Never expire</span>
                    </div>
                    ${creditsPayoutInfo}
                    <div class="packages-list">
                        ${packagesHtml}
                    </div>
                    <button id="buy-credits-btn" class="mode-option"
                            style="width:100%;padding:10px;margin-top:10px;background:#7c3aed;border:none;color:#fff;cursor:pointer;border-radius:4px;font-weight:bold;">
                        🛒 Buy Selected Package
                    </button>
                </div>
            `);
        }

        // === SECTION 4: Standalone cosmetic/render products ===
        if (this.config.paymentsEnabled && cosmeticProducts.length > 0) {
            let productsHtml = '';
            cosmeticProducts.forEach(product => {
                const priceFormatted = product.priceFormatted || this.formatPrice(product.price);
                const label = this.escapeHtml(product.label || product.id);
                const grantSummary = this.grantSummaryHtml(product.grants, { includeCredits: true });
                productsHtml += `
                    <div style="padding:10px;margin:5px 0;background:#252540;border:1px solid #444;border-radius:4px;">
                        <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;">
                            <strong style="color:#f0f0f0;">${label}</strong>
                            <span style="color:#fbbf24;font-weight:bold;">${priceFormatted} ${currency}</span>
                        </div>
                        ${grantSummary}
                        <button class="mode-option" data-mode="SHOP" data-action="buy_product" data-package-id="${this.escapeHtml(product.id)}"
                                style="width:100%;padding:8px;margin-top:8px;background:#334155;border:none;color:#fff;cursor:pointer;border-radius:4px;">
                            Unlock Pack
                        </button>
                    </div>
                `;
            });

            $container.append(`
                <div class="payment-section" style="margin-bottom:15px;padding:12px;background:#1a1a2e;border:1px solid #444;border-radius:6px;">
                    <div style="margin-bottom:10px;">
                        <strong style="color:#f0f0f0;">Premium Packs</strong>
                        <span style="font-size:0.85em;color:#888;margin-left:10px;">Cosmetics and render modes</span>
                    </div>
                    ${productsHtml}
                </div>
            `);
        }
        
        // === Credits balance display (if has some but not enough) ===
        if (this.config.creditsModeEnabled && this.userCredits > 0 && !hasCredits) {
            $container.prepend(`
                <div style="text-align:center;margin-bottom:10px;padding:8px;background:#1a1a2e;border:1px solid #f59e0b;border-radius:4px;">
                    <span style="color:#f59e0b;">⚠️ You have ${this.userCredits} credits (need ${this.config.creditsPerGame || 1} to play)</span>
                </div>
            `);
        }
        
        // === FREE play === shown when the instance is free-only OR offers free as a choice
        // alongside paid (freePlayEnabled). Free games go to the Pleb leaderboard.
        if (this.config.freePlayEnabled) {
            const note = this.config.paymentsEnabled
                ? '🪙 Free — high scores go to the Pleb leaderboard'
                : 'No payments required';
            $container.append(`
                <button class="mode-option" data-mode="FREE" data-action="free"
                        style="width:100%;padding:12px;background:#166534;border:none;color:#fff;cursor:pointer;border-radius:4px;">
                    <strong>🆓 Play Free</strong><br>
                    <span style="font-size:0.8em;color:#aaa;">${note}</span>
                </button>
            `);
        }
    },

    handleModeSelection: function(mode, action, packageId) {
        console.log("Mode selected:", mode, "Action:", action, "Package:", packageId);
        
        if (mode === 'FREE') {
            $('#payment-ui').hide();
            if (window.socket) {
                // play_free records the game as FREE (Pleb leaderboard, no payout) even on
                // an instance that also sells credits/entry.
                window.socket.emit('play_free');
            }
            return;
        }
        
        // If using existing credits, just start the game
        if (action === 'use_credit' && this.userCredits >= 1) {
            $('#payment-ui').hide();
            if (window.socket) {
                window.socket.emit('enter_game');
            }
            return;
        }
        
        // Request payment with type and optional packageId
        let paymentType = 'single_game';
        if (action === 'buy_credits') {
            paymentType = 'credits_package';
        } else if (action === 'buy_product') {
            paymentType = 'cosmetic_pack';
        }
        
        const requestData = { type: paymentType };
        if (packageId) {
            if (paymentType === 'cosmetic_pack') {
                requestData.productId = packageId;
            } else {
                requestData.packageId = packageId;
            }
        }
        
        if (window.socket) {
            window.socket.emit('request_payment', requestData);
            
            // Show loading state
            $('.game-modes').hide();
            $('#payment-details').show();
            $('#payment-status').text('Requesting payment address...');
            $('#payment-amount').text('...');
            $('#payment-address').val('Loading...');
        }
    },
    
    showPaymentRequest: function(data) {
        $('#payment-ui').show();
        $('#payment-details').show();
        $('.game-modes').hide();
        
        const isCreditsPurchase = data.paymentType === 'credits_package';
        const isProductPurchase = data.paymentType === 'cosmetic_pack';
        let headerText = '💳 Payment Required';
        if (isCreditsPurchase && data.package) {
            const bonus = data.package.bonus > 0 ? ` +${data.package.bonus} bonus` : '';
            headerText = `🎫 Buy ${data.package.credits}${bonus} Credits`;
        } else if (isProductPurchase && data.package) {
            headerText = `Buy ${data.package.label || data.package.id || 'Pack'}`;
        }
        $('.payment-header strong').text(headerText);
        
        const displayAmount = data.humanAmount || data.amountFormatted || data.amount;
        $('#payment-amount').text(displayAmount + ' ' + (data.currency || ''));
        $('#payment-address').val(data.address);
        $('#check-payment').data('payment-id', data.paymentId || data.id);
        
        if (data.reused) {
            $('#payment-status').html('<span style="color:#ff0">♻️ Using existing pending payment</span>');
        } else {
            const statusText = isCreditsPurchase
                ? 'Send payment to receive credits...'
                : (isProductPurchase ? 'Send payment to unlock this pack...' : 'Waiting for payment...');
            $('#payment-status').text(statusText);
        }
    },
    
    show: function() {
        this.render(); // Ensure options are up-to-date with current config
        $('#payment-ui').show();
        $('.game-modes').show();
        $('#payment-details').hide();
        $('.payment-header strong').text('🎮 Choose How to Play');
    }
};

// Expose globally
window.PaymentUI = PaymentUI;

// Initialize when DOM is ready
$(document).ready(function() {
    PaymentUI.init();
});
