const handlers = require('../html/js/network/socketHandlers');

test('new, duplicate and recovered invoice events display details without opening a wallet', () => {
    const previous = handlers._showPaymentFlow;
    handlers._showPaymentFlow = jest.fn();
    global.SmirkAuth = { _isLinked: true, isAvailable: () => true };
    global.window = { smirk: { requestPayment: jest.fn() } };
    const payment = jest.spyOn(handlers, '_trySmirkPayment').mockResolvedValue();
    try {
        handlers.onPaymentCreated({ paymentId: 8 });
        handlers.onPaymentCreated({ paymentId: 8 });
        handlers.onPaymentCreated({ paymentId: 8, reused: true });
        expect(payment).not.toHaveBeenCalled();
        expect(handlers._showPaymentFlow).toHaveBeenCalledTimes(3);
    } finally {
        payment.mockRestore();
        handlers._showPaymentFlow = previous;
        delete global.SmirkAuth;
        delete global.window;
    }
});

test('account changes invalidate invoice consent and cannot submit an old owner invoice', async () => {
    const chain = {
        append() { return this; }, text: jest.fn(function() { return this; }),
        prop: jest.fn(function() { return this; }), remove: jest.fn(),
        hide: jest.fn(), val: jest.fn(), removeData: jest.fn(function() { return this; })
    };
    global.$ = () => chain;
    global.UI = { scrollChat() {} };
    global.localStorage = { setItem() {} };
    global.SmirkAuth = { _isLinked: true, _wowReady: true };
    global.window = { smirk: { requestPayment: jest.fn() } };
    const refresh = jest.spyOn(handlers, '_refreshSmirkLinked').mockImplementation(() => {});
    const address = jest.spyOn(handlers, '_updateAddressButtonStatus').mockImplementation(() => {});
    const adapter = jest.spyOn(handlers, '_getSmirkPaymentAdapter').mockReturnValue({ pay: jest.fn() });
    const hideQR = jest.spyOn(handlers, 'hidePaymentQR').mockImplementation(() => {});
    try {
        Object.assign(handlers, { _smirkEnabled: true, _cryptoType: 'WOW', _network: 'mainnet', _sessionUserId: 7, _activePaymentId: 31 });
        handlers.onSessionResumed({ token: 'fixture-session', userId: 8 });
        expect(handlers._sessionUserId).toBe(8);
        expect(handlers._activePaymentId).toBeNull();
        expect(chain.val).toHaveBeenCalledWith('');
        expect(chain.removeData).toHaveBeenCalledWith('payment-id');
        expect(hideQR).toHaveBeenCalled();
        expect(SmirkAuth._isLinked).toBe(false);
        expect(SmirkAuth._wowReady).toBe(false);
        await handlers._trySmirkPayment({ paymentId: 31, ownerUserId: 7 });
        expect(adapter).not.toHaveBeenCalled();
        expect(window.smirk.requestPayment).not.toHaveBeenCalled();
    } finally {
        refresh.mockRestore(); address.mockRestore(); adapter.mockRestore(); hideQR.mockRestore();
        for (const key of ['$', 'UI', 'localStorage', 'SmirkAuth', 'window']) delete global[key];
        handlers._sessionUserId = null;
    }
});
