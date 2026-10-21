const PaymentHandlers = require('../src/network/paymentHandlers');
const GameModeManager = require('../src/game/gameModeManager');
const ConnectionHandler = require('../src/network/connectionHandler');
const SocketHandlers = require('../src/network/socketHandlers');
const { paymentRequest } = require('../html/js/network/smirkPaymentAdapter');

const row = {
    id: 31, user_id: 7, subaddress: 'WW3UyJFX6GPKdM21APyVYjGhfX3ebyHvPPgtFC3wHxkYTCGg8k2UM9DLTCzcgoaLHSKnvJKRtCPgJ1sxvgYiFCoK19vLk83Jn',
    expected_amount: '123456789012', description: '10 credit package', payment_type: 'credits_package',
    expires_at: new Date(Date.now() + 3600000).toISOString()
};

test.each([false, true])('authenticated session events expose the invoice owner without deriving it from the browser: resumed=%s', resumed => {
    const emit = jest.fn();
    ConnectionHandler.prototype._emitSessionEvents.call({ io: { to: () => ({ emit }) } },
        { id: 'fixture-socket' }, { resumed, token: 'fixture-session', user: { id: 7 } });
    expect(emit).toHaveBeenCalledWith(resumed ? 'session_resumed' : 'session_token', expect.objectContaining({ userId: 7 }));
});

test.each(['request', 'show', 'restore'])('the %s invoice path supplies an exact, spendable WOW contract', async path => {
    const manager = Object.create(GameModeManager.prototype);
    Object.assign(manager, {
        cryptoType: 'WOW', network: 'mainnet', currencyDecimals: 11,
        isPaymentIntakeEnabled: () => true,
        formatAtomicHuman: () => '1.2346',
        gameMode: 'PAID_CREDITS', creditsPackagePrice: row.expected_amount,
        getPrimaryCreditPackage: () => ({ price: row.expected_amount, credits: 10 }),
        createPaymentRequest: jest.fn(async () => manager._mapPaymentRowToRequest(row, 'credits_package', { credits: 10 })),
        db: { query: jest.fn(async () => ({ rows: [row] })) }
    });
    const emitted = [];
    const io = { to: () => ({ emit: (event, data) => emitted.push([event, data]) }) };
    const handlers = new PaymentHandlers({
        io, gameModeManager: manager, debugManager: { CONSOLE_LOGGING: false },
        queueManager: { getUserBySocket: () => ({ serverId: 'fixture-socket' }) },
        broadcastManager: { sendStatusUpdate: jest.fn() },
        walletService: {}
    });
    handlers._requirePaidAcknowledgement = () => ({ policyVersion: 'fixture' });
    handlers._allowInvoiceFlowForReserve = async () => true;
    handlers._ensureRequiredPayoutAddress = async () => ({ ok: true });
    handlers._monitorAddress = jest.fn();
    const socket = { id: 'fixture-socket', emit: (event, data) => emitted.push([event, data]) };
    try {
        if (path === 'request') await handlers.handlePaymentRequest(socket, { type: 'credits_package' });
        else if (path === 'show') await handlers.createAndShowPaymentRequest(socket, { paymentType: 'credits_package' });
        else await SocketHandlers.prototype._restorePaymentMonitoring.call({
            gameModeManager: manager, paymentHandlers: handlers, debugManager: { CONSOLE_LOGGING: false },
            connectionHandler: { getUserBySocket: () => ({ serverId: socket.id }) },
            broadcastManager: { sendStatusUpdate: jest.fn() }
        }, socket, 7);
        const payload = emitted.find(([event]) => event === 'payment_created')?.[1];
        expect(payload).toMatchObject({ ownerUserId: 7, asset: 'wow', network: 'mainnet', humanAmount: '1.23456789012', memo: row.description });
        expect(paymentRequest(payload)).toEqual({ asset: 'wow', amount: '1.23456789012', address: row.subaddress, memo: row.description });
    } finally {
        handlers.dispose();
    }
});
