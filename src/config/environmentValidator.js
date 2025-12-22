/**
 * Environment Validator
 * Validates payment configuration and emits warnings for suspicious settings.
 */

class EnvironmentValidator {
    constructor(options = {}) {
        this.logger = options.logger || console;
    }

    validate(config) {
        const warnings = [];
        const errors = [];

        // Check for conflicting legacy/new config
        if (process.env.GAME_MODE && process.env.PAYMENT_MODES) {
            warnings.push('Both GAME_MODE and PAYMENT_MODES are set. PAYMENT_MODES takes precedence.');
        }

        // Wallet RPC required for payments
        if (config.paymentsEnabled && !process.env.PRIMARY_WALLET_ENDPOINT) {
            warnings.push('Payments enabled but PRIMARY_WALLET_ENDPOINT not set. Wallet RPC will fail.');
        }

        // Blockchain RPC required for payments
        if (config.paymentsEnabled && !process.env.PRIMARY_RPC_ENDPOINT) {
            warnings.push('Payments enabled but PRIMARY_RPC_ENDPOINT missing. Block sync will fail.');
        }

        // Direct mode price validation
        if (config.modes.direct.enabled && config.modes.direct.price <= 0n) {
            errors.push('Direct payment mode enabled but price is not positive.');
        }

        // Credits mode package validation
        if (config.modes.credits.enabled && !config.modes.credits.packages.length) {
            errors.push('Credits mode enabled but no credit packages defined.');
        }

        // Validate CREDITS_PACKAGES JSON format
        if (process.env.CREDITS_PACKAGES) {
            try {
                const parsed = JSON.parse(process.env.CREDITS_PACKAGES);
                if (!Array.isArray(parsed)) {
                    errors.push('CREDITS_PACKAGES must be a JSON array.');
                } else if (parsed.length === 0) {
                    warnings.push('CREDITS_PACKAGES is an empty array. Using defaults.');
                } else {
                    // Validate each package has required fields
                    parsed.forEach((pkg, i) => {
                        if (!pkg.id) warnings.push(`CREDITS_PACKAGES[${i}] missing "id" field.`);
                        if (!pkg.credits && pkg.credits !== 0) warnings.push(`CREDITS_PACKAGES[${i}] missing "credits" field.`);
                        if (!pkg.price) warnings.push(`CREDITS_PACKAGES[${i}] missing "price" field.`);
                    });
                }
            } catch (e) {
                errors.push(`CREDITS_PACKAGES is not valid JSON: ${e.message}`);
            }
        } else if (config.modes.credits.enabled) {
            this.logger.info?.('ℹ️ Credits mode enabled with default packages. Set CREDITS_PACKAGES for production.');
        }

        // Warn if direct payouts enabled but no wallet RPC
        if (config.payouts.rules.direct.enabled && !process.env.PRIMARY_WALLET_ENDPOINT) {
            warnings.push('DIRECT_PAYOUTS_ENABLED=true but no PRIMARY_WALLET_ENDPOINT. Payouts will fail.');
        }

        // Warn if credits payouts enabled but no wallet RPC  
        if (config.payouts.rules.credits.enabled && !process.env.PRIMARY_WALLET_ENDPOINT) {
            warnings.push('CREDITS_PAYOUTS_ENABLED=true but no PRIMARY_WALLET_ENDPOINT. Payouts will fail.');
        }

        // Info about FREE mode
        if (!config.paymentsEnabled) {
            this.logger.info?.('ℹ️ Payments disabled. Server running in FREE mode.');
        }

        // Emit warnings and errors
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
