const QueueManager = require('../src/network/queueManager');
const PaymentHandlers = require('../src/network/paymentHandlers');

/**
 * Integration-style test to ensure a payment that confirms AFTER a block event
 * (where the entry was still unconfirmed) results in an immediate game start
 * without waiting for the next block.
 */

describe('Payment flow integration: confirm-after-block immediate start', () => {
  test('unconfirmed at block tick then confirmed triggers immediate game', async () => {
    const events = [];
    const activeGames = new Map();
    const socketId = 'sock-int';
    const blockHeight = 100;

    // Mock IO emitter
    const io = {
      to: () => ({
        emit: (event, data) => {
          events.push({ event, data });
        }
      })
    };

    // Minimal broadcast manager stub
    const broadcastManager = {
      sendStatusUpdate: () => {},
      broadcastChatMessage: () => {}
    };

    // Debug manager mock
    const debugManager = {
      CONSOLE_LOGGING: false,
      getCurrentBlockHeight: () => blockHeight
    };

    // User lookup
  const userObj = { id: socketId, clientId: 'client-int', payout_address: 'wow1address' };
    const getUserBySocket = (id) => id === socketId ? userObj : null;

    // createGameForUser mock (records active game & returns state)
    const createGameForUser = (user) => {
      const game = {
        getState: () => ({ player: { x:0, y:0 }, lighting: {}, torches: [], started: true })
      };
      activeGames.set(user.id, game);
      return game;
    };

    // Game mode manager mock (paid single game mode)
    const gameModeManager = {
      gameMode: 'PAID_SINGLE',
      cryptoType: 'WOW',
      currencyDecimals: 11,
      singleGamePrice: 1000,
      creditsPayoutEnabled: false,
      formatAtomicHuman: () => '0.001',
      getOrCreateUser: async () => ({ id: socketId, payout_address: 'wow1address', clientId: 'client-int' }),
      createPaymentRequest: async () => ({
        id: 'pay-1',
        address: 'addr-1',
        amount: 1000,
        amountFormatted: '0.001',
        expiresAt: new Date(Date.now()+60000)
      })
    };

    // Wallet service mock with manual callback control
    let monitorCallback;
    const walletService = {
      startPaymentMonitoring: (address, cb) => { monitorCallback = cb; },
      stopPaymentMonitoring: () => {}
    };

    // Instantiate real QueueManager & PaymentHandlers
    const queueManager = new QueueManager({
      debugManager,
      broadcastManager,
      io,
      createGameForUser,
      getUserBySocket,
      activeGames,
      gameModeManager,
      consoleLogging: false
    });

    const paymentHandlers = new PaymentHandlers({
      io,
      gameModeManager,
      walletService,
      debugManager,
      queueManager,
      broadcastManager
    });

    // Fake socket object with id
    const fakeSocket = { id: socketId, emit: (event, data) => events.push({ event, data }) };

    // Create payment request (does NOT queue yet) and start monitoring
    await paymentHandlers.createAndShowPaymentRequest(fakeSocket);

    expect(monitorCallback).toBeDefined();

    // Simulate mempool detection first
    monitorCallback({ in_mempool: true, confirmed: false, amount: 1000, confirmations: 0 });
    // Should have queued the player but not started a game
    expect(queueManager.getQueueLength()).toBe(1);
    expect(events.filter(e => e.event === 'game_start').length).toBe(0);

    // Simulate block tick BEFORE confirmation (should skip unconfirmed)
    queueManager.startGamesForWaiting(blockHeight);
    expect(events.filter(e => e.event === 'game_start').length).toBe(0);
    // Entry should still be in queue (re-queued)
    expect(queueManager.getQueueLength()).toBe(1);

    // Now simulate confirmation after the block
    monitorCallback({ in_mempool: true, confirmed: true, amount: 1000, confirmations: 1 });

    // Immediate game start expected
    const gameStarts = events.filter(e => e.event === 'game_start');
    expect(gameStarts.length).toBe(1);
    expect(gameStarts[0].data.blockHeight).toBe(blockHeight);
    // Queue should now be empty
    expect(queueManager.getQueueLength()).toBe(0);
  });
});
