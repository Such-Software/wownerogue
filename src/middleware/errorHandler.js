const { normalizeError, isTrustedError } = require('../utils/errors');

module.exports = function createErrorMiddleware({ logger = console } = {}) {
    return function errorMiddleware(err, req, res, next) { // eslint-disable-line no-unused-vars
        const normalized = normalizeError(err);
        const status = normalized.statusCode || 500;
        const response = {
            error: normalized.code || 'INTERNAL_ERROR',
            message: normalized.safeMessage || 'An unexpected error occurred.'
        };

        if (normalized.details) {
            response.details = normalized.details;
        }

        if (logger && typeof logger.error === 'function') {
            const logPayload = {
                message: normalized.message,
                code: normalized.code,
                status,
                path: req.path,
                method: req.method,
                trusted: isTrustedError(normalized)
            };
            if (normalized.details) {
                logPayload.details = normalized.details;
            }
            if (normalized.cause) {
                logPayload.cause = normalized.cause?.message || normalized.cause;
            }
            logger.error('Request failed', logPayload);
        }

        res.status(status).json(response);
    };
};
