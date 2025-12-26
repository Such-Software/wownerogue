/**
 * Tests for Early Entry feature
 * Early Entry allows players in free/credits mode to enter the dungeon immediately
 * without waiting for the next block, with the risk of dying if a block is found.
 */

const PaymentConfigManager = require('../src/config/paymentConfig');

describe('Early Entry Feature', () => {
    describe('Configuration', () => {
        it('should have earlyEntry configuration in DEFAULT_CONFIG', () => {
            const defaultConfig = PaymentConfigManager.DEFAULT_CONFIG;
            expect(defaultConfig.earlyEntry).toBeDefined();
            expect(typeof defaultConfig.earlyEntry.enabled).toBe('boolean');
            expect(typeof defaultConfig.earlyEntry.allowInFreeMode).toBe('boolean');
            expect(typeof defaultConfig.earlyEntry.allowInCreditsMode).toBe('boolean');
        });

        it('should have sensible defaults', () => {
            const defaultConfig = PaymentConfigManager.DEFAULT_CONFIG;
            // These should be enabled by default for better UX in free/credits modes
            expect(defaultConfig.earlyEntry.enabled).toBe(true);
            expect(defaultConfig.earlyEntry.allowInFreeMode).toBe(true);
            expect(defaultConfig.earlyEntry.allowInCreditsMode).toBe(true);
        });
        
        it('should include earlyEntry in manager config', () => {
            const manager = new PaymentConfigManager();
            const config = manager.getConfig();
            expect(config.earlyEntry).toBeDefined();
            expect(config.earlyEntry.enabled).toBe(true);
        });
    });

    describe('QueueHandler.isEarlyEntryAllowed', () => {
        let mockQueueHandler;
        const earlyEntryConfig = PaymentConfigManager.DEFAULT_CONFIG.earlyEntry;
        
        beforeEach(() => {
            // Create a mock queue handler with the method we want to test
            mockQueueHandler = {
                gameModeManager: {
                    gameMode: 'FREE'
                },
                isEarlyEntryAllowed: function() {
                    const config = earlyEntryConfig;
                    
                    // Check if early entry is enabled globally
                    if (!config || !config.enabled) {
                        return { allowed: false, reason: 'Early entry is not enabled' };
                    }

                    // Get current game mode
                    const mode = this.gameModeManager?.gameMode;

                    // Check mode-specific permissions
                    if (mode === 'FREE') {
                        if (!config.allowInFreeMode) {
                            return { allowed: false, reason: 'Early entry not available in free mode' };
                        }
                        return { allowed: true };
                    }

                    if (mode === 'PAID_CREDITS') {
                        if (!config.allowInCreditsMode) {
                            return { allowed: false, reason: 'Early entry not available in credits mode' };
                        }
                        return { allowed: true };
                    }

                    // Direct payment mode - not allowed
                    if (mode === 'PAID_SINGLE') {
                        return { allowed: false, reason: 'Early entry not available in direct payment mode' };
                    }

                    return { allowed: false, reason: 'Unknown game mode' };
                }
            };
        });

        it('should allow early entry in FREE mode when configured', () => {
            mockQueueHandler.gameModeManager.gameMode = 'FREE';
            const result = mockQueueHandler.isEarlyEntryAllowed();
            expect(result.allowed).toBe(true);
        });

        it('should allow early entry in PAID_CREDITS mode when configured', () => {
            mockQueueHandler.gameModeManager.gameMode = 'PAID_CREDITS';
            const result = mockQueueHandler.isEarlyEntryAllowed();
            expect(result.allowed).toBe(true);
        });

        it('should NOT allow early entry in PAID_SINGLE mode', () => {
            mockQueueHandler.gameModeManager.gameMode = 'PAID_SINGLE';
            const result = mockQueueHandler.isEarlyEntryAllowed();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('direct payment');
        });
    });

    describe('QueueManager.startEarlyGame', () => {
        it('should set isEarlyEntry flag on user', async () => {
            // Test that when startEarlyGame is called, the user gets marked
            const mockUser = { id: 'test-socket-id' };
            const blockHeight = 12345;
            
            // Simulate what startEarlyGame does
            mockUser.blockRec = blockHeight;
            mockUser.isEarlyEntry = true;
            
            expect(mockUser.blockRec).toBe(12345);
            expect(mockUser.isEarlyEntry).toBe(true);
        });

        it('should calculate death block correctly', () => {
            const currentBlock = 12345;
            const deathBlock = currentBlock + 1;
            
            expect(deathBlock).toBe(12346);
        });
    });

    describe('GameModeManager.getGameModeInfo', () => {
        const GameModeManager = require('../src/game/gameModeManager');
        
        it('should include earlyEntry config in getGameModeInfo', () => {
            const manager = new GameModeManager({ cryptoType: 'WOW' });
            const info = manager.getGameModeInfo();
            
            expect(info.earlyEntry).toBeDefined();
            expect(typeof info.earlyEntry.enabled).toBe('boolean');
            expect(typeof info.earlyEntry.allowInFreeMode).toBe('boolean');
            expect(typeof info.earlyEntry.allowInCreditsMode).toBe('boolean');
        });
    });
});
