'use strict';

jest.mock('../src/payments/qrService', () => ({
    generatePaymentQR: jest.fn(async () => 'data:image/png;base64,fixture')
}));

const SocketHandlers = require('../src/network/socketHandlers');
const GameModeManager = require('../src/game/gameModeManager');
const { generatePaymentQR } = require('../src/payments/qrService');

const pending = {
    id: 31, user_id: 7, subaddress: 'WW3UyJFX6GPKdM21APyVYjGhfX3ebyHvPPgtFC3wHxkYTCGg8k2UM9DLTCzcgoaLHSKnvJKRtCPgJ1sxvgYiFCoK19vLk83Jn',
    expected_amount: '123456789012', payment_type: 'credits_package',
    description: '10 credit package', product_id: 'ten-credits',
    product_grants: { credits: 10 }, provider_id: 'native-monero',
    expires_at: new Date(Date.now() + 3600000).toISOString(), address_index: 5
};

function fixture({ resumed = true, row = pending } = {}) {
    const events = [];
    const socket = {
        id: 'socket-7', connected: true, on: jest.fn(),
        emit: jest.fn((event, payload) => events.push([event, payload]))
    };
    const sessions = new Map([[socket.id, { id: 7 }]]);
    const monitored = new Map();
    const manager = Object.create(GameModeManager.prototype);
    Object.assign(manager, {
        paymentsEnabled: true, creditsModeEnabled: true, directModeEnabled: false,
        cryptoType: 'WOW', network: 'mainnet', currencyDecimals: 11,
        formatAtomicHuman: () => '1.235',
        db: { query: jest.fn(async () => ({ rows: row ? [row] : [] })) },
        getGameModeInfo: jest.fn(() => ({
            paymentsEnabled: manager.isPaymentIntakeEnabled('credits_package')
        }))
    });
    const handlers = Object.create(SocketHandlers.prototype);
    Object.assign(handlers, {
        _isShuttingDown: false,
        connectionHandler: {
            handleConnection: jest.fn(async () => ({
                sessionInfo: { resumed, user: { id: 7 } }
            })),
            getUserBySocket: () => ({ serverId: socket.id })
        },
        sessionManager: { sessions },
        suspendedGameManager: { hasSuspendedGame: () => false },
        queueManager: { updateSocketId: () => false },
        gameModeManager: manager,
        paymentHandlers: {
            socketPaymentMap: monitored,
            stopMonitoringForSocket: jest.fn(id => monitored.delete(id)),
            _monitorAddress: jest.fn((sock, request) => monitored.set(sock.id, {
                paymentId: request.id, address: request.address
            }))
        },
        walletService: { addressToUser: new Map() },
        broadcastManager: { sendStatusUpdate: jest.fn() },
        debugManager: { CONSOLE_LOGGING: false },
        _emitFairnessOffer: jest.fn(),
        _emitIdentity: jest.fn(async () => null)
    });
    return { handlers, socket, sessions, monitored, manager, events };
}

describe('pending invoice restoration on authenticated session resume', () => {
    const previous = {
        OPERATED_PRODUCT_PROFILE: process.env.OPERATED_PRODUCT_PROFILE,
        PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED
    };
    beforeEach(() => {
        generatePaymentQR.mockReset();
        generatePaymentQR.mockResolvedValue('data:image/png;base64,fixture');
        delete process.env.OPERATED_PRODUCT_PROFILE;
        process.env.PAYMENTS_ENABLED = 'true';
    });
    afterAll(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    test('resumes a standalone invoice after capabilities without a game or queue', async () => {
        const { handlers, socket, manager, events } = fixture();
        await handlers.handleConnection(socket);
        await new Promise(resolve => setImmediate(resolve));

        const modes = events.findIndex(([event]) => event === 'game_mode_info');
        const invoice = events.findIndex(([event]) => event === 'payment_created');
        expect(modes).toBeGreaterThanOrEqual(0);
        expect(invoice).toBeGreaterThan(modes);
        expect(events[invoice][1]).toMatchObject({
            paymentId: pending.id, ownerUserId: pending.user_id,
            amount: pending.expected_amount, productId: pending.product_id,
            memo: pending.description, restored: true
        });
        expect(manager.db.query).toHaveBeenCalledTimes(1);
        expect(manager.db.query.mock.calls[0][1]).toEqual([7]);
        expect(handlers.paymentHandlers._monitorAddress).toHaveBeenCalledTimes(1);
    });

    test('does not restore to a newly created or different owner session', async () => {
        const fresh = fixture({ resumed: false });
        await fresh.handlers.handleConnection(fresh.socket);
        expect(fresh.manager.db.query).not.toHaveBeenCalled();

        const wrongOwner = fixture({ row: { ...pending, user_id: 8 } });
        await wrongOwner.handlers._restorePaymentMonitoring(wrongOwner.socket, 7);
        expect(wrongOwner.events.some(([event]) => event === 'payment_created')).toBe(false);
        expect(wrongOwner.handlers.paymentHandlers._monitorAddress).not.toHaveBeenCalled();
    });

    test('drops an in-flight restore when the session is adopted elsewhere', async () => {
        const { handlers, socket, sessions, manager, events } = fixture();
        let finishQuery;
        manager.db.query = jest.fn(() => new Promise(resolve => { finishQuery = resolve; }));
        const restore = handlers._restorePaymentMonitoring(socket, 7);
        sessions.delete(socket.id);
        socket.connected = false;
        finishQuery({ rows: [pending] });
        await restore;
        expect(events.some(([event]) => event === 'payment_created')).toBe(false);
        expect(handlers.paymentHandlers._monitorAddress).not.toHaveBeenCalled();
    });

    test('does not deliver or watch after adoption during QR creation', async () => {
        const { handlers, socket, sessions, events } = fixture();
        let finishQr;
        generatePaymentQR.mockImplementationOnce(() => new Promise(resolve => { finishQr = resolve; }));
        const restore = handlers._restorePaymentMonitoring(socket, 7);
        await new Promise(resolve => setImmediate(resolve));
        expect(generatePaymentQR).toHaveBeenCalledTimes(1);
        sessions.delete(socket.id);
        finishQr('data:image/png;base64,fixture');
        await restore;
        expect(events.some(([event]) => event === 'payment_created')).toBe(false);
        expect(handlers.paymentHandlers._monitorAddress).not.toHaveBeenCalled();
    });

    test('does not replace a newer watcher installed while QR creation awaited', async () => {
        const { handlers, socket, monitored, events } = fixture();
        let finishQr;
        generatePaymentQR.mockImplementationOnce(() => new Promise(resolve => { finishQr = resolve; }));
        const restore = handlers._restorePaymentMonitoring(socket, 7);
        await new Promise(resolve => setImmediate(resolve));
        expect(generatePaymentQR).toHaveBeenCalledTimes(1);
        const newer = { paymentId: 32, address: 'newer-address' };
        monitored.set(socket.id, newer);
        finishQr('data:image/png;base64,fixture');
        await restore;
        expect(monitored.get(socket.id)).toBe(newer);
        expect(handlers.paymentHandlers.stopMonitoringForSocket).not.toHaveBeenCalled();
        expect(handlers.walletService.addressToUser.size).toBe(0);
        expect(events.some(([event]) => event === 'payment_created')).toBe(false);
    });

    test('keeps one watcher and one invoice event for the same pending payment', async () => {
        const { handlers, socket, events } = fixture();
        await handlers._restorePaymentMonitoring(socket, 7);
        await handlers._restorePaymentMonitoring(socket, 7);
        expect(handlers.paymentHandlers._monitorAddress).toHaveBeenCalledTimes(1);
        expect(events.filter(([event]) => event === 'payment_created')).toHaveLength(1);
    });

    test('stops a prior socket watcher before binding and monitoring the pending invoice', async () => {
        const { handlers, socket, monitored } = fixture();
        monitored.set(socket.id, { paymentId: 2, address: 'old-address' });
        const bind = jest.spyOn(handlers.walletService.addressToUser, 'set');
        await handlers._restorePaymentMonitoring(socket, 7);
        const stopped = handlers.paymentHandlers.stopMonitoringForSocket.mock.invocationCallOrder[0];
        const rebound = bind.mock.invocationCallOrder[0];
        const restarted = handlers.paymentHandlers._monitorAddress.mock.invocationCallOrder[0];
        expect(stopped).toBeLessThan(rebound);
        expect(rebound).toBeLessThan(restarted);
        expect(monitored.get(socket.id).paymentId).toBe(pending.id);
    });

    test('free and official paused profiles do not query or advertise an invoice', async () => {
        const free = fixture();
        free.manager.paymentsEnabled = false;
        await free.handlers.handleConnection(free.socket);
        expect(free.manager.db.query).not.toHaveBeenCalled();
        expect(free.events.find(([event]) => event === 'game_mode_info')[1].paymentsEnabled).toBe(false);
        expect(free.events.some(([event]) => event === 'payment_created')).toBe(false);

        process.env.OPERATED_PRODUCT_PROFILE = 'such-play-wow-prestige';
        process.env.PAYMENTS_ENABLED = 'false';
        const paused = fixture();
        await paused.handlers.handleConnection(paused.socket);
        expect(paused.manager.db.query).not.toHaveBeenCalled();
        expect(paused.events.find(([event]) => event === 'game_mode_info')[1].paymentsEnabled).toBe(false);
        expect(paused.events.some(([event]) => event === 'payment_created')).toBe(false);
    });

    test('uses persisted routed invoice identity and refuses a missing gateway reference', async () => {
        const gatewayRow = { ...pending, provider_id: 'btcpay', provider_invoice_id: 'invoice-31' };
        const routed = fixture({ row: gatewayRow });
        routed.manager.paymentProviders = { getProvider: () => ({ id: 'btcpay' }) };
        await routed.handlers._restorePaymentMonitoring(routed.socket, 7);
        const request = routed.handlers.paymentHandlers._monitorAddress.mock.calls[0][1];
        expect(request.invoiceId).toBe(gatewayRow.provider_invoice_id);

        const missing = fixture({ row: { ...gatewayRow, provider_invoice_id: null } });
        missing.manager.paymentProviders = routed.manager.paymentProviders;
        await missing.handlers._restorePaymentMonitoring(missing.socket, 7);
        expect(missing.handlers.paymentHandlers._monitorAddress).not.toHaveBeenCalled();
    });
});
