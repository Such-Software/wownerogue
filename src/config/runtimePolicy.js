/**
 * Pure runtime safety policies shared by startup, public status, and background workers.
 * Keeping these predicates side-effect free makes the money kill switches regression-testable.
 */

function isPayoutProcessingEnabled(config, gameModeManager, options = {}) {
    if (!config?.payouts?.enabled || gameModeManager?.payoutsEnabled === false) return false;

    const direct = Boolean(config.modes?.direct?.enabled)
        && Boolean(config.payouts?.rules?.direct?.enabled)
        && Boolean(gameModeManager?.directPayoutEnabled);
    const credits = Boolean(config.modes?.credits?.enabled)
        && Boolean(config.payouts?.rules?.credits?.enabled)
        && Boolean(gameModeManager?.creditsPayoutEnabled);

    // Admission switches are intentionally not consulted for durable liabilities. Once any
    // paid game has created a payout row, turning off a product or match mode must stop new
    // liabilities without stranding the existing one. Only settlement-worker callers opt into
    // this behavior, and PAYOUTS_ENABLED plus the manager emergency switch remain authoritative.
    const acceptedLiabilities = options.settleAcceptedLiabilities === true
        // Compatibility for callers/tests written before the dispatcher was audited as generic.
        || options.settleAcceptedMatchLiabilities === true;

    return direct || credits || acceptedLiabilities;
}

function isWalletRequired(config, gameModeManager, options = {}) {
    // Intake needs subaddress creation/receipt checks. Settlement still needs transfer RPC when
    // operators pause every new invoice, so payout-only recovery must initialize the same
    // authenticated wallet boundary instead of falling through to a default endpoint.
    return Boolean(config?.paymentsEnabled)
        || isPayoutProcessingEnabled(config, gameModeManager, options);
}

module.exports = { isPayoutProcessingEnabled, isWalletRequired };
