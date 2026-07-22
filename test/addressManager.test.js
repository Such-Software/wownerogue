const AddressManager = require('../src/network/addressManager');
const { AppError } = require('../src/utils/errors');

describe('AddressManager', () => {
    const sampleAddress = 'WW3UyJFX6GPKdM21APyVYjGhfX3ebyHvPPgtFC3wHxkYTCGg8k2UM9DLTCzcgoaLHSKnvJKRtCPgJ1sxvgYiFCoK19vLk83Jn';

    function createManager({ existingAddress = null, cryptoType = null, network = null, walletValidation = null } = {}) {
        const emitMock = jest.fn();
        const toMock = jest.fn().mockReturnValue({ emit: emitMock });
        const broadcastMock = { sendStatusUpdate: jest.fn() };
        const gameModeManager = {
            cryptoType,
            network,
            setUserPayoutAddress: jest.fn().mockResolvedValue(true),
            getOrCreateUser: jest.fn().mockResolvedValue({ payout_address: existingAddress })
        };
        if (walletValidation) {
            gameModeManager.validatePayoutAddress = jest.fn().mockResolvedValue(walletValidation);
        }

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

    test('accepts stagenet XMR prefixes and rejects mainnet prefixes on a stagenet server', async () => {
        const { manager, gameModeManager } = createManager({
            cryptoType: 'XMR',
            network: 'stagenet',
            walletValidation: { valid: true, nettype: 'stagenet' }
        });
        const stagenetAddress = `5${'1'.repeat(94)}`;
        const mainnetAddress = `4${'1'.repeat(94)}`;

        expect(manager.isValidAddress(stagenetAddress)).toBe(true);
        expect(manager.isValidAddress(mainnetAddress)).toBe(false);
        expect(await manager.saveAddress('socket-stage', stagenetAddress)).toBe(stagenetAddress);
        expect(gameModeManager.setUserPayoutAddress).toHaveBeenCalledWith('socket-stage', stagenetAddress);
    });

    test('wallet-RPC validation fails closed before an address is persisted', async () => {
        const { manager, gameModeManager } = createManager({
            cryptoType: 'XMR',
            network: 'stagenet',
            walletValidation: { valid: false, nettype: 'mainnet' }
        });
        const stagenetShapedAddress = `7${'1'.repeat(94)}`;

        expect(await manager.saveAddress('socket-bad', stagenetShapedAddress)).toBe(false);
        expect(gameModeManager.setUserPayoutAddress).not.toHaveBeenCalled();
    });
});
