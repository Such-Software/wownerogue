/**
 * Transaction History Panel
 * Displays payment and payout history for the user
 */
const TransactionHistory = {
    _isLoading: false,
    _paymentsData: null,
    _payoutsData: null,
    
    init: function() {
        // Bind close button
        $('#close-history').on('click', function() {
            $('#history-panel').hide();
        });
        
        // Bind history button
        $('#historyButton').on('click', function() {
            TransactionHistory.show();
        });
        
        // Bind tab switching
        $('.history-tab').on('click', function() {
            const tab = $(this).data('tab');
            TransactionHistory._switchTab(tab);
        });
    },
    
    _switchTab: function(tab) {
        // Update tab button styles
        $('.history-tab').each(function() {
            if ($(this).data('tab') === tab) {
                $(this).css({ background: '#4c1d95', color: '#fff' });
                $(this).addClass('active');
            } else {
                $(this).css({ background: '#333', color: '#aaa' });
                $(this).removeClass('active');
            }
        });
        
        // Show/hide content
        if (tab === 'payouts') {
            $('#payouts-content').show();
            $('#payments-content').hide();
        } else {
            $('#payouts-content').hide();
            $('#payments-content').show();
        }
    },
    
    show: function() {
        $('#history-panel').show();
        this._loadData();
    },
    
    hide: function() {
        $('#history-panel').hide();
    },
    
    _loadData: function() {
        if (this._isLoading) return;
        this._isLoading = true;
        
        const socketId = window.socket?.id;
        if (!socketId) {
            this._showError('Not connected to server');
            this._isLoading = false;
            return;
        }
        
        // Load both endpoints in parallel
        Promise.all([
            this._fetchPayments(socketId),
            this._fetchPayouts(socketId)
        ]).then(([payments, payouts]) => {
            this._paymentsData = payments;
            this._payoutsData = payouts;
            this._render();
        }).catch(err => {
            console.error('Failed to load transaction history:', err);
            this._showError('Failed to load history');
        }).finally(() => {
            this._isLoading = false;
        });
    },
    
    // These reads are now session-ownership gated (contract C2), so send the session token
    // (users.anon_token, persisted as localStorage['wownerogue_token']) as 'X-Session-Token'.
    _sessionHeaders: function() {
        var token = null;
        try { token = localStorage.getItem('wownerogue_token'); } catch (e) {}
        return token ? { 'X-Session-Token': token } : {};
    },

    _fetchPayments: function(socketId) {
        return fetch(`/api/user/${encodeURIComponent(socketId)}/payments?limit=50`, { headers: this._sessionHeaders() })
            .then(res => res.json())
            .catch(() => ({ payments: [], total: 0 }));
    },

    _fetchPayouts: function(socketId) {
        return fetch(`/api/user/${encodeURIComponent(socketId)}/payouts?limit=50`, { headers: this._sessionHeaders() })
            .then(res => res.json())
            .catch(() => ({ payouts: [], total: 0, totalReceived: 0 }));
    },
    
    _render: function() {
        this._renderSummary();
        this._renderPayouts();
        this._renderPayments();
    },
    
    _renderSummary: function() {
        const payouts = this._payoutsData || {};
        const payments = this._paymentsData || {};
        
        const currency = payouts.currency || payments.currency || 'WOW';
        const totalReceived = payouts.totalReceivedFormatted || '0';
        const totalPaid = payments.totalPaidFormatted || '0';
        
        $('#total-received').text(totalReceived + ' ' + currency);
        $('#total-payments').text(totalPaid + ' ' + currency);
    },
    
    _renderPayouts: function() {
        const $list = $('#payouts-list');
        const $empty = $('#payouts-empty');
        const data = this._payoutsData || {};
        const payouts = data.payouts || [];
        const currency = data.currency || 'WOW';
        
        $list.empty();
        
        if (payouts.length === 0) {
            $empty.show();
            return;
        }
        
        $empty.hide();
        
        payouts.forEach(payout => {
            const statusColor = this._getStatusColor(payout.status);
            const date = new Date(payout.createdAt).toLocaleDateString();
            const multiplierText = payout.multiplier ? ` (${payout.multiplier}x)` : '';
            
            const $item = $(`
                <div style="background:#1a1a2e; padding:12px; margin-bottom:8px; border-radius:6px; border-left:3px solid ${statusColor};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#4ade80; font-weight:bold;">${payout.amountFormatted} ${currency}${multiplierText}</span>
                        <span style="color:${statusColor}; font-size:0.85em; text-transform:uppercase;">${payout.status}</span>
                    </div>
                    <div style="color:#888; font-size:0.85em; margin-top:4px;">
                        ${payout.reason || 'Game reward'} • ${date}
                    </div>
                    ${payout.txHash ? `<div style="font-size:0.75em; margin-top:4px; word-break:break-all;">${
                        typeof SocketHandlers !== 'undefined' && SocketHandlers._explorerTxUrl
                            ? '<a href="' + SocketHandlers._explorerTxUrl + payout.txHash + '" target="_blank" rel="noopener" style="color:#60a5fa; text-decoration:underline;">TX: ' + payout.txHash.substring(0, 16) + '...</a>'
                            : '<span style="color:#60a5fa;">TX: ' + payout.txHash.substring(0, 16) + '...</span>'
                    } <button class="copy-hash-btn" data-hash="${payout.txHash}" style="font-size:10px; padding:1px 4px; cursor:pointer; background:#333; color:#fff; border:1px solid #555; border-radius:3px;">Copy</button></div>` : ''}
                </div>
            `);
            
            $list.append($item);
        });
    },
    
    _renderPayments: function() {
        const $list = $('#payments-list');
        const $empty = $('#payments-empty');
        const data = this._paymentsData || {};
        const payments = data.payments || [];
        const currency = data.currency || 'WOW';
        
        $list.empty();
        
        if (payments.length === 0) {
            $empty.show();
            return;
        }
        
        $empty.hide();
        
        payments.forEach(payment => {
            const statusColor = this._getStatusColor(payment.status);
            const date = new Date(payment.createdAt).toLocaleDateString();
            const typeLabel = this._getPaymentTypeLabel(payment.type);
            const creditsText = payment.creditsReceived > 0 ? ` → +${payment.creditsReceived} credits` : '';
            
            const $item = $(`
                <div style="background:#1a1a2e; padding:12px; margin-bottom:8px; border-radius:6px; border-left:3px solid ${statusColor};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#60a5fa; font-weight:bold;">${payment.amountFormatted} ${currency}</span>
                        <span style="color:${statusColor}; font-size:0.85em; text-transform:uppercase;">${payment.status}</span>
                    </div>
                    <div style="color:#888; font-size:0.85em; margin-top:4px;">
                        ${typeLabel}${creditsText} • ${date}
                    </div>
                </div>
            `);
            
            $list.append($item);
        });
    },
    
    _getStatusColor: function(status) {
        switch (status) {
            case 'confirmed':
            case 'completed':
                return '#4ade80';
            case 'pending':
                return '#f59e0b';
            case 'failed':
            case 'expired':
                return '#ef4444';
            default:
                return '#888';
        }
    },
    
    _getPaymentTypeLabel: function(type) {
        switch (type) {
            case 'single_game':
                return '💰 Single Game';
            case 'credits_package':
                return '🎫 Credits Package';
            default:
                return type || 'Payment';
        }
    },
    
    _showError: function(message) {
        $('#payouts-list').html(`<div style="color:#ef4444; text-align:center; padding:20px;">${message}</div>`);
        $('#payments-list').html(`<div style="color:#ef4444; text-align:center; padding:20px;">${message}</div>`);
        $('#payouts-empty, #payments-empty').hide();
    }
};

// Expose globally
window.TransactionHistory = TransactionHistory;

// Initialize when DOM is ready
$(document).ready(function() {
    TransactionHistory.init();
});
