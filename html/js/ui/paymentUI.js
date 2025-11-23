/**
 * Payment UI Manager
 * Handles the game mode selection and payment modal interactions
 */
const PaymentUI = {
    config: null,
    
    init: function() {
        console.log("Initializing PaymentUI...");
        
        // Bind close button
        $('#close-payment').on('click', function() {
            $('#payment-ui').hide();
        });

        // Bind mode options
        $('.mode-option').on('click', function() {
            const mode = $(this).data('mode');
            PaymentUI.handleModeSelection(mode);
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
    },

    updateConfig: function(config) {
        console.log("PaymentUI config updated:", config);
        this.config = config;
        this.render();
    },

    render: function() {
        if (!this.config) return;

        const currency = this.config.cryptoType || 'WOW';
        const decimals = currency === 'XMR' ? 12 : 11;
        const divisor = Math.pow(10, decimals);

        // Update PAID_SINGLE
        if (this.config.directModeEnabled) {
            const price = (this.config.singleGamePrice / divisor).toFixed(decimals === 12 ? 4 : 2);
            const $el = $('.mode-option[data-mode="PAID_SINGLE"]');
            $el.html(`<strong>💰 PAID SINGLE</strong> - ${price} ${currency} per game<br><span style="font-size:0.8em;color:#aaa;">Payouts enabled for winners</span>`);
            $el.show();
        } else {
            $('.mode-option[data-mode="PAID_SINGLE"]').hide();
        }

        // Update PAID_CREDITS
        if (this.config.creditsModeEnabled) {
            // Note: config.creditsPackagePrice is for the default package
            const price = (this.config.creditsPackagePrice / divisor).toFixed(decimals === 12 ? 4 : 2);
            // We assume the default package size is 10 if not specified, but let's be vague if unsure
            // Ideally we'd get package info. For now, "Credits Package" is safe.
            const $el = $('.mode-option[data-mode="PAID_CREDITS"]');
            $el.html(`<strong>🎫 CREDITS PACKAGE</strong> - ${price} ${currency}<br><span style="font-size:0.8em;color:#aaa;">Bulk discount, no payouts</span>`);
            $el.show();
        } else {
            $('.mode-option[data-mode="PAID_CREDITS"]').hide();
        }
        
        // Update FREE
        if (!this.config.paymentsEnabled) {
             $('.mode-option[data-mode="FREE"]').show();
             // If payments are disabled, maybe hide the others?
             // The logic above handles hiding if enabled flags are false.
        } else {
             // If payments are enabled, FREE is usually disabled/hidden
             $('.mode-option[data-mode="FREE"]').hide();
        }
    },

    handleModeSelection: function(mode) {
        console.log("Mode selected:", mode);
        
        if (mode === 'FREE') {
            $('#payment-ui').hide();
            return;
        }
        
        let paymentType = 'single_game';
        if (mode === 'PAID_CREDITS') {
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
        $('.payment-header strong').text('💳 Payment Required');
        
        const displayAmount = data.humanAmount || data.amountFormatted || data.amount;
        $('#payment-amount').text(displayAmount + ' ' + (data.currency || ''));
        $('#payment-address').val(data.address);
        $('#check-payment').data('payment-id', data.id);
        
        if (data.reused) {
            $('#payment-status').html('<span style="color:#ff0">♻️ Using existing pending payment</span>');
        } else {
            $('#payment-status').text('Waiting for payment...');
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
