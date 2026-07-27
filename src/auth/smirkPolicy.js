const { isTestNetworkFor } = require('../game/helpers/gameModeUtils');

/** Smirk is an explicit mainnet-only feature. Missing, malformed, or truthy-ish values stay off. */
function isSmirkEnabled(env = process.env) {
  return env.SMIRK_ENABLED === 'true' && !isTestNetworkFor(env.MONERO_NETWORK);
}

module.exports = { isSmirkEnabled };
