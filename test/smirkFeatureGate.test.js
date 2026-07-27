const { isSmirkEnabled } = require('../src/auth/smirkPolicy');
const GameModeManager = require('../src/game/gameModeManager');
const ClientSocketHandlers = require('../html/js/network/socketHandlers');

function gameModeInfoFixture() {
  const manager = Object.create(GameModeManager.prototype);
  Object.assign(manager, {
    creditsPayoutBaseValue: 0,
    cryptoType: 'WOW',
    network: 'mainnet',
    isTestNetwork: false,
    configSnapshot: { modes: { credits: { packages: [] } }, earlyEntry: {} },
    gameMode: 'FREE',
    freePlayEnabled: true,
    singleGamePrice: 0,
    creditsPackagePrice: 0,
    creditsPerGameCost: 1,
    paymentsEnabled: false,
    directModeEnabled: false,
    creditsModeEnabled: false,
    payoutsEnabled: false,
    directPayoutMultipliers: {},
    creditPayoutMultipliers: {},
    formatAtomic: () => '0',
    formatAtomicHuman: () => '0',
    getCosmeticProducts: () => [],
    isPayoutEnabledForMode: () => false,
    _getMatchEconomies: () => [],
    _getMatchRulesetInfo: () => ({})
  });
  return manager.getGameModeInfo();
}

describe('Smirk explicit opt-in policy', () => {
  const original = {};

  beforeEach(() => {
    for (const key of ['SMIRK_ENABLED', 'MONERO_NETWORK']) original[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  test('server policy is off for missing/truthy-ish values and every test network', () => {
    expect(isSmirkEnabled({ MONERO_NETWORK: 'mainnet' })).toBe(false);
    expect(isSmirkEnabled({ SMIRK_ENABLED: 'TRUE', MONERO_NETWORK: 'mainnet' })).toBe(false);
    expect(isSmirkEnabled({ SMIRK_ENABLED: '1', MONERO_NETWORK: 'mainnet' })).toBe(false);
    expect(isSmirkEnabled({ SMIRK_ENABLED: 'true', MONERO_NETWORK: 'stagenet' })).toBe(false);
    expect(isSmirkEnabled({ SMIRK_ENABLED: 'true', MONERO_NETWORK: 'testnet' })).toBe(false);
    expect(isSmirkEnabled({ SMIRK_ENABLED: 'true', MONERO_NETWORK: 'mainnet' })).toBe(true);
  });

  test('game-mode payload defaults Smirk off and advertises it only for exact mainnet opt-in', () => {
    delete process.env.SMIRK_ENABLED;
    process.env.MONERO_NETWORK = 'mainnet';
    expect(gameModeInfoFixture().smirkEnabled).toBe(false);

    process.env.SMIRK_ENABLED = 'true';
    expect(gameModeInfoFixture().smirkEnabled).toBe(true);

    process.env.MONERO_NETWORK = 'stagenet';
    expect(gameModeInfoFixture().smirkEnabled).toBe(false);
  });

  test('browser gate accepts only the explicit boolean true sent by the server', () => {
    expect(ClientSocketHandlers._isSmirkExplicitlyEnabled({})).toBe(false);
    expect(ClientSocketHandlers._isSmirkExplicitlyEnabled({ smirkEnabled: 'true' })).toBe(false);
    expect(ClientSocketHandlers._isSmirkExplicitlyEnabled({ smirkEnabled: false })).toBe(false);
    expect(ClientSocketHandlers._isSmirkExplicitlyEnabled({ smirkEnabled: true })).toBe(true);
  });
});
