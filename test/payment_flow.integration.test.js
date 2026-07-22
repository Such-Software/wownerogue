const QueueManager = require('../src/network/queueManager');
const PaymentHandlers = require('../src/network/paymentHandlers');
const { buildCommerceDisclosure } = require('../src/config/commerceDisclosurePolicy');

function legalAcknowledgement(gameModeManager) {
  const disclosure = buildCommerceDisclosure(gameModeManager, process.env);
  return {
    policyVersion: disclosure.policyVersion,
    ageEligible: true,
    termsRead: true,
    riskAccepted: true,
    testnetUnderstood: disclosure.service.isTestNetwork === true
  };
}

/**
 * Integration-style tests for the payment confirmation flow.
 *
 * 1. A payment that confirms AFTER a block event (entry still unconfirmed) results
 *    in an immediate game start without waiting for the next block.
 * 2. (Phase 0.1 security gate) A payment that is confirmed but UNDERPAID
 *    (received < expected) must NOT start a game or grant anything.
 */

const blockHeight = 100;
const socketId = 'sock-int';

/**
 * Build a fresh PaymentHandlers + QueueManager harness with controllable wallet
 * monitoring. Returns the pieces the tests need.
 */
function buildHarness() {
  const events = [];
  const activeGames = new Map();

  const io = {
    to: () => ({ emit: (event, data) => events.push({ event, data }) })
  };
  const broadcastManager = {
    sendStatusUpdate: (id, type, message) => events.push({ event: 'status', data: { type, message } }),
    broadcastChatMessage: () => {}
  };
  const debugManager = {
    CONSOLE_LOGGING: false,
    getCurrentBlockHeight: () => blockHeight
  };

  const userObj = { id: socketId, clientId: 'client-int', payout_address: 'wow1address' };
  const getUserBySocket = (id) => (id === socketId ? userObj : null);

  const createGameForUser = (user) => {
    const game = {
      getState: () => ({ player: { x: 0, y: 0 }, lighting: {}, torches: [], started: true })
    };
    activeGames.set(user.id, game);
    return game;
  };

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
      expiresAt: new Date(Date.now() + 60000)
    }),
    processGameStart: async () => ({ success: true, effectiveMode: 'PAID_SINGLE' }),
    db: {
      query: async (sql) => {
        if (sql && sql.includes('UPDATE payments') && sql.includes('RETURNING')) {
          return { rows: [{ id: 'pay-1' }] };
        }
        return { rows: [] };
      }
    }
  };

  let monitorCallback;
  const walletService = {
    startPaymentMonitoring: (address, cb) => { monitorCallback = cb; },
    stopPaymentMonitoring: () => {}
  };

  const queueManager = new QueueManager({
    debugManager, broadcastManager, io, createGameForUser, getUserBySocket,
    activeGames, gameModeManager, consoleLogging: false
  });

  const paymentHandlers = new PaymentHandlers({
    io, gameModeManager, walletService, debugManager, queueManager, broadcastManager
  });

  const fakeSocket = { id: socketId, emit: (event, data) => events.push({ event, data }) };

  return {
    events, queueManager, paymentHandlers, fakeSocket, gameModeManager,
    getMonitorCallback: () => monitorCallback
  };
}

describe('Payment flow integration: confirm-after-block immediate start', () => {
  test('unconfirmed at block tick then confirmed triggers immediate game', async () => {
    const { events, queueManager, paymentHandlers, fakeSocket, gameModeManager, getMonitorCallback } = buildHarness();

    await paymentHandlers.createAndShowPaymentRequest(fakeSocket, {
      legalAcknowledgement: legalAcknowledgement(gameModeManager)
    });
    const monitorCallback = getMonitorCallback();
    expect(monitorCallback).toBeDefined();

    // Simulate mempool detection first
    await monitorCallback({ in_mempool: true, confirmed: false, amount: 1000, confirmations: 0 });
    expect(queueManager.getQueueLength()).toBe(1);
    expect(events.filter(e => e.event === 'game_start').length).toBe(0);

    // Block tick BEFORE confirmation (should skip unconfirmed)
    await queueManager.startGamesForWaiting(blockHeight);
    expect(events.filter(e => e.event === 'game_start').length).toBe(0);
    expect(queueManager.getQueueLength()).toBe(1);

    // Confirmation after the block. `complete: true` means the received amount covers
    // the expected amount — required for a game to start (Phase 0.1 gate).
    await monitorCallback({ in_mempool: true, confirmed: true, complete: true, amount: 1000, required: 1000, confirmations: 1 });

    const gameStarts = events.filter(e => e.event === 'game_start');
    expect(gameStarts.length).toBe(1);
    expect(gameStarts[0].data.blockHeight).toBe(blockHeight);
    expect(queueManager.getQueueLength()).toBe(0);
  });

  test('confirmed but UNDERPAID does not start a game or grant anything', async () => {
    const { events, queueManager, paymentHandlers, fakeSocket, gameModeManager, getMonitorCallback } = buildHarness();

    await paymentHandlers.createAndShowPaymentRequest(fakeSocket, {
      legalAcknowledgement: legalAcknowledgement(gameModeManager)
    });
    const monitorCallback = getMonitorCallback();
    expect(monitorCallback).toBeDefined();

    // Mempool detection queues the player (queueing is gated on confirmation downstream)
    await monitorCallback({ in_mempool: true, confirmed: false, amount: 1, confirmations: 0 });

    // Confirmed on-chain, but only 1 of 1000 atomic units received → complete is false.
    await monitorCallback({ in_mempool: true, confirmed: true, complete: false, amount: 1, required: 1000, confirmations: 1 });

    // No game must start, and the user must be warned about the underpayment.
    expect(events.filter(e => e.event === 'game_start').length).toBe(0);
    expect(events.filter(e => e.event === 'payment_underpaid').length).toBe(1);
    const underpaid = events.find(e => e.event === 'payment_underpaid');
    expect(underpaid.data.received).toBe(1);
    expect(underpaid.data.required).toBe(1000);
    expect(underpaid.data.shortfall).toBe(999);

    // Repeated underpaid polls must not spam the user (notify once).
    await monitorCallback({ in_mempool: true, confirmed: true, complete: false, amount: 1, required: 1000, confirmations: 2 });
    expect(events.filter(e => e.event === 'payment_underpaid').length).toBe(1);
  });
});
