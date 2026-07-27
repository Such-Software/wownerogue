const SocketHandlers = require('../src/network/socketHandlers');
const PaymentHandlers = require('../src/network/paymentHandlers');
const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');

const ENV_KEYS = [
    'NODE_ENV',
    'LEGAL_POLICY_VERSION',
    'PAID_ACKNOWLEDGEMENT_REQUIRED',
    'MATCH_ENABLED',
    'MATCH_CRYPTO_RACE_ENABLED',
    'MATCH_PAYOUTS_ENABLED'
];

function manager(overrides = {}) {
    return {
        cryptoType: 'WOW',
        currencyLabel: 'WOW',
        network: 'mainnet',
        isTestNetwork: false,
        paymentsEnabled: false,
        directModeEnabled: false,
        creditsModeEnabled: false,
        freePlayEnabled: true,
        payoutsEnabled: false,
        gameMode: 'PAID_CREDITS',
        isPayoutEnabledForMode: () => false,
        ...overrides
    };
}

function acknowledgement(gameModeManager, overrides = {}) {
    const disclosure = buildCommerceDisclosure(gameModeManager, process.env);
    return {
        policyVersion: disclosure.policyVersion,
        ageEligible: true,
        termsRead: true,
        riskAccepted: true,
        testnetUnderstood: false,
        ...overrides
    };
}

function socket() {
    return {
        id: 'socket-paid-flow',
        handshake: { address: '127.0.0.1', headers: {} },
        emit: jest.fn()
    };
}

function baseContext(gameModeManager = manager()) {
    return {
        gameModeManager,
        sessionManager: null,
        broadcastManager: { sendStatusUpdate: jest.fn() },
        rateLimiter: {
            checkLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
            recordAttempt: jest.fn().mockResolvedValue(undefined)
        },
        _consumeFairnessAttempt: jest.fn().mockReturnValue({ proofVersion: 2 }),
        activeGames: new Map(),
        connectionHandler: { getUserBySocket: jest.fn().mockReturnValue({ serverId: 'socket-paid-flow' }) },
        debugManager: { getCurrentBlockHeight: jest.fn().mockReturnValue(100), CONSOLE_LOGGING: false },
        io: { to: jest.fn(() => ({ emit: jest.fn() })) }
    };
}

describe('current paid acknowledgement gates every value-consuming socket flow', () => {
    let previous;

    beforeEach(() => {
        previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
        process.env.NODE_ENV = 'test';
        process.env.LEGAL_POLICY_VERSION = 'paid-flow-current-v1';
        process.env.PAID_ACKNOWLEDGEMENT_REQUIRED = 'false';
        process.env.MATCH_ENABLED = 'true';
        delete process.env.MATCH_CRYPTO_RACE_ENABLED;
        delete process.env.MATCH_PAYOUTS_ENABLED;
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });

    test('invoice request rejects a stale policy before fairness, wallet, or database work', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.paymentHandlers = { handlePaymentRequest: jest.fn() };

        await SocketHandlers.prototype.handlePaymentRequest.call(ctx, client, {
            type: 'credits_package',
            legalAcknowledgement: acknowledgement(ctx.gameModeManager, { policyVersion: 'stale-v0' })
        });

        expect(ctx.paymentHandlers.handlePaymentRequest).not.toHaveBeenCalled();
        expect(ctx._consumeFairnessAttempt).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith('commerce_ack_required', expect.objectContaining({
            code: 'PAID_ACK_VERSION', policyVersion: 'paid-flow-current-v1'
        }));
    });

    test('invoice request accepts the current policy even with intake state reported off', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.paymentHandlers = { handlePaymentRequest: jest.fn().mockResolvedValue(undefined) };
        const ack = acknowledgement(ctx.gameModeManager);

        await SocketHandlers.prototype.handlePaymentRequest.call(ctx, client, {
            type: 'credits_package', legalAcknowledgement: ack
        });

        expect(ctx.paymentHandlers.handlePaymentRequest).toHaveBeenCalledWith(client, {
            type: 'credits_package', legalAcknowledgement: ack
        });
    });

    test('auto-start rejects stale policy before consuming a fairness offer or credit', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.gameManager = { createGameForUser: jest.fn() };

        await SocketHandlers.prototype.handleAutoStart.call(ctx, client, {
            legalAcknowledgement: acknowledgement(ctx.gameModeManager, { policyVersion: 'stale-v0' })
        });

        expect(ctx._consumeFairnessAttempt).not.toHaveBeenCalled();
        expect(ctx.gameManager.createGameForUser).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith('commerce_ack_required', expect.objectContaining({ code: 'PAID_ACK_VERSION' }));
    });

    test('auto-start with current policy reaches existing-credit consumption while intake is off', async () => {
        const client = socket();
        const gameModeManager = manager({
            canUserStartGame: jest.fn().mockResolvedValue({
                allowed: true,
                effectiveMode: 'PAID_CREDITS',
                useCredits: true
            }),
            requiresPayoutAddressForMode: jest.fn().mockReturnValue(false),
            processGameStart: jest.fn().mockResolvedValue({ success: true, creditsRemaining: 4 })
        });
        const ctx = baseContext(gameModeManager);
        const game = {
            id: 'game-1',
            dbId: null,
            getState: jest.fn().mockReturnValue({}),
            getProofCommitment: jest.fn().mockReturnValue('commitment')
        };
        ctx.gameManager = { createGameForUser: jest.fn().mockResolvedValue(game) };

        await SocketHandlers.prototype.handleAutoStart.call(ctx, client, {
            legalAcknowledgement: acknowledgement(gameModeManager)
        });

        expect(gameModeManager.canUserStartGame).toHaveBeenCalledWith(client.id);
        expect(gameModeManager.processGameStart).toHaveBeenCalledWith(client.id, game.id, { forceFree: false });
    });

    test('queued-credit entry rejects stale policy before queue eligibility or debit', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.queueHandler = { handleGameQueue: jest.fn() };

        await SocketHandlers.prototype.handleJoinQueue.call(ctx, client, {
            legalAcknowledgement: acknowledgement(ctx.gameModeManager, { policyVersion: 'stale-v0' })
        });

        expect(ctx._consumeFairnessAttempt).not.toHaveBeenCalled();
        expect(ctx.queueHandler.handleGameQueue).not.toHaveBeenCalled();
    });

    test('queued-credit entry accepts the current policy while invoice intake is off', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.queueHandler = { handleGameQueue: jest.fn().mockResolvedValue(undefined) };
        ctx.queueManager = { getPlayerIndex: jest.fn().mockReturnValue(-1) };

        await SocketHandlers.prototype.handleJoinQueue.call(ctx, client, {
            legalAcknowledgement: acknowledgement(ctx.gameModeManager)
        });

        expect(ctx.queueHandler.handleGameQueue).toHaveBeenCalledWith(
            client,
            expect.any(Function),
            expect.objectContaining({ fairnessProof: { proofVersion: 2 } })
        );
    });

    test('early entry rejects stale policy before queue eligibility or credit debit', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.queueHandler = { handleEarlyEntry: jest.fn() };

        await SocketHandlers.prototype.handleEarlyEntry.call(ctx, client, {
            legalAcknowledgement: acknowledgement(ctx.gameModeManager, { policyVersion: 'stale-v0' })
        });

        expect(ctx._consumeFairnessAttempt).not.toHaveBeenCalled();
        expect(ctx.queueHandler.handleEarlyEntry).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith('early_entry_error', expect.objectContaining({ code: 'PAID_ACK_VERSION' }));
    });

    test('early entry accepts current policy while invoice intake is off', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.queueHandler = { handleEarlyEntry: jest.fn().mockResolvedValue({ success: true }) };

        await SocketHandlers.prototype.handleEarlyEntry.call(ctx, client, {
            legalAcknowledgement: acknowledgement(ctx.gameModeManager)
        });

        expect(ctx.queueHandler.handleEarlyEntry).toHaveBeenCalledWith(
            client,
            expect.any(Function),
            { fairnessProof: { proofVersion: 2 } }
        );
    });

    test('paid PvP rejects stale policy before a credit or ticket is escrowed', async () => {
        const client = socket();
        const ctx = baseContext();
        ctx.matchQueue = {
            isEnabled: jest.fn().mockReturnValue(true),
            enqueue: jest.fn(),
            leave: jest.fn()
        };
        ctx._resolveMatchSession = jest.fn().mockResolvedValue({
            userId: 1, socketId: client.id, sessionToken: 'session'
        });

        await SocketHandlers.prototype._handleMatchQueue.call(ctx, client, {
            action: 'join', economy: 'crypto_race',
            legalAcknowledgement: acknowledgement(ctx.gameModeManager, { policyVersion: 'stale-v0' })
        });

        expect(ctx.matchQueue.enqueue).not.toHaveBeenCalled();
        expect(client.emit).toHaveBeenCalledWith('match_error', expect.objectContaining({ code: 'PAID_ACK_VERSION' }));
    });

    test.each(['credits_prestige', 'crypto_race'])(
        'paid PvP %s accepts the current policy while new invoice intake is off',
        async economy => {
            const client = socket();
            const ctx = baseContext();
            ctx.matchQueue = {
                isEnabled: jest.fn().mockReturnValue(true),
                enqueue: jest.fn().mockResolvedValue({ success: true, position: 1 }),
                leave: jest.fn()
            };
            ctx._resolveMatchSession = jest.fn().mockResolvedValue({
                userId: 1, socketId: client.id, sessionToken: 'session'
            });

            await SocketHandlers.prototype._handleMatchQueue.call(ctx, client, {
                action: 'join', economy,
                legalAcknowledgement: acknowledgement(ctx.gameModeManager)
            });

            expect(ctx.matchQueue.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 1, economy }),
                { economy }
            );
        }
    );

    test('continuation cache is canonical, capped, expires, and clears on failed selection', async () => {
        const gameModeManager = manager({
            gameMode: 'FREE',
            getCosmeticProduct: jest.fn().mockReturnValue(null)
        });
        const handler = new PaymentHandlers({
            io: { to: () => ({ emit: jest.fn() }) },
            gameModeManager,
            walletService: {},
            debugManager: { CONSOLE_LOGGING: false },
            queueManager: {},
            broadcastManager: { sendStatusUpdate: jest.fn() },
            sessionManager: null
        });
        const ack = acknowledgement(gameModeManager);
        try {
            handler._rememberPendingCommerceAcknowledgement('canonical', {
                ...ack,
                ignored: 'never retained'
            });
            expect(handler._getPendingCommerceAcknowledgement('canonical')).toEqual(ack);
            expect(Object.keys(handler._getPendingCommerceAcknowledgement('canonical'))).toEqual([
                'policyVersion', 'ageEligible', 'termsRead', 'riskAccepted', 'testnetUnderstood'
            ]);

            for (let index = 0; index < 300; index += 1) {
                handler._rememberPendingCommerceAcknowledgement(`socket-${index}`, ack);
            }
            expect(handler.pendingCommerceAcknowledgement.size).toBe(256);

            const expiresAt = handler.pendingCommerceAcknowledgement.get('socket-299').expiresAt;
            const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAt);
            expect(handler._getPendingCommerceAcknowledgement('socket-299')).toBeNull();
            now.mockRestore();

            handler._rememberPendingCommerceAcknowledgement('failed', ack);
            handler.pendingEntryFairness.set('failed', { proofVersion: 2 });
            await handler.createAndShowPaymentRequest({ id: 'failed' }, {
                paymentType: 'bogus',
                legalAcknowledgement: ack
            });
            expect(handler._getPendingCommerceAcknowledgement('failed')).toBeNull();
            expect(handler.pendingEntryFairness.has('failed')).toBe(false);
        } finally {
            handler.dispose();
        }
    });

    test('disconnect clears server-side acknowledgement and fairness continuation state', () => {
        const client = socket();
        const clearPendingCommerceAcknowledgement = jest.fn();
        const pendingEntryFairness = new Map([[client.id, { proofVersion: 2 }]]);
        const ctx = {
            fairnessOffers: { discardSocket: jest.fn() },
            paymentHandlers: { clearPendingCommerceAcknowledgement, pendingEntryFairness },
            connectionHandler: { handleDisconnect: jest.fn() }
        };

        SocketHandlers.prototype.handleDisconnect.call(ctx, client);

        expect(clearPendingCommerceAcknowledgement).toHaveBeenCalledWith(client.id);
        expect(pendingEntryFairness.has(client.id)).toBe(false);
    });
});
