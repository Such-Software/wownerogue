#!/usr/bin/env node
'use strict';

/**
 * Non-mutating production configuration preflight.
 *
 * This deliberately does not connect to PostgreSQL or either RPC. It catches dangerous operator
 * intent before a deploy; the server's normal startup then verifies live dependencies.
 */

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined });

const PaymentConfigManager = require('../config/paymentConfig');
const EnvironmentValidator = require('../config/environmentValidator');

try {
    const paymentConfig = new PaymentConfigManager({ logger: console });
    const result = new EnvironmentValidator({ logger: console }).assertValid(paymentConfig.getConfig());
    const summary = paymentConfig.summarize();

    console.log('\n✅ Production configuration preflight passed');
    console.log(`   chain: ${process.env.CRYPTO_TYPE || 'WOW'} / ${process.env.MONERO_NETWORK || 'mainnet'}`);
    console.log(`   free play: ${process.env.FREE_PLAY_ENABLED === 'true' || !summary.paymentsEnabled ? 'enabled' : 'disabled'}`);
    console.log(`   paid modes: ${[summary.directEnabled && 'direct', summary.creditsEnabled && 'credits'].filter(Boolean).join(', ') || 'none'}`);
    console.log(`   payout dispatch: ${result.money.payoutsEnabled ? 'enabled' : 'disabled'}`);
    process.exitCode = 0;
} catch (error) {
    console.error(`\n❌ Production configuration preflight failed: ${error.message}`);
    process.exitCode = 1;
}
