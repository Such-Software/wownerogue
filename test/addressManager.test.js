const AddressManager = require('../src/network/addressManager');
const { AppError } = require('../src/utils/errors');

describe('AddressManager', () => {
    const sampleAddress = 'WW3UyJFX6GPKdM21APyVYjGhfX3ebyHvPPgtFC3wHxkYTCGg8k2UM9DLTCzcgoaLHSKnvJKRtCPgJ1sxvgYiFCoK19vLk83Jn';

    function createManager({ existingAddress = null } = {}) {
        const emitMock = jest.fn();
        const toMock = jest.fn().mockReturnValue({ emit: emitMock });
        const broadcastMock = { sendStatusUpdate: jest.fn() };
        const gameModeManager = {
            setUserPayoutAddress: jest.fn().mockResolvedValue(true),
            getOrCreateUser: jest.fn().mockResolvedValue({ payout_address: existingAddress })
        };

        const manager = new AddressManager({
            gameModeManager,
            broadcastManager: broadcastMock,
            io: { to: toMock },
            debugManager: { CONSOLE_LOGGING: false },
            onConfirmed: jest.fn()
        });

        return { manager, emitMock, toMock, broadcastMock, gameModeManager };
    }

    test('saveAddress persists and emits confirmation', async () => {
        const { manager, emitMock, gameModeManager } = createManager();

        await manager.saveAddress('socket-1', sampleAddress);

        expect(gameModeManager.setUserPayoutAddress).toHaveBeenCalledWith('socket-1', sampleAddress);
        expect(emitMock).toHaveBeenCalledWith('address_confirmed', expect.objectContaining({ address: sampleAddress }));
    });

    test('saveAddress rejects invalid address input', async () => {
        const { manager } = createManager();
        await expect(manager.saveAddress('socket-2', 'not-an-address')).rejects.toBeInstanceOf(AppError);
    });

    test('handleDetection skips confirmation when address already set', async () => {
        const { manager, emitMock, gameModeManager } = createManager({ existingAddress: sampleAddress });

        await manager.handleDetection('socket-3', sampleAddress);

        expect(gameModeManager.getOrCreateUser).toHaveBeenCalled();
        expect(manager.pending.has('socket-3')).toBe(false);
        expect(emitMock).toHaveBeenCalledWith('address_confirmed', expect.objectContaining({ message: expect.stringContaining('already set') }));
    });
});
