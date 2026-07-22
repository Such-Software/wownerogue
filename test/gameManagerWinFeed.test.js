const GameManager = require('../src/game/gameManager');

function makeHarness(completion) {
    const targetedEmit = jest.fn();
    const io = {
        to: jest.fn(() => ({ emit: targetedEmit })),
        emit: jest.fn()
    };
    const game = {
        id: 'game-seed',
        player: { hasTreasure: false },
        moveCount: 12,
        startedAt: Date.now() - 1000,
        endGame: jest.fn(),
        getProofReveal: jest.fn(() => ({ commitment: 'proof' }))
    };
    const gameModeManager = {
        completeGame: jest.fn().mockResolvedValue(completion),
        db: { query: jest.fn().mockResolvedValue({ rows: [{ name: 'Alice' }] }) }
    };
    const manager = new GameManager({
        activeGames: new Map([['socket-1', game]]),
        io,
        broadcastManager: {},
        debugManager: { CONSOLE_LOGGING: false },
        gameModeManager
    });
    return { manager, game, io };
}

async function finishWin(completion) {
    const harness = makeHarness(completion);
    await harness.manager.handleGameOver(
        { id: 'socket-1' },
        harness.game,
        'won',
        'escaped',
        'Escaped',
        100
    );
    return harness.io.emit.mock.calls.find(([event]) => event === 'win_feed')?.[1];
}

describe('solo win feed payout status', () => {
    test('marks a win paid when completion contains a nested payout amount', async () => {
        const feed = await finishWin({
            success: true,
            payout: { status: 'queued', amount: '200000000000', multiplier: 2 }
        });

        expect(feed).toEqual(expect.objectContaining({ name: 'Alice', score: 100, paid: true }));
    });

    test('does not trust an obsolete top-level amount when no payout was created', async () => {
        const feed = await finishWin({ success: true, amount: '200000000000', payout: null });

        expect(feed).toEqual(expect.objectContaining({ paid: false }));
    });
});
