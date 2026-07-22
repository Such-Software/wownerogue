const QueueManager = require('../src/network/queueManager');

function buildManager() {
    const captured = [];
    const game = {
        id: 'game-id',
        dbId: 1,
        getState: () => ({}),
        getProofCommitment: () => ({ commitment: 'c'.repeat(64) })
    };
    const user = { id: 'socket-a', clientId: 'client-a' };
    const io = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    const manager = new QueueManager({
        debugManager: { getCurrentBlockHeight: () => 10 },
        broadcastManager: {},
        io,
        createGameForUser: jest.fn(async (_user, _type, options) => { captured.push(options); return game; }),
        getUserBySocket: () => user,
        activeGames: new Map(),
        gameModeManager: { processGameStart: jest.fn().mockResolvedValue({ success: true }) },
        consoleLogging: false
    });
    return { manager, captured, user };
}

describe('all queue start paths preserve the consumed fairness proof', () => {
    const fairnessProof = { offerId: 'offer', serverSeed: 'a'.repeat(64), clientSeed: '01' };

    test('next-block start', async () => {
        const { manager, captured } = buildManager();
        manager.addPlayer({ serverId: 'socket-a', clientId: 'client-a', userId: 1, fairnessProof });
        await manager.startGamesForWaiting(11);
        expect(captured[0].fairnessProof).toBe(fairnessProof);
    });

    test('confirmed-payment immediate start', async () => {
        const { manager, captured } = buildManager();
        manager.addPlayer({ serverId: 'socket-a', clientId: 'client-a', userId: 1, fairnessProof });
        await manager.startGameImmediately('socket-a', 11);
        expect(captured[0].fairnessProof).toBe(fairnessProof);
    });

    test('early entry start', async () => {
        const { manager, captured, user } = buildManager();
        await manager.startEarlyGame('socket-a', user, 11, { fairnessProof });
        expect(captured[0]).toEqual(expect.objectContaining({ earlyEntry: true, fairnessProof }));
    });
});
