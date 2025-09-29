/**
 * Environment Validator
 * Emits friendly warnings when payment related environment variables look suspicious.
 */

class EnvironmentValidator {
    constructor(options = {}) {
        this.logger = options.logger || console;
    }

    validate(config) {
        const warnings = [];
        const errors = [];

        if (process.env.GAME_MODE && process.env.PAYMENT_MODES) {
            warnings.push('Both GAME_MODE and PAYMENT_MODES are set. PAYMENT_MODES takes precedence.');
        }

        if (config.paymentsEnabled && !process.env.PRIMARY_WALLET_ENDPOINT) {
            warnings.push('paymentsEnabled is true but PRIMARY_WALLET_ENDPOINT is not set. Wallet RPC may fail.');
        }

        if (config.paymentsEnabled && !process.env.PRIMARY_RPC_ENDPOINT) {
            warnings.push('paymentsEnabled is true but PRIMARY_RPC_ENDPOINT is missing. Blockchain RPC is required.');
        }

        if (config.modes.direct.enabled && config.modes.direct.price <= 0n) {
            errors.push('Direct payment mode is enabled but direct price is not positive.');
        }

        if (config.modes.credits.enabled && !config.modes.credits.packages.length) {
            errors.push('Credits mode is enabled but no credit packages are defined.');
        }

        if (config.modes.credits.enabled && !process.env.CREDITS_PACKAGES) {
            this.logger.info?.('ℹ️ Credits mode enabled with default packages. Consider defining CREDITS_PACKAGES for production.');
        }

        if (!config.paymentsEnabled) {
            this.logger.info?.('ℹ️ Payments are currently disabled. Server will run in FREE mode.');
        }

        if (warnings.length) {
            warnings.forEach(msg => this.logger.warn?.(`⚠️ ${msg}`));
        }

        if (errors.length) {
            errors.forEach(msg => this.logger.error?.(`❌ ${msg}`));
        }

        return { warnings, errors };
    }
}

module.exports = EnvironmentValidator;
