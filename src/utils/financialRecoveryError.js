/**
 * Fail-closed error contract for startup reconciliation of durable money state.
 *
 * Only a scope, counters, and durable row identifiers are copied into the attached summary.
 * The underlying database error remains available as `cause` for trusted operator diagnostics.
 */
function createFinancialRecoveryError(scope, summary = {}, cause = undefined) {
    const unresolved = Array.isArray(summary.unresolved)
        ? summary.unresolved.map(item => ({
            type: String(item?.type || 'row'),
            id: item?.id == null ? null : String(item.id)
        }))
        : [];
    const recovery = Object.freeze({
        ok: false,
        scope: String(scope || 'financial_recovery'),
        scanFailed: summary.scanFailed === true,
        scanned: Math.max(0, Number(summary.scanned) || 0),
        resolved: Math.max(0, Number(summary.resolved) || 0),
        unresolved: Object.freeze(unresolved)
    });
    const failure = recovery.scanFailed ? 'scan failed' : `${unresolved.length} unresolved row(s)`;
    const error = new Error(`Financial recovery incomplete for ${recovery.scope}: ${failure}`);
    error.name = 'FinancialRecoveryError';
    error.code = 'FINANCIAL_RECOVERY_INCOMPLETE';
    error.recovery = recovery;
    if (cause) error.cause = cause;
    Error.captureStackTrace?.(error, createFinancialRecoveryError);
    return error;
}

module.exports = { createFinancialRecoveryError };
