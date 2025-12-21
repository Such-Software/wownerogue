/**
 * Payment UI Manager
 * Handles the game mode selection and payment modal interactions
 */
const PaymentUI = {
    config: null,
    userCredits: 0,
    hasPayoutAddress: false,
    
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
            PaymentUI.handleModeSelection(mode, action);
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
                 // Try modern clipboard API first
                 if (navigator.clipboard && navigator.clipboard.writeText) {
                     navigator.clipboard.writeText(addr).then(() => {
                         $('#copy-address').text('Copied!');
                         setTimeout(() => $('#copy-address').html('📋 Copy Address'), 2000);
                     });
                 } else {
                     // Fallback
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

        // Bind Shop Button (will be added to index.html)
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
        // Update credit display if visible
        $('#user-credits-display').text(this.userCredits);
    },

    render: function() {
        if (!this.config) return;

        const currency = this.config.cryptoType || 'WOW';
        const decimals = currency === 'XMR' ? 12 : 11;
        const divisor = Math.pow(10, decimals);
        const bothEnabled = this.config.directModeEnabled && this.config.creditsModeEnabled;
        const hasCredits = this.userCredits >= (this.config.creditsPerGame || 1);
        
        // Build dynamic options container
        const $container = $('.game-modes');
        $container.empty();
        
        // Add credits balance display if credits mode is enabled
        if (this.config.creditsModeEnabled) {
            $container.append(`
                <div class="credits-balance" style="text-align:center;margin-bottom:10px;padding:8px;background:#1a1a2e;border-radius:4px;">
                    <span style="color:#888;">Your Credits:</span> 
                    <strong id="user-credits-display" style="color:#4ade80;font-size:1.2em;">${this.userCredits}</strong>
                </div>
            `);
        }
        
        // If user has credits and credits mode is enabled, show "Use Credit" option first
        if (hasCredits && this.config.creditsModeEnabled) {
            const creditsPayoutsEnabled = this.config.creditsPayoutsEnabled;
            const payoutNote = creditsPayoutsEnabled 
                ? '<span style="color:#4ade80;">💰 Payouts enabled</span>' 
                : '<span style="color:#f59e0b;">⚡ Fast play • No payouts</span>';
            $container.append(`
                <button class="mode-option recommended" data-mode="PAID_CREDITS" data-action="use_credit" style="border:2px solid #4ade80;">
                    <strong>🎮 Use 1 Credit</strong> (${this.userCredits} available)<br>
                    <span style="font-size:0.8em;">Start game immediately • ${payoutNote}</span>
                </button>
            `);
        }
        
        // Show direct payment option
        if (this.config.directModeEnabled) {
            const price = (this.config.singleGamePrice / divisor).toFixed(decimals === 12 ? 4 : 2);
            const recommended = !hasCredits ? 'recommended' : '';
            const directPayoutsEnabled = this.config.directPayoutsEnabled !== false; // Default true
            const payoutInfo = directPayoutsEnabled 
                ? '<span style="color:#4ade80;">💰 2x payout on escape, 3x with treasure</span>'
                : '<span style="color:#f59e0b;">⚡ Play mode • No payouts</span>';
            $container.append(`
                <button class="mode-option ${recommended}" data-mode="PAID_SINGLE" data-action="pay_direct">
                    <strong>💰 Pay Per Game</strong> - ${price} ${currency}<br>
                    <span style="font-size:0.8em;">${payoutInfo}</span>
                </button>
            `);
        }

        // Show buy credits option if credits mode is enabled
        if (this.config.creditsModeEnabled) {
            const price = (this.config.creditsPackagePrice / divisor).toFixed(decimals === 12 ? 4 : 2);
            const pkgCredits = this.config.creditsPackageCount || 10;
            $container.append(`
                <button class="mode-option" data-mode="PAID_CREDITS" data-action="buy_credits">
                    <strong>🎫 Buy ${pkgCredits} Credits</strong> - ${price} ${currency}<br>
                    <span style="font-size:0.8em;color:#aaa;">Bulk discount • Credits never expire</span>
                </button>
            `);
        }
        
        // Show FREE option only if payments are disabled
        if (!this.config.paymentsEnabled) {
            $container.append(`
                <button class="mode-option" data-mode="FREE" data-action="free">
                    <strong>🆓 Free Play</strong><br>
                    <span style="font-size:0.8em;color:#aaa;">No payments required</span>
                </button>
            `);
        }
    },

    handleModeSelection: function(mode, action) {
        console.log("Mode selected:", mode, "Action:", action);
        
        if (mode === 'FREE') {
            $('#payment-ui').hide();
            // Emit to start game directly
            if (window.socket) {
                window.socket.emit('enter_game');
            }
            return;
        }
        
        // If using existing credits, just start the game
        if (action === 'use_credit' && this.userCredits >= 1) {
            $('#payment-ui').hide();
            if (window.socket) {
                window.socket.emit('enter_game'); // Will use credits automatically
            }
            return;
        }
        
        // Otherwise, request payment
        let paymentType = 'single_game';
        if (action === 'buy_credits') {
            paymentType = 'credits_package';
        }
        
        if (window.socket) {
            window.socket.emit('request_payment', { type: paymentType });
            
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
        $('.game-modes').hide(); // Hide selection, show payment
        
        const isCreditsPurchase = data.paymentType === 'credits_package';
        const headerText = isCreditsPurchase ? '🎫 Buy Credits' : '💳 Payment Required';
        $('.payment-header strong').text(headerText);
        
        const displayAmount = data.humanAmount || data.amountFormatted || data.amount;
        $('#payment-amount').text(displayAmount + ' ' + (data.currency || ''));
        $('#payment-address').val(data.address);
        $('#check-payment').data('payment-id', data.id);
        
        if (data.reused) {
            $('#payment-status').html('<span style="color:#ff0">♻️ Using existing pending payment</span>');
        } else {
            const statusText = isCreditsPurchase 
                ? 'Send payment to receive credits...'
                : 'Waiting for payment...';
            $('#payment-status').text(statusText);
        }
    },
    
    show: function() {
        $('#payment-ui').show();
        $('.game-modes').show();
        $('#payment-details').hide();
        $('.payment-header strong').text('🎮 Game Mode Selection');
    }
};

// Expose globally
window.PaymentUI = PaymentUI;

// Initialize when DOM is ready
$(document).ready(function() {
    PaymentUI.init();
});
